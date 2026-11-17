'use strict';
// Imports a roster of registration answers (e.g. an xlsx exported from Forms) into CN_社員台帳 without creating duplicates.
// The rows are PERSONAL DATA. This repository is public, so the rows are never stored here: they arrive through the
// environment (a GitHub secret) and this module only ever prints row numbers, counts and reasons - never a name or an e-mail.
//
// Per row (identified by its row number `no`):
//   create        : no ledger row has this e-mail or this name                          -> one new row (EmployeeID=未採番)
//   fill          : exactly ONE ledger row has this name (and no other row has the e-mail) -> only the EMPTY columns are filled
//   skip_existing : the match has nothing left to fill                                   -> nothing
//   hold          : category not in scope, duplicate inside the input, bad input         -> nothing, reported for a human
//   conflict      : several ledger rows share the name/e-mail, or the e-mail belongs to another person -> nothing, reported
// An existing value is never overwritten. EmployeeID stays 未採番 (the xlsx row number is NOT an employee id).

const SITE = 'cleannano';
const LEDGER_LIST = 'CN_社員台帳';
const MAX_ROWS = 50;
const DEPARTMENTS = ['躯体解体', '内装解体', '設備', '内勤'];
const CATEGORIES = ['一般社員', 'アルバイト', '協力会社'];
const DEFAULT_CATEGORIES = ['一般社員', 'アルバイト'];
const norm = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function validateRow(r) {
  if (!r || typeof r !== 'object') return '行が不正です';
  if (!Number.isInteger(r.no) || r.no < 1) return '行番号 no が整数ではありません';
  if (!norm(r.name)) return '氏名が空です';
  if (!CATEGORIES.includes(r.category)) return `区分が選択肢にありません（${CATEGORIES.join('/')}）`;
  if (r.email && !EMAIL.test(String(r.email).trim())) return 'メールの形式が正しくありません';
  if (r.hireDate && !DATE.test(String(r.hireDate))) return '入社日は YYYY-MM-DD です';
  if (r.department && !DEPARTMENTS.includes(r.department)) return `所属が選択肢にありません（${DEPARTMENTS.join('/')}）。備考へ入れてください`;
  return null;
}

function toFields(r) {
  return {
    Title: String(r.name).trim(),
    EmployeeID: '未採番',
    EmployeeCategory: r.category,
    EmploymentStatus: '在職',
    ProgressStatus: '未着手',
    ...(r.department ? { Department: r.department } : {}),
    ...(r.hireDate ? { HireDate: `${r.hireDate}T00:00:00Z` } : {}),
    ...(r.email ? { EmailAddress: String(r.email).trim() } : {}),
    ...(r.remarks ? { Remarks: String(r.remarks) } : {}),
  };
}

function plan(rows, ledgerItems, { categories = DEFAULT_CATEGORIES } = {}) {
  const led = (ledgerItems || []).map((i) => ({ id: String(i.id), f: i.fields || {} }));
  const seenName = new Map();
  const seenMail = new Map();
  return (rows || []).map((r) => {
    const base = { no: r && r.no };
    const bad = validateRow(r);
    if (bad) return { ...base, action: 'hold', reason: bad };
    if (!categories.includes(r.category)) return { ...base, action: 'hold', reason: `区分「${r.category}」は今回の対象外です` };
    const n = norm(r.name);
    const m = norm(r.email);
    if (seenName.has(n)) return { ...base, action: 'hold', reason: `入力内で同じ氏名が重複しています（行 ${seenName.get(n)}）` };
    if (m && seenMail.has(m)) return { ...base, action: 'hold', reason: `入力内で同じメールが重複しています（行 ${seenMail.get(m)}）` };
    seenName.set(n, r.no);
    if (m) seenMail.set(m, r.no);

    const byName = led.filter((x) => norm(x.f.Title) === n);
    const byMail = m ? led.filter((x) => norm(x.f.EmailAddress) === m) : [];
    if (byName.length > 1) return { ...base, action: 'conflict', reason: `同じ氏名の台帳の行が${byName.length}行あります` };
    if (byMail.length > 1) return { ...base, action: 'conflict', reason: `同じメールの台帳の行が${byMail.length}行あります` };
    if (byMail.length === 1 && (byName.length === 0 || byName[0].id !== byMail[0].id)) return { ...base, action: 'conflict', reason: 'このメールは、別の氏名の台帳の行にあります' };
    if (byName.length === 0) return { ...base, action: 'create' };

    const row = byName[0];
    const want = { EmployeeCategory: r.category, Department: r.department, HireDate: r.hireDate && `${r.hireDate}T00:00:00Z`, EmailAddress: r.email && String(r.email).trim(), Remarks: r.remarks };
    const fill = {};
    for (const [k, v] of Object.entries(want)) if (v && !norm(row.f[k])) fill[k] = v;
    if (!Object.keys(fill).length) return { ...base, action: 'skip_existing' };
    return { ...base, action: 'fill', rowId: row.id, fill, fillColumns: Object.keys(fill) };
  });
}

const counts = (actions) => actions.reduce((m, a) => ({ ...m, [a.action]: (m[a.action] || 0) + 1 }), {});
const view = (a) => ({ no: a.no, action: a.action, ...(a.reason ? { reason: a.reason } : {}), ...(a.fillColumns ? { fillColumns: a.fillColumns } : {}) });

async function readLedger(call) {
  const ledger = await call('sharepoint_manage', { operation: 'search', site: SITE, list: LEDGER_LIST, top: 500 });
  if (!ledger.ok) return { error: `社員台帳を読めませんでした: ${ledger.error}` };
  if (ledger.inner && ledger.inner.hasMore) return { error: '社員台帳が500件を超えているため、重複確認を完了できません' };
  return { items: (ledger.inner && ledger.inner.items) || [] };
}

async function importRoster(rows, call, { dryRun = true, categories = DEFAULT_CATEGORIES } = {}) {
  if (!Array.isArray(rows) || !rows.length) return { status: 'invalid_input', reason: '対象の行がありません', changed: false };
  if (rows.length > MAX_ROWS) return { status: 'invalid_input', reason: `対象は最大${MAX_ROWS}行です`, changed: false };
  const state = await readLedger(call);
  if (state.error) return { status: 'check_failed', reason: state.error, changed: false };
  const actions = plan(rows, state.items, { categories });
  if (dryRun) return { status: 'dry_run_ok', changed: false, counts: counts(actions), actions: actions.map(view), note: 'dryRun=false と承認文言で実行します。氏名・メールは出力しません' };

  const written = [];
  const failed = [];
  for (const a of actions) {
    const row = rows.find((r) => r.no === a.no);
    if (a.action === 'create') {
      const r = await call('sharepoint_manage', { operation: 'item_create', site: SITE, list: LEDGER_LIST, fields: toFields(row) });
      (r.ok && r.inner && r.inner.itemId ? written : failed).push({ no: a.no, action: 'create', ...(r.ok ? {} : { error: String(r.error || '').slice(0, 200) }) });
    } else if (a.action === 'fill') {
      const r = await call('sharepoint_manage', { operation: 'item_update', site: SITE, list: LEDGER_LIST, itemId: a.rowId, fields: a.fill });
      (r.ok ? written : failed).push({ no: a.no, action: 'fill', ...(r.ok ? {} : { error: String(r.error || '').slice(0, 200) }) });
    }
  }

  // verify by re-reading: every written row must now plan as skip_existing (nothing left to create or fill).
  const after = await readLedger(call);
  let verified = null;
  if (!after.error) {
    const touched = new Set(written.map((w) => w.no));
    verified = plan(rows, after.items, { categories }).filter((a) => touched.has(a.no)).every((a) => a.action === 'skip_existing');
  }
  return {
    status: failed.length ? 'partial' : 'completed',
    changed: written.length > 0,
    planned: counts(actions),
    written: written.length,
    failed,
    verifiedAllPresent: verified,
    needsHuman: actions.filter((a) => a.action === 'hold' || a.action === 'conflict').map(view),
  };
}

module.exports = { importRoster, plan, validateRow, toFields, MAX_ROWS, LEDGER_LIST, DEFAULT_CATEGORIES };
