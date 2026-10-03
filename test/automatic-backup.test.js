'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../scripts/automatic-backup');
const artifact = { id: 10, name: 'CN_AIIraiDaicho-unmanaged-backup', expired: false, size_in_bytes: 10, digest: 'sha256:' + 'a'.repeat(64), expires_at: '2030-01-01T00:00:00Z' };
function mock(runs, artifacts = [artifact]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.endsWith('/dispatches')) return { ok: true, status: 204 };
    if (url.includes('/runs?')) return { ok: true, status: 200, json: async () => ({ workflow_runs: runs }) };
    return { ok: true, status: 200, json: async () => ({ artifacts }) };
  };
  return { calls, fetchImpl };
}
test('dispatches existing export and verifies its new artifact metadata', async () => {
  const m = mock([{ id: 8, head_branch: 'main', created_at: '2026-09-27T00:00:01Z', status: 'completed', conclusion: 'success' }]);
  const result = await run('fake', { fetchImpl: m.fetchImpl, now: () => Date.parse('2026-09-27T00:00:00Z'), sleepImpl: async () => {} });
  assert.equal(result.status, 'pass');
  assert.equal(m.calls[0].method, 'POST');
  assert.match(m.calls[0].url, /cn-aiiraidaicho-backup-manual.yml\/dispatches$/);
  assert.equal(m.calls.slice(1).every(x => x.method === 'GET'), true);
});
test('fails closed on ambiguous concurrent runs', async () => {
  const x = { id: 8, head_branch: 'main', created_at: '2026-09-27T00:00:01Z', status: 'completed', conclusion: 'success' };
  const m = mock([x, {...x, id: 9}]);
  await assert.rejects(run('fake', { fetchImpl: m.fetchImpl, now: () => Date.parse('2026-09-27T00:00:00Z') }), /Ambiguous/);
});
test('fails when artifact absent', async () => {
  const m = mock([{ id: 8, head_branch: 'main', created_at: '2026-09-27T00:00:01Z', status: 'completed', conclusion: 'success' }], []);
  await assert.rejects(run('fake', { fetchImpl: m.fetchImpl, now: () => Date.parse('2026-09-27T00:00:00Z') }), /metadata/);
});
