const test = require('node:test');
const assert = require('node:assert');
const {
  EvidenceRecord,
  EvidenceLedger
} = require('../src/evidenceLedger');

test('Evidence Ledger', async (t) => {
  await t.test('creates evidence record with required fields', () => {
    const record = new EvidenceRecord({
      transactionId: 'tx-123',
      operationId: 'op-456',
      operationType: 'save',
      correlationId: 'corr-789'
    });

    assert.ok(record.recordId);
    assert.strictEqual(record.transactionId, 'tx-123');
    assert.strictEqual(record.operationId, 'op-456');
    assert.strictEqual(record.operationType, 'save');
    assert.strictEqual(record.correlationId, 'corr-789');
    assert.strictEqual(record.decision, 'AUTHORIZED');
    assert.strictEqual(record.principal, 'system');
    assert.ok(record.recordHash);
    assert.ok(record.recordedAt);
  });

  await t.test('computes record hash from fields', () => {
    const record = new EvidenceRecord({
      transactionId: 'tx-123',
      operationType: 'save'
    });

    const integrity = record.verifyIntegrity();
    assert.strictEqual(integrity.valid, true);
    assert.strictEqual(integrity.computed, record.recordHash);
  });

  await t.test('sanitizes context to allowed fields only', () => {
    const record = new EvidenceRecord({
      context: {
        appId: 'app-1',
        environmentId: 'env-prod',
        operationType: 'save',
        branch: 'main',
        canonicalBranch: 'main',
        secretKey: 'should-be-removed',
        sensitive: 'also-removed'
      }
    });

    assert.strictEqual(record.context.appId, 'app-1');
    assert.strictEqual(record.context.environmentId, 'env-prod');
    assert.strictEqual(record.context.operationType, 'save');
    assert.strictEqual(record.context.branch, 'main');
    assert.strictEqual(record.context.canonicalBranch, 'main');
    assert.strictEqual(record.context.secretKey, undefined);
    assert.strictEqual(record.context.sensitive, undefined);
  });

  await t.test('masks secret values in API request', () => {
    const request = {
      headers: {
        'x-api-key': 'secret123',
        'authorization': 'Bearer token456',
        'content-type': 'application/json'
      },
      body: {
        data: 'public'
      }
    };

    const record = new EvidenceRecord({
      externalApiRequest: request
    });

    assert.strictEqual(record.externalApiRequest.headers['x-api-key'], '[REDACTED]');
    assert.strictEqual(record.externalApiRequest.headers.authorization, '[REDACTED]');
    assert.strictEqual(record.externalApiRequest.headers['content-type'], 'application/json');
    assert.strictEqual(record.externalApiRequest.body.data, 'public');
  });

  await t.test('masks secret values in API response', () => {
    const response = {
      status: 200,
      body: {
        token: 'secret789',
        password: 'pass123',
        data: 'public'
      }
    };

    const record = new EvidenceRecord({
      externalApiResponse: response
    });

    assert.strictEqual(record.externalApiResponse.status, 200);
    assert.strictEqual(record.externalApiResponse.body.token, '[REDACTED]');
    assert.strictEqual(record.externalApiResponse.body.password, '[REDACTED]');
    assert.strictEqual(record.externalApiResponse.body.data, 'public');
  });

  await t.test('serializes record to JSON', () => {
    const record = new EvidenceRecord({
      transactionId: 'tx-123',
      operationType: 'save',
      decision: 'AUTHORIZED'
    });

    const json = record.toJSON();

    assert.ok(json.recordId);
    assert.strictEqual(json.transactionId, 'tx-123');
    assert.strictEqual(json.operationType, 'save');
    assert.strictEqual(json.decision, 'AUTHORIZED');
    assert.ok(json.recordHash);
  });

  await t.test('creates ledger with default capacity', () => {
    const ledger = new EvidenceLedger();

    assert.strictEqual(ledger.maxRecords, 100000);
    assert.strictEqual(ledger.records.length, 0);
    assert.strictEqual(ledger.lastHash, null);
  });

  await t.test('appends record to ledger', () => {
    const ledger = new EvidenceLedger();

    const record = ledger.append({
      transactionId: 'tx-1',
      operationType: 'save'
    });

    assert.ok(record.recordId);
    assert.strictEqual(ledger.records.length, 1);
    assert.strictEqual(ledger.lastHash, record.recordHash);
  });

  await t.test('creates hash chain with prevHash links', () => {
    const ledger = new EvidenceLedger();

    const record1 = ledger.append({
      transactionId: 'tx-1',
      operationType: 'save'
    });

    const record2 = ledger.append({
      transactionId: 'tx-2',
      operationType: 'save'
    });

    assert.strictEqual(record1.prevHash, null);
    assert.strictEqual(record2.prevHash, record1.recordHash);
  });

  await t.test('throws when appending past capacity', () => {
    const ledger = new EvidenceLedger({ maxRecords: 2 });

    ledger.append({ transactionId: 'tx-1' });
    ledger.append({ transactionId: 'tx-2' });

    assert.throws(() => {
      ledger.append({ transactionId: 'tx-3' });
    }, /Ledger capacity exceeded/);
  });

  await t.test('verifies ledger integrity across all records', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ transactionId: 'tx-1' });
    ledger.append({ transactionId: 'tx-2' });
    ledger.append({ transactionId: 'tx-3' });

    const integrity = ledger.verifyIntegrity();

    assert.strictEqual(integrity.valid, true);
    assert.strictEqual(integrity.errors.length, 0);
    assert.strictEqual(integrity.totalRecords, 3);
  });

  await t.test('detects hash tampering', () => {
    const ledger = new EvidenceLedger();

    const record = ledger.append({
      transactionId: 'tx-1',
      operationType: 'save'
    });

    // Tamper with record hash
    record.recordHash = 'tampered';

    const integrity = ledger.verifyIntegrity();

    assert.strictEqual(integrity.valid, false);
    assert.ok(integrity.errors.length > 0);
    assert.ok(integrity.errors[0].error.includes('Hash mismatch'));
  });

  await t.test('detects broken hash chain when prevHash does not match prior record', () => {
    const ledger = new EvidenceLedger();

    const record1 = ledger.append({
      transactionId: 'tx-1'
    });

    const record2 = ledger.append({
      transactionId: 'tx-2'
    });

    // Tamper with prevHash by modifying it after append
    // Note: This also invalidates the record's hash because prevHash is part of the hash computation
    record2.prevHash = 'broken-hash-value';

    const integrity = ledger.verifyIntegrity();

    assert.strictEqual(integrity.valid, false);
    assert.ok(integrity.errors.length > 0);
    // Check that at least one error mentions the hash chain being broken
    const hasChainError = integrity.errors.some(e => e.error.includes('Hash chain broken'));
    assert.ok(hasChainError);
  });

  await t.test('queries records by transactionId', () => {
    const ledger = new EvidenceLedger();

    ledger.append({
      transactionId: 'tx-1',
      operationType: 'save'
    });

    ledger.append({
      transactionId: 'tx-2',
      operationType: 'save'
    });

    ledger.append({
      transactionId: 'tx-1',
      operationType: 'delete'
    });

    const results = ledger.query({ transactionId: 'tx-1' });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.transactionId === 'tx-1'));
  });

  await t.test('queries records by operationType', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ operationType: 'save' });
    ledger.append({ operationType: 'publish' });
    ledger.append({ operationType: 'save' });

    const results = ledger.query({ operationType: 'save' });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.operationType === 'save'));
  });

  await t.test('queries records by decision', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ decision: 'AUTHORIZED' });
    ledger.append({ decision: 'DENIED' });
    ledger.append({ decision: 'AUTHORIZED' });

    const results = ledger.query({ decision: 'AUTHORIZED' });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.decision === 'AUTHORIZED'));
  });

  await t.test('queries records by principal', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ principal: 'user-1' });
    ledger.append({ principal: 'system' });
    ledger.append({ principal: 'user-1' });

    const results = ledger.query({ principal: 'user-1' });

    assert.strictEqual(results.length, 2);
    assert.ok(results.every(r => r.principal === 'user-1'));
  });

  await t.test('queries records by time range', async () => {
    const ledger = new EvidenceLedger();

    const now = new Date();
    const before = new Date(now.getTime() - 5000);
    const after = new Date(now.getTime() + 5000);

    ledger.append({
      transactionId: 'tx-1',
      recordedAt: now.toISOString()
    });

    const results = ledger.query({
      fromTime: before.toISOString(),
      toTime: after.toISOString()
    });

    assert.strictEqual(results.length, 1);
  });

  await t.test('gets record by ID', () => {
    const ledger = new EvidenceLedger();

    const record1 = ledger.append({ transactionId: 'tx-1' });
    const record2 = ledger.append({ transactionId: 'tx-2' });

    const found = ledger.getRecord(record1.recordId);

    assert.strictEqual(found.recordId, record1.recordId);
    assert.strictEqual(found.transactionId, 'tx-1');
  });

  await t.test('returns null when record not found', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ transactionId: 'tx-1' });

    const found = ledger.getRecord('nonexistent-id');

    assert.strictEqual(found, undefined);
  });

  await t.test('throws when deleting (append-only enforcement)', () => {
    const ledger = new EvidenceLedger();

    assert.throws(() => {
      ledger.delete();
    }, /Physical deletion of audit records is prohibited/);
  });

  await t.test('throws when modifying (immutability enforcement)', () => {
    const ledger = new EvidenceLedger();

    assert.throws(() => {
      ledger.modify();
    }, /Modification of audit records is prohibited/);
  });

  await t.test('exports records with optional filter', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ transactionId: 'tx-1', operationType: 'save' });
    ledger.append({ transactionId: 'tx-2', operationType: 'publish' });
    ledger.append({ transactionId: 'tx-1', operationType: 'delete' });

    const exported = ledger.export({ transactionId: 'tx-1' });

    assert.strictEqual(exported.length, 2);
    assert.ok(exported.every(r => r.transactionId === 'tx-1'));
  });

  await t.test('gets full ledger', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ transactionId: 'tx-1' });
    ledger.append({ transactionId: 'tx-2' });
    ledger.append({ transactionId: 'tx-3' });

    const full = ledger.getFullLedger();

    assert.strictEqual(full.length, 3);
    assert.ok(full.every(r => r.recordHash && r.transactionId));
  });

  await t.test('estimates ledger size in bytes', () => {
    const ledger = new EvidenceLedger();

    ledger.append({
      transactionId: 'tx-1',
      operationType: 'save',
      context: { appId: 'app-1' }
    });

    const size = ledger.estimateSize();

    assert.ok(size > 0);
    assert.strictEqual(typeof size, 'number');
  });

  await t.test('returns statistics with counts by decision', () => {
    const ledger = new EvidenceLedger();

    ledger.append({ decision: 'AUTHORIZED' });
    ledger.append({ decision: 'AUTHORIZED' });
    ledger.append({ decision: 'DENIED' });
    ledger.append({ decision: 'APPROVED' });

    const stats = ledger.getStatistics();

    assert.strictEqual(stats.totalRecords, 4);
    assert.strictEqual(stats.authorized, 2);
    assert.strictEqual(stats.denied, 1);
    assert.strictEqual(stats.approved, 1);
    assert.ok(stats.lastHash);
  });

  await t.test('statistics includes capacity info', () => {
    const ledger = new EvidenceLedger({ maxRecords: 1000 });

    ledger.append({ transactionId: 'tx-1' });
    ledger.append({ transactionId: 'tx-2' });

    const stats = ledger.getStatistics();

    assert.strictEqual(stats.capacity.used, 2);
    assert.strictEqual(stats.capacity.max, 1000);
    assert.strictEqual(stats.capacity.percentUsed, 0); // 2/1000 = 0.2%, rounds to 0
  });

  await t.test('first record has null prevHash', () => {
    const ledger = new EvidenceLedger();

    const record = ledger.append({ transactionId: 'tx-1' });

    assert.strictEqual(record.prevHash, null);

    const integrity = ledger.verifyIntegrity();
    assert.strictEqual(integrity.valid, true);
  });

  await t.test('records maintain version and commit info', () => {
    const record = new EvidenceRecord({
      bridgeVersion: '1.0.0',
      bridgeCommitSha: 'abc123def456',
      bridgeInstanceId: 'instance-789'
    });

    assert.strictEqual(record.bridgeVersion, '1.0.0');
    assert.strictEqual(record.bridgeCommitSha, 'abc123def456');
    assert.strictEqual(record.bridgeInstanceId, 'instance-789');
  });

  await t.test('records store plan and policy hashes', () => {
    const record = new EvidenceRecord({
      planHash: 'hash-plan-123',
      policyHash: 'hash-policy-456',
      preCheckHash: 'hash-precheck-789',
      resultHash: 'hash-result-000'
    });

    assert.strictEqual(record.planHash, 'hash-plan-123');
    assert.strictEqual(record.policyHash, 'hash-policy-456');
    assert.strictEqual(record.preCheckHash, 'hash-precheck-789');
    assert.strictEqual(record.resultHash, 'hash-result-000');
  });

  await t.test('records flag external API calls', () => {
    const record = new EvidenceRecord({
      apiCalled: true,
      externalApiRequest: { method: 'POST', url: 'https://api.example.com' },
      externalApiResponse: { status: 200, body: { result: 'ok' } }
    });

    assert.strictEqual(record.apiCalled, true);
    assert.ok(record.externalApiRequest);
    assert.ok(record.externalApiResponse);
  });

  await t.test('records decision code and correlationId for tracing', () => {
    const record = new EvidenceRecord({
      decision: 'DENIED',
      code: 'POLICY_DENIED',
      correlationId: 'corr-trace-123'
    });

    assert.strictEqual(record.decision, 'DENIED');
    assert.strictEqual(record.code, 'POLICY_DENIED');
    assert.strictEqual(record.correlationId, 'corr-trace-123');
  });

  await t.test('ledger query combines multiple filters', () => {
    const ledger = new EvidenceLedger();

    ledger.append({
      transactionId: 'tx-1',
      operationType: 'save',
      decision: 'AUTHORIZED'
    });

    ledger.append({
      transactionId: 'tx-1',
      operationType: 'save',
      decision: 'DENIED'
    });

    ledger.append({
      transactionId: 'tx-2',
      operationType: 'save',
      decision: 'AUTHORIZED'
    });

    const results = ledger.query({
      transactionId: 'tx-1',
      operationType: 'save',
      decision: 'AUTHORIZED'
    });

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].transactionId, 'tx-1');
    assert.strictEqual(results[0].operationType, 'save');
    assert.strictEqual(results[0].decision, 'AUTHORIZED');
  });

  await t.test('ledger maintains order of records', () => {
    const ledger = new EvidenceLedger();

    const r1 = ledger.append({ transactionId: 'tx-1' });
    const r2 = ledger.append({ transactionId: 'tx-2' });
    const r3 = ledger.append({ transactionId: 'tx-3' });

    assert.strictEqual(ledger.records[0].recordId, r1.recordId);
    assert.strictEqual(ledger.records[1].recordId, r2.recordId);
    assert.strictEqual(ledger.records[2].recordId, r3.recordId);
  });

  await t.test('context sanitization removes sensitive fields without affecting allowed fields', () => {
    const record = new EvidenceRecord({
      context: {
        appId: 'app-1',
        environmentId: 'env-prod',
        operationType: 'save',
        branch: 'feature-x',
        canonicalBranch: 'main',
        userId: 'user-123',
        apiKey: 'secret',
        token: 'auth-token',
        extra: 'value'
      }
    });

    const ctx = record.context;
    assert.strictEqual(Object.keys(ctx).length, 5); // only allowed fields
    assert.ok(ctx.appId);
    assert.ok(ctx.environmentId);
    assert.ok(ctx.operationType);
    assert.ok(ctx.branch);
    assert.ok(ctx.canonicalBranch);
  });

  await t.test('nested object secret masking', () => {
    const response = {
      user: {
        name: 'Alice',
        credentials: {
          password: 'secret123',
          api_key: 'key456'
        }
      }
    };

    const record = new EvidenceRecord({
      externalApiResponse: response
    });

    assert.strictEqual(record.externalApiResponse.user.name, 'Alice');
    // When an object contains secret fields, the entire object is masked
    assert.strictEqual(record.externalApiResponse.user.credentials, '[REDACTED]');
  });
});
