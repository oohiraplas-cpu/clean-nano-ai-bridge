const assert = require('node:assert/strict');
const test = require('node:test');
const { SharePointListWriter, CN_EMPLOYEE_LEDGER_FIELD_MAP } = require('../src/sharePointListWriter');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function createStubFetch({ onWrite } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/oauth2/v2.0/token')) {
      return jsonResponse({ access_token: 'fake-token', expires_in: 3600 });
    }
    if (options.method === 'PATCH' || options.method === 'POST') {
      onWrite?.(url, JSON.parse(options.body));
      return jsonResponse({ id: 'new-item' }, options.method === 'POST' ? 201 : 200);
    }
    throw new Error(`予期しないリクエスト: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeWriter(fetchImpl, overrides = {}) {
  return new SharePointListWriter({
    tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1',
    fieldMap: CN_EMPLOYEE_LEDGER_FIELD_MAP, fetchImpl, ...overrides
  });
}

test('createItemはfieldMapに従いfieldsをPOSTする', async () => {
  const writes = [];
  const fetchImpl = createStubFetch({ onWrite: (url, body) => writes.push({ url, body }) });
  const writer = makeWriter(fetchImpl);
  await writer.createItem('site-1', 'list-1', { name: '山田太郎', employeeId: 'EMP002', department: '現場' });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.endsWith('/sites/site-1/lists/list-1/items'));
  assert.deepEqual(writes[0].body, { fields: { Title: '山田太郎', EmployeeID: 'EMP002', Department: '現場' } });
});

test('updateItemはfieldMapに従いfieldsをPATCHする', async () => {
  const writes = [];
  const fetchImpl = createStubFetch({ onWrite: (url, body) => writes.push({ url, body }) });
  const writer = makeWriter(fetchImpl);
  const result = await writer.updateItem('site-1', 'list-1', 'item-1', { employmentStatus: '退職', remarks: '2026-09-30付' });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].url.endsWith('/sites/site-1/lists/list-1/items/item-1/fields'));
  assert.deepEqual(writes[0].body, { EmploymentStatus: '退職', Remarks: '2026-09-30付' });
  assert.equal(result.itemId, 'item-1');
});

test('fieldMapに存在しないキーは無視される（未知列への誤書き込み防止）', async () => {
  const writes = [];
  const fetchImpl = createStubFetch({ onWrite: (url, body) => writes.push({ url, body }) });
  const writer = makeWriter(fetchImpl);
  await writer.createItem('site-1', 'list-1', { name: '鈴木', unknownColumn: '無視されるべき' });
  assert.deepEqual(writes[0].body, { fields: { Title: '鈴木' } });
});

test('fieldMapに一致する項目が無い場合はエラーになる', async () => {
  const fetchImpl = createStubFetch();
  const writer = makeWriter(fetchImpl);
  await assert.rejects(() => writer.createItem('site-1', 'list-1', { unknownColumn: 'x' }), /fieldMapに一致する項目がありません/);
});

test('fieldMap未指定でコンストラクトした場合は呼び出し時にエラーになる', async () => {
  const fetchImpl = createStubFetch();
  const writer = new SharePointListWriter({ tenantId: 't', clientId: 'c', clientSecret: 's', fetchImpl });
  await assert.rejects(() => writer.createItem('site-1', 'list-1', { name: 'x' }), /fieldMapが指定されていません/);
});

test('siteId/listId/itemId未指定はエラーになる', async () => {
  const fetchImpl = createStubFetch();
  const writer = makeWriter(fetchImpl);
  await assert.rejects(() => writer.createItem(null, 'list-1', { name: 'x' }), /siteIdとlistIdは必須です/);
  await assert.rejects(() => writer.updateItem('site-1', 'list-1', null, { name: 'x' }), /siteId・listId・itemIdは必須です/);
});

test('認証失敗時はエラーを投げる（DELETEは提供しないことの確認も兼ねる）', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'invalid_client' }, 401);
  const writer = makeWriter(fetchImpl);
  await assert.rejects(() => writer.createItem('site-1', 'list-1', { name: 'x' }), /SharePoint認証に失敗しました/);
  assert.equal(typeof writer.deleteItem, 'undefined');
});
