const test = require('node:test');
const assert = require('node:assert/strict');
const { RequestLedgerStore, RequestLedgerError } = require('../src/requestLedgerStore');

const FIELD_MAP = { title: 'Title', status: 'Status', auditId: 'AuditId', description: 'Description', assignee: 'Assignee', dueDate: 'DueDate' };

// Graph の最小モック。items を保持し、POST/PATCH/GET を模擬する。
function makeFetch({ failWrite = false, corruptReadBack = false } = {}) {
  const items = new Map();
  let nextId = 1;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (url.includes('login.microsoftonline.com')) {
      return { ok: true, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    }
    const method = options.method || 'GET';
    if (method === 'POST' && url.endsWith('/items')) {
      if (failWrite) return { ok: false, status: 403, text: async () => 'denied' };
      const id = String(nextId++);
      const fields = JSON.parse(options.body).fields;
      items.set(id, { ...fields });
      return { ok: true, status: 201, json: async () => ({ id }) };
    }
    const m = url.match(/\/items\/(\d+)(\/fields)?/);
    if (m && method === 'PATCH') {
      const cur = items.get(m[1]);
      if (!cur) return { ok: false, status: 404, text: async () => 'not found' };
      Object.assign(cur, JSON.parse(options.body));
      return { ok: true, status: 204, json: async () => null };
    }
    if (m && method === 'GET') {
      const cur = items.get(m[1]);
      if (!cur) return { ok: false, status: 404, text: async () => 'not found' };
      const fields = corruptReadBack ? { ...cur, Title: 'changed-by-someone-else' } : cur;
      return { ok: true, status: 200, json: async () => ({ id: m[1], fields }) };
    }
    return { ok: false, status: 500, text: async () => 'unexpected' };
  };
  return { fetchImpl, items, calls };
}

function makeStore(opts = {}, fieldMap = FIELD_MAP) {
  const mock = makeFetch(opts);
  const store = new RequestLedgerStore({
    tenantId: 't', clientId: 'c', clientSecret: 's', siteId: 'site', listId: 'list',
    fieldMap, fetchImpl: mock.fetchImpl
  });
  return { store, ...mock };
}

test('未設定の列があれば書き込みを拒否する（fail-closed）', async () => {
  const { store, calls } = makeStore({}, { title: 'Title' });
  assert.equal(store.checkConfiguration().configured, false);
  await assert.rejects(store.createRequest({ title: 'x' }), (e) => e.code === 'NOT_CONFIGURED');
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('作成後に再取得して一致した場合のみ verified=true', async () => {
  const { store, items } = makeStore();
  const result = await store.createRequest({ title: 'テスト依頼', description: '確認用' });
  assert.equal(result.verified, true);
  assert.match(result.auditId, /^CNAI-\d{8}-/);
  assert.equal(items.get(result.itemId).Title, 'テスト依頼');
  assert.equal(items.get(result.itemId).AuditId, result.auditId);
});

test('書き込みが失敗したら成功扱いにせずエラーを返す', async () => {
  const { store } = makeStore({ failWrite: true });
  await assert.rejects(store.createRequest({ title: 'x' }), (e) => e.code === 'UPSTREAM_ERROR' && e.detail.status === 403);
});

test('再取得の内容が違えば VERIFY_FAILED（成功と報告しない）', async () => {
  const { store } = makeStore({ corruptReadBack: true });
  await assert.rejects(store.createRequest({ title: 'テスト' }), (e) => e.code === 'VERIFY_FAILED');
});

test('許可されていない項目の更新は拒否する（監査IDは変更不可）', async () => {
  const { store } = makeStore();
  const { itemId } = await store.createRequest({ title: 'a' });
  await assert.rejects(store.updateRequest(itemId, { auditId: 'X' }), (e) => e.code === 'FORBIDDEN_FIELD');
});

test('許可された項目の更新は再取得で確認する', async () => {
  const { store } = makeStore();
  const { itemId } = await store.createRequest({ title: 'a' });
  const result = await store.updateRequest(itemId, { status: '完了' });
  assert.equal(result.verified, true);
  assert.equal(result.request.status, '完了');
});

test('削除の機能は存在しない', () => {
  const { store } = makeStore();
  assert.equal(typeof store.deleteRequest, 'undefined');
});
