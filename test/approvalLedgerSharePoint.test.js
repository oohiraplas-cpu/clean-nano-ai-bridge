const test = require('node:test');
const assert = require('node:assert/strict');
const { createApprovalLedger } = require('../src/server');
const { getConfig } = require('../src/config');

const fieldMap = {
  requestId: 'RequestId',
  stepIndex: 'StepIndex',
  tool: 'ToolName',
  status: 'ApprovalStatus',
  approver: 'ApprovedBy',
  approvedAt: 'ApprovedAt',
  revoked: 'Revoked'
};
const config = {
  sharepoint: { tenantId: 'tenant', clientId: 'client', clientSecret: 'secret' },
  approvalLedger: { siteId: 'site-verified', listId: 'list-verified', fieldMap }
};
const expected = { requestId: 'req-1', stepIndex: 2, tool: 'deploy_to_test' };
const approvedRow = {
  RequestId: 'req-1',
  StepIndex: 2,
  ToolName: 'deploy_to_test',
  ApprovalStatus: '承認',
  ApprovedBy: 'approver@example.com',
  ApprovedAt: '2026-10-11T11:00:00Z',
  Revoked: false
};

test('SharePoint Approval Ledger injects verified IDs and filters matching request and step', async () => {
  let args;
  const reader = {
    async listItems(input) {
      args = input;
      return { hasMore: false, items: [
        { fields: { ...approvedRow, RequestId: 'other-request' } },
        { fields: approvedRow }
      ] };
    }
  };
  const ledger = createApprovalLedger(config, reader);
  assert.equal(ledger.configured, true);
  assert.deepEqual(await ledger.check(expected), {
    approved: true, reason: null, approver: 'approver@example.com'
  });
  assert.deepEqual(args, { siteId: 'site-verified', listId: 'list-verified', top: 200 });
});

test('SharePoint reader errors and partial 200-row results fail closed', async () => {
  const unreadable = createApprovalLedger(config, {
    async listItems() { throw new Error('denied'); }
  });
  assert.deepEqual(await unreadable.check(expected), { approved: false, reason: 'ledger_unreadable' });

  const partial = createApprovalLedger(config, {
    async listItems() { return { hasMore: true, items: [{ fields: approvedRow }] }; }
  });
  assert.deepEqual(await partial.check(expected), { approved: false, reason: 'ledger_unreadable' });
});

test('Approval Ledger stays unconfigured when verified SharePoint settings are absent', async () => {
  const ledger = createApprovalLedger({ sharepoint: config.sharepoint }, {
    async listItems() { throw new Error('must not be called'); }
  });
  assert.equal(ledger.configured, false);
  assert.deepEqual(await ledger.check(expected), { approved: false, reason: 'ledger_not_configured' });
});

test('approval configuration is explicitly injected from environment variables', () => {
  const parsed = getConfig({
    SHAREPOINT_APPROVAL_SITE_ID: 'verified-site',
    SHAREPOINT_APPROVAL_LIST_ID: 'verified-list',
    SHAREPOINT_APPROVAL_FIELD_MAP: JSON.stringify(fieldMap)
  });
  assert.equal(parsed.approvalLedger.siteId, 'verified-site');
  assert.equal(parsed.approvalLedger.listId, 'verified-list');
  assert.deepEqual(parsed.approvalLedger.fieldMap, fieldMap);

  const missing = getConfig({});
  assert.equal(missing.approvalLedger.siteId, '');
  assert.equal(missing.approvalLedger.listId, '');
  assert.deepEqual(missing.approvalLedger.fieldMap, {});
});
