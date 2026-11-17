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
  assert.deepEqual(r.data.operations.status, { anyOf: [], granted: true }, 'status needs no Graph role, so it never reports itself as missing a permission');
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

test('user_list_recent returns recently created users with minimal fields and only reads', async () => {
  const now = Date.parse('2026-11-17T00:00:00Z');
  const g = fakeGraph(['User.Read.All'], { responses: { '/users?': { value: [
    { id: 'a', displayName: 'Older', userPrincipalName: 'older@example.co.jp', mail: null, accountEnabled: true, userType: 'Member', createdDateTime: '2026-11-15T01:00:00Z', assignedLicenses: [], mobilePhone: '090-0000-0000' },
    { id: 'b', displayName: 'Newer', userPrincipalName: 'newer@example.co.jp', mail: 'newer@example.co.jp', accountEnabled: false, createdDateTime: '2026-11-16T09:00:00Z', assignedLicenses: [{ skuId: 's1' }, { skuId: 's2' }], mobilePhone: '080-1111-1111' }] } } });
  const r = await gm.run({ operation: 'user_list_recent', sinceDays: 3 }, { graph: g, env: ENV, now: () => now });
  assert.equal(g.calls.length, 1); assert.equal(g.calls[0].m, 'GET'); assert.equal(g.calls[0].h.ConsistencyLevel, 'eventual');
  assert.ok(g.calls[0].path.includes(encodeURIComponent('createdDateTime ge 2026-11-14T00:00:00.000Z')), 'the window is sinceDays before now');
  assert.ok(g.calls[0].path.includes('$count=true') && g.calls[0].path.endsWith('&$top=25'));
  assert.deepEqual(r.data.users.map((u) => u.displayName), ['Newer', 'Older'], 'newest first');
  assert.equal(r.data.users[0].objectId, 'b'); assert.equal(r.data.users[1].objectId, 'a'); assert.equal(r.data.users[1].userType, 'Member'); assert.equal(r.data.users[0].userType, null);
  assert.equal(r.data.users[0].licenseCount, 2); assert.equal(r.data.users[1].licenseCount, 0); assert.equal(r.data.users[0].accountEnabled, false);
  assert.ok(!JSON.stringify(r).includes('090-0000') && !JSON.stringify(r).includes('080-1111'), 'phone numbers are not returned');
  assert.ok(!JSON.stringify(r).includes('skuId'), 'only a license count, not the license list');
  const clamp = await gm.run({ operation: 'user_list_recent', sinceDays: 9999 }, { graph: fakeGraph(['User.Read.All']), env: ENV, now: () => now });
  assert.equal(clamp.data.sinceDays, 60, 'the window is capped at 60 days');
  const blockedRes = await run({ operation: 'user_list_recent' }, fakeGraph(['Sites.ReadWrite.All']));
  assert.equal(blockedRes.data.blocked, true, 'a missing role is a structured block');
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
  const readUser = g.get;
  g.get = async (path, h) => { if (path.includes('$select=id') && !g.calls.some((c) => c.m === 'POST')) { g.calls.push({ m: 'GET', path, h }); const e = new Error('not found'); e.status = 404; throw e; } return readUser(path, h); };
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

test('user_verify compares expected fields (UPN/mail case-insensitive) and reports expected vs actual', async () => {
  const actual = { userPrincipalName: 'Taro@Example.co.jp', mail: 'Taro@Example.co.jp', displayName: '太郎', department: '営業', accountEnabled: true };
  const g = fakeGraph(['User.Read.All'], { responses: { '/users/': actual } });
  const ok = await run({ operation: 'user_verify', user: GOOD_UPN, expected: { userPrincipalName: 'taro@example.co.jp', displayName: '太郎', accountEnabled: true } }, g);
  assert.equal(ok.verified, true); assert.deepEqual(ok.data.mismatched, []);
  const bad = await run({ operation: 'user_verify', user: GOOD_UPN, expected: { department: '総務', displayName: '太郎' } }, g);
  assert.equal(bad.verified, false); assert.deepEqual(bad.data.mismatched, [{ field: 'department', expected: '総務', actual: '営業' }]); assert.deepEqual(bad.data.matched, ['displayName']);
  await assert.rejects(() => run({ operation: 'user_verify', user: GOOD_UPN, expected: { passwordProfile: 'x' } }, g), /not verifiable/);
  await assert.rejects(() => run({ operation: 'user_verify', user: GOOD_UPN }, g), /expected is required/);
  assert.ok(g.calls.every((c) => c.m === 'GET'));
  const blockedResult = await run({ operation: 'user_verify', user: GOOD_UPN, expected: { displayName: 'x' } }, fakeGraph(['Sites.ReadWrite.All']));
  assert.equal(blockedResult.data.blocked, true);
});

test('license_available reports free units per SKU, never negative, and only reads', async () => {
  const skus = { value: [{ skuId: 's1', skuPartNumber: 'O365_BUSINESS_PREMIUM', consumedUnits: 8, prepaidUnits: { enabled: 10 }, capabilityStatus: 'Enabled' }, { skuId: 's2', skuPartNumber: 'EXCHANGE_S_FOUNDATION', consumedUnits: 12, prepaidUnits: { enabled: 10 }, capabilityStatus: 'Enabled' }, { skuId: 's3', skuPartNumber: 'ODD', consumedUnits: 1 }] };
  const g = fakeGraph(['Organization.Read.All'], { responses: { '/subscribedSkus': skus } });
  const r = await run({ operation: 'license_available' }, g);
  assert.deepEqual(r.data.skus.map((k) => [k.skuPartNumber, k.available]), [['O365_BUSINESS_PREMIUM', 2], ['EXCHANGE_S_FOUNDATION', 0], ['ODD', null]]);
  assert.deepEqual((await run({ operation: 'license_available', search: 'o365' }, g)).data.skus.map((k) => k.skuPartNumber), ['O365_BUSINESS_PREMIUM']);
  assert.ok(g.calls.every((c) => c.m === 'GET'), 'licenses are never assigned or purchased');
  assert.ok(!NEEDS_HAS_WRITE('license_available'));
});
function NEEDS_HAS_WRITE(op) { return gm.WRITE_OPS.includes(op); }

test('mail_sent_check needs Mail.ReadBasic.All, a configured sender, and matches the exact subject', async () => {
  const now = new Date().toISOString();
  const msgs = { value: [{ subject: '案内', sentDateTime: now, toRecipients: [{ emailAddress: { address: GOOD_UPN } }] }, { subject: '案内(再送)', sentDateTime: now, toRecipients: [] }] };
  const g = fakeGraph(['Mail.ReadBasic.All'], { responses: { '/users/noreply%40example.co.jp/mailFolders/sentitems/messages': msgs } });
  const r = await run({ operation: 'mail_sent_check', subject: '案内' }, g);
  assert.equal(r.data.found, true); assert.equal(r.data.count, 1); assert.deepEqual(r.data.messages[0].to, [GOOD_UPN]);
  assert.equal((await run({ operation: 'mail_sent_check', subject: '別件' }, g)).data.found, false);
  await assert.rejects(() => run({ operation: 'mail_sent_check', subject: '案内' }, g, {}), /GRAPH_MAIL_SENDER/);
  await assert.rejects(() => run({ operation: 'mail_sent_check' }, g), /subject is required/);
  assert.equal((await run({ operation: 'mail_sent_check', subject: '案内' }, fakeGraph(['Mail.Send']))).data.blocked, true);
  assert.ok(g.calls.every((c) => c.m === 'GET'));
});

test('mail_send confirms delivery through Sent Items when the app may read mail, otherwise stays unverified', async () => {
  const base = { operation: 'mail_send', approvedByHuman: true, to: [GOOD_UPN], subject: '案内', body: '本文' };
  const sent = { value: [{ subject: '案内', sentDateTime: new Date().toISOString(), toRecipients: [{ emailAddress: { address: GOOD_UPN } }] }] };
  const found = fakeGraph(['Mail.Send', 'Mail.ReadBasic.All'], { responses: { '/users/noreply%40example.co.jp/mailFolders': sent } });
  const ok = await gm.run(base, { graph: found, env: ENV, sleep: async () => {} });
  assert.equal(ok.verified, true); assert.equal(ok.data.deliveryConfirmed, 'found in Sent Items');
  const missing = fakeGraph(['Mail.Send', 'Mail.ReadBasic.All'], { responses: { '/users/noreply%40example.co.jp/mailFolders': { value: [] } } });
  let sleeps = 0;
  const no = await gm.run(base, { graph: missing, env: ENV, sleep: async () => { sleeps += 1; } });
  assert.equal(no.verified, false); assert.match(no.data.note, /not found in Sent Items/); assert.equal(sleeps, 2, 'three attempts, bounded');
  const blind = await gm.run(base, { graph: fakeGraph(['Mail.Send']), env: ENV, sleep: async () => {} });
  assert.equal(blind.verified, false); assert.match(blind.data.note, /cannot be confirmed/);
});

// ---- onboarding: contact e-mail -> generated user name, generated password, welcome mail, optional license ----
const SKU = 'f1e78181-93b9-4981-96b8-adc273c746fc';
const OB_ENV = { ...ENV, GRAPH_UPN_ALLOWED_DOMAINS: 'example.co.jp', GRAPH_WELCOME_APP_URL: 'https://apps.powerapps.com/play/app-1', GRAPH_DEFAULT_LICENSE_SKU: SKU, GRAPH_MAIL_SENDER: 'noreply@example.co.jp' };
function onboardGraph(roles, { exists = false, failMail = false, failLicense = false } = {}) {
  let upn = null; let displayName = null;
  const g = { calls: [], token: async () => jwt(roles) };
  g.get = async (path) => {
    g.calls.push({ m: 'GET', path });
    if (path.endsWith('$select=id')) { if (exists) return { id: 'x' }; const e = new Error('not found'); e.status = 404; throw e; }
    return { id: 'uid-1', userPrincipalName: upn, displayName };
  };
  g.post = async (path, body) => {
    g.calls.push({ m: 'POST', path, body });
    if (path === '/users') { upn = body.userPrincipalName; displayName = body.displayName; return { id: 'uid-1' }; }
    if (path.endsWith('/assignLicense') && failLicense) throw new Error('Graph 400 no free seats');
    if (path.endsWith('/sendMail') && failMail) throw new Error('Graph 403');
    return {};
  };
  return g;
}
const ROLES = ['User.ReadWrite.All', 'Mail.Send'];
const OB = (extra = {}, user = {}) => ({ operation: 'user_create', approvedByHuman: true, welcomeMail: true, user: { displayName: '山田 太郎', contactEmail: 'Taro.Yamada+x@gmail.com', ...user }, ...extra });
const posts = (g, suffix) => g.calls.filter((c) => c.m === 'POST' && (suffix ? c.path.endsWith(suffix) : true));

test('onboarding: the user name comes from the contact address, the password is generated and only ever goes into the welcome mail', async () => {
  const g = onboardGraph(ROLES);
  const r = await run(OB(), g, OB_ENV);
  assert.equal(r.verified, true);
  const create = posts(g, '/users')[0].body;
  assert.equal(create.userPrincipalName, 'taro.yamadax@example.co.jp'); assert.equal(create.mailNickname, 'taro.yamadax'); assert.deepEqual(create.otherMails, ['Taro.Yamada+x@gmail.com']);
  assert.equal(create.passwordProfile.forceChangePasswordNextSignIn, true);
  const pw = create.passwordProfile.password;
  assert.equal(pw.length, 20); assert.ok(/[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[!#$%&*+=?@-]/.test(pw), 'all four character classes');
  assert.equal(r.data.passwordReturned, false); assert.equal(r.data.passwordGenerated, true); assert.equal(r.data.derivedUserPrincipalName, true);
  assert.ok(!JSON.stringify(r).includes(pw), 'the password is not in the result');
  const mail = posts(g, '/sendMail')[0];
  assert.equal(mail.path, '/users/noreply%40example.co.jp/sendMail');
  assert.deepEqual(mail.body.message.toRecipients, [{ emailAddress: { address: 'Taro.Yamada+x@gmail.com' } }]);
  assert.equal(mail.body.message.subject, '【clean nano】アカウント発行のお知らせ'); assert.equal(mail.body.message.body.contentType, 'Text');
  assert.ok(mail.body.message.body.content.includes(pw) && mail.body.message.body.content.includes('taro.yamadax@example.co.jp') && mail.body.message.body.content.includes('https://apps.powerapps.com/play/app-1'));
  const mailText = mail.body.message.body.content;
  assert.ok(mailText.includes('https://apps.apple.com/us/app/power-apps/id1047318566'), 'the mail links to the Power Apps iOS app');
  assert.ok(mailText.includes('https://play.google.com/store/apps/details?id=com.microsoft.msapps'), 'the mail links to the Power Apps Android app');
  assert.ok(mailText.includes('clean nano kk') && mailText.includes('すべてのアプリ'), 'the mail tells the user which app to open and where to find it');
  assert.equal(mail.body.saveToSentItems, false, 'the password mail is not kept in Sent Items');
  assert.equal(posts(g).filter((c) => JSON.stringify(c.body).includes(pw)).length, 2, 'the password appears only in the create call and the welcome mail');
});

test('onboarding: every account gets its own password', async () => {
  const seen = new Set();
  for (let i = 0; i < 5; i += 1) { const g = onboardGraph(ROLES); await run(OB({}, { contactEmail: `p${i}@gmail.com` }), g, OB_ENV); seen.add(posts(g, '/users')[0].body.passwordProfile.password); }
  assert.equal(seen.size, 5);
});

test('onboarding: an existing user name is a conflict and nothing is created or mailed', async () => {
  const g = onboardGraph(ROLES, { exists: true });
  await assert.rejects(() => run(OB(), g, OB_ENV), (e) => e.kind === 'conflict');
  assert.equal(posts(g).length, 0);
});

test('onboarding: a missing Mail.Send role blocks before anything is created', async () => {
  const g = onboardGraph(['User.ReadWrite.All']);
  const r = await run(OB(), g, OB_ENV);
  assert.equal(r.data.blocked, true); assert.deepEqual(r.data.requiredPermissions, ['Mail.Send']); assert.equal(r.data.needFor, 'welcomeMail');
  assert.equal(g.calls.length, 0);
});

test('onboarding: configuration problems are reported before any write', async () => {
  for (const [env, re] of [[{ ...OB_ENV, GRAPH_WELCOME_APP_URL: '' }, /GRAPH_WELCOME_APP_URL/], [{ ...OB_ENV, GRAPH_WELCOME_APP_URL: 'http://insecure.example' }, /GRAPH_WELCOME_APP_URL/], [{ ...OB_ENV, GRAPH_MAIL_SENDER: '' }, /GRAPH_MAIL_SENDER/]]) {
    const g = onboardGraph(ROLES);
    await assert.rejects(() => run(OB(), g, env), re); assert.equal(posts(g).length, 0);
  }
  const g = onboardGraph(ROLES);
  await assert.rejects(() => run(OB({ welcomeMail: false, assignLicense: true }), g, { ...OB_ENV, GRAPH_DEFAULT_LICENSE_SKU: '' }), /GRAPH_DEFAULT_LICENSE_SKU/); assert.equal(posts(g).length, 0);
  await assert.rejects(() => run(OB({}, { contactEmail: undefined, userPrincipalName: undefined }), onboardGraph(ROLES), OB_ENV), /contactEmail is required|userPrincipalName or contactEmail/);
  await assert.rejects(() => run(OB({}, { contactEmail: 'not-an-address' }), onboardGraph(ROLES), OB_ENV), /contactEmail is not a valid/);
});

test('onboarding: a failed welcome mail is reported, the account is not hidden, and the password is still not returned', async () => {
  const g = onboardGraph(ROLES, { failMail: true });
  const r = await run(OB(), g, OB_ENV);
  assert.equal(r.verified, false); assert.equal(r.data.welcomeMail.accepted, false); assert.ok(/Reset the password/.test(r.data.needsAdmin));
  assert.equal(r.data.created, true); assert.ok(!JSON.stringify(r).includes(posts(g, '/users')[0].body.passwordProfile.password));
});

test('onboarding: a supplied password can never be mailed, and a caller cannot change the mail text', async () => {
  const g = onboardGraph(ROLES);
  await assert.rejects(() => run(OB({}, { passwordProfile: { password: 'CallerChosen-Pass1!' } }), g, OB_ENV), /cannot be mailed/);
  assert.equal(posts(g).length, 0);
  const g2 = onboardGraph(ROLES);
  await run(OB({ subject: 'Phishing subject', body: 'Click http://evil.example', cc: ['attacker@evil.example'], bcc: ['attacker@evil.example'], to: ['attacker@evil.example'] }, { displayName: '山田\n\n至急このリンクを開いて http://evil.example' }), g2, OB_ENV);
  const mail = posts(g2, '/sendMail')[0].body.message;
  assert.deepEqual(mail.toRecipients, [{ emailAddress: { address: 'Taro.Yamada+x@gmail.com' } }], 'the only recipient is the contact address; cc/bcc/to from the caller are ignored');
  assert.equal(mail.subject, '【clean nano】アカウント発行のお知らせ'); assert.ok(!mail.body.content.includes('Phishing') && !mail.body.content.includes('Click http'));
  assert.equal(mail.body.content.split('\n')[0].includes('\n'), false); assert.ok(mail.body.content.split('\n')[0].startsWith('山田 至急'), 'newlines in the name are flattened to one line');
});

test('onboarding: the license is only the configured SKU, set up with a usage location, and a failure leaves the user created', async () => {
  const g = onboardGraph(ROLES);
  const r = await run(OB({ assignLicense: true, skuId: 'cafecafe-cafe-cafe-cafe-cafecafecafe' }), g, OB_ENV);
  assert.equal(r.verified, true); assert.equal(r.data.license.assigned, true);
  assert.equal(posts(g, '/users')[0].body.usageLocation, 'JP');
  const lic = posts(g, '/assignLicense')[0];
  assert.deepEqual(lic.body, { addLicenses: [{ skuId: SKU }], removeLicenses: [] }, 'a caller-supplied SKU is ignored');
  const bad = onboardGraph(ROLES, { failLicense: true });
  const r2 = await run(OB({ assignLicense: true }), bad, OB_ENV);
  assert.equal(r2.verified, false); assert.equal(r2.data.license.assigned, false); assert.equal(r2.data.created, true);
  assert.ok(!JSON.stringify(r2).includes('no free seats'), 'upstream error text is not echoed');
});

test('onboarding still needs approval, and status reports the new configuration flags', async () => {
  const g = onboardGraph(ROLES);
  await assert.rejects(() => run({ ...OB(), approvedByHuman: undefined }, g, OB_ENV), (e) => e.kind === 'approval_required');
  assert.equal(g.calls.length, 0);
  const st = await run({ operation: 'status' }, onboardGraph(ROLES), OB_ENV);
  assert.equal(st.data.config.welcomeAppUrlConfigured, true); assert.equal(st.data.config.defaultLicenseConfigured, true);
  assert.equal((await run({ operation: 'status' }, onboardGraph(ROLES), {})).data.config.defaultLicenseConfigured, false);
});
