'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createP0SharePointApprovalLedger } = require('../src/p0SharePointApprovalReader');
const now = new Date('2026-10-13T12:00:00Z');
const sha = 'a'.repeat(40);
const fieldMap = { requestId:'r', stepIndex:'i', tool:'t', status:'s', approver:'p', approvedAt:'d', revoked:'v', targetSha:'sha', environmentId:'env', appId:'app', changeHash:'hash', approvalStage:'stage' };
const config = { siteId:'site', listId:'list', fieldMap };
const expected = { requestId:'req', stepIndex:0, tool:'publish:change', targetSha:sha, environmentId:'env1', appId:'app1', changeHash:sha, approvalStage:'change' };
const fields = { r:'req', i:0, t:'publish:change', s:'承認', p:'reviewer', d:'2026-10-13T11:00:00Z', v:false, sha, env:'env1', app:'app1', hash:sha, stage:'change' };
test('read-only adapter verifies mapped approval row', async () => {
  const reader = { listItems: async () => ({ status:'ok', hasMore:false, items:[{ fields }] }) };
  const ledger = createP0SharePointApprovalLedger({ reader, config, now: () => now });
  assert.equal((await ledger.check(expected)).bindingVerified, true);
});
test('incomplete pagination is denied, never accepted as a complete ledger', async () => {
  const reader = { listItems: async () => ({ status:'ok', hasMore:true, items:[{ fields }] }) };
  const ledger = createP0SharePointApprovalLedger({ reader, config, now: () => now });
  assert.equal((await ledger.check(expected)).reason, 'ledger_unreadable');
});
test('missing configuration fails closed', async () => {
  const ledger = createP0SharePointApprovalLedger({ reader:{ listItems:async () => ({}) }, config:{} });
  assert.equal((await ledger.check(expected)).reason, 'ledger_not_configured');
});

test('malformed approval row blocks rather than silently skipping', async () => {
  const reader = { listItems: async () => ({ status:'ok', hasMore:false, items:[{ fields }] .concat([{}]) }) };
  const ledger = createP0SharePointApprovalLedger({ reader, config, now: () => now });
  assert.equal((await ledger.check(expected)).reason, 'ledger_unreadable');
});
