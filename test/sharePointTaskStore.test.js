const assert = require('node:assert/strict');
const test = require('node:test');
const { SharePointTaskStore } = require('../src/sharePointTaskStore');

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function createStubFetch({ items, onWrite }) {
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
    return jsonResponse({ value: items });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function makeStore(fetchImpl, overrides = {}) {
  return new SharePointTaskStore({
    tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'secret-1',
    siteId: 'site-1', listId: 'list-1', fetchImpl, ...overrides
  });
}

test('SharePoint Listsのアイテムをタスクへ変換して一覧取得できる', async () => {
  const fetchImpl = createStubFetch({
    items: [{ id: '1', fields: { TaskId: 'task-1', Title: 'テスト', Status: '未着手', RetryCount: '0' } }]
  });
  const store = makeStore(fetchImpl);
  const tasks = await store.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'task-1');
  assert.equal(tasks[0].retry_count, 0);
  assert.ok(fetchImpl.calls.some((c) => c.url.includes('/oauth2/v2.0/token')));
});

test('未着手タスクをnext()で返し、承認待ちは除外する', async () => {
  const fetchImpl = createStubFetch({
    items: [
      { id: '1', fields: { TaskId: 'task-1', Title: 'A', ApprovalRequired: 'true' } },
      { id: '2', fields: { TaskId: 'task-2', Title: 'B' } }
    ]
  });
  const store = makeStore(fetchImpl);
  const next = await store.next();
  assert.equal(next.id, 'task-2');
});

test('既存idはPATCH、新規idはPOSTでupsertする', async () => {
  const writes = [];
  const fetchImpl = createStubFetch({
    items: [{ id: 'item-1', fields: { TaskId: 'task-1', Title: '既存' } }],
    onWrite: (url, body) => writes.push({ url, body })
  });
  const store = makeStore(fetchImpl);
  await store.upsert({ id: 'task-1', title: '更新後' });
  await store.upsert({ id: 'task-2', title: '新規' });
  assert.equal(writes.length, 2);
  assert.ok(writes[0].url.includes('/items/item-1/fields'));
  assert.equal(writes[0].body.Title, '更新後');
  assert.ok(writes[1].url.endsWith('/items'));
  assert.equal(writes[1].body.fields.Title, '新規');
});

test('存在しないidのupdateはnullを返す', async () => {
  const fetchImpl = createStubFetch({ items: [] });
  const store = makeStore(fetchImpl);
  const result = await store.update('missing', { status: '完了' });
  assert.equal(result, null);
});

test('認証失敗時はエラーを投げる', async () => {
  const fetchImpl = async () => jsonResponse({ error: 'invalid_client' }, 401);
  const store = makeStore(fetchImpl);
  await assert.rejects(() => store.list(), /SharePoint認証に失敗しました/);
});
