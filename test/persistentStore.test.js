'use strict';
// 永続ストア自動選択（PERSISTENT_STORE）: 優先順位・フォールバック記録・契約・秘密値の非出力。実環境には接続しない。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { selectPersistentStore, createPersistentStore, PRIORITY } = require('../src/persistence/storeSelect');

const reachable = async () => ({ reachable: true });
const unreachable = (reasonCode = 'UNREACHABLE') => async () => ({ reachable: false, reasonCode });

test('the priority order is fixed: Azure Storage, then SharePoint audit list, then file', () => {
  assert.deepEqual([...PRIORITY], ['azure-storage', 'sharepoint-audit-list', 'file']);
});

test('Azure Storage is chosen first when it is configured and reachable, even if SharePoint is also reachable', async () => {
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true }, sharePointAudit: { configured: true }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': reachable, 'sharepoint-audit-list': reachable }
  });
  assert.equal(sel.selected, 'azure-storage');
  assert.equal(sel.liveStatus, 'VERIFIED');
  assert.equal(sel.fallbackUsed, false);
});

test('SharePoint is chosen when Azure Storage is unreachable, and the Azure failure is recorded', async () => {
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true }, sharePointAudit: { configured: true }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': unreachable('AZURE_OIDC_MISSING'), 'sharepoint-audit-list': reachable }
  });
  assert.equal(sel.selected, 'sharepoint-audit-list');
  const azure = sel.investigation.find((i) => i.backend === 'azure-storage');
  assert.equal(azure.probe, 'UNREACHABLE');
  assert.equal(azure.reasonCode, 'AZURE_OIDC_MISSING');
  assert.equal(sel.fallbackUsed, false);
});

test('when every remote is unreachable the file store is used, flagged as fallback with the live step BLOCKED', async () => {
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true }, sharePointAudit: { configured: true }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': unreachable(), 'sharepoint-audit-list': unreachable() }
  });
  assert.equal(sel.selected, 'file');
  assert.equal(sel.fallbackUsed, true);
  assert.equal(sel.liveStatus, 'BLOCKED');
});

test('an unconfigured remote is skipped without a probe and does not count as a failure', async () => {
  let probed = false;
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: false }, sharePointAudit: { configured: false }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': async () => { probed = true; return { reachable: true }; } }
  });
  assert.equal(probed, false);
  assert.equal(sel.selected, 'file');
  assert.equal(sel.fallbackUsed, false);
  assert.equal(sel.liveStatus, 'NOT_VERIFIED');
});

test('with nothing configured no store is selected, and the refusal is a reason code rather than a silent memory store', async () => {
  const sel = await selectPersistentStore({ settings: {}, probes: {} });
  assert.equal(sel.selected, null);
  assert.equal(sel.reasonCode, 'NO_STORE_AVAILABLE');
  assert.throws(() => createPersistentStore({ selection: sel }), /no persistent store selected/);
});

test('a probe that throws is recorded as PROBE_ERROR and its message never reaches the output', async () => {
  const secret = 'AccountKey=dummy-value-998877';
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': async () => { throw new Error(secret); } }
  });
  assert.equal(sel.selected, 'file');
  assert.equal(sel.investigation.find((i) => i.backend === 'azure-storage').reasonCode, 'PROBE_ERROR');
  assert.doesNotMatch(JSON.stringify(sel), /dummy-value-998877|AccountKey/);
});

test('the investigation output never echoes configured names, endpoints or account identifiers', async () => {
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true, accountName: 'acct-visible-name' }, sharePointAudit: { configured: true, siteUrl: 'https://tenant.example.invalid/sites/x' }, fileStorePath: '/tmp/x.json' },
    probes: { 'azure-storage': unreachable(), 'sharepoint-audit-list': unreachable() }
  });
  const text = JSON.stringify(sel);
  assert.doesNotMatch(text, /acct-visible-name|tenant\.example|sites\/x/);
});

test('a missing probe is recorded as NOT_PROBED and the selection moves on', async () => {
  const sel = await selectPersistentStore({
    settings: { azureStorage: { configured: true }, fileStorePath: '/tmp/x.json' },
    probes: {}
  });
  assert.equal(sel.selected, 'file');
  assert.equal(sel.investigation.find((i) => i.backend === 'azure-storage').probe, 'NOT_PROBED');
});

test('the file backend round-trips append, get and list through the shared store contract', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pst-'));
  const file = path.join(dir, 'store.json');
  const sel = await selectPersistentStore({ settings: { fileStorePath: file } });
  const store = createPersistentStore({ selection: sel, fileStorePath: file });
  assert.equal(store.kind, 'file');
  await store.append('audit', { auditRecordId: 'a-1', action: 'probe' });
  const got = await store.get('audit', 'a-1');
  assert.equal(got.action, 'probe');
  const listed = await store.list('audit');
  assert.equal(listed.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a remote backend must satisfy the store contract before it is used', async () => {
  const sel = { selected: 'azure-storage', investigation: [] };
  assert.throws(() => createPersistentStore({ selection: sel, backends: { 'azure-storage': { append() {} } } }), /store contract/);
  const memory = new Map();
  const ok = {
    append: async (c, r) => { memory.set(`${c}:${r.id}`, r); },
    get: async (c, k) => memory.get(`${c}:${k}`) || null,
    list: async (c) => [...memory.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v)
  };
  const store = createPersistentStore({ selection: sel, backends: { 'azure-storage': ok } });
  assert.equal(store.kind, 'azure-storage');
  await store.append('audit', { id: 'z' });
  assert.equal((await store.get('audit', 'z')).id, 'z');
});
