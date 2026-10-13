'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalDiffHash, verifyApprovedScope } = require('../src/approvalScopeContractDraft');
const base = { requestId: 'r', operation: 'save', appId: 'app-1', environmentId: 'env-1',
  runtimeCommitSha: 'a'.repeat(40), sourceSha: 'b'.repeat(40), params: { z: 1, a: { y: 2, x: 3 } } };
test('canonical SHA-256 is stable under JSON key ordering', () => {
  const changedOrder = { ...base, params: { a: { x: 3, y: 2 }, z: 1 } };
  assert.equal(canonicalDiffHash(base), canonicalDiffHash(changedOrder));
  assert.match(canonicalDiffHash(base), /^[a-f0-9]{64}$/);
});
test('runtime SHA and source SHA are independent and both bound to approval', () => {
  const hash = canonicalDiffHash(base);
  for (const changed of [
    { runtimeCommitSha: 'c'.repeat(40) }, { sourceSha: 'c'.repeat(40) },
    { operation: 'publish' }, { appId: 'other' }, { params: { z: 2 } }
  ]) assert.notEqual(canonicalDiffHash(base), canonicalDiffHash({ ...base, ...changed }));
  const approved = { requestId: base.requestId, tool: base.operation,
    targetId: base.appId, environmentId: base.environmentId,
    commitSha: base.runtimeCommitSha, diffHash: hash, status: '承認',
    revoked: false, executionId: '', executionStatus: '' };
  assert.equal(verifyApprovedScope(base, approved), true);
  assert.equal(verifyApprovedScope({ ...base, sourceSha: 'c'.repeat(40) }, approved), false);
  assert.equal(verifyApprovedScope({ ...base, operation: 'publish' }, approved), false);
  assert.equal(verifyApprovedScope({ ...base, runtimeCommitSha: 'c'.repeat(40) }, approved), false);
});
test('missing SHA domains, invalid operation and unapproved state fail closed', () => {
  for (const delta of [{ sourceSha: undefined }, { runtimeCommitSha: undefined },
    { operation: 'deploy' }, { params: [] }]) {
    assert.throws(() => canonicalDiffHash({ ...base, ...delta }));
  }
  assert.equal(verifyApprovedScope(base, null), false);
});
