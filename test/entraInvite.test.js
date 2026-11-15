'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ei = require('../src/entraInvite');
const { MCP_METHODS, MCP_PUBLIC_TOOLS, PUBLISHED_TOOLS } = require('../src/server');

const jwt = (roles) => `x.${Buffer.from(JSON.stringify({ roles, tid: 't', appid: 'a', exp: 4102444800 })).toString('base64url')}.y`;
const ENV = { AZURE_TENANT_ID: 'tenant-1', AZURE_CLIENT_ID: 'client-1', AZURE_CLIENT_SECRET: 'sekret-value' };
const OID = '11111111-2222-3333-4444-555555555555';

function fakeFetch({ roles = ['User.Invite.All'], invite, getUser } = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init });
    const res = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/oauth2/v2.0/token')) return res(200, { access_token: jwt(roles), expires_in: 3600 });
    if (url.endsWith('/invitations')) return invite ? invite() : res(201, { id: 'inv-1', status: 'PendingAcceptance', invitedUserType: 'Guest', inviteRedeemUrl: 'https://redeem.example/secret', invitedUser: { id: OID } });
    if (url.includes('/users/')) return getUser ? getUser() : res(200, { id: OID, displayName: '山田 太郎', mail: 'taro@example.com', userType: 'Guest', externalUserState: 'PendingAcceptance' });
    throw new Error(`unexpected ${url}`);
  };
  return { calls, impl };
}
const go = (params, f, env = ENV) => ei.run(params, { env, fetchImpl: f.impl, audit: () => {} });

test('schema matches the contract and the tool is dispatchable without changing the published surface', () => {
  assert.deepEqual(ei.DEF.inputSchema, { type: 'object', properties: { displayName: { type: 'string', description: '招待する利用者の氏名' }, email: { type: 'string', format: 'email', description: '招待先メールアドレス' } }, required: ['displayName', 'email'], additionalProperties: false });
  assert.ok(MCP_METHODS.includes('entra_invite_user'));
  assert.ok(MCP_PUBLIC_TOOLS.some((t) => t.name === 'entra_invite_user'));
  assert.ok(!PUBLISHED_TOOLS.some((t) => t.name === 'entra_invite_user'), 'tools/list (published) is unchanged');
});

test('happy path: token -> invitation -> Object ID -> re-read; mail is sent by Microsoft; secrets are not returned', async () => {
  const f = fakeFetch();
  const r = await go({ displayName: '山田 太郎', email: 'taro@example.com' }, f);
  assert.equal(r.status, 'ok'); assert.equal(r.verified, true);
  assert.equal(r.data.objectId, OID); assert.equal(r.data.invitationMailRequested, true);
  const [tok, inv] = f.calls;
  assert.equal(tok.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.ok(tok.url.includes('/tenant-1/oauth2/v2.0/token'));
  const form = new URLSearchParams(tok.init.body);
  assert.equal(form.get('scope'), 'https://graph.microsoft.com/.default'); assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(inv.url, 'https://graph.microsoft.com/v1.0/invitations');
  assert.match(inv.init.headers.Authorization, /^Bearer /);
  assert.deepEqual(JSON.parse(inv.init.body), { invitedUserDisplayName: '山田 太郎', invitedUserEmailAddress: 'taro@example.com', inviteRedirectUrl: ei.DEFAULT_REDIRECT_URL, sendInvitationMessage: true });
  const out = JSON.stringify(r);
  assert.ok(!out.includes('sekret-value') && !out.includes('redeem.example') && !out.includes('Bearer'));
});

test('invalid input is rejected before any request', async () => {
  const f = fakeFetch();
  for (const p of [{}, { displayName: 'a' }, { email: 'a@b.com' }, { displayName: '', email: 'a@b.com' }, { displayName: 'a', email: 'not-mail' }, { displayName: 'a', email: 'a@b.com', extra: 1 }, null, 'x']) {
    const r = await go(p, f); assert.equal(r.status, 'error'); assert.equal(r.errorKind, 'invalid_input');
  }
  assert.equal(f.calls.length, 0);
});

test('missing Graph settings and a missing role are reported without calling the invitation API', async () => {
  const f0 = fakeFetch();
  const c = await go({ displayName: 'a', email: 'a@b.com' }, f0, {});
  assert.equal(c.errorKind, 'config'); assert.equal(f0.calls.length, 0);
  const f1 = fakeFetch({ roles: ['Sites.ReadWrite.All'] });
  const b = await go({ displayName: 'a', email: 'a@b.com' }, f1);
  assert.equal(b.status, 'error'); assert.equal(b.data.blocked, true); assert.ok(b.data.requiredPermissions.includes('User.Invite.All'));
  assert.ok(!f1.calls.some((x) => x.url.endsWith('/invitations')));
});

test('Graph failure is a classified error; a failed re-read keeps the Object ID and reports partial', async () => {
  const fail = fakeFetch({ invite: async () => ({ ok: false, status: 403, text: async () => '{"error":{"code":"Authorization_RequestDenied"}}' }) });
  const e = await go({ displayName: 'a', email: 'a@b.com' }, fail);
  assert.equal(e.status, 'error'); assert.equal(e.errorKind, 'permission');
  const part = fakeFetch({ getUser: async () => ({ ok: false, status: 403, text: async () => '{}' }) });
  const p = await go({ displayName: 'a', email: 'a@b.com' }, part);
  assert.equal(p.status, 'partial'); assert.equal(p.data.objectId, OID); assert.ok(p.data.verifyNote);
});

test('ENTRA_INVITE_REDIRECT_URL must be https', async () => {
  const f = fakeFetch();
  const r = await go({ displayName: 'a', email: 'a@b.com' }, f, { ...ENV, ENTRA_INVITE_REDIRECT_URL: 'http://x' });
  assert.equal(r.errorKind, 'config');
  const ok = await go({ displayName: 'a', email: 'a@b.com' }, fakeFetch(), { ...ENV, ENTRA_INVITE_REDIRECT_URL: 'https://app.example.com/' });
  assert.equal(ok.status, 'ok');
});
