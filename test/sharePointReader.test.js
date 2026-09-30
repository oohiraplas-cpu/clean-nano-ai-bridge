const assert = require('node:assert/strict');
const test = require('node:test');
const { SharePointReader } = require('../src/sharePointReader');
const { validateGetSharePointListParams } = require('../src/bridgeExtensionsValidation');
function reader(handler) {
  const calls = [];
  const instance = new SharePointReader({ tenantId: 't', clientId: 'c', clientSecret: 's', siteId: 'site',
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method || 'GET' });
      if (url.includes('/oauth2/v2.0/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }));
      return handler(url);
    }
  });
  return { instance, calls };
}
const json = value => new Response(JSON.stringify(value));
test('対象未指定のリスト一覧を複数ページから取得し書込みを行わない', async () => {
  const { instance, calls } = reader(url => json(url.includes('skiptoken') ?
    { value: [{ id: 'b', displayName: '請求' }] } :
    { value: [{ id: 'a', displayName: '経費' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site/lists?skiptoken=2' }));
  const result = await instance.listItems({});
  assert.equal(result.mode, 'lists'); assert.equal(result.count, 2); assert.equal(result.hasMore, false);
  assert.deepEqual(calls.filter(c => !c.url.includes('/token')).map(c => c.method), ['GET', 'GET']);
  assert.equal(validateGetSharePointListParams({}), null);
  assert.match(validateGetSharePointListParams({ top: '2' }), /top/);
});
test('既存項目を保持し列内部名・型・必須設定を実値で返す', async () => {
  const column = { id: 'c1', name: 'Amount', displayName: '金額', required: true, currency: { locale: 'ja-JP' } };
  const { instance } = reader(url => {
    if (url.includes('/items?')) return json({ value: [{ id: '1', fields: { Amount: 1200 } }] });
    if (url.includes('skiptoken')) return json({ value: [{ id: 'c2', name: 'Evidence', hidden: false, text: {} }] });
    return json({ value: [column], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site/lists/list/columns?skiptoken=2' });
  });
  const result = await instance.listItems({ listId: 'list', top: 1 });
  assert.equal(result.items[0].fields.Amount, 1200); assert.equal(result.schemaStatus, 'ok');
  assert.deepEqual(result.columns[0], column); assert.equal(result.columns.length, 2);
});
test('列定義が403の場合も従来の項目を返し未確認を明示する', async () => {
  const { instance } = reader(url => url.includes('/columns?') ? new Response('forbidden', { status: 403 }) : json({ value: [{ id: '1', fields: { Title: 'x' } }] }));
  const result = await instance.listItems({ listId: 'list' });
  assert.equal(result.count, 1); assert.equal(result.schemaStatus, 'unavailable'); assert.deepEqual(result.columns, []);
});
test('一覧取得上限に達した場合は不足を明示する', async () => {
  const { instance } = reader(() => json({ value: [{ id: '1' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/site/lists?skiptoken=2' }));
  const result = await instance.listItems({ top: 1 }); assert.equal(result.hasMore, true);
});
test('Graph以外へのページ継続URLにトークンを送らない', async () => {
  const { instance, calls } = reader(() => json({ value: [], '@odata.nextLink': 'https://example.com/collect' }));
  await assert.rejects(instance.listItems({}), /対象エンドポイント/);
  assert.equal(calls.length, 2); assert.ok(calls.every(c => !c.url.startsWith('https://example.com')));
});
test('別のリストへの継続URLを拒否する', async () => {
  const { instance } = reader(() => json({ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/sites/other/lists' }));
  await assert.rejects(instance.listItems({}), /対象エンドポイント/);
});
test('IDをURLセグメントとして符号化する', async () => {
  const { instance, calls } = reader(() => json({ value: [] }));
  await instance.listItems({ siteId: 'a/b', listId: 'c/d' });
  assert.ok(calls.some(c => c.url.includes('/sites/a%2Fb/lists/c%2Fd/items')));
});
