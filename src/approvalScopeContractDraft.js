'use strict';
const crypto = require('node:crypto');

// Draft-only canonical approval contract. Does not enable server mutation routes.
// runtimeCommitSha identifies the running Bridge code; sourceSha identifies
// the exact Power Apps source revision. They must never be substituted.
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new TypeError('invalid_approval_payload');
}
function validateScope(scope) {
  if (!scope || !['update', 'save', 'publish'].includes(scope.operation) ||
      ![scope.requestId, scope.appId, scope.environmentId].every(x => typeof x === 'string' && x.trim()) ||
      !/^[a-f0-9]{40}$/.test(scope.runtimeCommitSha || '') ||
      !/^[a-f0-9]{40}$/.test(scope.sourceSha || '') ||
      !scope.params || Object.getPrototypeOf(scope.params) !== Object.prototype) {
    throw new TypeError('invalid_approval_scope');
  }
  return scope;
}
function canonicalDiffHash(scope) {
  validateScope(scope);
  // Operation-specific hash includes both SHA domains and all approved params.
  return crypto.createHash('sha256').update(canonical({
    requestId: scope.requestId, operation: scope.operation,
    appId: scope.appId, environmentId: scope.environmentId,
    runtimeCommitSha: scope.runtimeCommitSha, sourceSha: scope.sourceSha,
    params: scope.params
  })).digest('hex');
}
function verifyApprovedScope(scope, approval) {
  try {
    const hash = canonicalDiffHash(scope);
    return Boolean(approval && approval.requestId === scope.requestId &&
      approval.tool === scope.operation && approval.targetId === scope.appId &&
      approval.environmentId === scope.environmentId &&
      approval.commitSha === scope.runtimeCommitSha &&
      approval.diffHash === hash && approval.status === '承認' &&
      approval.revoked === false && approval.executionId === '' &&
      approval.executionStatus === '');
  } catch { return false; }
}
module.exports = { canonicalDiffHash, verifyApprovedScope };
