'use strict';
// Provider Worker core: claims provider jobs from the Bridge job queue (windowsJobs.js) and runs
// the matching *existing* local AI CLI (Gemini CLI / Claude Code CLI). No new API, no HTTP call to a
// model vendor: only a locally installed CLI is spawned.
//
// Safety rules:
//  - Commands are spawned with an argument array and shell:false. The prompt goes through stdin, never argv.
//  - repository / branch / workdir must match an allowlist (config/provider-policy.json or injected).
//  - The child gets an allowlisted environment. API-key variables are NOT forwarded unless the policy
//    opts in, so a CLI can only run on its own logged-in (already licensed) session -> no surprise billing.
//  - One run per taskId (in-process set + on-disk lock + done marker). Queue claim is already atomic.
//  - Everything stored or returned (output, audit) passes through secretMasking.
//  - A provider is only runnable when the registry says ACTIVE; ACTIVE is only written after a real selftest.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { maskDeep, maskSecrets } = require('./secretMasking');

const SELFTEST_PROMPT = 'Reply with exactly this single word and nothing else: PROVIDER_SELFTEST_OK';
const SELFTEST_EXPECT = 'PROVIDER_SELFTEST_OK';

// argv builders. Non-destructive by construction: read-only tool set, no session persistence.
const PROVIDER_SPECS = Object.freeze({
  claude_code: Object.freeze({
    id: 'claude_code',
    binaries: ['claude'],
    versionArgs: ['--version'],
    // Prompt arrives on stdin. Only read-only built-in tools are enabled.
    buildArgs: () => ['-p', '--output-format', 'text', '--no-session-persistence', '--tools', 'Read,Glob,Grep'],
    apiKeyEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    authHint: 'Claude Code CLI にログイン済みであること（`claude` を対話起動して認証。APIキー課金は使わない）'
  }),
  gemini: Object.freeze({
    id: 'gemini',
    binaries: ['gemini'],
    versionArgs: ['--version'],
    // Gemini CLI headless mode: -p is a fixed instruction, the actual prompt is appended from stdin.
    buildArgs: () => ['-p', 'Follow the instructions given on standard input.'],
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'],
    authHint: 'Gemini CLI にGoogleアカウントでログイン済みであること（APIキー課金は使わない）'
  })
});

const BASE_ENV_KEYS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];

class ProviderBlocked extends Error {
  constructor(code, message, unblock) {
    super(message);
    this.code = code;
    this.unblock = unblock || null;
  }
}

// ---------- policy / allowlist ----------

function loadPolicy(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizePolicy(raw);
}

function normalizePolicy(raw = {}) {
  const repositories = Array.isArray(raw.repositories) ? raw.repositories : [];
  return {
    repositories: repositories.map((r) => ({
      name: String(r.name),
      branches: Array.isArray(r.branches) ? r.branches.map(String) : [],
      workdirs: (Array.isArray(r.workdirs) ? r.workdirs : []).map((w) => path.resolve(String(w)))
    })),
    timeoutMs: Number.isInteger(raw.timeoutMs) && raw.timeoutMs > 0 ? raw.timeoutMs : 300000,
    maxOutputBytes: Number.isInteger(raw.maxOutputBytes) && raw.maxOutputBytes > 0 ? raw.maxOutputBytes : 200000,
    allowApiKeyEnv: raw.allowApiKeyEnv === true
  };
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Returns the resolved (realpath) workdir, or throws ProviderBlocked(ALLOWLIST_DENIED). */
function checkAllowlist(job, policy) {
  const deny = (why) => new ProviderBlocked('ALLOWLIST_DENIED', `allowlist違反: ${why}`, 'config/provider-policy.json のallowlistに対象を追加（人間承認）');
  if (!job.repository || !job.branch) throw deny('repository/branchが未指定');
  const repo = policy.repositories.find((r) => r.name === job.repository);
  if (!repo) throw deny('repositoryが許可リストにありません');
  if (!repo.branches.includes(job.branch)) throw deny('branchが許可リストにありません');
  let real;
  try { real = fs.realpathSync(path.resolve(job.workspace)); } catch { throw deny('workdirが存在しません'); }
  const allowedRoots = repo.workdirs.map((w) => { try { return fs.realpathSync(w); } catch { return w; } });
  if (!allowedRoots.some((root) => isInside(root, real))) throw deny('workdirが許可ディレクトリ外です');
  return real;
}

// ---------- process helpers (no shell) ----------

function buildChildEnv(spec, policy, source = process.env) {
  const env = {};
  for (const key of BASE_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
  if (policy.allowApiKeyEnv) for (const key of spec.apiKeyEnv) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

/** PATH lookup without a shell. On Windows only real executables (.exe/.com) are spawnable without a shell. */
function resolveCommand(names, env = process.env, platform = process.platform) {
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['.exe', '.com'] : [''];
  const shims = [];
  for (const dir of dirs) {
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (!fs.statSync(candidate).isFile()) continue;
          if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
          return { file: candidate, shim: false };
        } catch { /* keep searching */ }
      }
      if (platform === 'win32') {
        for (const ext of ['.cmd', '.bat', '.ps1']) {
          if (fs.existsSync(path.join(dir, name + ext))) shims.push(path.join(dir, name + ext));
        }
      }
    }
  }
  return shims.length ? { file: null, shim: true, shims } : { file: null, shim: false };
}

function runCli({ file, args, stdin = '', cwd, env, timeoutMs, maxOutputBytes, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, truncated, timedOut, durationMs: Date.now() - started });
    };
    const append = (current, chunk) => {
      if (current.length >= maxOutputBytes) { truncated = true; return current; }
      const next = current + chunk.toString('utf8');
      if (next.length > maxOutputBytes) { truncated = true; return next.slice(0, maxOutputBytes); }
      return next;
    };
    try {
      child = spawnImpl(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return finish({ exitCode: null, spawnError: error.code || error.message });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', (error) => finish({ exitCode: null, spawnError: error.code || error.message }));
    child.on('close', (code, signal) => finish({ exitCode: code, signal: signal || null }));
    child.stdin.on('error', () => { /* child exited before reading stdin */ });
    child.stdin.end(stdin);
  });
}

// ---------- duplicate-run prevention ----------

function createRunGuard(dir, { staleMs = 30 * 60 * 1000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const active = new Set();
  const lockPath = (taskId) => path.join(dir, `${taskId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`);
  const donePath = (taskId) => path.join(dir, `${taskId.replace(/[^A-Za-z0-9._-]/g, '_')}.done`);
  return {
    /** true = this process now exclusively owns the task. */
    acquire(taskId) {
      if (active.has(taskId) || fs.existsSync(donePath(taskId))) return false;
      try {
        fs.writeFileSync(lockPath(taskId), String(process.pid), { flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let age = 0;
        try { age = Date.now() - fs.statSync(lockPath(taskId)).mtimeMs; } catch { /* vanished */ }
        if (age < staleMs) return false;
        fs.rmSync(lockPath(taskId), { force: true }); // stale lock from a crashed worker
        try { fs.writeFileSync(lockPath(taskId), String(process.pid), { flag: 'wx' }); } catch { return false; }
      }
      active.add(taskId);
      return true;
    },
    release(taskId, { done = true } = {}) {
      active.delete(taskId);
      if (done) fs.writeFileSync(donePath(taskId), new Date().toISOString());
      fs.rmSync(lockPath(taskId), { force: true });
    }
  };
}

// ---------- registry ----------

function loadRegistry(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveRegistry(file, registry) {
  fs.writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`);
}

function providerStatus(registry, providerId) {
  const entry = registry.providers?.[providerId];
  return entry || { status: 'UNKNOWN' };
}

/** Wallboard participants = ACTIVE providers only. */
function wallboardProviders(registry) {
  return Object.entries(registry.providers || {})
    .filter(([, entry]) => entry.status === 'ACTIVE' && entry.wallboard !== false)
    .map(([id]) => id);
}

// ---------- git evidence ----------

async function git(args, cwd, env) {
  const r = await runCli({ file: 'git', args, cwd, env, timeoutMs: 20000, maxOutputBytes: 100000 });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

async function gitState(cwd, env) {
  return {
    branch: await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd, env),
    head: await git(['rev-parse', 'HEAD'], cwd, env),
    changed: (await git(['status', '--porcelain'], cwd, env)) || ''
  };
}

// ---------- job execution ----------

function classifyFailure(run) {
  const text = `${run.stderr}\n${run.stdout}`.toLowerCase();
  if (/not logged in|please (log ?in|run \/login)|unauthori[sz]ed|authentication|api key|login required|credentials/.test(text)) {
    return 'AUTH_REQUIRED';
  }
  return 'CLI_ERROR';
}

/**
 * Runs one provider job. Returns a result payload for POST /job/result (never throws for expected failures).
 */
async function executeProviderJob(job, ctx) {
  const { policy, registry, guard, audit, spawnImpl, env: hostEnv = process.env, platform = process.platform } = ctx;
  const spec = PROVIDER_SPECS[job.provider];
  const base = { taskId: job.taskId, provider: job.provider };
  const blocked = (code, message, unblock) => ({
    ...base, status: 'BLOCKED', reason: `${code}: ${message}`, exitCode: null,
    summary: message, evidence: { provider: job.provider, blockedCode: code, unblockCondition: unblock || null }
  });

  if (!spec) return blocked('PROVIDER_UNKNOWN', `未対応のprovider: ${job.provider}`, 'PROVIDER_SPECSに実在CLIのアダプタを追加');
  const entry = providerStatus(registry, job.provider);
  if (entry.status !== 'ACTIVE') {
    return blocked('PROVIDER_NOT_ACTIVE', `${job.provider}はRegistry上 ${entry.status} です`, entry.unblockCondition || '`--selftest` をPASSさせてACTIVE化');
  }
  let workdir;
  try { workdir = checkAllowlist(job, policy); } catch (error) {
    audit('denied', { taskId: job.taskId, provider: job.provider, code: error.code });
    return blocked(error.code, error.message, error.unblock);
  }
  if (!guard.acquire(job.taskId)) {
    audit('duplicate_refused', { taskId: job.taskId });
    return blocked('DUPLICATE_RUN', '同一taskIdは既に実行中または実行済みです（二重実行防止）', null);
  }
  try {
    const cli = resolveCommand(spec.binaries, hostEnv, platform);
    if (!cli.file) {
      const why = cli.shim ? 'CLIが .cmd/.ps1 シムのみで、shellなしでは起動できません' : `${spec.binaries[0]} CLIがPATHに見つかりません`;
      return blocked('CLI_NOT_FOUND', why, 'CLIの実体(.exe)をPATHへ配置しログインする');
    }
    const childEnv = buildChildEnv(spec, policy, hostEnv);
    const before = await gitState(workdir, childEnv);
    if (before.branch !== job.branch) {
      return blocked('BRANCH_MISMATCH', `workdirのbranch(${before.branch})がジョブ指定(${job.branch})と一致しません`, '対象branchをcheckoutしてから再投入');
    }
    audit('started', { taskId: job.taskId, provider: job.provider, head: before.head });
    const run = await runCli({
      file: cli.file, args: spec.buildArgs(), stdin: job.action, cwd: workdir, env: childEnv,
      timeoutMs: policy.timeoutMs, maxOutputBytes: policy.maxOutputBytes, spawnImpl
    });
    const after = await gitState(workdir, childEnv);
    const secrets = ctx.extraSecrets || [];
    const output = maskSecrets(run.stdout, secrets);
    const stderr = maskSecrets(run.stderr, secrets).slice(0, 4000);
    const worktreeChanged = before.head !== after.head || before.changed !== after.changed;
    const evidence = {
      provider: job.provider, exitCode: run.exitCode, durationMs: run.durationMs, timedOut: run.timedOut,
      truncated: run.truncated, commitBefore: before.head, commitAfter: after.head, worktreeChanged,
      testStatus: 'NOT_RUN', stderr
    };
    let status;
    let reason = null;
    if (run.spawnError) { return blocked('CLI_NOT_FOUND', `起動失敗: ${run.spawnError}`, 'CLIの実体をPATHへ配置'); }
    if (run.timedOut) { status = 'FAILED'; reason = 'TIMEOUT'; }
    else if (run.exitCode === 0 && !worktreeChanged) status = 'COMPLETED';
    else if (run.exitCode === 0) { status = 'FAILED'; reason = 'WORKTREE_CHANGED: 非破壊実行のはずがworktreeが変化'; }
    else {
      const code = classifyFailure(run);
      if (code === 'AUTH_REQUIRED') return { ...blocked('AUTH_REQUIRED', 'CLIが未ログイン/認証不足です', spec.authHint), evidence: { ...evidence, blockedCode: 'AUTH_REQUIRED', unblockCondition: spec.authHint } };
      status = 'FAILED';
      reason = `${code}: exit=${run.exitCode}`;
    }
    audit('finished', { taskId: job.taskId, provider: job.provider, status, exitCode: run.exitCode, durationMs: run.durationMs });
    return maskDeep({
      ...base, status, reason, exitCode: Number.isInteger(run.exitCode) ? run.exitCode : null,
      summary: `${job.provider} ${status} (exit ${run.exitCode})`, output, evidence,
      changedFiles: after.changed ? after.changed.split('\n').map((line) => line.slice(3)).slice(0, 100) : []
    });
  } finally {
    guard.release(job.taskId);
  }
}

/** Version probe only (no model call, no cost). */
async function probeProvider(providerId, { policy, env = process.env, platform = process.platform, spawnImpl } = {}) {
  const spec = PROVIDER_SPECS[providerId];
  if (!spec) return { providerId, found: false, code: 'PROVIDER_UNKNOWN' };
  const cli = resolveCommand(spec.binaries, env, platform);
  if (!cli.file) return { providerId, found: false, code: cli.shim ? 'SHIM_ONLY' : 'CLI_NOT_FOUND', shims: cli.shims };
  const run = await runCli({ file: cli.file, args: spec.versionArgs, env: buildChildEnv(spec, policy || normalizePolicy(), env), cwd: process.cwd(), timeoutMs: 20000, maxOutputBytes: 4000, spawnImpl });
  return { providerId, found: true, file: cli.file, exitCode: run.exitCode, version: maskSecrets(run.stdout.trim().split('\n')[0] || ''), code: run.exitCode === 0 ? 'OK' : 'VERSION_FAILED' };
}

/**
 * Real, non-destructive call: fixed harmless prompt, read-only tools, allowlisted workdir.
 * Returns { pass, ... }. Registry is only changed by the caller after pass === true.
 */
async function selftestProvider(providerId, ctx, job) {
  const guard = ctx.guard;
  const result = await executeProviderJob(
    { taskId: `selftest-${providerId}-${Date.now()}`, provider: providerId, action: SELFTEST_PROMPT, ...job },
    { ...ctx, registry: { providers: { [providerId]: { status: 'ACTIVE' } } }, guard }
  );
  const pass = result.status === 'COMPLETED' && typeof result.output === 'string' && result.output.includes(SELFTEST_EXPECT);
  return { pass, result };
}

module.exports = {
  PROVIDER_SPECS, SELFTEST_PROMPT, SELFTEST_EXPECT, ProviderBlocked,
  normalizePolicy, loadPolicy, checkAllowlist, buildChildEnv, resolveCommand, runCli,
  createRunGuard, loadRegistry, saveRegistry, providerStatus, wallboardProviders,
  executeProviderJob, probeProvider, selftestProvider
};
