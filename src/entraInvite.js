'use strict';
// entra_invite_user: invite an external user to Microsoft Entra ID as a guest (Microsoft Graph POST /invitations).
//  - Input is exactly { displayName, email }. Nothing else is accepted.
//  - One call: token (client credentials) -> invitation (Microsoft sends the invitation mail) -> guest user's Object ID -> re-read check.
//  - No Power Automate / HTTP connector / SharePoint sync flow is involved.
//  - The client secret and the access token are never returned or logged. The redemption URL is not returned either.
//  - The granted application roles are read from the token itself first; a missing role is returned as a structured
//    block instead of calling Graph and guessing.
const crypto = require('crypto');
const { decodeRoles } = require('./graphManage');

const TOOL_NAME = 'entra_invite_user';
const DEFAULT_REDIRECT_URL = 'https://myapplications.microsoft.com';
// Any one of these application roles can create an invitation.
const REQUIRED_ROLES = ['User.Invite.All', 'User.ReadWrite.All', 'Directory.ReadWrite.All'];
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MAX_NAME = 256;

const DEF = {
  name: TOOL_NAME,
  description: '名前とメールアドレスを受け取り、Microsoft Entra IDへゲストとして招待し、生成されたObject IDを返す。',
  displayName: 'Microsoft Entra外部ユーザー招待',
  inputSchema: {
    type: 'object',
    properties: {
      displayName: { type: 'string', description: '招待する利用者の氏名' },
      email: { type: 'string', format: 'email', description: '招待先メールアドレス' },
    },
    required: ['displayName', 'email'],
    additionalProperties: false,
  },
};

class InviteError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

function validate(params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
  if (!p) throw new InviteError('入力はオブジェクトで指定してください', 'invalid_input');
  const extra = Object.keys(p).filter((k) => k !== 'displayName' && k !== 'email');
  if (extra.length) throw new InviteError(`未対応の項目です: ${extra.join(', ')}`, 'invalid_input');
  const displayName = typeof p.displayName === 'string' ? p.displayName.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!displayName || displayName.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(displayName)) throw new InviteError('displayName（氏名）は1〜256文字の文字列で指定してください', 'invalid_input');
  const email = typeof p.email === 'string' ? p.email.trim() : '';
  if (!EMAIL.test(email) || email.length > 254) throw new InviteError('email（メールアドレス）の形式が正しくありません', 'invalid_input');
  return { displayName, email };
}

function settings(env) {
  return {
    tenantId: env.SHAREPOINT_TENANT_ID || env.AZURE_TENANT_ID,
    clientId: env.SHAREPOINT_CLIENT_ID || env.AZURE_CLIENT_ID,
    clientSecret: env.SHAREPOINT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET,
  };
}

function redirectUrl(env) {
  const v = String(env.ENTRA_INVITE_REDIRECT_URL || '').trim();
  if (!v) return DEFAULT_REDIRECT_URL;
  if (!/^https:\/\//i.test(v)) throw new InviteError('ENTRA_INVITE_REDIRECT_URL は https:// で始まるURLにしてください', 'config');
  return v;
}

async function getToken(cfg, fetchImpl) {
  const r = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }).toString(),
  });
  let j = {};
  try { j = await r.json(); } catch (_) { /* handled below */ }
  if (!j.access_token) throw new InviteError(`Graphトークンを取得できませんでした: ${j.error || r.status}`, 'permission');
  return j.access_token;
}

async function graphCall(fetchImpl, method, url, token, body) {
  const r = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    let code = '';
    try { code = (JSON.parse(text).error || {}).code || ''; } catch (_) { /* keep empty */ }
    throw new InviteError(`Graph ${method} ${url.split('?')[0].replace('https://graph.microsoft.com/v1.0', '')} ${r.status}${code ? ` ${code}` : ''}`, r.status === 401 || r.status === 403 ? 'permission' : r.status === 429 || r.status >= 500 ? 'transient' : r.status === 400 ? 'invalid_input' : 'unknown', { status: r.status });
  }
  return text ? JSON.parse(text) : {};
}

async function invite(input, env, fetchImpl) {
  const cfg = settings(env);
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) throw new InviteError('Graph設定（テナントID・クライアントID・シークレット）が未設定です', 'config');
  const redirect = redirectUrl(env);
  const token = await getToken(cfg, fetchImpl);
  const info = decodeRoles(token);
  if (!info.undecodable && !REQUIRED_ROLES.some((r) => info.roles.includes(r))) {
    return { verified: false, data: { blocked: true, kind: 'permission', requiredPermissions: REQUIRED_ROLES, anyOf: true, grantedRoles: info.roles,
      adminPortal: 'Microsoft Entra admin center > App registrations > (the Bridge app) > API permissions > Add a permission > Microsoft Graph > Application permissions > User.Invite.All > Grant admin consent',
      humanApproval: 'Admin consent for the application permission (human only)' } };
  }
  const inv = await graphCall(fetchImpl, 'POST', 'https://graph.microsoft.com/v1.0/invitations', token, {
    invitedUserDisplayName: input.displayName,
    invitedUserEmailAddress: input.email,
    inviteRedirectUrl: redirect,
    sendInvitationMessage: true,
  });
  const objectId = inv.invitedUser && inv.invitedUser.id;
  if (!objectId) throw new InviteError('招待は受け付けられましたがObject IDを取得できませんでした', 'unknown');
  const data = { invited: true, objectId, invitationId: inv.id || null, displayName: input.displayName, email: input.email,
    invitedUserType: inv.invitedUserType || 'Guest', status: inv.status || null, invitationMailRequested: true, invitationMailSentBy: 'Microsoft Entra' };
  let verified = false;
  try {
    const u = await graphCall(fetchImpl, 'GET', `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(objectId)}?$select=id,displayName,mail,userType,externalUserState`, token);
    verified = u.id === objectId;
    data.guest = { id: u.id, displayName: u.displayName, mail: u.mail || null, userType: u.userType, externalUserState: u.externalUserState || null };
  } catch (e) {
    data.verifyNote = '招待は作成済みですが、ゲストユーザーの再取得による確認はできませんでした（User.Read.All 等の権限不足の可能性）。';
  }
  return { verified, data };
}

async function run(params, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const t0 = Date.now();
  const operationId = `ei_${crypto.randomUUID()}`;
  const auditFn = deps.audit || ((rec) => { try { require('./platformManage')._internal.audit(env, rec); } catch (_) { /* audit must never break the call */ } });
  try {
    const input = validate(params);
    const r = await invite(input, env, fetchImpl);
    const blocked = Boolean(r.data && r.data.blocked);
    const status = blocked ? 'error' : r.verified ? 'ok' : 'partial';
    const res = { status, verified: r.verified, operationId, tool: TOOL_NAME, data: r.data, ...(blocked ? { errorKind: 'permission' } : {}), elapsedMs: Date.now() - t0 };
    auditFn({ opId: operationId, tool: TOOL_NAME, status, verified: r.verified, objectId: r.data.objectId, elapsedMs: res.elapsedMs });
    return res;
  } catch (e) {
    const kind = e.kind || 'unknown';
    const res = { status: 'error', verified: false, operationId, tool: TOOL_NAME, errorKind: kind, error: String(e.message).slice(0, 400), elapsedMs: Date.now() - t0 };
    auditFn({ opId: operationId, tool: TOOL_NAME, status: 'error', errorKind: kind, error: res.error.slice(0, 200) });
    return res;
  }
}

module.exports = { run, DEF, TOOL_NAME, validate, REQUIRED_ROLES, DEFAULT_REDIRECT_URL };
