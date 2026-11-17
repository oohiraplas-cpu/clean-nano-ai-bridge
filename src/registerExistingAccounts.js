'use strict';
// Registers EXISTING Entra accounts in the employee ledger (CN_社員台帳) without creating duplicates.
//
// For each target (identified by its Entra user principal name, never by name alone):
//   - already linked    : a ledger row already holds this EntraObjectId                          -> skip (idempotent)
//   - link              : exactly ONE ledger row has the same name AND an empty EntraObjectId     -> write only EntraObjectId into that row
//   - create            : no ledger row has the same name and none holds the id                   -> add one new row
//   - conflict          : several rows share the name, or the one row already holds ANOTHER id    -> write nothing, report for a human
//   - not_found         : the UPN is not among the Entra users that were fetched                 -> write nothing, report
// Nothing else in a ledger row is touched: no category and no existing value is overwritten. A contact e-mail given for a
// person is written to EmailAddress only when that column is empty (link) or on the new row (create).
// MAIL: for a person whose contact e-mail was given, the fixed account-info mail (sign-in name = ID + the app steps, never a
// password) is sent ONLY if this run wrote that person's row (link/create), so re-running never mails twice. resendMail=true
// also mails already-linked people who have an e-mail given. Delivery cannot be confirmed by the Bridge ("accepted" only).
// The report contains flags, counts, UPNs and ids only. Ledger values and e-mail addresses are never printed.

const SITE = 'cleannano';
const LEDGER_LIST = 'CN_社員台帳';
const MAX_TARGETS = 20;
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// A target is "UPN" or "UPN=contact e-mail" (a string), or { upn, email }.
function parseTarget(t) {
  if (t && typeof t === 'object') return { upn: String(t.upn || '').trim(), email: String(t.email || '').trim() };
  const [upn, ...rest] = String(t || '').split('=');
  return { upn: upn.trim(), email: rest.join('=').trim() };
}

function plan(targetUpns, entraUsers, ledgerItems) {
  const byUpn = new Map((entraUsers || []).map((u) => [norm(u.userPrincipalName), u]));
  const rows = (ledgerItems || []).map((i) => ({ id: String(i.id), title: norm((i.fields || {}).Title), oid: norm((i.fields || {}).EntraObjectId), emailEmpty: !norm((i.fields || {}).EmailAddress) }));
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
    return { upn, displayName: u.displayName, objectId, action: 'link', rowId: sameName[0].id, rowEmailEmpty: sameName[0].emailEmpty };
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

async function registerExisting(targets, call, { dryRun = true, resendMail = false } = {}) {
  const parsed = [];
  const seenUpn = new Set();
  for (const t of targets || []) {
    const p = parseTarget(t);
    if (!p.upn || seenUpn.has(norm(p.upn))) continue;
    seenUpn.add(norm(p.upn));
    parsed.push(p);
  }
  if (!parsed.length) return { status: 'invalid_input', reason: '対象のサインイン名が空です', changed: false };
  if (parsed.length > MAX_TARGETS) return { status: 'invalid_input', reason: `対象は最大${MAX_TARGETS}件です`, changed: false };
  const bad = parsed.filter((p) => p.email && !EMAIL.test(p.email));
  if (bad.length) return { status: 'invalid_input', reason: `連絡先メールの形式が正しくない対象があります: ${bad.map((b) => b.upn).join(', ')}`, changed: false };
  const emailOf = new Map(parsed.filter((p) => p.email).map((p) => [norm(p.upn), p.email]));
  const upns = parsed.map((p) => p.upn);

  const state = await fetchState(call);
  if (state.error) return { status: 'check_failed', reason: state.error, changed: false };
  const actions = plan(upns, state.users, state.items);
  const view = (a) => ({ upn: a.upn, displayName: a.displayName || null, action: a.action, mailGiven: emailOf.has(norm(a.upn)), ...(a.reason ? { reason: a.reason } : {}) });
  const willMail = (a) => emailOf.has(norm(a.upn)) && (['link', 'create'].includes(a.action) || (resendMail && a.action === 'skip_linked'));
  if (dryRun) return { status: 'dry_run_ok', changed: false, counts: counts(actions), mailPlanned: actions.filter(willMail).length, noEmailGiven: actions.filter((a) => ['link', 'create'].includes(a.action) && !emailOf.has(norm(a.upn))).length, actions: actions.map(view), note: 'dryRun=false と承認文言で実行します。メールは、連絡先が指定された人にだけ送ります' };

  const written = [];
  const failed = [];
  for (const a of actions) {
    const email = emailOf.get(norm(a.upn));
    if (a.action === 'link') {
      const fields = { EntraObjectId: a.objectId, ...(email && a.rowEmailEmpty ? { EmailAddress: email } : {}) };
      const r = await call('sharepoint_manage', { operation: 'item_update', site: SITE, list: LEDGER_LIST, itemId: a.rowId, fields });
      (r.ok ? written : failed).push({ upn: a.upn, action: 'link', ...(r.ok ? {} : { error: String(r.error || '').slice(0, 200) }) });
    } else if (a.action === 'create') {
      const r = await call('sharepoint_manage', { operation: 'item_create', site: SITE, list: LEDGER_LIST, fields: { Title: a.displayName, EmployeeID: '未採番', EntraObjectId: a.objectId, ...(email ? { EmailAddress: email } : {}), EmploymentStatus: '在職', ProgressStatus: '未着手' } });
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

  // mail: only for people whose row this run wrote (or an explicit resend), and only when a contact e-mail was given.
  const wroteUpn = new Set(written.map((w) => w.upn));
  const mailTargets = actions.filter((a) => emailOf.has(norm(a.upn)) && ((a.action === 'link' || a.action === 'create') ? wroteUpn.has(a.upn) : (resendMail && a.action === 'skip_linked')));
  const mailResults = [];
  for (const a of mailTargets) {
    const r = await call('graph_manage', { operation: 'account_info_mail', user: a.upn, contactEmail: emailOf.get(norm(a.upn)), approvedByHuman: true, approver: 'register-existing workflow' });
    const accepted = Boolean(r.ok && r.inner && r.inner.accepted);
    mailResults.push({ upn: a.upn, accepted, ...(accepted ? {} : { error: String(r.error || (r.inner && r.inner.blocked ? '権限がありません' : '不明')).slice(0, 200) }) });
  }

  const needsHuman = actions.filter((a) => a.action === 'conflict' || a.action === 'not_found').map(view);
  const noMail = actions.filter((a) => ['link', 'create'].includes(a.action) && !emailOf.has(norm(a.upn))).map((a) => ({ upn: a.upn, reason: '連絡先メールが指定されていないため、案内メールを送っていません' }));
  return {
    status: failed.length || mailResults.some((m) => !m.accepted) ? 'partial' : 'completed',
    changed: written.length > 0 || mailResults.some((m) => m.accepted),
    planned: counts(actions),
    written: written.length,
    failed,
    verifiedAllLinked: verified,
    mail: { accepted: mailResults.filter((m) => m.accepted).length, failed: mailResults.filter((m) => !m.accepted), skippedNoEmail: noMail },
    needsHuman,
    note: '案内メールには、サインイン名（ID）とアプリの手順を載せています。パスワードは載せていません(管理者から別にお伝えください)。メールの到達はBridgeでは確認できません。社員ID は「未採番」、区分は空です',
  };
}

module.exports = { registerExisting, plan, parseTarget, MAX_TARGETS, LEDGER_LIST };
