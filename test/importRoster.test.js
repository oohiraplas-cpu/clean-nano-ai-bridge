'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { importRoster, plan, validateRow, toFields } = require('../src/importRoster');

// All names and e-mail addresses below are fictitious.
const ROWS = [
  { no: 1, name: '架空 一郎', category: '一般社員', hireDate: '2026-07-01', email: 'ichiro@example.test' },
  { no: 2, name: '架空 二郎', category: '一般社員', department: '設備', hireDate: '2026-02-02', email: 'jiro@example.test' },
  { no: 3, name: '架空 三郎', category: '一般社員', remarks: '会社名:架空建設' },
  { no: 4, name: '架空 協力', category: '協力会社', email: 'kyoryoku@example.test' },
];
const LEDGER = [
  { id: '10', fields: { Title: '架空二郎', EmailAddress: '', Department: '', EmployeeCategory: '一般社員' } },
  { id: '11', fields: { Title: '別人', EmailAddress: 'jiro@example.test' } },
];

test('plan: create / fill / conflict / hold are decided without writing', () => {
  const a = plan(ROWS, [{ id: '10', fields: { Title: '架空二郎', EmployeeCategory: '一般社員' } }]);
  assert.deepEqual(a.map((x) => x.action), ['create', 'fill', 'create', 'hold']);
  assert.deepEqual(a[1].fillColumns.sort(), ['Department', 'EmailAddress', 'HireDate']);
  assert.match(a[3].reason, /対象外/);
});

test('plan: an e-mail that belongs to a different person is a conflict, never a write', () => {
  const a = plan([ROWS[1]], LEDGER);
  assert.equal(a[0].action, 'conflict');
  assert.match(a[0].reason, /別の氏名/);
});

test('plan: existing values are never overwritten, and nothing left to fill is skip_existing', () => {
  const full = [{ id: '10', fields: { Title: '架空一郎', EmailAddress: 'old@example.test', HireDate: '2020-01-01', EmployeeCategory: '一般社員' } }];
  assert.equal(plan([ROWS[0]], full)[0].action, 'skip_existing');
  const partial = [{ id: '10', fields: { Title: '架空一郎', EmailAddress: 'old@example.test' } }];
  const a = plan([ROWS[0]], partial)[0];
  assert.equal(a.action, 'fill');
  assert.ok(!('EmailAddress' in a.fill), 'the existing e-mail is kept');
});

test('plan: several same-name ledger rows and duplicates inside the input are not written', () => {
  const two = [{ id: '1', fields: { Title: '架空一郎' } }, { id: '2', fields: { Title: '架空 一郎' } }];
  assert.equal(plan([ROWS[0]], two)[0].action, 'conflict');
  const dup = plan([ROWS[0], { ...ROWS[0], no: 9, email: '' }], []);
  assert.deepEqual(dup.map((x) => x.action), ['create', 'hold']);
  assert.match(dup[1].reason, /行 1/);
});

test('validateRow rejects values outside the ledger choices instead of guessing', () => {
  assert.match(validateRow({ no: 1, name: 'x', category: '一般社員', department: '工事部' }), /所属/);
  assert.match(validateRow({ no: 1, name: 'x', category: '社員' }), /区分/);
  assert.match(validateRow({ no: 1, name: 'x', category: '一般社員', hireDate: '2026/07/01' }), /YYYY-MM-DD/);
  assert.equal(validateRow(ROWS[0]), null);
});

test('toFields: employee id stays 未採番, nothing is invented', () => {
  const f = toFields(ROWS[0]);
  assert.equal(f.EmployeeID, '未採番');
  assert.equal(f.HireDate, '2026-07-01T00:00:00Z');
  assert.ok(!('Department' in f));
});

function fakeCall(ledger) {
  const writes = [];
  const items = ledger.map((i) => ({ ...i, fields: { ...i.fields } }));
  const call = async (tool, args) => {
    if (args.operation === 'search') return { ok: true, inner: { items } };
    writes.push(args);
    if (args.operation === 'item_create') { items.push({ id: String(100 + writes.length), fields: args.fields }); return { ok: true, inner: { itemId: String(100 + writes.length) } }; }
    if (args.operation === 'item_update') { Object.assign(items.find((i) => i.id === args.itemId).fields, args.fields); return { ok: true, inner: {} }; }
    return { ok: false, error: 'unexpected' };
  };
  return { call, writes };
}

test('dry run writes nothing and prints no name or e-mail', async () => {
  const { call, writes } = fakeCall([]);
  const report = await importRoster(ROWS, call, { dryRun: true });
  assert.equal(report.status, 'dry_run_ok');
  assert.equal(writes.length, 0);
  const text = JSON.stringify(report);
  for (const secret of ['架空', 'example.test', '建設']) assert.ok(!text.includes(secret), secret);
});

test('apply writes only in-scope rows, verifies by re-reading, and re-running writes nothing more', async () => {
  const { call, writes } = fakeCall([]);
  const first = await importRoster(ROWS, call, { dryRun: false });
  assert.equal(first.status, 'completed');
  assert.equal(first.written, 3);
  assert.equal(first.verifiedAllPresent, true);
  assert.equal(writes.length, 3);
  assert.ok(writes.every((w) => w.fields.Title !== '架空 協力'), 'out-of-scope category is not written');
  const second = await importRoster(ROWS, call, { dryRun: false });
  assert.equal(second.written, 0);
  assert.equal(writes.length, 3, 're-running is safe');
  assert.equal(JSON.stringify(first).includes('example.test'), false);
});

test('a ledger that cannot be read fails closed with no write', async () => {
  let wrote = false;
  const call = async (tool, args) => { if (args.operation !== 'search') wrote = true; return { ok: false, error: 'HTTP 500' }; };
  const r = await importRoster(ROWS, call, { dryRun: false });
  assert.equal(r.status, 'check_failed');
  assert.equal(wrote, false);
});
