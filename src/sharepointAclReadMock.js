'use strict';
// Unwired READ-only ACL evidence adapter. Does not request tokens, mutate ACL or grant WRITE.
// Caller must inject an already authenticated, site-scoped SharePoint REST GET transport.
const SITE = 'https://hisyoengineer.sharepoint.com/sites/cleannano';
const LIST = '973f17d6-3566-4795-9712-2386bb7bf540';
const PREFIX = "/_api/web/lists(guid'" + LIST + "')";
function requireGet(get) { if (typeof get !== 'function') throw new Error('read_transport_unavailable'); }
function unwrap(x) { return x && x.d ? x.d : x; }
async function collectAclEvidence({ get, siteUrl = SITE, listId = LIST, principalIds = [] } = {}) {
  requireGet(get);
  if (siteUrl !== SITE || listId !== LIST) throw new Error('target_mismatch');
  if (!Array.isArray(principalIds) || principalIds.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('principal_id_invalid');
  const base = PREFIX;
  // GET only. No POST, permission edits, credentials, or HTTP connector activation.
  const list = unwrap(await get(base + '?$select=Id,HasUniqueRoleAssignments,EffectiveBasePermissions'));
  if (!list || typeof list.HasUniqueRoleAssignments !== 'boolean') throw new Error('inheritance_unverified');
  const raw = unwrap(await get(base + '/roleassignments?$expand=Member,RoleDefinitionBindings'));
  const assignments = Array.isArray(raw.value) ? raw.value : raw.results;
  if (!Array.isArray(assignments)) throw new Error('role_assignments_unverified');
  const effective = [];
  for (const principalId of principalIds) {
    const p = unwrap(await get(base + '/getusereffectivepermissions(@u)?@u=' + encodeURIComponent("'"+principalId+"'")));
    if (!p || typeof p !== 'object' || !p.GetUserEffectivePermissions && !p.High && !p.Low) throw new Error('effective_permissions_unverified');
    effective.push({principalId, permissions:p.GetUserEffectivePermissions || p});
  }
  // Evidence only: role assignments do not prove group transitive membership or service principal rights.
  return {verified:true,siteUrl,listId,hasUniqueRoleAssignments:list.HasUniqueRoleAssignments,
    roleAssignments:assignments,effective,limitations:['nested_group_membership_unverified','service_principal_app_only_permissions_unverified','actor_identity_mapping_unverified']};
}
module.exports = {collectAclEvidence};
