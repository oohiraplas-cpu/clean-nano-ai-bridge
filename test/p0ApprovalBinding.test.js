'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ApprovalLedger } = require('../src/approvalLedger');
const NOW = new Date('2026-10-13T12:00:00Z');
const sha = 'a'.repeat(40);
const map = { requestId:'r', stepIndex:'i', tool:'t', status:'s', approver:'p', approvedAt:'d', revoked:'v', targetSha:'sha', environmentId:'env', appId:'app', changeHash:'hash', approvalStage:'stage' };
const expected = { requestId:'req', stepIndex:0, tool:'publish:change', targetSha:sha, environmentId:'env1', appId:'app1', changeHash:sha, approvalStage:'change' };
const row = { r:'req', i:0, t:'publish:change', s:'承認', p:'human', d:'2026-10-13T11:00:00Z', v:false, sha, env:'env1', app:'app1', hash:sha, stage:'change' };
function ledger(fieldMap, data) { return new ApprovalLedger({ config:{ siteId:'site', listId:'list', fieldMap }, fetchRows: async () => data, now: () => NOW }); }
test('mapped immutable binding is verified from ledger row', async () => assert.equal((await ledger(map,[row]).check(expected)).bindingVerified,true));
test('unmapped immutable binding fails closed', async () => assert.equal((await ledger({ ...map, changeHash:undefined },[row]).check(expected)).reason,'binding_not_configured'));
test('SHA mismatch fails closed', async () => assert.equal((await ledger(map,[{...row,sha:'b'.repeat(40)}]).check(expected)).reason,'binding_mismatch'));
test('environment mismatch fails closed', async () => assert.equal((await ledger(map,[{...row,env:'other'}]).check(expected)).reason,'binding_mismatch'));
test('stage mismatch fails closed', async () => assert.equal((await ledger(map,[{...row,stage:'publish'}]).check(expected)).reason,'binding_mismatch'));
