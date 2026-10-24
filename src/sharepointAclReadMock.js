'use strict';
// Unwired READ-only ACL evidence adapter. Does not request tokens, mutate ACL or grant WRITE.
// Caller must inject an already authenticated, site-scoped SharePoint REST GET transport.
const SITE = 'https://hisyoengineer.sharepoint.com/sites/cleannano';
const LIST = '973f17d6-3566-4795-9712-2386bb7bf540';
const PREFIX = "/_api/web/lists(guid'" + LIST + "')";
function requireGet(get) { if (typeof get !== 'function') throw new Error('read_transport_unavailable'); }
function unwrap(x) { return x && x.d ? x.d : x; }
async function collectAclEvidence({ get, siteUrl = SITE, listId = LIST, principalLogins = [] } = {}) {
  requireGet(get);
  if (siteUrl !== SITE || listId !== LIST) throw new Error('target_mismatch');
  if (!Array.isArray(principalLogins) || principalLogins.some(login => typeof login !== 'string' || !login.trim() || login.length > 512)) throw new Error('principal_login_invalid');
  const base = PREFIX;
  // GET only. No POST, permission edits, credentials, or HTTP connector activation.
  const list = unwrap(await get(base + '?$select=Id,HasUniqueRoleAssignments,EffectiveBasePermissions'));
  if (!list || typeof list.HasUniqueRoleAssignments !== 'boolean') throw new Error('inheritance_unverified');
  const raw = unwrap(await get(base + '/roleassignments?$expand=Member,RoleDefinitionBindings'));
  const assignments = Array.isArray(raw.value) ? raw.value : raw.results;
  if (!Array.isArray(assignments)) throw new Error('role_assignments_unverified');
  const effective = [];
  for (const login of principalLogins) {
    const p = unwrap(await get(base + '/getusereffectivepermissions(@u)?@u=' + encodeURIComponent("'"+login.replace(/'/g,"''")+"'")));
    if (!p || typeof p !== 'object' || !p.GetUserEffectivePermissions && !p.High && !p.Low) throw new Error('effective_permissions_unverified');
    effective.push({login, permissions:p.GetUserEffectivePermissions || p});
  }
  // Evidence only: role assignments do not prove group transitive membership or service principal rights.
  return {verified:true,siteUrl,listId,hasUniqueRoleAssignments:list.HasUniqueRoleAssignments,
    roleAssignments:assignments,effective,limitations:['nested_group_membership_unverified','service_principal_app_only_permissions_unverified','actor_identity_mapping_unverified']};
}
// Unwired security checks for a future transport; no token acquisition or network calls.
function validateSharePointTokenClaims(claims, expectedAudience = 'https://hisyoengineer.sharepoint.com') {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('token_claims_missing');
  const audience = String(claims.aud || '').replace(/\/$/, '');
  if (audience !== expectedAudience) throw new Error('token_audience_mismatch');
  const delegated = typeof claims.scp === 'string' && claims.scp.split(/\s+/).includes('AllSites.Read');
  const application = Array.isArray(claims.roles) && claims.roles.includes('Sites.Read.All');
  if (!delegated && !application) throw new Error('token_read_permission_unverified');
  // Caller must still independently verify actual site access, identity, and app-only permissions.
  return {audienceVerified:true,readClaimVerified:true,principalType:delegated?'delegated':'application',liveAccessVerified:false};
}
function validateSameOriginNextLink(nextLink, siteUrl = SITE) {
  if (typeof nextLink !== 'string' || !nextLink) throw new Error('pagination_link_missing');
  let url;
  try { url = new URL(nextLink,siteUrl); } catch { throw new Error('pagination_link_invalid'); }
  if (url.origin !== new URL(siteUrl).origin || !url.pathname.startsWith(new URL(siteUrl).pathname + '/_api/web/lists(guid')) throw new Error('pagination_target_mismatch');
  if (!url.pathname.includes(LIST)) throw new Error('pagination_target_mismatch');
  return url.toString();
}
function canEditListItems(mask) {
  if (!mask || typeof mask !== 'object') throw new Error('permission_mask_missing');
  // SPBasePermissions.EditListItems = bit 3 (zero-based) in Low.
  const low = mask.Low;
  if (typeof low !== 'string' && typeof low !== 'number') throw new Error('permission_mask_invalid');
  let bits;
  try { bits = BigInt(low); } catch { throw new Error('permission_mask_invalid'); }
  if (bits < 0n || bits > 0xffffffffn) throw new Error('permission_mask_invalid');
  return (bits & (1n << 3n)) !== 0n;
}
module.exports = {collectAclEvidence,validateSharePointTokenClaims,validateSameOriginNextLink,canEditListItems};
