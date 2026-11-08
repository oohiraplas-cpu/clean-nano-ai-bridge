const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateEmployeeTenure } = require('../src/employeeTenure');
const { validateGetEmployeeTenureParams } = require('../src/bridgeExtensionsValidation');
const { MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');

test('入社日から基準日までの年・か月・日と通算日数を返す', () => {
  const r = calculateEmployeeTenure('2024-04-01', '2026-11-08');
  assert.equal(r.status, '在籍');
  assert.deepEqual([r.years, r.months, r.days], [2, 7, 7]);
  assert.equal(r.totalDays, 951);
  assert.equal(r.label, '2年7か月7日');
});

test('存在しない日付の記念日は月末に丸めて計算する（1/31入社→3/1は1か月1日）', () => {
  const r = calculateEmployeeTenure('2026-01-31', '2026-03-01');
  assert.deepEqual([r.years, r.months, r.days], [0, 1, 1]);
});

test('入社当日は0日、基準日省略時は実行日を使う', () => {
  assert.equal(calculateEmployeeTenure('2026-11-08', '2026-11-08').label, '0日');
  const r = calculateEmployeeTenure('2026-11-01', undefined, new Date('2026-11-08T05:00:00Z'));
  assert.equal(r.asOf, '2026-11-08');
  assert.equal(r.totalDays, 7);
});

test('入社日が基準日より未来なら入社前を返す', () => {
  const r = calculateEmployeeTenure('2026-12-01', '2026-11-08');
  assert.equal(r.status, '入社前');
  assert.equal(r.daysUntilHire, 23);
  assert.equal(r.totalDays, 0);
});

test('不正・実在しない日付はエラー', () => {
  assert.ok(calculateEmployeeTenure('2026-02-30', '2026-11-08').error);
  assert.ok(calculateEmployeeTenure('2026/01/01', '2026-11-08').error);
  assert.ok(calculateEmployeeTenure('2026-01-01', 'abc').error);
});

test('パラメータ検証', () => {
  assert.equal(validateGetEmployeeTenureParams({ hireDate: '2024-04-01' }), null);
  assert.ok(validateGetEmployeeTenureParams({}));
  assert.ok(validateGetEmployeeTenureParams({ hireDate: '2024-04-01', extra: 1 }));
  assert.ok(validateGetEmployeeTenureParams({ hireDate: '2024-04-01', asOf: 5 }));
});

test('get_employee_tenure は読み取り専用ツールとして登録されている', () => {
  assert.ok(MCP_METHODS.includes('get_employee_tenure'));
  const tool = MCP_PUBLIC_TOOLS.find((t) => t.name === 'get_employee_tenure');
  assert.equal(tool.annotations.readOnlyHint, true);
});
