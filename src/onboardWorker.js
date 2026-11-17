'use strict';
// Repeatable onboarding of ONE person from a name and a contact e-mail address.
//
//   1. validate input
//   2. duplicate check against the employee ledger (CN_社員台帳) and Entra  -> STOP if anything matches (nothing is written)
//   3. dryRun=true (default): print the plan only
//   4. user_create  (Entra account + welcome mail with the Power Apps install steps; the password is generated on the server and never returned)
//   5. ledger row   (name, e-mail, EntraObjectId, status; the category is left EMPTY on purpose: the person picks it on first sign-in)
//   6. verify       (re-read the account and the ledger row; flags only)
//
// It talks to the Bridge only through `call(tool, args)`, so it is testable without a network.
// `call` resolves to { ok: boolean, inner: object|null, error: string|null } where `inner` is the tool's own data object.
//
// Defaults that a human can override per run:
//   - the account is created DISABLED (enableNow=false). The owner assigns the license in the admin center first, then enables it,
//     so nobody can sign in before they are allowed to use the app.
//   - the ledger "社員ID" is a required column and no numbering rule is known, so it is set to 未採番 and reported for the owner to fill.

const SITE = 'cleannano';
const LEDGER_LIST = 'CN_社員台帳';
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();

function validate(input) {
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (!displayName || displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(displayName)) return { error: '氏名は1〜256文字で指定してください' };
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!EMAIL.test(email) || email.length > 254) return { error: 'メールアドレスの形式が正しくありません' };
  return { displayName, email };
}

async function onboardWorker(input, call, { dryRun = true, enableNow = false, approver = 'owner' } = {}) {
  const v = validate(input || {});
  if (v.error) return { status: 'invalid_input', reason: v.error, changed: false };
  const { displayName, email } = v;
  const name = norm(displayName);
  const mail = norm(email);

  // 2. duplicate check -------------------------------------------------------------------------------------------
  const ledger = await call('sharepoint_manage', { operation: 'search', site: SITE, list: LEDGER_LIST, top: 500 });
  if (!ledger.ok) return { status: 'check_failed', reason: `社員台帳を読めませんでした: ${ledger.error}`, changed: false };
  if (ledger.inner && ledger.inner.hasMore) return { status: 'check_failed', reason: '社員台帳が500件を超えているため、重複確認を完了できません', changed: false };
  const hits = [];
  for (const row of (ledger.inner && ledger.inner.items) || []) {
    const f = row.fields || {};
    if (norm(f.Title) === name) hits.push('ledger_name');
    if (norm(f.EmailAddress) && norm(f.EmailAddress) === mail) hits.push('ledger_email');
  }
  const entra = await call('graph_manage', { operation: 'user_search', search: displayName, top: 25 });
  if (!entra.ok) return { status: 'check_failed', reason: `Entra を検索できませんでした: ${entra.error}`, changed: false };
  for (const u of (entra.inner && entra.inner.users) || []) {
    if (norm(u.displayName) === name) hits.push('entra_name');
    if (norm(u.mail) === mail || norm(u.userPrincipalName) === mail) hits.push('entra_email');
  }
  if (hits.length) return { status: 'duplicate_found', matches: [...new Set(hits)], reason: '同じ人の可能性があるため、何も作成していません。照合してから進めてください', changed: false };

  // 3. plan only -------------------------------------------------------------------------------------------------
  const plan = {
    entraAccount: { displayName, contactEmail: email, accountEnabled: Boolean(enableNow), welcomeMail: true },
    ledgerRow: { list: LEDGER_LIST, Title: displayName, EmailAddress: email, EmploymentStatus: '在職', ProgressStatus: '未着手', EmployeeID: '未採番', EmployeeCategory: '(空: 初回サインインで本人が選ぶ)' },
  };
  if (dryRun) return { status: 'dry_run_ok', plan, changed: false, note: 'dryRun=false と承認文言で実行します' };

  // 4. create the account (this also sends the welcome mail) -----------------------------------------------------
  const created = await call('graph_manage', { operation: 'user_create', user: { displayName, contactEmail: email, accountEnabled: Boolean(enableNow) }, welcomeMail: true, approvedByHuman: true, approver });
  if (!created.ok) return { status: 'create_failed', reason: String(created.error || '').slice(0, 300), changed: false };
  const data = created.inner || {};
  if (data.blocked) return { status: 'create_blocked', reason: '必要な権限が付与されていません', requiredPermissions: data.requiredPermissions, changed: false };
  const user = data.user || {};
  const objectId = user.id || null;
  const upn = user.userPrincipalName || null;
  if (!data.created || !objectId) return { status: 'create_failed', reason: 'アカウントの作成結果を確認できませんでした', changed: false };
  const mailAccepted = Boolean(data.welcomeMail && data.welcomeMail.accepted);

  // 5. ledger row ------------------------------------------------------------------------------------------------
  const row = await call('sharepoint_manage', { operation: 'item_create', site: SITE, list: LEDGER_LIST, fields: { Title: displayName, EmployeeID: '未採番', EmailAddress: email, EntraObjectId: objectId, EmploymentStatus: '在職', ProgressStatus: '未着手' } });
  const ledgerOk = row.ok && row.inner && row.inner.itemId;
  if (!ledgerOk) {
    return { status: 'created_but_ledger_failed', changed: true, entra: { objectId, userPrincipalName: upn, accountEnabled: user.accountEnabled, welcomeMailAccepted: mailAccepted }, reason: `アカウントは作成済みですが、台帳への登録に失敗しました: ${String(row.error || '').slice(0, 200)}`, next: '同じ氏名・メールで再実行しないでください(重複になります)。台帳への登録だけを手動で行ってください' };
  }

  // 6. verify ----------------------------------------------------------------------------------------------------
  const check = await call('graph_manage', { operation: 'user_get', user: objectId });
  const u = (check.ok && check.inner) || {};
  return {
    status: 'completed',
    changed: true,
    entra: { objectId, userPrincipalName: upn, accountEnabled: u.accountEnabled === undefined ? null : u.accountEnabled, licenseCount: Array.isArray(u.assignedLicenses) ? u.assignedLicenses.length : null, welcomeMailAccepted: mailAccepted },
    ledger: { itemId: row.inner.itemId, entraObjectIdLinked: row.inner.fields ? norm(row.inner.fields.EntraObjectId) === norm(objectId) : null, employeeIdIsPlaceholder: true, categoryEmpty: true },
    nextForOwner: [
      'Microsoft 365 管理センターで、ライセンスを付与してください',
      enableNow ? null : 'ライセンスの付与後に、アカウントを有効化(サインインのブロックを解除)してください',
      '社員台帳の「社員ID」(未採番)を入力してください',
      'アプリ「clean nano kk」が本人に共有されているか確認してください',
    ].filter(Boolean),
  };
}

module.exports = { onboardWorker, validate, SITE, LEDGER_LIST };
