const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ApprovalLedger,
  isApprovalLedgerConfigured,
  validateApprovalRecord
} = require('../src/approvalLedger');

const NOW = new Date('2026-10-11T12:00:00Z');
const EXPECTED = { requestId: 'req-1', stepIndex: 0, tool: 'deploy_to_test' };
const GOOD = {
  requestId: 'req-1', stepIndex: 0, tool: 'deploy_to_test', status: '承認',
  approver: 'approver@example.com', approvedAt: '2026-10-11T11:00:00Z', revoked: false
};

test('正しい承認レコードは有効', () => {
  assert.deepEqual(validateApprovalRecord(GOOD, EXPECTED, { now: NOW }), { valid: true, reason: null });
});

test('承認者・日時・状態・取消の不備はそれぞれ拒否される', () => {
  assert.equal(validateApprovalRecord(null, EXPECTED, { now: NOW }).reason, 'no_record');
  assert.equal(validateApprovalRecord({ ...GOOD, approver: '  ' }, EXPECTED, { now: NOW }).reason, 'approver_missing');
  assert.equal(validateApprovalRecord({ ...GOOD, approvedAt: 'not-a-date' }, EXPECTED, { now: NOW }).reason, 'approved_at_invalid');
  assert.equal(validateApprovalRecord({ ...GOOD, status: '申請中' }, EXPECTED, { now: NOW }).reason, 'not_approved');
  assert.equal(validateApprovalRecord({ ...GOOD, revoked: true }, EXPECTED, { now: NOW }).reason, 'revoked');
});

test('承認台帳は設定が揃っていなければ未設定扱い（fail closed）', async () => {
  assert.equal(isApprovalLedgerConfigured(null), false);
  assert.equal(isApprovalLedgerConfigured({ siteId: 's', listId: 'l', fieldMap: {} }), false);
  const ledger = new ApprovalLedger();
  assert.equal(ledger.configured, false);
  assert.deepEqual(await ledger.check(EXPECTED), { approved: false, reason: 'ledger_not_configured' });
});

test('列名がすべて指定された設定でのみ、台帳を読んで承認を判定する', async () => {
  const fieldMap = {
    requestId: 'r', stepIndex: 's', tool: 't', status: 'st', approver: 'a', approvedAt: 'd', revoked: 'x'
  };
  const row = { r: 'req-1', s: 0, t: 'deploy_to_test', st: '承認', a: 'approver@example.com', d: '2026-10-11T11:00:00Z', x: false };
  const ledger = new ApprovalLedger({
    config: { siteId: 's', listId: 'l', fieldMap },
    fetchRows: async (query) => (query.requestId === 'req-1' ? [row] : []),
    now: () => NOW
  });
  assert.equal(ledger.configured, true);
  assert.deepEqual(await ledger.check(EXPECTED), { approved: true, reason: null, approver: 'approver@example.com' });
  assert.equal((await ledger.check({ ...EXPECTED, requestId: 'req-2' })).reason, 'no_record');
});

test('scoped approvals reject missing or mismatched app environment and SHA', () => {
  const expected = { ...EXPECTED, appId: 'app-1', environmentId: 'env-1', changeSha: 'abc123' };
  const good = { ...GOOD, appId: 'app-1', environmentId: 'env-1', changeSha: 'abc123' };
  assert.equal(validateApprovalRecord(good, expected, { now: NOW }).valid, true);
  for (const key of ['appId', 'environmentId', 'changeSha']) {
    assert.equal(validateApprovalRecord({ ...good, [key]: 'wrong' }, expected, { now: NOW }).reason, key + '_mismatch');
    assert.equal(validateApprovalRecord({ ...good, [key]: undefined }, expected, { now: NOW }).reason, key + '_mismatch');
    assert.equal(validateApprovalRecord(good, { ...expected, [key]: '' }, { now: NOW }).reason, 'approval_scope_incomplete');
  }
});

test('scoped approval fails closed when SharePoint field mapping is absent', async () => {
  const fieldMap = { requestId: 'r', stepIndex: 's', tool: 't', status: 'st', approver: 'a', approvedAt: 'd', revoked: 'x' };
  const ledger = new ApprovalLedger({
    config: { siteId: 's', listId: 'l', fieldMap },
    fetchRows: async () => [{ r: 'req-1', s: 0, t: 'deploy_to_test', st: '承認', a: 'human', d: '2026-10-11T11:00:00Z', x: false }],
    now: () => NOW
  });
  assert.equal((await ledger.check({ ...EXPECTED, appId: 'a', environmentId: 'e', changeSha: 'sha' })).reason, 'approval_scope_columns_unconfigured');
});

test('scoped approval succeeds only with all mapped values matching', async () => {
  const fieldMap = { requestId: 'r', stepIndex: 's', tool: 't', status: 'st', approver: 'a', approvedAt: 'd', revoked: 'x', appId: 'app', environmentId: 'env', changeSha: 'sha' };
  const row = { r: 'req-1', s: 0, t: 'deploy_to_test', st: '承認', a: 'human', d: '2026-10-11T11:00:00Z', x: false, app: 'app-1', env: 'env-1', sha: 'abc123' };
  const ledger = new ApprovalLedger({ config: { siteId: 's', listId: 'l', fieldMap }, fetchRows: async () => [row], now: () => NOW });
  const expected = { ...EXPECTED, appId: 'app-1', environmentId: 'env-1', changeSha: 'abc123' };
  assert.equal((await ledger.check(expected)).approved, true);
  assert.equal((await ledger.check({ ...expected, changeSha: 'changed' })).reason, 'changeSha_mismatch');
});
