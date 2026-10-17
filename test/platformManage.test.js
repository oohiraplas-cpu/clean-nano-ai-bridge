'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const pm = require('../src/platformManage');
const { _internal: I } = pm;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
const env = { CN_SNAPSHOT_DIR: tmp, SHAREPOINT_SITE_ID: 'site1', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's', POWERAPPS_ORG_URL: 'https://org.crm.dynamics.com' };

function ctrlEntry() {
  const j = { TopParent: { Name: 'Screen1', Template: { Name: 'screen' }, Rules: [{ Property: 'Fill', InvariantScript: 'RGBA(1,2,3,1)' }], Children: [{ Name: 'Image1', Template: { Name: 'image' }, Rules: [{ Property: 'Image', InvariantScript: 'old' }], Children: [] }] } };
  return { name: 'Controls\\4.json', data: Buffer.from(JSON.stringify(j)) };
}

test('classify maps HTTP errors', () => {
  assert.strictEqual(I.classify(new Error('Graph GET x 429: busy')), 'transient');
  assert.strictEqual(I.classify(new Error('Graph GET x 404: nf')), 'not_found');
  assert.strictEqual(I.classify(new Error('x 403: denied')), 'permission');
  assert.strictEqual(I.classify(new Error('x 400: invalid')), 'invalid_input');
});

test('withRepair retries transient once and stops on repeat', async () => {
  let n = 0;
  const ok = await I.withRepair('t', async () => { if (n++ === 0) throw new Error('x 503: down'); return 7; }, { delayMs: 1 });
  assert.strictEqual(ok.out, 7);
  await assert.rejects(I.withRepair('t', async () => { throw new Error('x 503: down'); }, { delayMs: 1 }), (e) => e.attempts.some((a) => a.stop));
});

test('powerFxCheck', () => {
  assert.deepStrictEqual(I.powerFxCheck('If(a, "x", Blank())'), []);
  assert.ok(I.powerFxCheck('If(a, "x"').length);
  assert.ok(I.powerFxCheck('"abc').length);
});

test('applyRules / readRules', () => {
  const inner = [ctrlEntry()];
  I.applyRules(inner, [{ control: 'Image1', property: 'Image', script: 'logo' }, { control: 'Image1', property: 'Tooltip', script: '"hi"' }]);
  const r = I.readRules(inner, 'Image1')[0];
  assert.strictEqual(r.rules.find((x) => x.property === 'Image').script, 'logo');
  assert.strictEqual(r.rules.find((x) => x.property === 'Tooltip').script, '"hi"');
  assert.throws(() => I.applyRules(inner, [{ control: 'Nope', property: 'Image', script: 'x' }]), /not found/);
});

test('appChecker flags problems', () => {
  const res = { name: 'References\\Resources.json', data: Buffer.from(JSON.stringify({ Resources: [{ Name: 'logo', Content: 'Image', ResourceKind: 'LocalFile', Path: 'Assets\\Images\\a.png' }] })) };
  const c = I.appChecker([ctrlEntry(), res]);
  assert.strictEqual(c.ok, false);
  assert.ok(c.errors.some((e) => e.kind === 'missing_asset'));
  assert.ok(c.warnings.some((w) => w.kind === 'image_not_in_resources'));
});

function fakeGraph() {
  const cols = [{ id: 'c1', name: 'Title', displayName: 'Title', text: {} }, { id: 'c2', name: 'Status0', displayName: 'Status', choice: { choices: ['A'] } }];
  const items = {}; let nid = 1;
  return {
    async get(p) { if (/\/columns/.test(p)) return { value: cols }; const m = p.match(/items\/(\d+)/); if (m) return { id: m[1], fields: items[m[1]] }; if (/\/lists\?/.test(p)) return { value: [{ id: '11111111-1111-1111-1111-111111111111', displayName: 'CN Test' }] }; return { id: 'L', displayName: 'CN Test', columns: cols }; },
    async post(p, b) { if (/items$/.test(p)) { if (b.fields.Status) throw new Error('Graph POST items 400: Field Status is not recognized'); const id = String(nid++); items[id] = { ...b.fields }; return { id }; } return { id: 'L', ...b }; },
    async patch(p, b) { const m = p.match(/items\/(\d+)\/fields/); if (m) Object.assign(items[m[1]], b); if (/columns\/c2/.test(p)) Object.assign(cols[1], b); return {}; },
    async del() { return {}; },
  };
}

test('sharepoint item_create repairs field names and verifies; update verifies', async () => {
  const g = fakeGraph();
  const r = await pm.run('sharepoint_manage', { operation: 'item_create', list: 'CN Test', fields: { Title: 'x', Status: 'A' } }, { env, graph: g });
  assert.strictEqual(r.verified, true, JSON.stringify(r));
  assert.deepStrictEqual(r.data.mappedFields, [{ from: 'Status', to: 'Status0' }]);
  const u = await pm.run('sharepoint_manage', { operation: 'item_update', list: 'CN Test', itemId: r.data.itemId, fields: { Title: 'y' } }, { env, graph: g });
  assert.strictEqual(u.verified, true, JSON.stringify(u));
});

test('choice_update and delete approval', async () => {
  const g = fakeGraph();
  const r = await pm.run('sharepoint_manage', { operation: 'choice_update', list: 'CN Test', column: 'Status', choices: ['B'] }, { env, graph: g });
  assert.deepStrictEqual(r.data.column.choices, ['A', 'B']);
  const d = await pm.run('sharepoint_manage', { operation: 'delete', list: 'CN Test', itemId: '1' }, { env, graph: g });
  assert.strictEqual(d.status, 'approval_required');
  assert.strictEqual(d.approval, 'DELETE item 1');
});

test('flow trigger_edit saves + verifies; delete needs approval', async () => {
  const cd = { properties: { connectionReferences: {}, definition: { triggers: { R: { type: 'Recurrence', recurrence: { frequency: 'Day', interval: 1 } } }, actions: {} } } };
  let stored = JSON.stringify(cd);
  const client = { async get() { return { name: 'f', statecode: 0, clientdata: stored }; }, async patch(p, b) { if (b.clientdata) stored = b.clientdata; }, async post() { return {}; } };
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const r = await pm.run('powerautomate_manage', { operation: 'trigger_edit', flowId: id, set: [{ path: 'R.recurrence.interval', value: 2 }] }, { env, flowClient: client });
  assert.strictEqual(r.verified, true, JSON.stringify(r));
  assert.strictEqual(JSON.parse(stored).properties.definition.triggers.R.recurrence.interval, 2);
  const del = await pm.run('powerautomate_manage', { operation: 'delete', flowId: id }, { env, flowClient: client });
  assert.strictEqual(del.status, 'approval_required');
});

test('errors are audited', async () => {
  const r = await pm.run('powerplatform_validate', { operation: 'nope' }, { env });
  assert.strictEqual(r.status, 'error');
  const a = await pm.run('powerplatform_validate', { operation: 'audit' }, { env });
  assert.ok(a.data.entries.length >= 1);
});

test('exactly four tools', () => {
  assert.deepStrictEqual(pm.TOOL_NAMES, ['sharepoint_manage', 'powerapps_manage', 'powerautomate_manage', 'powerplatform_validate']);
});

test('powerFxCheck ignores apostrophes inside comments', () => {
  const pm = require('../src/platformManage');
  const fx = pm._internal && pm._internal.powerFxCheck;
  if (!fx) return;
  assert.deepStrictEqual(fx("/*hasn't been added*/\nSet(a, 1) // don't"), []);
  assert.ok(fx('Set(a, "x').length > 0);
});

test('premium guard: standard passes, HTTP / Dataverse / unknown blocked', () => {
  assert.deepStrictEqual(I.premiumScan({ triggers: { manual: { type: 'Request', kind: 'Button' } }, actions: { a: { type: 'OpenApiConnection', inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' } } } } }), []);
  assert.ok(I.premiumScan({ actions: { h: { type: 'Http' } } }).length);
  assert.ok(I.premiumScan({ triggers: { t: { type: 'Request', kind: 'Http' } } }).length);
  assert.ok(I.premiumScan('/providers/microsoft.powerapps/apis/shared_commondataserviceforapps').length);
  assert.ok(I.premiumScan('/apis/shared_cr123-5fmycustom').length);
});

test('premium guard stops flow create before any API call', async () => {
  const r = await pm.run('powerautomate_manage', { operation: 'create', name: 'x', definition: { triggers: {}, actions: { h: { type: 'Http', inputs: {} } } } }, { env, flowClient: { get() { throw new Error('must not call'); }, post() { throw new Error('must not call'); } } });
  assert.strictEqual(r.status, 'blocked_premium');
  assert.strictEqual(r.verified, false);
});

test('chat-friendly: operation aliases, JSON-string params, helpful unknown op', async () => {
  const n = I.normalizeParams('sharepoint_manage', { operation: 'Item Get', fields: '{"Title":"a"}', listName: 'L' });
  assert.strictEqual(n.operation, 'search');
  assert.deepStrictEqual(n.fields, { Title: 'a' });
  assert.strictEqual(n.list, 'L');
  assert.strictEqual(I.normalizeParams('powerapps_manage', { operation: 'state' }).operation, 'state_get');
  const r = await pm.run('sharepoint_manage', { operation: 'zzz' }, { env });
  assert.strictEqual(r.status, 'error');
  assert.match(r.error, /valid: .*search/);
});
