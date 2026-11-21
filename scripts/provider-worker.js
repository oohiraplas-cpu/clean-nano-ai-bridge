#!/usr/bin/env node
'use strict';
// Windows Provider Worker. Pulls provider jobs from the Bridge (/executor + /job routes) and runs the local CLI.
//
//   node scripts/provider-worker.js                    # run the worker loop
//   node scripts/provider-worker.js --probe            # version probe of every provider (no model call)
//   node scripts/provider-worker.js --selftest <id> --repo <name> --branch <b> --workdir <dir>
//                                                      # real non-destructive call; ACTIVE on PASS only
//
// Env (read here only; secrets are never printed): BRIDGE_URL, MCP_API_KEY, WORKER_ID,
// PROVIDER_POLICY_FILE, PROVIDER_REGISTRY_FILE, WORKER_STATE_DIR, WORKER_POLL_MS.

const fs = require('node:fs');
const path = require('node:path');
const worker = require('../src/providerWorker');
const { maskSecrets } = require('../src/secretMasking');

const root = path.resolve(__dirname, '..');
const cfg = {
  bridgeUrl: (process.env.BRIDGE_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.MCP_API_KEY || '',
  workerId: process.env.WORKER_ID || `provider-worker-${require('node:os').hostname().toLowerCase().replace(/[^a-z0-9.-]/g, '-')}`.slice(0, 60),
  policyFile: process.env.PROVIDER_POLICY_FILE || path.join(root, 'config', 'provider-policy.json'),
  registryFile: process.env.PROVIDER_REGISTRY_FILE || path.join(root, 'config', 'ai-provider-registry.json'),
  stateDir: process.env.WORKER_STATE_DIR || path.join(root, 'data', 'provider-worker'),
  pollMs: Number(process.env.WORKER_POLL_MS) || 5000
};

function makeAudit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'audit.jsonl');
  return (event, data = {}) => {
    const line = maskSecrets(JSON.stringify({ at: new Date().toISOString(), workerId: cfg.workerId, event, ...data }), [cfg.apiKey]);
    fs.appendFileSync(file, `${line}\n`);
  };
}

function bridge(method, route, body) {
  return fetch(`${cfg.bridgeUrl}${route}`, {
    method,
    headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

async function runLoop({ once = false } = {}) {
  if (!cfg.bridgeUrl || !cfg.apiKey) { console.error('BRIDGE_URL / MCP_API_KEY が未設定です'); process.exit(2); }
  const policy = worker.loadPolicy(cfg.policyFile);
  const audit = makeAudit(cfg.stateDir);
  const guard = worker.createRunGuard(path.join(cfg.stateDir, 'locks'));
  const providers = Object.keys(worker.PROVIDER_SPECS);
  const heartbeat = () => {
    const registry = worker.loadRegistry(cfg.registryFile);
    return bridge('POST', '/executor/heartbeat', { executorId: cfg.workerId, version: 'provider-worker/1', capabilities: worker.wallboardProviders(registry), status: 'IDLE' });
  };
  await bridge('POST', '/executor/register', { executorId: cfg.workerId, version: 'provider-worker/1', capabilities: providers });
  audit('worker_started', { providers });
  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  while (!stop) {
    const registry = worker.loadRegistry(cfg.registryFile); // re-read each cycle: ACTIVE state is dynamic
    await heartbeat().catch(() => {});
    const pulled = await bridge('GET', `/job/pull?executorId=${encodeURIComponent(cfg.workerId)}&providers=${providers.join(',')}`).catch((e) => ({ status: 0, body: { error: e.message } }));
    const job = pulled.body?.job;
    if (job) {
      audit('claimed', { taskId: job.taskId, provider: job.provider });
      await bridge('POST', '/job/checkpoint', { taskId: job.taskId, status: 'CLAIMED', completedSteps: ['claim'], nextStep: 'execute', testStatus: 'PENDING' }).catch(() => {});
      const result = await worker.executeProviderJob(job, { policy, registry, guard, audit, extraSecrets: [cfg.apiKey] });
      const posted = await bridge('POST', '/job/result', { ...result, executorId: cfg.workerId });
      audit('result_posted', { taskId: job.taskId, status: result.status, httpStatus: posted.status });
    } else if (once) break;
    if (!job) await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  if (process.argv.includes('--probe')) {
    const out = [];
    for (const id of Object.keys(worker.PROVIDER_SPECS)) out.push(await worker.probeProvider(id, {}));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (process.argv.includes('--selftest')) {
    const id = arg('--selftest');
    const repo = arg('--repo'); const branch = arg('--branch'); const workdir = arg('--workdir');
    if (!worker.PROVIDER_SPECS[id] || !repo || !branch || !workdir) { console.error('usage: --selftest <provider> --repo <name> --branch <b> --workdir <dir>'); process.exit(2); }
    const policy = worker.loadPolicy(cfg.policyFile);
    policy.repositories = policy.repositories.filter((r) => r.name === repo).map((r) => ({ ...r, workdirs: [...r.workdirs, path.resolve(workdir)] }));
    const audit = makeAudit(cfg.stateDir);
    const guard = worker.createRunGuard(path.join(cfg.stateDir, 'locks'));
    const probe = await worker.probeProvider(id, { policy });
    if (!probe.found) { console.log(JSON.stringify({ provider: id, pass: false, probe })); process.exit(1); }
    const { pass, result } = await worker.selftestProvider(id, { policy, guard, audit }, { repository: repo, branch, workspace: workdir });
    const summary = { provider: id, pass, probe, status: result.status, reason: result.reason, exitCode: result.exitCode, unblock: result.evidence?.unblockCondition || null };
    if (pass) {
      const registry = worker.loadRegistry(cfg.registryFile);
      registry.providers[id] = { status: 'ACTIVE', wallboard: true, cli: registry.providers[id]?.cli, verifiedAt: new Date().toISOString(), cliVersion: probe.version };
      worker.saveRegistry(cfg.registryFile, registry);
    }
    console.log(JSON.stringify(summary, null, 2));
    process.exit(pass ? 0 : 1);
  }
  await runLoop({ once: process.argv.includes('--once') });
}

if (require.main === module) main().catch((e) => { console.error(maskSecrets(e.message, [cfg.apiKey])); process.exit(1); });
module.exports = { runLoop };
