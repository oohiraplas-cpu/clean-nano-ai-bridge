'use strict';
// Lane D: SharePoint WRITE のモック試験。
// 対象は cleannano サイトに固定。実 Graph には接続しない（実接続は BLOCKED）。
// 正常系・異常系・dry-run・Snapshot失敗・監査失敗・保存後再取得・承認・物理削除なし を確認する。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createOperationsMcp } = require('../src/operationsMcp');
const { createMemoryStore } = require('../src/operations/store');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TOKEN = 'token-lane-d-test-AAAA5001';
const LIST = '11111111-2222-3333-4444-555555555555';
const COL = 'aaaaaaaa-2222-3333-4444-555555555555';
const planArgs = { operationType: 'read', targetEnvironmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb', targetObjectId: 'obj-1', action: '書込みの試験' };

// 状態を持つフェイク Graph。silent* で「書いたように見えて実際は書かれない」を再現する。
function fakeGraph(options = {}) {
  const state = {
    columns: [{ id: COL, name: 'Title', displayName: 'Title', hidden: false, readOnly: false, required: false, columnGroup: null }],
    items: [{ id: '7', fields: { Title: 'old' } }],
    permissions: [{ id: 'perm-owner', roles: ['owner'], grantedToIdentitiesV2: [{}] }, { id: 'perm-read', roles: ['read'], grantedToIdentitiesV2: [{}] }],
    siteStatus: options.siteStatus || 200,
    silentWrite: options.silentWrite === true,
    postStatus: options.postStatus || null
  };
  const calls = [];
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetchImpl = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    const path = String(url).replace(GRAPH, '');
    const pathname = path.split('?')[0];
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (method === 'GET' && pathname === '/sites/hisyoengineer.sharepoint.com:/sites/cleannano') {
      return state.siteStatus === 200 ? json(200, { id: 'site-1', displayName: 'cleannano' }) : json(state.siteStatus, {});
    }
    if (method === 'GET' && pathname === '/sites/site-1/permissions') return json(200, { value: state.permissions });
    if (method === 'GET' && pathname === `/sites/site-1/lists/${LIST}/columns`) return json(200, { value: state.columns });
    if (method === 'POST' && pathname === `/sites/site-1/lists/${LIST}/columns`) {
      if (state.postStatus) return json(state.postStatus, {});
      const id = crypto.randomUUID();
      if (!state.silentWrite) state.columns.push({ id, name: opts.body ? JSON.parse(opts.body).name : '', displayName: JSON.parse(opts.body).displayName, hidden: false, readOnly: false, required: false });
      return json(201, { id, name: JSON.parse(opts.body).name });
    }
    if (method === 'PATCH' && pathname === `/sites/site-1/lists/${LIST}/columns/${COL}`) {
      const patch = JSON.parse(opts.body);
      if (!state.silentWrite) Object.assign(state.columns.find((c) => c.id === COL), patch);
      return json(200, {});
    }
    if (method === 'GET' && pathname === `/sites/site-1/lists/${LIST}/items/7`) return json(200, { id: '7', fields: state.items[0].fields });
    if (method === 'PATCH' && pathname === `/sites/site-1/lists/${LIST}/items/7/fields`) {
      if (!state.silentWrite) Object.assign(state.items[0].fields, JSON.parse(opts.body));
      return json(200, {});
    }
    if (method === 'GET' && pathname === `/sites/site-1/lists/${LIST}/items/999`) return json(404, {});
    if (method === 'GET' && pathname.startsWith(`/sites/site-1/lists/${LIST}/items/`) && pathname.endsWith('/fields') === false) {
      const id = pathname.split('/').pop();
      const item = state.items.find((i) => i.id === id);
      return item ? json(200, { id, fields: item.fields }) : json(404, {});
    }
    if (method === 'POST' && pathname === `/sites/site-1/lists/${LIST}/items`) {
      const fields = JSON.parse(opts.body).fields;
      if (!state.silentWrite) state.items.push({ id: '8', fields });
      return json(201, { id: '8' });
    }
    if (method === 'POST' && pathname === '/sites/site-1/permissions') {
      const body = JSON.parse(opts.body);
      const perm = { id: 'perm-new', roles: body.roles, grantedToIdentitiesV2: body.recipients };
      if (!state.silentWrite) state.permissions.push(perm);
      return json(201, { value: [perm] });
    }
    if (method === 'DELETE' && pathname.startsWith('/sites/site-1/permissions/')) {
      const id = pathname.split('/').pop();
      if (!state.silentWrite) state.permissions = state.permissions.filter((p) => p.id !== id);
      return json(204, {});
    }
    // 上記以外は 404（想定外の経路は通さない）
    return json(404, {});
  };
  return { fetchImpl, state, calls };
}

function mcpFor(graph, { approvals = true, withSharePoint = true } = {}) {
  const adapters = {};
  if (approvals) adapters.approval = { configured: true, verify: async (token) => ({ approved: token === 'good-approval-token' }) };
  return createOperationsMcp(
    {},
    {
      store: createMemoryStore(),
      adapters,
      fetchImpl: graph.fetchImpl,
      sharePointTokenProvider: withSharePoint ? (async () => TOKEN) : undefined
    }
  );
}

async function plan(mcp) {
  const res = await mcp.callTool('operation_plan', planArgs);
  assert.equal(res.status, 'PASS');
  return res.operationId;
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET');
const events = async (mcp, name) => (await mcp.store.list('audit')).filter((r) => r.tool === name && r.event && r.event !== 'tool_started' && r.event !== 'tool_completed');

// ---------- 列 ----------

test('sp_column_create writes once, reads back, verifies and records the change', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', displayName: 'メモ', type: 'text' } });
  assert.equal(res.status, 'PASS');
  assert.equal(res.executed, true);
  assert.equal(res.verification, 'PASS');
  assert.equal(res.rollbackAvailable, true);
  assert.match(res.beforeHash, /^[0-9a-f]{64}$/);
  assert.match(res.afterHash, /^[0-9a-f]{64}$/);
  assert.notEqual(res.beforeHash, res.afterHash);
  const post = writes(graph.calls).find((c) => c.method === 'POST');
  assert.equal(post.body.name, 'Memo');
  assert.deepEqual(post.body.text, {});
  const names = (await events(mcp, 'sp_column_create')).map((r) => r.event);
  assert.deepEqual(names, ['write_started', 'write_completed']);
  assert.equal((await mcp.store.list('snapshots')).length, 1);
});

test('dry-run never writes, never snapshots and never starts an audit write', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, dryRun: true, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.status, 'PASS');
  assert.equal(res.dryRun, true);
  assert.equal(res.executed, false);
  assert.equal(res.snapshotStored, false);
  assert.equal(writes(graph.calls).length, 0);
  assert.equal((await mcp.store.list('snapshots')).length, 0);
  assert.equal((await events(mcp, 'sp_column_create')).length, 0);
});

test('a duplicate column name is refused before any write', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Title', type: 'text' } });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.reasonCode, 'CONFLICT');
  assert.equal(writes(graph.calls).length, 0);
});

test('when the snapshot cannot be stored, the write is not performed', async () => {
  const graph = fakeGraph();
  const mcp = createOperationsMcp({}, {
    store: { ...createMemoryStore(), append: async (c, r) => { if (c === 'snapshots') throw new Error('down'); return createMemoryStore().append(c, r); } },
    adapters: { approval: { configured: true, verify: async () => ({ approved: false }) } },
    fetchImpl: graph.fetchImpl,
    sharePointTokenProvider: async () => TOKEN
  });
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.reasonCode, 'SNAPSHOT_STORE_FAILED');
  assert.equal(writes(graph.calls).length, 0);
});

test('when the write-started audit cannot be saved, the write is not performed', async () => {
  const graph = fakeGraph();
  const base = createMemoryStore();
  const store = { ...base, append: async (c, r) => { if (c === 'audit' && r.event === 'write_started') throw new Error('audit down'); return base.append(c, r); } };
  const mcp = createOperationsMcp({}, { store, adapters: {}, fetchImpl: graph.fetchImpl, sharePointTokenProvider: async () => TOKEN });
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(res.executed, false);
  assert.equal(writes(graph.calls).length, 0);
});

test('when the write is accepted but the re-read does not show it, verification fails and rollback stays available', async () => {
  const graph = fakeGraph({ silentWrite: true });
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.reasonCode, 'VERIFY_FAILED');
  assert.equal(res.verification, 'FAIL');
  assert.equal(res.rollbackAvailable, true);
  assert.equal(res.executed, true);
  const completed = (await events(mcp, 'sp_column_create')).find((r) => r.event === 'write_completed');
  assert.equal(completed.verification, 'FAIL');
});

test('when the completion audit fails after the write, the result is FAIL and says the write happened', async () => {
  const graph = fakeGraph();
  const base = createMemoryStore();
  const store = { ...base, append: async (c, r) => { if (c === 'audit' && r.event === 'write_completed') throw new Error('audit down'); return base.append(c, r); } };
  const mcp = createOperationsMcp({}, { store, adapters: {}, fetchImpl: graph.fetchImpl, sharePointTokenProvider: async () => TOKEN });
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.reasonCode, 'AUDIT_WRITE_FAILED');
  assert.equal(res.executed, true);
  assert.equal(writes(graph.calls).length, 1);
});

test('a Graph rejection on write is reported as a failure with no execution claimed', async () => {
  const graph = fakeGraph({ postStatus: 500 });
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_create', { operationId, listId: LIST, column: { name: 'Memo', type: 'text' } });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.reasonCode, 'UPSTREAM_ERROR');
  assert.equal(res.executed, false);
  assert.equal(res.writeAttempted, true);
  assert.equal((await events(mcp, 'sp_column_create')).some((r) => r.event === 'write_failed'), true);
});

test('sp_column_update changes only the given properties and verifies them', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_update', { operationId, listId: LIST, columnId: COL, patch: { displayName: '件名' } });
  assert.equal(res.status, 'PASS');
  assert.equal(graph.state.columns[0].displayName, '件名');
  assert.deepEqual(writes(graph.calls).find((c) => c.method === 'PATCH').body, { displayName: '件名' });
});

test('sp_column_update refuses an unknown column without writing', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_column_update', { operationId, listId: LIST, columnId: 'bbbbbbbb-2222-3333-4444-555555555555', patch: { hidden: true } });
  assert.equal(res.reasonCode, 'TARGET_NOT_FOUND');
  assert.equal(writes(graph.calls).length, 0);
});

// ---------- 項目 ----------

test('sp_item_create creates a row and verifies the stored values', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_create', { operationId, listId: LIST, fields: { Title: 'new-row', Count: 3 } });
  assert.equal(res.status, 'PASS');
  assert.equal(res.writeResult.itemId, '8');
  assert.equal(res.verification, 'PASS');
});

test('sp_item_update changes only the given fields and returns the before and after hashes', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_update', { operationId, listId: LIST, itemId: '7', fields: { Title: 'changed' } });
  assert.equal(res.status, 'PASS');
  assert.equal(graph.state.items[0].fields.Title, 'changed');
  assert.notEqual(res.beforeHash, res.afterHash);
});

test('sp_item_update on a missing item is refused without writing', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_update', { operationId, listId: LIST, itemId: '999', fields: { Title: 'x' } });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.reasonCode, 'TARGET_NOT_FOUND');
  assert.equal(writes(graph.calls).length, 0);
});

test('sp_attachment_add is BLOCKED because the attachment write path is unverified, and calls nothing', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_attachment_add', { operationId, listId: LIST, itemId: '7', fileName: 'a.txt', contentBase64: Buffer.from('hi').toString('base64') });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.reasonCode, 'ATTACHMENT_API_UNVERIFIED');
  assert.equal(graph.calls.length, 0);
});

test('sp_attachment_add refuses content over 1MB before anything else', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const big = Buffer.alloc(1024 * 1024 + 1, 1).toString('base64');
  const res = await mcp.callTool('sp_attachment_add', { operationId, listId: LIST, itemId: '7', fileName: 'big.bin', contentBase64: big });
  assert.equal(res.reasonCode, 'VALIDATION_FAILED');
  assert.equal(graph.calls.length, 0);
});

// ---------- 権限 ----------

test('sp_permissions_plan validates addresses and never writes', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const bad = await mcp.callTool('sp_permissions_plan', { roles: ['read'], recipientEmails: ['not-an-email'] });
  assert.equal(bad.reasonCode, 'VALIDATION_FAILED');
  const ok = await mcp.callTool('sp_permissions_plan', { roles: ['read'], recipientEmails: ['a@example.com'] });
  assert.equal(ok.status, 'PASS');
  assert.equal(ok.executed, false);
  assert.equal(writes(graph.calls).length, 0);
  assert.ok(operationId);
});

test('sp_permissions_grant is BLOCKED without an approval token and calls nothing', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_permissions_grant', { operationId, roles: ['read'], recipientEmails: ['a@example.com'] });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.reasonCode, 'APPROVAL_REQUIRED');
  assert.equal(writes(graph.calls).length, 0);
});

test('sp_permissions_grant refuses an invalid approval token', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_permissions_grant', { operationId, approvalToken: 'wrong', roles: ['read'], recipientEmails: ['a@example.com'] });
  assert.equal(res.reasonCode, 'APPROVAL_INVALID');
  assert.equal(writes(graph.calls).length, 0);
});

test('sp_permissions_grant with a valid approval writes once and verifies the new grant', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_permissions_grant', { operationId, approvalToken: 'good-approval-token', roles: ['read'], recipientEmails: ['a@example.com'] });
  assert.equal(res.status, 'PASS');
  assert.deepEqual(res.writeResult.permissionIds, ['perm-new']);
  assert.equal(writes(graph.calls).length, 1);
});

test('sp_permissions_grant without an approval adapter is BLOCKED, not PASS', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph, { approvals: false });
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_permissions_grant', { operationId, approvalToken: 'good-approval-token', roles: ['read'], recipientEmails: ['a@example.com'] });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(writes(graph.calls).length, 0);
});

test('sp_permissions_revoke removes only the access grant, never data, and verifies the removal', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_permissions_revoke', { operationId, approvalToken: 'good-approval-token', permissionId: 'perm-read' });
  assert.equal(res.status, 'PASS');
  assert.equal(graph.state.permissions.some((p) => p.id === 'perm-read'), false);
  assert.equal(graph.state.items.length, 1, 'no list data is removed');
  assert.equal(graph.state.columns.length, 1, 'no column is removed');
});

test('sp_permissions_revoke refuses an owner grant and an unknown grant', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const owner = await mcp.callTool('sp_permissions_revoke', { operationId, approvalToken: 'good-approval-token', permissionId: 'perm-owner' });
  assert.equal(owner.reasonCode, 'OWNER_REVOKE_BLOCKED');
  const unknown = await mcp.callTool('sp_permissions_revoke', { operationId, approvalToken: 'good-approval-token', permissionId: 'nope' });
  assert.equal(unknown.reasonCode, 'TARGET_NOT_FOUND');
  assert.equal(writes(graph.calls).length, 0);
});

// ---------- 前提条件・未構成 ----------

test('when the site diagnosis does not pass, no write is attempted', async () => {
  const graph = fakeGraph({ siteStatus: 403 });
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_create', { operationId, listId: LIST, fields: { Title: 'x' } });
  assert.equal(res.status, 'FAIL');
  assert.equal(res.reasonCode, 'PRECONDITION_FAILED');
  assert.equal(writes(graph.calls).length, 0);
});

test('without any token source, every SharePoint WRITE is BLOCKED and nothing is called', async () => {
  const graph = fakeGraph();
  const mcp = createOperationsMcp({}, { store: createMemoryStore(), fetchImpl: graph.fetchImpl });
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_create', { operationId, listId: LIST, fields: { Title: 'x' } });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(graph.calls.length, 0);
});

test('an unknown operation plan is refused before anything else', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const res = await mcp.callTool('sp_item_create', { operationId: '00000000-0000-4000-8000-000000000000', listId: LIST, fields: { Title: 'x' } });
  assert.equal(res.reasonCode, 'TARGET_NOT_FOUND');
  assert.equal(graph.calls.length, 0);
});

test('the input contract rejects fields outside the allowed shape before reaching the handler', async () => {
  const graph = fakeGraph();
  const mcp = mcpFor(graph);
  const operationId = await plan(mcp);
  const res = await mcp.callTool('sp_item_create', { operationId, listId: LIST, fields: { Title: { nested: true } } });
  assert.equal(res.status, 'FAIL');
  assert.equal(graph.calls.length, 0);
});

test('every WRITE tool declares dry-run, rollback, audit and the required permission metadata', async () => {
  const mcp = mcpFor(fakeGraph());
  const names = ['sp_column_create', 'sp_column_update', 'sp_item_create', 'sp_item_update', 'sp_attachment_add', 'sp_permissions_grant', 'sp_permissions_revoke'];
  const { CATALOG } = require('../src/operationsMcp');
  for (const name of names) {
    const entry = CATALOG.find((e) => e.name === name);
    assert.equal(entry.meta.category, 'WRITE', name);
    assert.equal(entry.meta.supportsDryRun, true, name);
    assert.equal(entry.meta.supportsRollback, true, name);
    assert.equal(entry.meta.auditRequired, true, name);
    assert.equal(entry.meta.additionalCost, false, name);
    assert.ok(entry.meta.requiredPermissions.length > 0, name);
  }
  assert.equal(CATALOG.find((e) => e.name === 'sp_permissions_grant').meta.requiresApproval, true);
  assert.equal(CATALOG.find((e) => e.name === 'sp_permissions_revoke').meta.requiresApproval, true);
  assert.ok(mcp);
});

test('no tool in the operations catalogue deletes list items, lists, columns or sites', () => {
  const { CATALOG } = require('../src/operationsMcp');
  assert.equal(CATALOG.some((e) => /delete|remove|purge/i.test(e.name)), false);
});
