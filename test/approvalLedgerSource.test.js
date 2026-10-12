const test = require('node:test');
const assert = require('node:assert/strict');
const { SharePointReader } = require('../src/sharePointReader');
const { ApprovalLedger, isApprovalLedgerConfigured } = require('../src/approvalLedger');
const { createApprovalLedgerFetchRows } = require('../src/approvalLedgerSource');
const { getConfig } = require('../src/config');
const { createApp } = require('../src/server');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const NOW = new Date('2026-10-11T12:00:00Z');
const FIELD_MAP = Object.freeze({
  requestId: 'col_request', stepIndex: 'col_step', tool: 'col_tool', status: 'col_status',
  approver: 'col_approver', approvedAt: 'col_approved_at', revoked: 'col_revoked'
});
const LEDGER_CONFIG = Object.freeze({ siteId: 'site-1', listId: 'list-1', listName: '', fieldMap: FIELD_MAP });
const EXPECTED = { requestId: 'req-1', stepIndex: 0, tool: 'deploy_to_test' };

function approvedFields(overrides = {}) {
  return {
    col_request: 'req-1', col_step: 0, col_tool: 'deploy_to_test', col_status: '承認',
    col_approver: 'approver@example.com', col_approved_at: '2026-10-11T11:00:00Z', col_revoked: false,
    ...overrides
  };
}

// Graph の取得を模擬する fetch。tokenは固定、items はページ単位で返す。
function fakeGraph(pages, { tokenOk = true, itemsStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).startsWith('https://login.microsoftonline.com')) {
      return tokenOk
        ? { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }
        : { ok: false, status: 401, text: async () => '' };
    }
    const index = calls.filter((c) => c.url.includes('/items')).length - 1;
    const page = pages[index];
    return {
      ok: itemsStatus === 200,
      status: itemsStatus,
      json: async () => page,
      text: async () => 'upstream'
    };
  };
  return { fetchImpl, calls };
}

function readerWith(fetchImpl) {
  return new SharePointReader({
    tenantId: 'tenant', clientId: 'client', clientSecret: 'secret', siteId: 'site-1',
    graphBaseUrl: GRAPH, tokenUrl: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token', fetchImpl
  });
}

test('fetchListFields は nextLink を辿って全件を返す（読み取りのみ）', async () => {
  const { fetchImpl, calls } = fakeGraph([
    { value: [{ fields: { a: 1 } }], '@odata.nextLink': `${GRAPH}/sites/site-1/lists/list-1/items?page=2` },
    { value: [{ fields: { a: 2 } }] }
  ]);
  const rows = await readerWith(fetchImpl).fetchListFields({ listId: 'list-1' });
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
  const graphCalls = calls.filter((c) => c.url.startsWith(GRAPH));
  assert.ok(graphCalls.length >= 2 && graphCalls.every((c) => c.method === 'GET'), 'Graphへは GET のみ');
  assert.ok(calls[2].url.endsWith('/items?page=2'));
});

test('fetchListFields は件数上限を超えたら例外（一部だけで判定しない）', async () => {
  const page = { value: [{ fields: {} }], '@odata.nextLink': `${GRAPH}/sites/site-1/lists/list-1/items?next=1` };
  const { fetchImpl } = fakeGraph([page, page, page]);
  await assert.rejects(
    () => readerWith(fetchImpl).fetchListFields({ listId: 'list-1', maxPages: 2 }),
    /読み取り上限/
  );
});

test('fetchListFields は想定外のnextLink（別ホスト）を拒否する', async () => {
  const { fetchImpl } = fakeGraph([
    { value: [], '@odata.nextLink': 'https://evil.example.com/steal' }
  ]);
  await assert.rejects(() => readerWith(fetchImpl).fetchListFields({ listId: 'list-1' }), /想定外/);
});

test('fetchListFields は認証失敗・Graphエラーを例外にする（承認なし扱いになる）', async () => {
  const noToken = fakeGraph([], { tokenOk: false });
  await assert.rejects(() => readerWith(noToken.fetchImpl).fetchListFields({ listId: 'list-1' }), /認証に失敗/);
  const graphErr = fakeGraph([{}], { itemsStatus: 403 });
  await assert.rejects(() => readerWith(graphErr.fetchImpl).fetchListFields({ listId: 'list-1' }), /403/);
});

test('fetchListFields は SharePoint 未設定なら外部へ接続せず例外', async () => {
  const { fetchImpl, calls } = fakeGraph([]);
  const reader = new SharePointReader({ siteId: 'site-1', fetchImpl });
  await assert.rejects(() => reader.fetchListFields({ listId: 'list-1' }), /SharePoint設定が不足/);
  assert.equal(calls.length, 0);
});

test('取得元は依頼ID・ステップ番号で絞り込み、承認判定は台帳が行う', async () => {
  const rows = [
    approvedFields(),
    approvedFields({ col_request: 'req-2' }),
    approvedFields({ col_step: 1 })
  ];
  const reader = { fetchListFields: async () => rows };
  const fetchRows = createApprovalLedgerFetchRows({ reader, config: LEDGER_CONFIG });
  assert.deepEqual(await fetchRows(EXPECTED), [rows[0]]);
  const ledger = new ApprovalLedger({ config: LEDGER_CONFIG, fetchRows, now: () => NOW });
  assert.deepEqual(await ledger.check(EXPECTED), { approved: true, reason: null, approver: 'approver@example.com' });
});

test('列名の設定を使い、列名が違えば承認なし（推測しない）', async () => {
  const reader = { fetchListFields: async () => [approvedFields()] };
  const wrongMap = { ...FIELD_MAP, requestId: 'no_such_column' };
  const config = { ...LEDGER_CONFIG, fieldMap: wrongMap };
  const ledger = new ApprovalLedger({
    config,
    fetchRows: createApprovalLedgerFetchRows({ reader, config }),
    now: () => NOW
  });
  assert.equal((await ledger.check(EXPECTED)).reason, 'no_record');
});

test('listName だけでも設定として扱われ、リスト名で取得される', async () => {
  const seen = [];
  const reader = { fetchListFields: async (params) => { seen.push(params); return [approvedFields()]; } };
  const config = { siteId: 'site-1', listId: '', listName: 'CN_Approvals', fieldMap: FIELD_MAP };
  assert.equal(isApprovalLedgerConfigured(config), true);
  const ledger = new ApprovalLedger({
    config,
    fetchRows: createApprovalLedgerFetchRows({ reader, config }),
    now: () => NOW
  });
  assert.equal((await ledger.check(EXPECTED)).approved, true);
  assert.deepEqual(seen[0], { siteId: 'site-1', listId: undefined, listName: 'CN_Approvals' });
});

test('サイトまたはリストが未設定なら未設定扱い（fail closed）', async () => {
  let called = false;
  const reader = { fetchListFields: async () => { called = true; return [approvedFields()]; } };
  for (const config of [
    { ...LEDGER_CONFIG, siteId: '' },
    { ...LEDGER_CONFIG, listId: '', listName: '' }
  ]) {
    const ledger = new ApprovalLedger({
      config,
      fetchRows: createApprovalLedgerFetchRows({ reader, config }),
      now: () => NOW
    });
    assert.equal((await ledger.check(EXPECTED)).reason, 'ledger_not_configured');
  }
  assert.equal(called, false, '未設定では SharePoint を読まない');
});

test('取得エラーは ledger_unreadable として承認なしになる', async () => {
  const reader = { fetchListFields: async () => { throw new Error('boom'); } };
  const ledger = new ApprovalLedger({
    config: LEDGER_CONFIG,
    fetchRows: createApprovalLedgerFetchRows({ reader, config: LEDGER_CONFIG }),
    now: () => NOW
  });
  assert.deepEqual(await ledger.check(EXPECTED), { approved: false, reason: 'ledger_unreadable' });
});

test('設定の環境変数（APPROVAL_LEDGER_*）は getConfig 経由でのみ読まれ、既定値は空', () => {
  const empty = getConfig({}).approvalLedger;
  assert.equal(empty.siteId, '');
  assert.equal(empty.listId, '');
  assert.equal(empty.fieldMap.requestId, '');
  assert.equal(isApprovalLedgerConfigured(empty), false);

  const set = getConfig({
    APPROVAL_LEDGER_SITE_ID: 'site-9',
    APPROVAL_LEDGER_LIST_NAME: 'CN_Approvals',
    APPROVAL_LEDGER_COL_REQUEST_ID: 'RequestId',
    APPROVAL_LEDGER_COL_STEP_INDEX: 'StepIndex',
    APPROVAL_LEDGER_COL_TOOL: 'Tool',
    APPROVAL_LEDGER_COL_STATUS: 'Status',
    APPROVAL_LEDGER_COL_APPROVER: 'Approver',
    APPROVAL_LEDGER_COL_APPROVED_AT: 'ApprovedAt',
    APPROVAL_LEDGER_COL_REVOKED: 'Revoked'
  }).approvalLedger;
  assert.equal(isApprovalLedgerConfigured(set), true);
});

test('MCP経由：承認台帳が未設定なら、承認が必要な依頼は人間承認待ちのまま進まない', async () => {
  const app = createApp(getConfig({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const url = `http://127.0.0.1:${server.address().port}/mcp`;
    const call = async (name, args) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      });
      return (await response.json()).result;
    };
    const created = await call('create_execution_request', {
      agentId: 'ReleaseAI', steps: [{ tool: 'deploy_to_test' }]
    });
    const requestId = created.structuredContent.requestId;
    assert.equal(created.structuredContent.status, '人間承認待ち');
    const advanced = await call('get_execution_status', { requestId });
    assert.equal(advanced.structuredContent.status, '人間承認待ち');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
