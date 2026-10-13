'use strict';
const crypto = require('node:crypto');
const { canonicalDiffHash } = require('./approvalScopeContractDraft');
// Server-only receipts retain the authenticated human snapshot independently of
// lastModifiedBy, which the reservation PATCH changes to the service actor.
// A restart loses receipts and therefore denies recheck; never reconstruct from input.
const receipts = new WeakMap();
const DECISION_FIELDS = ['requestId', 'tool', 'targetId', 'environmentId', 'commitSha',
  'diffHash', 'approverId', 'approvedAt', 'expiresAt', 'status', 'revoked'];
function decisionHash(record) {
  return crypto.createHash('sha256').update(JSON.stringify(
    DECISION_FIELDS.map(key => [key, record[key]])
  )).digest('hex');
}
function validETag(etag) { return typeof etag === 'string' && etag.trim() && etag !== '*'; }
function receiptMap(store, timestamp) {
  if (!receipts.has(store)) receipts.set(store, new Map());
  const map = receipts.get(store);
  for (const [id, receipt] of map) if (receipt.expiresAt <= timestamp) map.delete(id);
  return map;
}

// Draft-only adapter for the PR #125 SharePointApprovalStore contract.
// A reservation is consumed on successful If-Match PATCH; never retry conflicts.
function createAtomicApprovalReservation({ store, now = () => Date.now() } = {}) {
  return async function reserveApproval(context = {}) {
    const { approvalId, requestId, operation, targetSha, appId, environmentId, changeHash, runtimeCommitSha, sourceSha, params } = context;
    if (!store || typeof store.assertConfigured !== 'function' || typeof store.read !== 'function' || typeof store.patch !== 'function' ||
        typeof store.verifyHuman !== 'function' || !/^[1-9][0-9]*$/.test(String(approvalId || '')) ||
        !['update', 'save', 'publish'].includes(operation) || !requestId || !appId || !environmentId ||
        !/^[a-f0-9]{40}$/i.test(targetSha || '') || !/^[a-f0-9]{64}$/i.test(changeHash || '')) {
      return { reserved: false, reason: 'reservation_not_configured' };
    }
    // Legacy approvals cannot prove distinct runtime and source revisions.
    // Require the server-computed canonical hash and both independently pinned SHAs.
    let computedHash;
    try {
      computedHash = canonicalDiffHash({ requestId, operation, appId, environmentId,
        runtimeCommitSha, sourceSha, params });
    } catch { return { reserved: false, reason: 'approval_scope_not_configured' }; }
    if (sourceSha !== targetSha || changeHash !== computedHash) {
      return { reserved: false, reason: 'approval_scope_mismatch' };
    }
    try {
      store.assertConfigured();
      const snapshot = await store.read(approvalId);
      const record = snapshot?.record;
      const start = Date.parse(record?.approvedAt);
      const expiry = Date.parse(record?.expiresAt);
      const timestamp = now();
      if (!validETag(snapshot?.etag) || !record || typeof record.approverId !== 'string' || !record.approverId.trim() || record.requestId !== requestId ||
          record.tool !== operation || record.targetId !== appId ||
          record.environmentId !== environmentId || record.commitSha !== runtimeCommitSha ||
          record.diffHash !== changeHash || record.status !== '承認' || record.revoked !== false ||
          record.executionId || record.executionStatus || !Number.isFinite(start) ||
          !Number.isFinite(expiry) || start > timestamp || expiry <= timestamp ||
          expiry <= start || expiry - start > 86400000) {
        return { reserved: false, reason: 'approval_invalid_or_used' };
      }
      if (await store.verifyHuman(snapshot) !== true) return { reserved: false, reason: 'approver_unverified' };
      // Clone the Graph-origin snapshot before any service PATCH. The directory
      // verifier must query current allowlist/account status on each invocation.
      const humanSnapshot = structuredClone(snapshot);
      const hash = decisionHash(humanSnapshot.record);
      const executionId = crypto.randomUUID();
      await store.patch(approvalId, snapshot.etag, {
        executionId, executionStatus: 'reserved',
        executionResult: JSON.stringify({ executionId, diffHash: changeHash, reservedAt: new Date(timestamp).toISOString() })
      });
      const confirmed = await store.read(approvalId);
      if (!validETag(confirmed?.etag) || confirmed.etag === snapshot.etag || !confirmed?.record || decisionHash(confirmed.record) !== hash || confirmed?.record?.executionId !== executionId || confirmed?.record?.executionStatus !== 'reserved' ||
          confirmed.record.requestId !== requestId || confirmed.record.tool !== operation ||
          confirmed.record.targetId !== appId || confirmed.record.environmentId !== environmentId ||
          confirmed.record.commitSha !== runtimeCommitSha || confirmed.record.diffHash !== changeHash ||
          confirmed.record.revoked !== false || confirmed.record.status !== '承認' ||
          !Number.isFinite(Date.parse(confirmed.record.approvedAt)) ||
          Date.parse(confirmed.record.approvedAt) > now() ||
          !Number.isFinite(Date.parse(confirmed.record.expiresAt)) ||
          Date.parse(confirmed.record.expiresAt) <= now()) {
        return { reserved: false, reason: 'reservation_unconfirmed' };
      }
      if (await store.verifyHuman(structuredClone(humanSnapshot)) !== true) {
        return { reserved: false, reason: 'approver_unverified_after_reservation' };
      }
      receiptMap(store, now()).set(executionId, { humanSnapshot, hash, approvalId: String(approvalId),
        etag: confirmed.etag, expiresAt: Date.parse(record.expiresAt) });
      return { reserved: true, singleUseVerified: true, approvalActiveVerified: true,
        approvalId: String(approvalId), executionId, requestId, operation, targetSha };
    } catch {
      // Includes ETag 412 and uncertain post-write outcomes: never retry.
      return { reserved: false, reason: 'reservation_failed_or_conflict' };
    }
  };
}
// Re-read immediately before mutation. Never trust a cached approval flag.
function createApprovalRecheck({ store, now = () => Date.now() } = {}) {
  return async function recheckApproval(context = {}) {
    const { approvalId, executionId, requestId, operation, targetSha, appId, environmentId, changeHash, runtimeCommitSha, sourceSha, params } = context;
    if (!store || typeof store.assertConfigured !== 'function' || typeof store.read !== 'function' || typeof store.verifyHuman !== 'function' ||
        !/^[1-9][0-9]*$/.test(String(approvalId || '')) || !executionId) return false;
    try {
      if (sourceSha !== targetSha || changeHash !== canonicalDiffHash({ requestId, operation, appId, environmentId,
        runtimeCommitSha, sourceSha, params })) return false;
      store.assertConfigured();
      const receipt = receipts.get(store)?.get(executionId);
      if (!receipt || receipt.approvalId !== String(approvalId)) return false;
      const snapshot = await store.read(approvalId);
      const record = snapshot?.record;
      const start = Date.parse(record?.approvedAt), end = Date.parse(record?.expiresAt), time = now();
      const valid = Boolean(validETag(snapshot?.etag) && snapshot.etag === receipt.etag && record && decisionHash(record) === receipt.hash && record.executionId === executionId &&
        record.executionStatus === 'reserved' && record.requestId === requestId &&
        record.tool === operation && record.targetId === appId &&
        record.environmentId === environmentId && record.commitSha === runtimeCommitSha &&
        record.diffHash === changeHash && record.revoked === false && record.status === '承認' &&
        Number.isFinite(start) && Number.isFinite(end) && start <= time && end > time &&
        end > start && end - start <= 86400000 &&
        await store.verifyHuman(structuredClone(receipt.humanSnapshot)) === true);
      if (!valid) { receipts.get(store).delete(executionId); return false; }
      // Directory verification is asynchronous: detect any ledger edit during it.
      const final = await store.read(approvalId);
      const active = validETag(final?.etag) && final.etag === receipt.etag &&
        final.record?.executionId === executionId && final.record.executionStatus === 'reserved' &&
        decisionHash(final.record) === receipt.hash && Date.parse(final.record.expiresAt) > now();
      // Consume the local receipt synchronously after all awaited reads. Two
      // concurrent rechecks cannot both authorize the same reservation.
      if (receipts.get(store)?.get(executionId) !== receipt) return false;
      receipts.get(store).delete(executionId);
      return Boolean(active);
    } catch { receipts.get(store)?.delete(executionId); return false; }
  };
}
module.exports = { createAtomicApprovalReservation, createApprovalRecheck };
