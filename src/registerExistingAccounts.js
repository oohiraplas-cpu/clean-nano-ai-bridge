'use strict';
// Registers EXISTING Entra accounts in the employee ledger (CN_社員台帳) without creating duplicates.
//
// For each target (identified by its Entra user principal name, never by name alone):
//   - already linked    : a ledger row already holds this EntraObjectId                          -> skip (idempotent)
//   - link              : exactly ONE ledger row has the same name AND an empty EntraObjectId     -> write only EntraObjectId into that row
//   - create            : no ledger row has the same name and none holds the id                   -> add one new row
//   - conflict          : several rows share the name, or the one row already holds ANOTHER id    -> write nothing, report for a human
//   - not_found         : the UPN is not among the Entra users that were fetched                 -> write nothing, report
// Nothing else in a ledger row is touched: no e-mail, no category, no existing value is overwritten.
// The report contains flags, counts, UPNs and ids only. Ledger values (e-mail, category) are never printed.

const SITE = 'cleannano';
const LEDGER_LIST = 'CN_社員台帳';
const MAX_TARGETS = 20;
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();

function plan(targetUpns, entraUsers, ledgerItems) {
  const byUpn = new Map((entraUsers || []).map((u) => [norm(u.userPrincipalName), u]));
  const rows = (ledgerItems || []).map((i) => ({ id: String(i.id), title: norm((i.fields || {}).Title), oid: norm((i.fields || {}).EntraObjectId) }));
  const seen = new Set();
  return (targetUpns || []).map((raw) => {
    const upn = String(raw || '').trim();
    const u = byUpn.get(norm(upn));
    if (!u) return { upn, action: 'not_found', reason: 'この UPN は、取得した Entra ユーザーの中にありません' };
    const objectId = u.objectId;
    if (!objectId) return { upn, displayName: u.displayName, action: 'not_found', reason: 'オブジェクト ID を取得できませんでした' };
    if (seen.has(norm(objectId))) return { upn, displayName: u.displayName, objectId, action: 'conflict', reason: '同じアカウントが対象に重複しています' };
    seen.add(norm(objectId));

    if (rows.some((r) => r.oid && r.oid === norm(objectId))) return { upn, displayName: u.displayName, objectId, action: 'skip_linked' };
    const sameName = rows.filter((r) => r.title && r.title === norm(u.displayName));
    if (sameName.length === 0) return { upn, displayName: u.displayName, objectId, action: 'create' };
    if (sameName.length > 1) return { upn, displayName: u.displayName, objectId, action: 'conflict', reason: `同じ氏名の台帳の行が${sameName.length}行あります` };
    if (sameName[0].oid) return { upn, displayName: u.displayName, objectId, action: 'conflict', reason: '同じ氏名の行に、別のオブジェクト ID が入っています' };
    return { upn, displayName: u.displayName, objectId, action: 'link', rowId: sameName[0].id };
  });
}

const counts = (actions) => actions.reduce((m, a) => ({ ...m, [a.action]: (m[a.action] || 0) + 1 }), {});

async function fetchState(call, upns) {
  const entra = await call('graph_manage', { operation: 'user_list_recent', sinceDays: 60 });
  if (!entra.ok) return { error: `Entra を読めませんでした: ${entra.error}` };
  if (entra.inner && entra.inner.hasMore) return { error: 'Entra のユーザーが多すぎて、対象を特定できません' };
  const ledger = await call('sharepoint_manage', { operation: 'search', site: SITE, list: LEDGER_LIST, top: 500 });
  if (!ledger.ok) return { error: `社員台帳を読めませんでした: ${ledger.error}` };
  if (ledger.inner && ledger.inner.hasMore) return { error: '社員台帳が500件を超えているため、重複確認を完了できません' };
  return { users: (entra.inner && entra.inner.users) || [], items: (ledger.inner && ledger.inner.items) || [] };
}

async function registerExisting(targetUpns, call, { dryRun = true } = {}) {
  const upns = [...new Set((targetUpns || []).map((s) => String(s || '').trim()).filter(Boolean))];
  if (!upns.length) return { status: 'invalid_input', reason: '対象のサインイン名が空です', changed: false };
  if (upns.length > MAX_TARGETS) return { status: 'invalid_input', reason: `対象は最大${MAX_TARGETS}件です`, changed: false };

  const state = await fetchState(call);
  if (state.error) return { status: 'check_failed', reason: state.error, changed: false };
  const actions = plan(upns, state.users, state.items);
  const view = (a) => ({ upn: a.upn, displayName: a.displayName || null, action: a.action, ...(a.reason ? { reason: a.reason } : {}) });
  if (dryRun) return { status: 'dry_run_ok', changed: false, counts: counts(actions), actions: actions.map(view), note: 'dryRun=false と承認文言で実行します' };

  const written = [];
  const failed = [];
  for (const a of actions) {
    if (a.action === 'link') {
      const r = await call('sharepoint_manage', { operation: 'item_update', site: SITE, list: LEDGER_LIST, itemId: a.rowId, fields: { EntraObjectId: a.objectId } });
      (r.ok ? written : failed).push({ upn: a.upn, action: 'link', ...(r.ok ? {} : { error: String(r.error || '').slice(0, 200) }) });
    } else if (a.action === 'create') {
      const r = await call('sharepoint_manage', { operation: 'item_create', site: SITE, list: LEDGER_LIST, fields: { Title: a.displayName, EmployeeID: '未採番', EntraObjectId: a.objectId, EmploymentStatus: '在職', ProgressStatus: '未着手' } });
      (r.ok && r.inner && r.inner.itemId ? written : failed).push({ upn: a.upn, action: 'create', ...(r.ok ? {} : { error: String(r.error || '').slice(0, 200) }) });
    }
  }

  // verify by re-reading: every created/linked target must now be "skip_linked".
  const after = await fetchState(call);
  let verified = null;
  if (!after.error) {
    const again = plan(upns, after.users, after.items);
    const touched = new Set(written.map((w) => w.upn));
    verified = again.filter((a) => touched.has(a.upn)).every((a) => a.action === 'skip_linked');
  }
  const needsHuman = actions.filter((a) => a.action === 'conflict' || a.action === 'not_found').map(view);
  return {
    status: failed.length ? 'partial' : 'completed',
    changed: written.length > 0,
    planned: counts(actions),
    written: written.length,
    failed,
    verifiedAllLinked: verified,
    needsHuman,
    note: '社員ID は「未採番」です。区分とメールアドレスは空のままです(区分は本人が初回サインインで選びます)',
  };
}

module.exports = { registerExisting, plan, MAX_TARGETS, LEDGER_LIST };
