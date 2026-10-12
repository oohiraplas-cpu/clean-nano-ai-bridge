'use strict';
const crypto = require('node:crypto');
// Draft-only adapter for the PR #125 SharePointApprovalStore contract.
// A reservation is consumed on successful If-Match PATCH; never retry conflicts.
function createAtomicApprovalReservation({ store, now = () => Date.now() } = {}) {
  return async function reserveApproval(context = {}) {
    const { approvalId, requestId, operation, targetSha, appId, environmentId, changeHash } = context;
    if (!store || typeof store.read !== 'function' || typeof store.patch !== 'function' ||
        typeof store.verifyHuman !== 'function' || !/^[1-9][0-9]*$/.test(String(approvalId || '')) ||
        !['deploy', 'publish'].includes(operation) || !requestId || !appId || !environmentId ||
        !/^[a-f0-9]{40}$/i.test(targetSha || '') || !/^[a-f0-9]{64}$/i.test(changeHash || '')) {
      return { reserved: false, reason: 'reservation_not_configured' };
    }
    try {
      const snapshot = await store.read(approvalId);
      const record = snapshot?.record;
      const start = Date.parse(record?.approvedAt);
      const expiry = Date.parse(record?.expiresAt);
      const timestamp = now();
      if (!snapshot?.etag || !record || record.requestId !== requestId ||
          record.tool !== operation || record.targetId !== appId ||
          record.environmentId !== environmentId || record.commitSha !== targetSha ||
          record.diffHash !== changeHash || record.status !== '承認' || record.revoked !== false ||
          record.executionId || record.executionStatus || !Number.isFinite(start) ||
          !Number.isFinite(expiry) || start > timestamp || expiry <= timestamp ||
          expiry <= start || expiry - start > 86400000) {
        return { reserved: false, reason: 'approval_invalid_or_used' };
      }
      if (await store.verifyHuman(snapshot) !== true) return { reserved: false, reason: 'approver_unverified' };
      const executionId = crypto.randomUUID();
      await store.patch(approvalId, snapshot.etag, {
        executionId, executionStatus: 'reserved',
        executionResult: JSON.stringify({ executionId, diffHash: changeHash, reservedAt: new Date(timestamp).toISOString() })
      });
      const confirmed = await store.read(approvalId);
      if (confirmed?.record?.executionId !== executionId || confirmed?.record?.executionStatus !== 'reserved' ||
          confirmed.record.revoked !== false || confirmed.record.status !== '承認' ||
          Date.parse(confirmed.record.expiresAt) <= now()) {
        return { reserved: false, reason: 'reservation_unconfirmed' };
      }
      return { reserved: true, singleUseVerified: true, approvalActiveVerified: true,
        executionId, requestId, operation, targetSha };
    } catch {
      // Includes ETag 412 and uncertain post-write outcomes: never retry.
      return { reserved: false, reason: 'reservation_failed_or_conflict' };
    }
  };
}
module.exports = { createAtomicApprovalReservation };
