'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gm = require('../src/graphManage');
const platformManage = require('../src/platformManage');

const jwt = (roles) => `x.${Buffer.from(JSON.stringify({ roles, tid: 'tenant-1', appid: 'app-1', exp: 4102444800 })).toString('base64url')}.y`;
function fakeGraph(roles, { responses = {} } = {}) {
  const calls = [];
  const reply = (m, path) => { const key = Object.keys(responses).find((k) => path.startsWith(k)); return key ? (typeof responses[key] === 'function' ? responses[key](m, path) : responses[key]) : { value: [] }; };
  return { calls, token: async () => jwt(roles),
    get: async (path, h) => { calls.push({ m: 'GET', path, h }); return reply('GET', path); },
    post: async (path, body) => { calls.push({ m: 'POST', path, body }); return reply('POST', path); },
    patch: async (path, body) => { calls.push({ m: 'PATCH', path, body }); return reply('PATCH', path); } };
}
const ENV = { GRAPH_UPN_ALLOWED_DOMAINS: 'example.co.jp', GRAPH_MAIL_ALLOWED_DOMAINS: 'example.co.jp', GRAPH_MAIL_SENDER: 'noreply@example.co.jp' };
const run = (p, graph, env = ENV) => gm.run(p, { graph, env });
const GOOD_UPN = 'taro@example.co.jp';

test('status lists granted roles and what each operation needs, without the token', async () => {
  const g = fakeGraph(['Sites.ReadWrite.All', 'User.Read.All']);
  const r = await run({ operation: 'status' }, g);
  assert.deepEqual(r.data.grantedRoles, ['Sites.ReadWrite.All', 'User.Read.All']);
  assert.equal(r.data.operations.user_get.granted, true); assert.equal(r.data.operations.user_create.granted, false); assert.equal(r.data.operations.mail_send.granted, false);
  assert.equal(r.data.tenantId, 'tenant-1'); assert.equal(r.data.config.mailSenderConfigured, true);
  assert.ok(!JSON.stringify(r).includes('x.') || !JSON.stringify(r).includes('.y'), 'no token in output');
  assert.equal(g.calls.length, 0, 'status makes no Graph call');
});

test('a missing role is a structured block with the exact roles, and Graph is never called', async () => {
  const g = fakeGraph(['Sites.ReadWrite.All']);
  for (const [operation, extra, need] of [['user_get', { user: GOOD_UPN }, 'User.Read.All'], ['group_list', {}, 'Group.Read.All'], ['license_list', {}, 'Organization.Read.All'], ['app_get', { appId: '11111111-1111-1111-1111-111111111111' }, 'Application.Read.All']]) {
    const r = await run({ operation, ...extra }, g);
    assert.equal(r.data.blocked, true, operation); assert.ok(r.data.requiredPermissions.includes(need)); assert.deepEqual(r.data.grantedRoles, ['Sites.ReadWrite.All']);
    assert.ok(r.data.adminPortal && r.data.humanApproval);
  }
  const w = await run({ operation: 'user_create', user: {}, approvedByHuman: true }, g);
  assert.equal(w.data.blocked, true); assert.ok(w.data.requiredPermissions.includes('User.ReadWrite.All'));
  assert.equal(g.calls.length, 0);
});

test('READ builds safe, encoded Graph requests', async () => {
  const g = fakeGraph(['User.Read.All', 'Group.Read.All', 'Organization.Read.All', 'Application.Read.All']);
  await run({ operation: 'user_get', user: GOOD_UPN }, g);
  await run({ operation: 'user_search', search: "O'Brien", top: 500 }, g);
  await run({ operation: 'group_list', search: 'CN' }, g);
  await run({ operation: 'group_members', group: '22222222-2222-2222-2222-222222222222' }, g);
  await run({ operation: 'license_list' }, g);
  await run({ operation: 'user_licenses', user: GOOD_UPN }, g);
  assert.ok(g.calls.every((c) => c.m === 'GET'), 'reads are GET only');
  assert.ok(g.calls[0].path.startsWith('/users/taro%40example.co.jp?$select='));
  assert.ok(g.calls[1].path.includes(encodeURIComponent("startswith(displayName,'O''Brien')")), 'single quotes are escaped');
  assert.ok(g.calls[1].path.endsWith('&$top=25'), 'top is capped');
  assert.equal(g.calls[1].h.ConsistencyLevel, 'eventual');
  assert.ok(g.calls[3].path.startsWith('/groups/22222222-2222-2222-2222-222222222222/members'));
  assert.equal(g.calls[4].path.split('?')[0], '/subscribedSkus');
});

test('invalid identifiers are rejected before any request', async () => {
  const g = fakeGraph(['User.Read.All', 'Group.Read.All', 'Application.Read.All']);
  await assert.rejects(() => run({ operation: 'user_get', user: "x'; DROP" }, g), /object id|user principal/);
  await assert.rejects(() => run({ operation: 'user_get', user: '../groups' }, g), /object id|user principal/);
  await assert.rejects(() => run({ operation: 'group_members', group: 'not-a-guid' }, g), /GUID/);
  await assert.rejects(() => run({ operation: 'app_get', appId: "1' or '1'='1" }, g), /GUID/);
  await assert.rejects(() => run({ operation: 'user_search' }, g), /search is required/);
  await assert.rejects(() => run({ operation: 'delete_everything' }, g), /unknown operation/);
  assert.equal(g.calls.length, 0);
});

test('WRITE operations need approvedByHuman and never run without it', async () => {
  const g = fakeGraph(['User.ReadWrite.All', 'Mail.Send', 'User.Read.All']);
  for (const p of [{ operation: 'user_create', user: { userPrincipalName: GOOD_UPN } }, { operation: 'user_update', user: GOOD_UPN, patch: { jobTitle: 'x' } }, { operation: 'mail_send', to: [GOOD_UPN], subject: 's', body: 'b' }]) {
    await assert.rejects(() => run(p, g), (e) => e.kind === 'approval_required');
    await assert.rejects(() => run({ ...p, approvedByHuman: 'true' }, g), (e) => e.kind === 'approval_required', 'only boolean true counts');
  }
  assert.equal(g.calls.length, 0);
});

test('user_create: allowed domains, password rules, re-read verification, password never returned', async () => {
  const PASSWORD = 'Sup3r-Secret-Pass!';
  const created = { id: '33333333-3333-3333-3333-333333333333', userPrincipalName: GOOD_UPN, displayName: '太郎' };
  const g = fakeGraph(['User.ReadWrite.All'], { responses: { '/users/': created, '/users': created } });
  g.post = async (path, body) => { g.calls.push({ m: 'POST', path, body }); return created; };
  const good = { operation: 'user_create', approvedByHuman: true, user: { displayName: '太郎', mailNickname: 'taro', userPrincipalName: GOOD_UPN, passwordProfile: { password: PASSWORD } } };
  await assert.rejects(() => run(good, g, {}), /GRAPH_UPN_ALLOWED_DOMAINS/);
  await assert.rejects(() => run({ ...good, user: { ...good.user, userPrincipalName: 'a@evil.example' } }, g), /outside the allowed domains/);
  await assert.rejects(() => run({ ...good, user: { ...good.user, passwordProfile: { password: 'short' } } }, g), /password/);
  const r = await run(good, g);
  assert.equal(r.verified, true); assert.equal(r.data.passwordReturned, false);
  assert.ok(!JSON.stringify(r).includes(PASSWORD), 'the password is not in the result');
  const post = g.calls.find((c) => c.m === 'POST');
  assert.equal(post.path, '/users'); assert.equal(post.body.passwordProfile.forceChangePasswordNextSignIn, true);
  assert.equal(g.calls.at(-1).m, 'GET', 'the user is re-read after creation');
});

test('user_update: only allowlisted fields, re-read compares every changed field', async () => {
  const G = ['User.ReadWrite.All'];
  const g = fakeGraph(G, { responses: { '/users/': { jobTitle: '課長', department: 'old' } } });
  await assert.rejects(() => run({ operation: 'user_update', user: GOOD_UPN, patch: { passwordProfile: {} }, approvedByHuman: true }, g), /not updatable/);
  await assert.rejects(() => run({ operation: 'user_update', user: GOOD_UPN, patch: { userPrincipalName: 'x@y' }, approvedByHuman: true }, g), /not updatable/);
  const ok = await run({ operation: 'user_update', user: GOOD_UPN, patch: { jobTitle: '課長' }, approvedByHuman: true }, g);
  assert.equal(ok.verified, true); assert.deepEqual(ok.data.mismatched, []);
  const bad = await run({ operation: 'user_update', user: GOOD_UPN, patch: { department: 'new' }, approvedByHuman: true }, g);
  assert.equal(bad.verified, false); assert.deepEqual(bad.data.mismatched, ['department']);
});

test('mail_send: configured sender, allowed domains only, text body, reported as unverified', async () => {
  const g = fakeGraph(['Mail.Send']);
  const base = { operation: 'mail_send', approvedByHuman: true, to: [GOOD_UPN], subject: '案内', body: '本文' };
  await assert.rejects(() => run(base, g, {}), /GRAPH_MAIL_SENDER/);
  await assert.rejects(() => run({ ...base, to: ['x@outside.example'] }, g), /outside the allowed domains/);
  await assert.rejects(() => run({ ...base, to: Array.from({ length: 21 }, (_, i) => `u${i}@example.co.jp`) }, g), /too many|outside/);
  await assert.rejects(() => run({ ...base, body: 'x'.repeat(8001) }, g), /body/);
  const r = await run(base, g);
  assert.equal(r.verified, false, 'delivery is not independently verifiable');
  const post = g.calls.find((c) => c.m === 'POST');
  assert.equal(post.path, '/users/noreply%40example.co.jp/sendMail'); assert.equal(post.body.message.body.contentType, 'Text');
  const spoof = fakeGraph(['Mail.Send']);
  await run({ ...base, sender: 'ceo@example.co.jp', from: 'ceo@example.co.jp' }, spoof);
  assert.equal(spoof.calls.find((c) => c.m === 'POST').path, '/users/noreply%40example.co.jp/sendMail', 'a caller-supplied sender is ignored; configuration decides');
});

test('an unreadable token does not block: Graph answers instead of guessing', async () => {
  const g = { calls: [], token: async () => 'opaque-token', get: async (p) => { g.calls.push(p); return { value: [] }; } };
  const r = await run({ operation: 'group_list' }, g);
  assert.equal(r.verified, true); assert.equal(g.calls.length, 1);
});

test('graph_manage is published through platformManage and the audit/approval wiring', async () => {
  assert.ok(platformManage.TOOL_NAMES.includes('graph_manage'));
  const def = platformManage.TOOL_DEFS.find((t) => t.name === 'graph_manage');
  assert.deepEqual(def.inputSchema.properties.operation.enum, gm.OPERATIONS);
  const g = fakeGraph(['User.Read.All']);
  const ok = await platformManage.run('graph_manage', { operation: 'user_get', user: GOOD_UPN }, { graph: g, env: { ...ENV, PA_SNAPSHOT_DIR: require('os').tmpdir() } });
  assert.equal(ok.status, 'ok');
  const denied = await platformManage.run('graph_manage', { operation: 'user_update', user: GOOD_UPN, patch: { jobTitle: 'x' } }, { graph: fakeGraph(['User.ReadWrite.All']), env: ENV });
  assert.equal(denied.status, 'approval_required');
  const bad = await platformManage.run('graph_manage', { operation: 'nope' }, { graph: g, env: ENV });
  assert.equal(bad.status, 'error');
});
