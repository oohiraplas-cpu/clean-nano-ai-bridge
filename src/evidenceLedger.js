/**
 * Evidence Ledger: Immutable Audit Trail with Hash Chain
 *
 * Records all operations with tamper-detection via prevHash/recordHash.
 * Append-only; physical deletion is prohibited.
 */

const crypto = require('node:crypto');

/**
 * Evidence Record
 */
class EvidenceRecord {
  constructor({
    recordId = crypto.randomUUID(),
    transactionId,
    operationId,
    operationType,
    correlationId,
    principal = 'system',
    context = {},
    decision = 'AUTHORIZED',
    code = 'OK',
    apiCalled = false,
    externalApiRequest = null,
    externalApiResponse = null,
    planHash,
    policyHash,
    preCheckHash,
    resultHash,
    bridgeVersion = '0.0.0',
    bridgeCommitSha = '',
    bridgeInstanceId = '',
    prevHash = null,
    recordedAt = new Date().toISOString()
  } = {}) {
    this.recordId = recordId;
    this.transactionId = transactionId;
    this.operationId = operationId;
    this.operationType = operationType;
    this.correlationId = correlationId;
    this.principal = principal;
    this.context = this._sanitizeContext(context);
    this.decision = decision; // AUTHORIZED, DENIED, APPROVED, REJECTED
    this.code = code;
    this.apiCalled = apiCalled;
    this.externalApiRequest = this._maskSecrets(externalApiRequest);
    this.externalApiResponse = this._maskSecrets(externalApiResponse);
    this.planHash = planHash;
    this.policyHash = policyHash;
    this.preCheckHash = preCheckHash;
    this.resultHash = resultHash;
    this.bridgeVersion = bridgeVersion;
    this.bridgeCommitSha = bridgeCommitSha;
    this.bridgeInstanceId = bridgeInstanceId;
    this.prevHash = prevHash;
    this.recordedAt = recordedAt;
    this.recordHash = this._computeHash();
  }

  /**
   * Compute SHA256 hash of this record (excluding recordHash itself)
   */
  _computeHash() {
    const hashInput = {
      recordId: this.recordId,
      transactionId: this.transactionId,
      operationId: this.operationId,
      operationType: this.operationType,
      correlationId: this.correlationId,
      principal: this.principal,
      decision: this.decision,
      code: this.code,
      apiCalled: this.apiCalled,
      planHash: this.planHash,
      policyHash: this.policyHash,
      preCheckHash: this.preCheckHash,
      resultHash: this.resultHash,
      bridgeVersion: this.bridgeVersion,
      bridgeCommitSha: this.bridgeCommitSha,
      bridgeInstanceId: this.bridgeInstanceId,
      prevHash: this.prevHash,
      recordedAt: this.recordedAt
    };

    return crypto
      .createHash('sha256')
      .update(JSON.stringify(hashInput))
      .digest('hex');
  }

  /**
   * Verify hash integrity
   */
  verifyIntegrity() {
    const computedHash = this._computeHash();
    return {
      valid: computedHash === this.recordHash,
      computed: computedHash,
      stored: this.recordHash
    };
  }

  /**
   * Sanitize context (remove sensitive fields)
   */
  _sanitizeContext(context = {}) {
    const sanitized = { ...context };

    // Keep essential fields
    const allowed = ['appId', 'environmentId', 'operationType', 'branch', 'canonicalBranch'];
    const minimal = {};

    for (const key of allowed) {
      if (key in context) {
        minimal[key] = sanitized[key];
      }
    }

    return minimal;
  }

  /**
   * Mask secret values
   */
  _maskSecrets(obj) {
    if (!obj) return null;
    if (typeof obj !== 'object') return obj;

    const masked = { ...obj };

    for (const key in masked) {
      if (/secret|password|token|key|credential|authorization|x-api-key/i.test(key)) {
        masked[key] = '[REDACTED]';
      } else if (typeof masked[key] === 'object' && masked[key] !== null) {
        masked[key] = this._maskSecrets(masked[key]);
      }
    }

    return masked;
  }

  /**
   * Serialize to JSON
   */
  toJSON() {
    return {
      recordId: this.recordId,
      transactionId: this.transactionId,
      operationId: this.operationId,
      operationType: this.operationType,
      correlationId: this.correlationId,
      principal: this.principal,
      decision: this.decision,
      code: this.code,
      apiCalled: this.apiCalled,
      planHash: this.planHash,
      policyHash: this.policyHash,
      preCheckHash: this.preCheckHash,
      resultHash: this.resultHash,
      bridgeVersion: this.bridgeVersion,
      bridgeCommitSha: this.bridgeCommitSha,
      bridgeInstanceId: this.bridgeInstanceId,
      prevHash: this.prevHash,
      recordHash: this.recordHash,
      recordedAt: this.recordedAt
    };
  }
}

/**
 * Evidence Ledger: Append-only audit trail
 */
class EvidenceLedger {
  constructor({ maxRecords = 100000 } = {}) {
    this.records = [];
    this.maxRecords = maxRecords;
    this.lastHash = null;
  }

  /**
   * Append a record to the ledger
   */
  append(recordData = {}) {
    if (this.records.length >= this.maxRecords) {
      throw new Error(`Ledger capacity exceeded (max ${this.maxRecords} records)`);
    }

    const record = new EvidenceRecord({
      ...recordData,
      prevHash: this.lastHash
    });

    // Verify hash chain
    if (!record.verifyIntegrity().valid) {
      throw new Error('Record hash integrity check failed');
    }

    this.records.push(record);
    this.lastHash = record.recordHash;

    return record;
  }

  /**
   * Get a record by ID
   */
  getRecord(recordId) {
    return this.records.find(r => r.recordId === recordId);
  }

  /**
   * Query records by filter
   */
  query(filter = {}) {
    let results = this.records;

    if (filter.transactionId) {
      results = results.filter(r => r.transactionId === filter.transactionId);
    }

    if (filter.operationType) {
      results = results.filter(r => r.operationType === filter.operationType);
    }

    if (filter.decision) {
      results = results.filter(r => r.decision === filter.decision);
    }

    if (filter.principal) {
      results = results.filter(r => r.principal === filter.principal);
    }

    if (filter.fromTime && filter.toTime) {
      const from = new Date(filter.fromTime);
      const to = new Date(filter.toTime);
      results = results.filter(r => {
        const recordTime = new Date(r.recordedAt);
        return recordTime >= from && recordTime <= to;
      });
    }

    return results;
  }

  /**
   * Verify ledger integrity (check all hashes in chain)
   */
  verifyIntegrity() {
    const errors = [];

    for (let i = 0; i < this.records.length; i++) {
      const record = this.records[i];
      const integrity = record.verifyIntegrity();

      if (!integrity.valid) {
        errors.push({
          index: i,
          recordId: record.recordId,
          error: `Hash mismatch: computed ${integrity.computed}, stored ${integrity.stored}`
        });
      }

      // Check hash chain
      if (i > 0) {
        const prevRecord = this.records[i - 1];
        if (record.prevHash !== prevRecord.recordHash) {
          errors.push({
            index: i,
            recordId: record.recordId,
            error: `Hash chain broken: prevHash ${record.prevHash} != prev record hash ${prevRecord.recordHash}`
          });
        }
      } else {
        // First record should have null prevHash
        if (record.prevHash !== null) {
          errors.push({
            index: 0,
            recordId: record.recordId,
            error: `First record should have null prevHash, got ${record.prevHash}`
          });
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      totalRecords: this.records.length
    };
  }

  /**
   * Get statistics
   */
  getStatistics() {
    const authorized = this.records.filter(r => r.decision === 'AUTHORIZED').length;
    const denied = this.records.filter(r => r.decision === 'DENIED').length;
    const approved = this.records.filter(r => r.decision === 'APPROVED').length;

    return {
      totalRecords: this.records.length,
      authorized,
      denied,
      approved,
      lastHash: this.lastHash,
      capacity: {
        used: this.records.length,
        max: this.maxRecords,
        percentUsed: Math.round((this.records.length / this.maxRecords) * 100)
      }
    };
  }

  /**
   * Export records (read-only, no deletion)
   */
  export(filter = {}) {
    const records = this.query(filter);
    return records.map(r => r.toJSON());
  }

  /**
   * Physical deletion is PROHIBITED
   * This method always throws
   */
  delete() {
    throw new Error('Physical deletion of audit records is prohibited. Ledger is append-only.');
  }

  /**
   * Physical modification is PROHIBITED
   * This method always throws
   */
  modify() {
    throw new Error('Modification of audit records is prohibited. Ledger is immutable.');
  }

  /**
   * Get the entire ledger (use with caution - may be large)
   */
  getFullLedger() {
    return this.records.map(r => r.toJSON());
  }

  /**
   * Estimate ledger size in bytes
   */
  estimateSize() {
    return this.records.reduce((sum, r) => sum + JSON.stringify(r.toJSON()).length, 0);
  }
}

module.exports = {
  EvidenceRecord,
  EvidenceLedger
};
