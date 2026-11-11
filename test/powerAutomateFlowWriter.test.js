'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../src/powerAutomateFlowWriter');

const F1 = '11111111-1111-1111-1111-111111111111';
const F2 = '22222222-2222-2222-2222-222222222222';
const SOL = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const cd = (subject) => JSON.stringify({
  properties: {
    connectionReferences: { shared_office365: { connectionName: 'x' } },
    definition: { triggers: { manual: { type: 'Request' } }, actions: { Send_mail: { type: 'OpenApiConnection', inputs: { subject } } } },
  },
  schemaVersion: '1.0.0.0',
});

function fakeClient() {
  const wf = {
    [F1]: { workflowid: F1, name: "Daily O'Report", statecode: 0, statuscode: 1, modifiedon: '2026-01-01', category: 5, clientdata: cd('Hello world') },
    [F2]: { workflowid: F2, name: 'Approval', statecode: 1, statuscode: 2, modifiedon: '2026-01-02', category: 5, clientdata: cd('Approve') },
  };
  const calls = { get: [], patch: [] };
  return {
    wf, calls,
    async get(p) {
      calls.get.push(p);
      if (p.startsWith('solutions?')) return { value: p.includes("'MySol'") ? [{ solutionid: SOL }] : [] };
      if (p.startsWith('solutioncomponents?')) return { value: p.includes(SOL) ? [{ objectid: F2 }] : [] };
      const one = p.match(/^workflows\(([^)]+)\)/);
      if (one) { if (!wf[one[1]]) throw new Error('404'); return { ...wf[one[1]] }; }
      if (p.startsWith('workflows?')) {
        let rows = Object.values(wf);
        const m = p.match(/contains\(name,'((?:[^']|'')*)'\)/);
        if (m) rows = rows.filter((r) => r.name.includes(m[1].replace(/''/g, "'")));
        const t = p.match(/\$top=(\d+)/);
        if (t) rows = rows.slice(0, +t[1]);
        return { value: rows };
      }
      throw new Error(`unexpected GET ${p}`);
    },
    async patch(p, body) { calls.patch.push({ p, body }); const id = p.match(/^workflows\(([^)]+)\)$/)[1]; Object.assign(wf[id], body); },
    async post() { throw new Error('unexpected POST'); },
  };
}

const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-flows-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const deps = (client) => ({ client, snapshotDir: tmp });

test('listFlows with nameContains escapes quotes', async () => {
  const c = fakeClient();
  const r = await W.listFlows({ nameContains: "O'Rep" }, deps(c));
  assert.ok(c.calls.get[0].includes("contains(name,'O''Rep')"));
  assert.ok(c.calls.get[0].includes('category eq 5'));
  assert.deepStrictEqual(r.flows, [{ id: F1, name: "Daily O'Report", state: 'off', modifiedOn: '2026-01-01' }]);
});

test('listFlows filtered by solution', async () => {
  const c = fakeClient();
  const r = await W.listFlows({ solutionName: 'MySol' }, deps(c));
  assert.deepStrictEqual(r.flows.map((f) => [f.id, f.state]), [[F2, 'on']]);
  await assert.rejects(W.listFlows({ solutionName: 'Nope' }, deps(c)), /not found/);
});

test('readFlow summary and search', async () => {
  const c = fakeClient();
  const full = await W.readFlow({ flowId: F1 }, deps(c));
  assert.deepStrictEqual([full.triggers, full.actions, full.connectionReferences], [['manual'], ['Send_mail'], ['shared_office365']]);
  assert.ok(full.definition.actions.Send_mail);
  const s = await W.readFlow({ flowId: F1, search: 'Hello' }, deps(c));
  assert.strictEqual(s.definition, undefined);
  assert.strictEqual(s.matches.length, 1);
  assert.match(s.matches[0].text, /Hello world/);
  await assert.rejects(W.readFlow({ flowId: 'bad' }, deps(c)), /GUID/);
});

test('updateFlow success + verify + snapshot', async () => {
  const c = fakeClient();
  const r = await W.updateFlow({ flowId: F1, edits: [{ find: 'Hello world', replace: 'Hi there', expectCount: 1 }] }, deps(c));
  assert.strictEqual(r.status, 'saved_verified');
  assert.deepStrictEqual(r.edits, [{ index: 0, matches: 1 }]);
  assert.strictEqual(c.calls.patch.length, 1);
  assert.ok(c.wf[F1].clientdata.includes('Hi there'));
  assert.ok(fs.existsSync(path.join(tmp, 'flows', `${r.snapshotId}.json`)));
  assert.match(r.snapshotId, new RegExp(`^flow_${F1}_\\w+_[0-9a-f]{12}$`));
  assert.ok((await W.listFlowSnapshots({}, deps(c))).snapshots.includes(r.snapshotId));
});

test('updateFlow find not found / expectCount mismatch -> no PATCH', async () => {
  const c = fakeClient();
  await assert.rejects(W.updateFlow({ flowId: F1, edits: [{ find: 'zzz', replace: 'y' }] }, deps(c)), /not found/);
  await assert.rejects(W.updateFlow({ flowId: F1, edits: [{ find: 'Hello', replace: 'y', expectCount: 2 }] }, deps(c)), /expected 2/);
  assert.strictEqual(c.calls.patch.length, 0);
});

test('updateFlow producing invalid JSON is refused', async () => {
  const c = fakeClient();
  await assert.rejects(W.updateFlow({ flowId: F1, edits: [{ find: '"Hello world"', replace: '"Hello' }] }, deps(c)), /invalid/);
  await assert.rejects(W.updateFlow({ flowId: F1, edits: [{ find: '"actions"', replace: '"acts"' }] }, deps(c)), /invalid/);
  assert.strictEqual(c.calls.patch.length, 0);
});

test('updateFlow dryRun makes no PATCH', async () => {
  const c = fakeClient();
  const r = await W.updateFlow({ flowId: F1, edits: [{ find: 'Hello', replace: 'Bye' }], dryRun: true }, deps(c));
  assert.strictEqual(r.status, 'dry_run');
  assert.strictEqual(c.calls.patch.length, 0);
});

test('setFlowState on/off', async () => {
  const c = fakeClient();
  assert.deepStrictEqual(await W.setFlowState({ flowId: F1, state: 'on' }, deps(c)), { status: 'verified', state: 'on' });
  assert.deepStrictEqual(c.calls.patch[0].body, { statecode: 1, statuscode: 2 });
  assert.deepStrictEqual(await W.setFlowState({ flowId: F1, state: 'off' }, deps(c)), { status: 'verified', state: 'off' });
  assert.deepStrictEqual(c.calls.patch[1].body, { statecode: 0, statuscode: 1 });
  await assert.rejects(W.setFlowState({ flowId: F1, state: 'maybe' }, deps(c)), /state/);
});

test('rollbackFlow restores clientdata', async () => {
  const c = fakeClient();
  const orig = c.wf[F2].clientdata;
  const r = await W.updateFlow({ flowId: F2, edits: [{ find: 'Approve', replace: 'Reject' }] }, deps(c));
  assert.notStrictEqual(c.wf[F2].clientdata, orig);
  const rb = await W.rollbackFlow({ snapshotId: r.snapshotId }, deps(c));
  assert.deepStrictEqual([rb.status, rb.verified], ['rolled_back', true]);
  assert.strictEqual(c.wf[F2].clientdata, orig);
  await assert.rejects(W.rollbackFlow({ snapshotId: '../x' }, deps(c)), /valid snapshotId/);
});
