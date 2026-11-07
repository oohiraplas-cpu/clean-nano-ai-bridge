'use strict';
// Power Automate 書込みの承認ゲート（POWER_AUTOMATE_WRITE）: モッククライアントで検証する。実環境には接続しない。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runPowerAutomateWrite, OPERATIONS } = require('../src/operations/powerAutomateWrite');

const FLOW_ID = '11111111-2222-3333-4444-555555555555';
// 既存の書込み処理は triggers と actions の存在を検証するため、フィクスチャにも両方を入れる。
const ORIGINAL = JSON.stringify({ properties: { definition: { triggers: { t: { type: 'Request' } }, actions: { step: { note: 'old-value' } } } } });

function mockClient() {
  const state = { clientdata: ORIGINAL, statecode: 1, statuscode: 2, name: 'Employee intake' };
  const log = { gets: 0, patches: [] };
  return {
    state,
    log,
    get: async () => { log.gets += 1; return { ...state, workflowid: FLOW_ID }; },
    patch: async (_path, body) => {
      log.patches.push(body);
      if (body.clientdata !== undefined) state.clientdata = body.clientdata;
      if (body.statecode !== undefined) { state.statecode = body.statecode; state.statuscode = body.statuscode; }
    }
  };
}

function tmpSnapshotDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pawrite-'));
}

test('the operation list is limited to update, state change and restore', () => {
  assert.deepEqual([...OPERATIONS].sort(), ['flow_restore', 'flow_set_state', 'flow_update']);
});

test('a real update without human approval is refused and nothing is written', async () => {
  const client = mockClient();
  const dir = tmpSnapshotDir();
  const out = await runPowerAutomateWrite({ operation: 'flow_update', args: { flowId: FLOW_ID, edits: [{ find: 'old-value', replace: 'new-value' }] } }, { client, snapshotDir: dir });
  assert.equal(out.status, 'APPROVAL_REQUIRED');
  assert.equal(out.executed, false);
  assert.equal(client.log.patches.length, 0);
  assert.equal(client.state.clientdata, ORIGINAL);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a dry run needs no approval and writes nothing to the flow', async () => {
  const client = mockClient();
  const dir = tmpSnapshotDir();
  const out = await runPowerAutomateWrite({ operation: 'flow_update', args: { flowId: FLOW_ID, edits: [{ find: 'old-value', replace: 'new-value' }], dryRun: true } }, { client, snapshotDir: dir });
  assert.equal(out.status, 'dry_run');
  assert.equal(out.executed, false);
  assert.equal(out.rollback, null);
  assert.equal(client.log.patches.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an approved update saves, verifies, and returns a rollback that restores the original content', async () => {
  const client = mockClient();
  const dir = tmpSnapshotDir();
  const deps = { client, snapshotDir: dir };
  const out = await runPowerAutomateWrite({ operation: 'flow_update', approvedByHuman: true, args: { flowId: FLOW_ID, edits: [{ find: 'old-value', replace: 'new-value' }] } }, deps);
  assert.equal(out.status, 'saved_verified');
  assert.equal(out.verified, true);
  assert.match(client.state.clientdata, /new-value/);
  assert.equal(out.rollback.method, 'flow_restore');

  const restored = await runPowerAutomateWrite({ operation: 'flow_restore', approvedByHuman: true, args: out.rollback.args }, deps);
  assert.equal(restored.verified, true);
  assert.equal(client.state.clientdata, ORIGINAL);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a state change without approval is refused, and an approved one returns the previous state for rollback', async () => {
  const client = mockClient();
  const dir = tmpSnapshotDir();
  const deps = { client, snapshotDir: dir };
  const refused = await runPowerAutomateWrite({ operation: 'flow_set_state', args: { flowId: FLOW_ID, state: 'off' } }, deps);
  assert.equal(refused.status, 'APPROVAL_REQUIRED');
  assert.equal(client.log.patches.length, 0);
  assert.equal(client.state.statecode, 1);

  const done = await runPowerAutomateWrite({ operation: 'flow_set_state', approvedByHuman: true, args: { flowId: FLOW_ID, state: 'off' } }, deps);
  assert.equal(done.verified, true);
  assert.equal(done.before, 'on');
  assert.equal(done.after, 'off');
  assert.deepEqual(done.rollback, { method: 'flow_set_state', args: { flowId: FLOW_ID, state: 'on' } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an edit whose find text is absent is refused before any write', async () => {
  const client = mockClient();
  const dir = tmpSnapshotDir();
  await assert.rejects(() => runPowerAutomateWrite({ operation: 'flow_update', approvedByHuman: true, args: { flowId: FLOW_ID, edits: [{ find: 'not-present', replace: 'x' }] } }, { client, snapshotDir: dir }), /find text not found/);
  assert.equal(client.log.patches.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('without an injected client or an explicit snapshot directory the write is refused, so no default connection is used', async () => {
  await assert.rejects(() => runPowerAutomateWrite({ operation: 'flow_set_state', approvedByHuman: true, args: { flowId: FLOW_ID, state: 'off' } }, { snapshotDir: '/tmp/x' }), (e) => e.code === 'CLIENT_NOT_INJECTED');
  await assert.rejects(() => runPowerAutomateWrite({ operation: 'flow_set_state', approvedByHuman: true, args: { flowId: FLOW_ID, state: 'off' } }, { client: mockClient() }), (e) => e.code === 'SNAPSHOT_DIR_REQUIRED');
});

test('an unknown operation is refused', async () => {
  await assert.rejects(() => runPowerAutomateWrite({ operation: 'flow_delete', approvedByHuman: true, args: {} }, { client: mockClient(), snapshotDir: '/tmp/x' }), (e) => e.code === 'UNSUPPORTED_OPERATION');
});
