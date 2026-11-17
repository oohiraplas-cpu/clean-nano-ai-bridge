'use strict';
// Reconciles recently created Entra users against the employee ledger (CN_社員台帳) rows WITHOUT exposing ledger contents.
// It only returns match flags and counts: no e-mail address, no category value, no ledger name leaves this module.
//
// Inputs
//   entraUsers : [{ objectId, displayName, userPrincipalName, mail }]            (graph_manage user_list_recent)
//   ledgerItems: [{ id, fields: { Title, EntraObjectId, EmailAddress, EmployeeCategory } }]  (sharepoint_manage search)
//
// Why three keys: the app links a signed-in person to the ledger by EntraObjectId, so that is the only reliable link.
// A name or e-mail match without that link is only a CANDIDATE (kanji spellings differ: 橋中/箸中, 二平/仁平, 優也/悠弥).

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
const filled = (v) => norm(v).length > 0;

function reconcile(entraUsers, ledgerItems) {
  const users = Array.isArray(entraUsers) ? entraUsers : [];
  const rows = (Array.isArray(ledgerItems) ? ledgerItems : []).map((i) => ({ id: String(i.id), f: i.fields || {} }));

  const byObject = new Map();
  for (const r of rows) {
    const k = norm(r.f.EntraObjectId);
    if (!k) continue;
    byObject.set(k, [...(byObject.get(k) || []), r]);
  }
  const duplicateObjectIds = [...byObject.values()].filter((v) => v.length > 1).length;

  const matchedRowIds = new Set();
  const results = users.map((u) => {
    const oid = norm(u.objectId);
    const name = norm(u.displayName);
    const emails = new Set([norm(u.userPrincipalName), norm(u.mail)].filter(Boolean));

    const linked = oid ? (byObject.get(oid) || []) : [];
    const byName = name ? rows.filter((r) => norm(r.f.Title) === name) : [];
    const byEmail = rows.filter((r) => filled(r.f.EmailAddress) && emails.has(norm(r.f.EmailAddress)));

    for (const r of [...linked, ...byName, ...byEmail]) matchedRowIds.add(r.id);

    const best = linked[0] || byName[0] || byEmail[0] || null;
    let status = 'missing';
    if (linked.length) status = 'linked';
    else if (byName.length || byEmail.length) status = 'candidate_existing';

    return {
      displayName: u.displayName || null,
      userPrincipalName: u.userPrincipalName || null,
      objectIdKnown: Boolean(oid),
      matchedByObjectId: linked.length > 0,
      matchedByName: byName.length > 0,
      matchedByEmail: byEmail.length > 0,
      ledgerRowsMatched: new Set([...linked, ...byName, ...byEmail].map((r) => r.id)).size,
      ledgerEmailFilled: best ? filled(best.f.EmailAddress) : null,
      ledgerCategorySet: best ? filled(best.f.EmployeeCategory) : null,
      status,
    };
  });

  const summary = {
    entraUsers: users.length,
    ledgerRows: rows.length,
    ledgerRowsWithEntraObjectId: rows.filter((r) => filled(r.f.EntraObjectId)).length,
    ledgerRowsWithEmail: rows.filter((r) => filled(r.f.EmailAddress)).length,
    ledgerRowsWithCategory: rows.filter((r) => filled(r.f.EmployeeCategory)).length,
    ledgerRowsNotMatchedByAnyListedUser: rows.filter((r) => !matchedRowIds.has(r.id)).length,
    duplicateEntraObjectIdsInLedger: duplicateObjectIds,
    linked: results.filter((r) => r.status === 'linked').length,
    candidateExisting: results.filter((r) => r.status === 'candidate_existing').length,
    missing: results.filter((r) => r.status === 'missing').length,
  };
  return { summary, results };
}

module.exports = { reconcile, norm };
