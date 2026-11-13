'use strict';
// graph_manage: Microsoft Graph (Entra ID / Outlook) through the same client-credentials app the SharePoint Graph client uses.
//  - READ operations are allowlisted GET endpoints only.
//  - WRITE operations (user_create / user_update / mail_send) need params.approvedByHuman === true. The OZ Router forwards that
//    flag only after it has verified a human-signed approval.
//  - Before calling Graph the granted application roles are read from the access token itself (names only; the token is never
//    returned or logged). A missing role is returned as a structured block (data.blocked) instead of being guessed around.
//  - Passwords are never returned or logged. Mail is limited to allowed recipient domains and a configured sender.
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
  user_create: ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  user_update: ['User.ReadWrite.All', 'Directory.ReadWrite.All'],
  mail_send: ['Mail.Send'],
};
const READ_OPS = ['status', 'user_get', 'user_search', 'user_groups', 'user_licenses', 'group_list', 'group_members', 'license_list', 'app_get', 'sp_get', 'permission_grants'];
const WRITE_OPS = ['user_create', 'user_update', 'mail_send'];
const OPERATIONS = [...READ_OPS, ...WRITE_OPS];
const USER_FIELDS = 'id,displayName,givenName,surname,userPrincipalName,mail,accountEnabled,jobTitle,department,mobilePhone,officeLocation,usageLocation,createdDateTime,assignedLicenses';
const UPDATABLE = ['displayName', 'givenName', 'surname', 'jobTitle', 'department', 'mobilePhone', 'officeLocation', 'usageLocation', 'accountEnabled'];
const MAX_TOP = 25;
const MAX_MAIL_BODY = 8000;
const MAX_RECIPIENTS = 20;

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
    const checks = Object.fromEntries(OPERATIONS.map((o) => [o, { anyOf: NEEDS[o] ?? [], granted: (NEEDS[o] ?? []).some((r) => info.roles.includes(r)) }]));
    return { verified: true, data: { tenantId: info.tenantId, appId: info.appId, grantedRoles: info.roles, tokenExpiresAt: info.expiresAt, rolesReadable: !info.undecodable, operations: checks,
      config: { mailSenderConfigured: Boolean(env.GRAPH_MAIL_SENDER), mailAllowedDomainsConfigured: csv(env.GRAPH_MAIL_ALLOWED_DOMAINS).length > 0, upnAllowedDomainsConfigured: csv(env.GRAPH_UPN_ALLOWED_DOMAINS).length > 0 } } };
  }
  if (!OPERATIONS.includes(op)) throw new GraphOpError(`unknown operation "${op}"`, 'invalid_input');
  // Permission pre-check from the token itself. If the roles cannot be read, let Graph answer instead of guessing.
  if (!info.undecodable && !NEEDS[op].some((role) => info.roles.includes(role))) return blocked(op, info.roles);
  if (mayWrite && p.approvedByHuman !== true) throw new GraphOpError('approval required: this operation changes the directory or sends mail', 'approval_required', { approval: `graph_manage.${op}` });

  switch (op) {
    case 'user_get': return { verified: true, data: await graph.get(`/users/${userRef(p)}?$select=${USER_FIELDS}`) };
    case 'user_search': {
      const s = odata(String(p.search || '').trim());
      if (!s) throw new GraphOpError('search is required', 'invalid_input');
      const r = await graph.get(`/users?$filter=${enc(`startswith(displayName,'${s}') or startswith(userPrincipalName,'${s}') or startswith(mail,'${s}')`)}&$select=${USER_FIELDS}&$top=${top(p)}`, { ConsistencyLevel: 'eventual' });
      return { verified: true, data: { count: (r.value || []).length, users: r.value || [] } };
    }
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
    case 'user_create': return createUser(p, env, graph);
    case 'user_update': return updateUser(p, graph);
    case 'mail_send': return sendMail(p, env, graph);
    default: throw new GraphOpError(`unknown operation "${op}"`, 'invalid_input');
  }
}

async function createUser(p, env, graph) {
  const u = p.user && typeof p.user === 'object' ? p.user : null;
  if (!u) throw new GraphOpError('user object is required', 'invalid_input');
  const domains = csv(env.GRAPH_UPN_ALLOWED_DOMAINS);
  if (!domains.length) throw new GraphOpError('GRAPH_UPN_ALLOWED_DOMAINS is not configured; user creation is refused', 'config');
  const upn = String(u.userPrincipalName || '');
  if (!UPN.test(upn) || !domains.includes(upn.split('@')[1].toLowerCase())) throw new GraphOpError('userPrincipalName is missing, invalid, or outside the allowed domains', 'invalid_input');
  const password = u.passwordProfile && u.passwordProfile.password;
  if (typeof u.displayName !== 'string' || !u.displayName.trim() || typeof u.mailNickname !== 'string' || !u.mailNickname.trim() || typeof password !== 'string' || password.length < 12) throw new GraphOpError('displayName, mailNickname, and passwordProfile.password (12+ chars) are required', 'invalid_input');
  const body = { accountEnabled: u.accountEnabled !== false, displayName: u.displayName, mailNickname: u.mailNickname, userPrincipalName: upn,
    ...(u.usageLocation ? { usageLocation: String(u.usageLocation) } : {}), ...(u.jobTitle ? { jobTitle: String(u.jobTitle) } : {}), ...(u.department ? { department: String(u.department) } : {}),
    passwordProfile: { password, forceChangePasswordNextSignIn: u.passwordProfile.forceChangePasswordNextSignIn !== false } };
  const created = await graph.post('/users', body);
  const again = await graph.get(`/users/${enc(created.id || upn)}?$select=${USER_FIELDS}`);
  const verified = again.userPrincipalName && again.userPrincipalName.toLowerCase() === upn.toLowerCase() && again.displayName === u.displayName;
  return { verified: Boolean(verified), data: { created: true, user: again, passwordReturned: false } };
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

async function sendMail(p, env, graph) {
  const sender = String(env.GRAPH_MAIL_SENDER || '');
  const domains = csv(env.GRAPH_MAIL_ALLOWED_DOMAINS);
  if (!UPN.test(sender) || !domains.length) throw new GraphOpError('GRAPH_MAIL_SENDER and GRAPH_MAIL_ALLOWED_DOMAINS must be configured; mail is refused', 'config');
  const to = Array.isArray(p.to) ? p.to.map(String) : [];
  if (!to.length || to.length > MAX_RECIPIENTS || !to.every((a) => UPN.test(a) && domains.includes(a.split('@')[1].toLowerCase()))) throw new GraphOpError('recipients are missing, too many, or outside the allowed domains', 'invalid_input');
  if (typeof p.subject !== 'string' || !p.subject.trim() || p.subject.length > 200 || typeof p.body !== 'string' || !p.body.trim() || p.body.length > MAX_MAIL_BODY) throw new GraphOpError('subject (<=200) and plain-text body (<=8000) are required', 'invalid_input');
  await graph.post(`/users/${enc(sender)}/sendMail`, { message: { subject: p.subject, body: { contentType: 'Text', content: p.body }, toRecipients: to.map((address) => ({ emailAddress: { address } })) }, saveToSentItems: true });
  // Graph answers 202 with no message id, so delivery cannot be re-read here. Reported as partial on purpose.
  return { verified: false, data: { accepted: true, recipients: to.length, note: 'Graph accepted the request (202). Delivery is not independently verifiable from here.' } };
}

const DEF = {
  name: 'graph_manage',
  description: 'Microsoft Graph(Entra ID / Outlook)を1ツールで実行(operation指定)。読み取り=status(付与済み権限)/user_get/user_search/user_groups/user_licenses/group_list/group_members/license_list/app_get/sp_get/permission_grants。書込=user_create/user_update/mail_send は approvedByHuman:true 必須。必要な権限が付与されていない場合は推測せず、必要な権限を構造化して返します。パスワードは返しません。',
  inputSchema: { type: 'object', properties: {
    operation: { type: 'string', enum: OPERATIONS }, user: { type: ['string', 'object'] }, search: { type: 'string' }, top: { type: 'integer', minimum: 1, maximum: MAX_TOP }, group: { type: 'string' },
    appId: { type: 'string' }, patch: { type: 'object' }, to: { type: 'array', items: { type: 'string' }, maxItems: MAX_RECIPIENTS }, subject: { type: 'string' }, body: { type: 'string' },
    approvedByHuman: { type: 'boolean' }, approver: { type: 'string' } }, required: ['operation'], additionalProperties: false },
};

module.exports = { run, DEF, OPERATIONS, READ_OPS, WRITE_OPS, NEEDS, decodeRoles, GraphOpError };
