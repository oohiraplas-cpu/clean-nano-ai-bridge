'use strict';
// Read-only list discovery; never infer internal field names from display names.
async function discoverApprovalLedger({ reader, siteId, searchTerm = '承認' } = {}) {
  const blocked = reason => Object.freeze({ status:'BLOCKED', reason });
  if (!reader || typeof reader.listLists !== 'function' || !siteId) return blocked('site_or_reader_not_configured');
  let result;
  try { result = await reader.listLists({ siteId, top:200 }); }
  catch { return blocked('list_discovery_failed'); }
  if (!result || result.status !== 'ok' || result.siteId !== siteId ||
      result.hasMore !== false || !Array.isArray(result.lists)) return blocked('list_discovery_incomplete');
  const matches = result.lists.filter(x => x && typeof x.id === 'string' && x.id &&
    typeof x.displayName === 'string' && x.displayName.includes(searchTerm));
  if (matches.length !== 1) return blocked(matches.length ? 'ambiguous_approval_lists' : 'approval_list_not_found');
  return Object.freeze({ status:'DISCOVERED', siteId, listId:matches[0].id,
    displayName:matches[0].displayName, internalColumnsVerified:false });
}
module.exports = { discoverApprovalLedger };
