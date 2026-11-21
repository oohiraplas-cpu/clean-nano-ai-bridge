const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const test = require('node:test');
const worker = require('../src/providerWorker');
const windowsJobs = require('../src/windowsJobs');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

const KEY = 'test-master-key-9f3a1c77';
const SECRET_IN_OUTPUT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A fake *local CLI* fixture (never a vendor API): behaviour is chosen by the prompt received on stdin.
function makeFakeCli(dir, name = 'claude') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('9.9.9-fixture'); process.exit(0); }
let input = ''; process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  if (input.includes('SLEEP')) { setTimeout(() => {}, 60000); return; }
  if (input.includes('LEAK')) { console.log('key=${SECRET_IN_OUTPUT}'); process.exit(0); }
  if (input.includes('NOAUTH')) { console.error('Not logged in. Please run /login'); process.exit(1); }
  if (input.includes('ENV')) { console.log(JSON.stringify({ k: process.env.ANTHROPIC_API_KEY || null, argv: process.argv.slice(2) })); process.exit(0); }
  console.log(input.includes('PROVIDER_SELFTEST_OK') ? 'PROVIDER_SELFTEST_OK' : 'done');
});
`);
  fs.chmodSync(file, 0o755);
  return file;
}

function makeRepo() {
  const dir = fs.realpathSync(tmp('pw-repo-'));
  const run = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'init');
  return dir;
}

function ctxFor(repo, fakeDir, over = {}) {
  const stateDir = tmp('pw-state-');
  const events = [];
  return {
    ctx: {
      policy: worker.normalizePolicy({ repositories: [{ name: 'r', branches: ['main'], workdirs: [repo] }], timeoutMs: 3000, ...over.policy }),
      registry: { providers: { claude_code: { status: 'ACTIVE' }, gemini: { status: 'BLOCKED', unblockCondition: 'install gemini' } } },
      guard: worker.createRunGuard(path.join(stateDir, 'locks')),
      audit: (event, data) => events.push({ event, ...data }),
      env: { PATH: `${fakeDir}${path.delimiter}${process.env.PATH}`, ANTHROPIC_API_KEY: 'sk-ant-should-not-pass-0000', HOME: stateDir },
      ...over.ctx
    },
    events
  };
}
const job = (repo, action, extra = {}) => ({ taskId: `t-${Math.random().toString(36).slice(2, 8)}`, provider: 'claude_code', repository: 'r', branch: 'main', workspace: repo, action, ...extra });

test('実行: stdin経由で渡し、引数配列(shellなし)・COMPLETED・commit証跡を返す', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx, events } = ctxFor(repo, fake);
  const r = await worker.executeProviderJob(job(repo, 'hello; rm -rf / $(whoami)'), ctx);
  assert.equal(r.status, 'COMPLETED');
  assert.equal(r.exitCode, 0);
  assert.match(r.evidence.commitBefore, /^[0-9a-f]{40}$/);
  assert.equal(r.evidence.commitBefore, r.evidence.commitAfter);
  assert.deepEqual(events.map((e) => e.event), ['started', 'finished']);
});

test('秘密値マスキング: 出力のトークンと、子プロセスへのAPIキー非転送', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake);
  const leak = await worker.executeProviderJob(job(repo, 'LEAK'), ctx);
  assert.ok(!JSON.stringify(leak).includes(SECRET_IN_OUTPUT));
  const env = await worker.executeProviderJob(job(repo, 'ENV'), ctx);
  const seen = JSON.parse(env.output);
  assert.equal(seen.k, null, 'ANTHROPIC_API_KEYは既定で転送しない');
  assert.deepEqual(seen.argv, ['-p', '--output-format', 'text', '--no-session-persistence', '--tools', 'Read,Glob,Grep']);
});

test('allowlist: 未許可repository/branch/workdirはBLOCKEDで実行されない', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake);
  for (const bad of [{ repository: 'other' }, { branch: 'dev' }, { workspace: os.tmpdir() }, { workspace: path.join(repo, '..', '..') }]) {
    const r = await worker.executeProviderJob(job(repo, 'x', bad), ctx);
    assert.equal(r.status, 'BLOCKED', JSON.stringify(bad));
    assert.match(r.reason, /ALLOWLIST_DENIED/);
  }
});

test('timeout: 子プロセスを停止しFAILED(TIMEOUT)', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake, { policy: { timeoutMs: 400 } });
  const r = await worker.executeProviderJob(job(repo, 'SLEEP'), ctx);
  assert.equal(r.status, 'FAILED');
  assert.equal(r.reason, 'TIMEOUT');
});

test('二重実行防止: 同一taskIdの2回目と同時実行は実行されない', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake);
  const j = job(repo, 'SLEEP', { taskId: 'dup-1' });
  const first = worker.executeProviderJob(j, { ...ctx, policy: { ...ctx.policy, timeoutMs: 800 } });
  const concurrent = await worker.executeProviderJob(j, ctx);
  assert.match(concurrent.reason, /DUPLICATE_RUN/);
  await first;
  const again = await worker.executeProviderJob(j, ctx);
  assert.match(again.reason, /DUPLICATE_RUN/, '完了済みtaskIdは再実行しない');
});

test('未ログインCLIはBLOCKED(AUTH_REQUIRED)、非ACTIVE/CLI無しproviderもBLOCKED', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake);
  const auth = await worker.executeProviderJob(job(repo, 'NOAUTH'), ctx);
  assert.equal(auth.status, 'BLOCKED');
  assert.match(auth.reason, /AUTH_REQUIRED/);
  const gem = await worker.executeProviderJob(job(repo, 'x', { provider: 'gemini' }), ctx);
  assert.equal(gem.status, 'BLOCKED');
  assert.match(gem.reason, /PROVIDER_NOT_ACTIVE/);
  const active = { ...ctx, registry: { providers: { gemini: { status: 'ACTIVE' } } } };
  const missing = await worker.executeProviderJob(job(repo, 'x', { provider: 'gemini' }), active);
  assert.match(missing.reason, /CLI_NOT_FOUND/);
});

test('Wallboard参加はACTIVE providerのみ / Windowsの.cmdシムはshellなしでは使わない', () => {
  assert.deepEqual(worker.wallboardProviders({ providers: { a: { status: 'ACTIVE' }, b: { status: 'BLOCKED' }, c: { status: 'ACTIVE', wallboard: false } } }), ['a']);
  const dir = tmp('pw-win-');
  fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@echo off');
  const r = worker.resolveCommand(['gemini'], { PATH: dir }, 'win32');
  assert.equal(r.file, null);
  assert.equal(r.shim, true);
});

test('selftest: 実CLI呼び出しPASSでのみ成功判定', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const { ctx } = ctxFor(repo, fake);
  const { pass } = await worker.selftestProvider('claude_code', ctx, { repository: 'r', branch: 'main', workspace: repo });
  assert.equal(pass, true);
});

test('Queue E2E: submit→Worker claim→実行→result/Audit。legacy executorはprovider jobを取らない', async () => {
  const fake = tmp('pw-fake-'); makeFakeCli(fake);
  const repo = makeRepo();
  const stateDir = tmp('pw-e2e-');
  const policyFile = path.join(stateDir, 'policy.json');
  const registryFile = path.join(stateDir, 'registry.json');
  fs.writeFileSync(policyFile, JSON.stringify({ repositories: [{ name: 'r', branches: ['main'], workdirs: [repo] }], timeoutMs: 5000 }));
  fs.writeFileSync(registryFile, JSON.stringify({ providers: { claude_code: { status: 'ACTIVE' }, gemini: { status: 'BLOCKED', unblockCondition: 'install gemini' } } }));
  const config = getConfig({ WEBHOOK_API_KEY: 'hook-key-1234', MCP_API_KEY: KEY, TASKS_FILE: path.join(stateDir, 'tasks.json') });
  const server = createApp(config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: auth, body: JSON.stringify(body) }).then((r) => r.json());
  try {
    const ids = { ok: `e2e-ok-${Date.now()}`, gem: `e2e-gem-${Date.now()}` };
    await post('/job/submit', { taskId: ids.ok, action: 'summarize', workspace: repo, provider: 'claude_code', repository: 'r', branch: 'main' });
    await post('/job/submit', { taskId: ids.gem, action: 'summarize', workspace: repo, provider: 'gemini', repository: 'r', branch: 'main' });
    const legacy = await fetch(`${base}/job/pull?executorId=legacy-1`, { headers: auth }).then((r) => r.json());
    assert.equal(legacy.job, null, 'providerなしPullはprovider jobを取らない');

    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'provider-worker.js'), '--once'], {
        env: { PATH: `${fake}${path.delimiter}${process.env.PATH}`, BRIDGE_URL: base, MCP_API_KEY: KEY, WORKER_ID: 'pw-test', PROVIDER_POLICY_FILE: policyFile, PROVIDER_REGISTRY_FILE: registryFile, WORKER_STATE_DIR: stateDir, WORKER_POLL_MS: '50', HOME: stateDir }
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(run.status, 0, run.stderr);
    const ok = await fetch(`${base}/job/${ids.ok}`, { headers: auth }).then((r) => r.json());
    const gem = await fetch(`${base}/job/${ids.gem}`, { headers: auth }).then((r) => r.json());
    assert.equal(ok.job.status, 'COMPLETED');
    assert.equal(ok.job.result.exitCode, 0);
    assert.equal(ok.job.result.evidence.provider, 'claude_code');
    assert.equal(ok.job.checkpointHistory[0].stage, 'CLAIMED');
    assert.equal(gem.job.status, 'BLOCKED');
    assert.match(gem.job.result.reason, /PROVIDER_NOT_ACTIVE/);
    const audit = fs.readFileSync(path.join(stateDir, 'audit.jsonl'), 'utf8');
    assert.match(audit, /"event":"claimed"/);
    assert.match(audit, /"event":"result_posted"/);
    assert.ok(!audit.includes(KEY) && !run.stdout.includes(KEY) && !run.stderr.includes(KEY));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('windowsJobs: provider形式の検証', () => {
  const state = windowsJobs.createWindowsJobState();
  assert.throws(() => windowsJobs.submitWindowsJob(state, { action: 'a', workspace: 'w', provider: 'Bad Name!' }), /provider/);
  const r = windowsJobs.submitWindowsJob(state, { taskId: 'p1', action: 'a', workspace: 'w', provider: 'Gemini' });
  assert.equal(state.jobs.get('p1').provider, 'gemini');
  assert.equal(r.accepted, true);
});
