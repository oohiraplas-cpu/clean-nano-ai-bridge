'use strict';
// graph_manage: Microsoft Graph (Entra ID / Outlook) through the same client-credentials app the SharePoint Graph client uses.
//  - READ operations are allowlisted GET endpoints only.
//  - WRITE operations (user_create / user_update / mail_send) need params.approvedByHuman === true. The OZ Router forwards that
//    flag only after it has verified a human-signed approval.
//  - Before calling Graph the granted application roles are read from the access token itself (names only; the token is never
//    returned or logged). A missing role is returned as a structured block (data.blocked) instead of being guessed around.
//  - Passwords are never returned or logged. Mail is limited to allowed recipient domains and a configured sender.
const crypto = require('crypto');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UPN = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}$/;

class GraphOpError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

// Microsoft Graph standard application role names. Any one of the listed roles is enough. Confirm in the tenant before granting.
const NEEDS = {
  user_get: ['User.Read.All', 'Directory.Read.All'],
  user_search: ['User.Read.All', 'Directory.Read.All'],
  user_groups: ['User.Read.All', 'GroupMember.Read.All', 'Directory.Read.All'],
  user_licenses: ['User.Read.All', 'Directory.Read.All'],
  group_list: ['Group.Read.All', 'GroupMember.Read.All', 'Directory.Read.All'],
  group_members: ['GroupMember.Read.All', 'Group.Read.All', 'Directory.Read.All'],
  license_list: ['Organization.Read.All', 'LicenseAssignment.Read.All', 'Directory.Read.All'],
  app_get: ['Application.Read.All', 'Directory.Read.All'],
  sp_get: ['Application.Read.All', 'Directory.Read.All'],
  permission_grants: ['Application.Read.All', 'Directory.Read.All'],
  user_verify: ['User.Read.All', 'Directory.Read.All'],
  license_available: ['Organization.Read.All', 'LicenseAssignment.Read.All', 'Directory.Read.All'],
  mail_sent_check: ['Mail.ReadBasic.All', 'Mail.Read'],
  user_create: ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  user_update: ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  mail_send: ['Mail.Send'],
};
const READ_OPS = ['status', 'user_verify', 'license_available', 'mail_sent_check', 'user_get', 'user_search', 'user_groups', 'user_licenses', 'group_list', 'group_members', 'license_list', 'app_get', 'sp_get', 'permission_grants'];
const WRITE_OPS = ['user_create', 'user_update', 'mail_send'];
const OPERATIONS = [...READ_OPS, ...WRITE_OPS];
const USER_FIELDS = 'id,displayName,givenName,surname,userPrincipalName,mail,accountEnabled,jobTitle,department,mobilePhone,officeLocation,usageLocation,createdDateTime,assignedLicenses';
const UPDATABLE = ['displayName', 'givenName', 'surname', 'jobTitle', 'department', 'mobilePhone', 'officeLocation', 'usageLocation', 'accountEnabled'];
const MAX_TOP = 25;
const MAX_MAIL_BODY = 8000;
const MAX_RECIPIENTS = 20;
const VERIFY_FIELDS = ['displayName', 'givenName', 'surname', 'userPrincipalName', 'mail', 'accountEnabled', 'jobTitle', 'department', 'mobilePhone', 'officeLocation', 'usageLocation'];
const CASE_INSENSITIVE = new Set(['userPrincipalName', 'mail']);
const WELCOME_SUBJECT = '【clean nano】アカウント発行のお知らせ';
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const enc = encodeURIComponent;
const odata = (s) => String(s).replace(/'/g, "''");
const top = (p) => Math.min(Math.max(Number.isInteger(Number(p.top)) ? Number(p.top) : 10, 1), MAX_TOP);
const csv = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function decodeRoles(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return { roles: Array.isArray(payload.roles) ? payload.roles : [], tenantId: payload.tid || null, appId: payload.appid || null, expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null };
  } catch (_) { return { roles: [], tenantId: null, appId: null, expiresAt: null, undecodable: true }; }
}

function blocked(op, granted, extra = {}) {
  return { verified: false, data: { blocked: true, kind: 'permission', operation: op, requiredPermissions: NEEDS[op], anyOf: true, grantedRoles: granted,
    adminPortal: 'Microsoft Entra admin center > App registrations > (the Bridge app) > API permissions > Add a permission > Microsoft Graph > Application permissions > Grant admin consent',
    humanApproval: 'Admin consent for the application permission (human only)', ...extra } };
}

const userRef = (p) => { const u = String(p.user || '').trim(); if (!GUID.test(u) && !UPN.test(u)) throw new GraphOpError('user must be an object id (GUID) or a user principal name', 'invalid_input'); return enc(u); };
const guidOf = (v, name) => { if (!GUID.test(String(v || ''))) throw new GraphOpError(`${name} must be a GUID`, 'invalid_input'); return String(v); };

async function run(p, deps = {}) {
  const op = p.operation;
  const env = deps.env || process.env;
  const graph = deps.graph;
  if (!graph) throw new GraphOpError('Graph settings missing (tenant / client id / secret)', 'config');
  const info = decodeRoles(await graph.token());
  const mayWrite = WRITE_OPS.includes(op);

  if (op === 'status') {
    // An operation with no entry in NEEDS (status itself) needs no Graph role, so it is always granted.
    const checks = Object.fromEntries(OPERATIONS.map((o) => [o, { anyOf: NEEDS[o] ?? [], granted: !NEEDS[o] || NEEDS[o].some((r) => info.roles.includes(r)) }]));
    return { verified: true, data: { tenantId: info.tenantId, appId: info.appId, grantedRoles: info.roles, tokenExpiresAt: info.expiresAt, rolesReadable: !info.undecodable, operations: checks,
      config: { mailSenderConfigured: Boolean(env.GRAPH_MAIL_SENDER), mailAllowedDomainsConfigured: csv(env.GRAPH_MAIL_ALLOWED_DOMAINS).length > 0, upnAllowedDomainsConfigured: csv(env.GRAPH_UPN_ALLOWED_DOMAINS).length > 0, welcomeAppUrlConfigured: /^https:\/\//.test(String(env.GRAPH_WELCOME_APP_URL || '')), defaultLicenseConfigured: GUID.test(String(env.GRAPH_DEFAULT_LICENSE_SKU || '')) } } };
  }
  if (!OPERATIONS.includes(op)) throw new GraphOpError(`unknown operation "${op}"`, 'invalid_input');
  // Permission pre-check from the token itself. If the roles cannot be read, let Graph answer instead of guessing.
  if (!info.undecodable && !NEEDS[op].some((role) => info.roles.includes(role))) return blocked(op, info.roles);
  if (op === 'user_create' && p.welcomeMail === true && !info.undecodable && !info.roles.includes('Mail.Send')) return blocked(op, info.roles, { requiredPermissions: ['Mail.Send'], anyOf: false, needFor: 'welcomeMail' });
  if (mayWrite && p.approvedByHuman !== true) throw new GraphOpError('approval required: this operation changes the directory or sends mail', 'approval_required', { approval: `graph_manage.${op}` });

  switch (op) {
    case 'user_get': return { verified: true, data: await graph.get(`/users/${userRef(p)}?$select=${USER_FIELDS}`) };
    case 'user_search': {
      const s = odata(String(p.search || '').trim());
      if (!s) throw new GraphOpError('search is required', 'invalid_input');
      const r = await graph.get(`/users?$filter=${enc(`startswith(displayName,'${s}') or startswith(userPrincipalName,'${s}') or startswith(mail,'${s}')`)}&$select=${USER_FIELDS}&$top=${top(p)}`, { ConsistencyLevel: 'eventual' });
      return { verified: true, data: { count: (r.value || []).length, users: r.value || [] } };
    }
    case 'user_verify': return verifyUser(p, graph, userRef(p));
    case 'license_available': {
      const r = await graph.get('/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus');
      const needle = String(p.search || '').toLowerCase();
      const skus = (r.value || []).filter((k) => !needle || String(k.skuPartNumber).toLowerCase().includes(needle)).map((k) => {
        const enabled = k.prepaidUnits && Number.isFinite(k.prepaidUnits.enabled) ? k.prepaidUnits.enabled : null;
        return { skuId: k.skuId, skuPartNumber: k.skuPartNumber, enabled, consumed: k.consumedUnits ?? null, available: enabled === null ? null : Math.max(enabled - (k.consumedUnits ?? 0), 0), capabilityStatus: k.capabilityStatus };
      });
      return { verified: true, data: { count: skus.length, skus, note: 'availability only: licenses are never assigned or purchased here' } };
    }
    case 'mail_sent_check': return { verified: true, data: await sentCheck(p, env, graph, p.subject) };
    case 'user_groups': { const r = await graph.get(`/users/${userRef(p)}/memberOf?$select=id,displayName,mail,securityEnabled&$top=${top(p)}`); return { verified: true, data: { count: (r.value || []).length, groups: r.value || [] } }; }
    case 'user_licenses': { const r = await graph.get(`/users/${userRef(p)}/licenseDetails`); return { verified: true, data: { count: (r.value || []).length, licenses: (r.value || []).map((l) => ({ skuId: l.skuId, skuPartNumber: l.skuPartNumber })) } }; }
    case 'group_list': {
      const f = p.search ? `&$filter=${enc(`startswith(displayName,'${odata(p.search)}')`)}` : '';
      const r = await graph.get(`/groups?$select=id,displayName,mail,securityEnabled${f}&$top=${top(p)}`, { ConsistencyLevel: 'eventual' });
      return { verified: true, data: { count: (r.value || []).length, groups: r.value || [] } };
    }
    case 'group_members': { const r = await graph.get(`/groups/${guidOf(p.group, 'group')}/members?$select=id,displayName,userPrincipalName&$top=${top(p)}`); return { verified: true, data: { count: (r.value || []).length, members: r.value || [] } }; }
    case 'license_list': { const r = await graph.get('/subscribedSkus?$select=skuId,skuPartNumber,consumedUnits,prepaidUnits,capabilityStatus'); return { verified: true, data: { count: (r.value || []).length, skus: r.value || [] } }; }
    case 'app_get': { const r = await graph.get(`/applications?$filter=${enc(`appId eq '${guidOf(p.appId, 'appId')}'`)}&$select=id,appId,displayName,signInAudience,requiredResourceAccess`); return { verified: true, data: { count: (r.value || []).length, applications: r.value || [] } }; }
    case 'sp_get': { const r = await graph.get(`/servicePrincipals?$filter=${enc(`appId eq '${guidOf(p.appId, 'appId')}'`)}&$select=id,appId,displayName,accountEnabled`); return { verified: true, data: { count: (r.value || []).length, servicePrincipals: r.value || [] } }; }
    case 'permission_grants': {
      const sp = await graph.get(`/servicePrincipals?$filter=${enc(`appId eq '${guidOf(p.appId, 'appId')}'`)}&$select=id`);
      const id = sp.value && sp.value[0] && sp.value[0].id;
      if (!id) throw new GraphOpError('service principal not found', 'not_found');
      const r = await graph.get(`/servicePrincipals/${id}/appRoleAssignments?$top=${top(p)}`);
      return { verified: true, data: { count: (r.value || []).length, assignments: (r.value || []).map((a) => ({ resourceDisplayName: a.resourceDisplayName, appRoleId: a.appRoleId, createdDateTime: a.createdDateTime })) } };
    }
    case 'user_create': return createUser(p, env, graph, deps);
    case 'user_update': return updateUser(p, graph);
    case 'mail_send': return sendMail(p, env, graph, info.roles, deps.sleep || defaultSleep);
    default: throw new GraphOpError(`unknown operation "${op}"`, 'invalid_input');
  }
}

async function verifyUser(p, graph, ref) {
  const expected = p.expected && typeof p.expected === 'object' ? p.expected : null;
  if (!expected || !Object.keys(expected).length) throw new GraphOpError('expected is required (fields to compare)', 'invalid_input');
  const bad = Object.keys(expected).filter((k) => !VERIFY_FIELDS.includes(k));
  if (bad.length) throw new GraphOpError(`fields not verifiable: ${bad.join(', ')}`, 'invalid_input');
  const actual = await graph.get(`/users/${ref}?$select=${USER_FIELDS}`);
  const norm = (k, v) => (CASE_INSENSITIVE.has(k) && typeof v === 'string' ? v.toLowerCase() : v);
  const mismatched = [];
  for (const k of Object.keys(expected)) if (norm(k, actual[k]) !== norm(k, expected[k])) mismatched.push(k);
  return { verified: mismatched.length === 0, data: { matched: Object.keys(expected).filter((k) => norm(k, actual[k]) === norm(k, expected[k])),
    mismatched: mismatched.map((k) => ({ field: k, expected: expected[k], actual: actual[k] ?? null })), user: actual } };
}

async function sentCheck(p, env, graph, subject) {
  const sender = String(env.GRAPH_MAIL_SENDER || '');
  if (!UPN.test(sender)) throw new GraphOpError('GRAPH_MAIL_SENDER must be configured', 'config');
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200) throw new GraphOpError('subject is required (<=200)', 'invalid_input');
  const minutes = Math.min(Math.max(Number.isInteger(Number(p.sinceMinutes)) ? Number(p.sinceMinutes) : 30, 1), 1440);
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  const r = await graph.get(`/users/${enc(sender)}/mailFolders/sentitems/messages?$filter=${enc(`sentDateTime ge ${since}`)}&$orderby=sentDateTime desc&$select=subject,sentDateTime,toRecipients&$top=${MAX_TOP}`);
  const messages = (r.value || []).filter((m) => m.subject === subject).map((m) => ({ subject: m.subject, sentDateTime: m.sentDateTime, to: (m.toRecipients || []).map((x) => x.emailAddress && x.emailAddress.address) }));
  return { found: messages.length > 0, count: messages.length, messages, searchedMinutes: minutes };
}

// 20 characters from all four classes, drawn with crypto.randomInt. The value is only ever placed in the welcome mail body.
function generatePassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; const L = 'abcdefghijkmnpqrstuvwxyz'; const D = '23456789'; const S = '!#$%&*+-=?@';
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(U), pick(L), pick(D), pick(S)];
  while (chars.length < 20) chars.push(pick(U + L + D + S));
  for (let i = chars.length - 1; i > 0; i -= 1) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}
const sanitizeNickname = (local) => String(local || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '').slice(0, 64);
const oneLine = (v, max) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

// Fixed template: the caller controls only the display name (single line). Link and sender come from configuration.
// Official Power Apps mobile player store pages (Microsoft Learn "Install the Power Apps mobile app").
const POWER_APPS_IOS_URL = 'https://apps.apple.com/us/app/power-apps/id1047318566';
const POWER_APPS_ANDROID_URL = 'https://play.google.com/store/apps/details?id=com.microsoft.msapps';

function welcomeBody(displayName, upn, password, appUrl) {
  return [`${oneLine(displayName, 60)} 様`, '', 'アカウントを発行しました。次の情報でサインインしてください。', '', `サインイン名: ${upn}`, `初期パスワード: ${password}`, '',
    '初回のサインイン時に、必ずパスワードを変更してください。このメールは、変更後に削除してください。', '',
    '■ アプリの使い方（スマートフォン）',
    '1. 「Power Apps」アプリをインストールしてください。',
    `   iPhone: ${POWER_APPS_IOS_URL}`,
    `   Android: ${POWER_APPS_ANDROID_URL}`,
    '2. アプリを開き、上のサインイン名と初期パスワードでサインインします（パスワードの変更を求められます）。',
    '3. 一覧に「clean nano kk」が表示されます。表示されない場合は、「すべてのアプリ」で検索してください。',
    '', '■ パソコン・ブラウザから使う場合', `アプリ: ${appUrl}`, '',
    '心当たりがない場合は、このメールに返信せず、管理者へ連絡してください。'].join('\n');
}

async function createUser(p, env, graph, deps = {}) {
  const u = p.user && typeof p.user === 'object' ? p.user : null;
  if (!u) throw new GraphOpError('user object is required', 'invalid_input');
  const domains = csv(env.GRAPH_UPN_ALLOWED_DOMAINS);
  if (!domains.length) throw new GraphOpError('GRAPH_UPN_ALLOWED_DOMAINS is not configured; user creation is refused', 'config');
  const welcome = p.welcomeMail === true;
  const license = p.assignLicense === true;
  const sender = String(env.GRAPH_MAIL_SENDER || '');
  const appUrl = String(env.GRAPH_WELCOME_APP_URL || '');
  const skuId = String(env.GRAPH_DEFAULT_LICENSE_SKU || '');
  // Every configuration problem is reported before anything is created.
  if (welcome && (!UPN.test(sender) || !/^https:\/\//.test(appUrl))) throw new GraphOpError('GRAPH_MAIL_SENDER and GRAPH_WELCOME_APP_URL (https) must be configured for the welcome mail', 'config');
  if (license && !GUID.test(skuId)) throw new GraphOpError('GRAPH_DEFAULT_LICENSE_SKU must be configured to assign a license (a caller can never pick the SKU)', 'config');
  const contact = typeof u.contactEmail === 'string' ? u.contactEmail.trim() : '';
  if (contact && !UPN.test(contact)) throw new GraphOpError('contactEmail is not a valid address', 'invalid_input');
  if (welcome && !contact) throw new GraphOpError('contactEmail is required to send the welcome mail', 'invalid_input');
  let upn = String(u.userPrincipalName || '');
  let nickname = typeof u.mailNickname === 'string' ? sanitizeNickname(u.mailNickname) : '';
  if (!upn) {
    if (!contact) throw new GraphOpError('userPrincipalName or contactEmail is required', 'invalid_input');
    nickname = nickname || sanitizeNickname(contact.split('@')[0]);
    if (!nickname) throw new GraphOpError('a user name cannot be derived from contactEmail', 'invalid_input');
    upn = `${nickname}@${domains[0]}`;
  }
  if (!UPN.test(upn) || !domains.includes(upn.split('@')[1].toLowerCase())) throw new GraphOpError('userPrincipalName is missing, invalid, or outside the allowed domains', 'invalid_input');
  nickname = nickname || sanitizeNickname(upn.split('@')[0]);
  if (typeof u.displayName !== 'string' || !u.displayName.trim() || !nickname) throw new GraphOpError('displayName is required', 'invalid_input');
  const supplied = u.passwordProfile && u.passwordProfile.password;
  if (supplied !== undefined && (typeof supplied !== 'string' || supplied.length < 12)) throw new GraphOpError('passwordProfile.password must be 12+ chars (or omit it to have one generated)', 'invalid_input');
  if (welcome && supplied !== undefined) throw new GraphOpError('a supplied password cannot be mailed; omit it so one is generated', 'invalid_input');
  let exists = false;
  try { await graph.get(`/users/${enc(upn)}?$select=id`); exists = true; } catch (e) { if (e.status !== 404) throw e; }
  if (exists) throw new GraphOpError('a user with this user principal name already exists; nothing was changed', 'conflict');
  const generated = supplied === undefined;
  const password = generated ? (deps.randomPassword || generatePassword)() : supplied;
  const usageLocation = u.usageLocation ? String(u.usageLocation) : (license ? String(env.GRAPH_DEFAULT_USAGE_LOCATION || 'JP') : '');
  const body = { accountEnabled: u.accountEnabled !== false, displayName: u.displayName, mailNickname: nickname, userPrincipalName: upn,
    ...(usageLocation ? { usageLocation } : {}), ...(u.jobTitle ? { jobTitle: String(u.jobTitle) } : {}), ...(u.department ? { department: String(u.department) } : {}), ...(contact ? { otherMails: [contact] } : {}),
    passwordProfile: { password, forceChangePasswordNextSignIn: !(u.passwordProfile && u.passwordProfile.forceChangePasswordNextSignIn === false) } };
  const created = await graph.post('/users', body);
  const result = { created: true, passwordReturned: false, passwordGenerated: generated, derivedUserPrincipalName: !u.userPrincipalName };
  let licenseOk = true;
  if (license) {
    try { await graph.post(`/users/${enc(created.id || upn)}/assignLicense`, { addLicenses: [{ skuId }], removeLicenses: [] }); result.license = { requested: true, assigned: true }; } catch (_) { licenseOk = false; result.license = { requested: true, assigned: false, note: 'the license could not be assigned (no free seat or missing permission); the user was created without it' }; }
  }
  const again = await graph.get(`/users/${enc(created.id || upn)}?$select=${USER_FIELDS}`);
  const verified = Boolean(again.userPrincipalName && again.userPrincipalName.toLowerCase() === upn.toLowerCase() && again.displayName === u.displayName);
  let mailOk = true;
  if (welcome) {
    try {
      await graph.post(`/users/${enc(sender)}/sendMail`, { message: { subject: WELCOME_SUBJECT, body: { contentType: 'Text', content: welcomeBody(u.displayName, upn, password, appUrl) }, toRecipients: [{ emailAddress: { address: contact } }] }, saveToSentItems: false });
      result.welcomeMail = { requested: true, accepted: true, note: 'Graph accepted the mail (202). It contains the sign-in name and the generated password; neither is returned here.' };
    } catch (_) {
      mailOk = false;
      result.welcomeMail = { requested: true, accepted: false };
      result.needsAdmin = 'The account exists but the welcome mail failed and nobody knows the generated password. Reset the password in the Entra admin center and hand it over.';
    }
  }
  return { verified: verified && licenseOk && mailOk, data: { ...result, user: again } };
}

async function updateUser(p, graph) {
  const ref = userRef(p);
  const patch = p.patch && typeof p.patch === 'object' ? p.patch : null;
  if (!patch || !Object.keys(patch).length) throw new GraphOpError('patch is required', 'invalid_input');
  const bad = Object.keys(patch).filter((k) => !UPDATABLE.includes(k));
  if (bad.length) throw new GraphOpError(`fields not updatable: ${bad.join(', ')}`, 'invalid_input');
  await graph.patch(`/users/${ref}`, patch);
  const again = await graph.get(`/users/${ref}?$select=${USER_FIELDS}`);
  const mismatched = Object.keys(patch).filter((k) => again[k] !== patch[k]);
  return { verified: mismatched.length === 0, data: { updated: Object.keys(patch), mismatched, user: again } };
}

async function sendMail(p, env, graph, roles = [], sleep = defaultSleep) {
  const sender = String(env.GRAPH_MAIL_SENDER || '');
  const domains = csv(env.GRAPH_MAIL_ALLOWED_DOMAINS);
  if (!UPN.test(sender) || !domains.length) throw new GraphOpError('GRAPH_MAIL_SENDER and GRAPH_MAIL_ALLOWED_DOMAINS must be configured; mail is refused', 'config');
  const to = Array.isArray(p.to) ? p.to.map(String) : [];
  if (!to.length || to.length > MAX_RECIPIENTS || !to.every((a) => UPN.test(a) && domains.includes(a.split('@')[1].toLowerCase()))) throw new GraphOpError('recipients are missing, too many, or outside the allowed domains', 'invalid_input');
  if (typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > 200 || typeof p.body !== 'string' || !p.body.trim() || p.body.length > MAX_MAIL_BODY) throw new GraphOpError('subject (<=200) and plain-text body (<=8000) are required', 'invalid_input');
  await graph.post(`/users/${enc(sender)}/sendMail`, { message: { subject: p.subject, body: { contentType: 'Text', content: p.body }, toRecipients: to.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: true });
  // Graph answers 202 with no message id. Confirm through Sent Items only when the app may read mail; otherwise report partial.
  if (NEEDS.mail_sent_check.some((role) => roles.includes(role))) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await sleep(1500);
      const check = await sentCheck({ sinceMinutes: 10 }, env, graph, p.subject);
      if (check.found) return { verified: true, data: { accepted: true, recipients: to.length, deliveryConfirmed: 'found in Sent Items', sentItems: check.messages[0] } };
    }
    return { verified: false, data: { accepted: true, recipients: to.length, note: 'Graph accepted the request (202) but the message was not found in Sent Items yet.' } };
  }
  return { verified: false, data: { accepted: true, recipients: to.length, note: 'Graph accepted the request (202). Delivery cannot be confirmed because the app has no Mail.ReadBasic.All / Mail.Read.' } };
}

const DEF = {
  name: 'graph_manage',
  description: 'Microsoft Graph(Entra ID / Outlook)を1ツールで実行(operation指定)。読み取り=status(付与済み権限)/user_verify(期待値との照合)/license_available(空きライセンス数)/mail_sent_check(送信済みの確認)/user_get/user_search/user_groups/user_licenses/group_list/group_members/license_list/app_get/sp_get/permission_grants。書込=user_create(連絡先メールから会社ドメインのユーザー名を作成。初期パスワードはサーバー内で自動生成し、案内メールで本人へ。返しません)/user_update/mail_send は approvedByHuman:true 必須。必要な権限が付与されていない場合は推測せず、必要な権限を構造化して返します。パスワードは返しません。',
  inputSchema: { type: 'object', properties: {
    operation: { type: 'string', enum: OPERATIONS }, user: { type: ['string', 'object'] }, search: { type: 'string' }, top: { type: 'integer', minimum: 1, maximum: MAX_TOP }, group: { type: 'string' },
    appId: { type: 'string' }, expected: { type: 'object' }, sinceMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, patch: { type: 'object' }, to: { type: 'array', items: { type: 'string' }, maxItems: MAX_RECIPIENTS }, subject: { type: 'string' }, body: { type: 'string' },
    welcomeMail: { type: 'boolean' }, assignLicense: { type: 'boolean' }, approvedByHuman: { type: 'boolean' }, approver: { type: 'string' } }, required: ['operation'], additionalProperties: false },
};

module.exports = { run, DEF, OPERATIONS, READ_OPS, WRITE_OPS, NEEDS, decodeRoles, GraphOpError };
