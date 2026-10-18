const assert = require('node:assert/strict');
const test = require('node:test');
const { PaymentNotificationIdempotency } = require('../src/paymentNotificationIdempotency');

test('PaymentNotificationIdempotency', async (t) => {
  await t.test('generates consistent hash for same estimate and due date', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue1 = { estimateId: 'EST-001', dueDate: '2026-10-01' };
    const overdue2 = { estimateId: 'EST-001', dueDate: '2026-10-01' };

    const hash1 = idempotency.generateNotificationHash(overdue1);
    const hash2 = idempotency.generateNotificationHash(overdue2);

    assert.equal(hash1, hash2, 'Same estimate and due date should produce same hash');
  });

  await t.test('generates different hash for different estimates', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue1 = { estimateId: 'EST-001', dueDate: '2026-10-01' };
    const overdue2 = { estimateId: 'EST-002', dueDate: '2026-10-01' };

    const hash1 = idempotency.generateNotificationHash(overdue1);
    const hash2 = idempotency.generateNotificationHash(overdue2);

    assert.notEqual(hash1, hash2, 'Different estimates should produce different hashes');
  });

  await t.test('records notification and can retrieve it', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5, amount: 100000 };

    idempotency.recordNotification(overdue, 'sent');
    const records = idempotency.getRecords();

    assert.equal(records.length, 1);
    assert.equal(records[0].estimateId, 'EST-001');
    assert.equal(records[0].status, 'sent');
    assert.equal(records[0].daysOverdue, 5);
  });

  await t.test('skips notification within 24 hours with same or worse overdue state', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5, amount: 100000 };

    // 最初の通知を記録
    idempotency.recordNotification(overdue, 'sent');

    // 同じ状態で再度チェック
    const shouldSkip = idempotency.shouldSkipNotification(overdue);
    assert.equal(shouldSkip, true, 'Should skip within 24 hours with same overdue state');
  });

  await t.test('does not skip notification when overdue days increase', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const idempotency2 = new PaymentNotificationIdempotency();

    // 同じ internal store を共有させる（シミュレーション）
    const store = new Map();
    const overdue1 = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5, amount: 100000 };
    const overdue2 = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 8, amount: 100000 };

    // 手動で store を設定
    const hash = idempotency.generateNotificationHash(overdue1);
    store.set(hash, {
      timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12時間前
      status: 'sent',
      estimateId: 'EST-001',
      dueDate: '2026-10-01',
      daysOverdue: 5,
      amount: 100000
    });
    idempotency.store = store;

    // 超過日数が増加 → スキップしない
    const shouldSkip = idempotency.shouldSkipNotification(overdue2);
    assert.equal(shouldSkip, false, 'Should not skip when overdue days increase');
  });

  await t.test('skips notification within 24 hours with decreased overdue days (status improved)', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const store = new Map();

    const overdue1 = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 8, amount: 100000 };
    const overdue2 = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5, amount: 100000 }; // improved

    const hash = idempotency.generateNotificationHash(overdue1);
    store.set(hash, {
      timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(), // 12時間前
      status: 'sent',
      estimateId: 'EST-001',
      dueDate: '2026-10-01',
      daysOverdue: 8,
      amount: 100000
    });
    idempotency.store = store;

    const shouldSkip = idempotency.shouldSkipNotification(overdue2);
    assert.equal(shouldSkip, true, 'Should skip when status has improved (overdue days decreased)');
  });

  await t.test('does not skip notification after 24 hours even with same state', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const store = new Map();

    const overdue = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5, amount: 100000 };

    // 25時間前に記録
    const hash = idempotency.generateNotificationHash(overdue);
    store.set(hash, {
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      status: 'sent',
      estimateId: 'EST-001',
      dueDate: '2026-10-01',
      daysOverdue: 5,
      amount: 100000
    });
    idempotency.store = store;

    const shouldSkip = idempotency.shouldSkipNotification(overdue);
    assert.equal(shouldSkip, false, 'Should not skip after 24 hours have passed');
  });

  await t.test('prunes old records beyond maxHistoryDays', () => {
    const idempotency = new PaymentNotificationIdempotency({ maxHistoryDays: 7 });
    const today = new Date('2026-10-09');

    // 古い記録を追加（35日前）
    idempotency.store.set('old-hash', {
      timestamp: new Date(today.getTime() - 35 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'sent',
      estimateId: 'EST-001',
      dueDate: '2026-09-04',
      daysOverdue: 35,
      amount: 100000
    });

    // 新しい記録を追加（3日前）
    idempotency.store.set('new-hash', {
      timestamp: new Date(today.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      status: 'sent',
      estimateId: 'EST-002',
      dueDate: '2026-10-06',
      daysOverdue: 3,
      amount: 50000
    });

    assert.equal(idempotency.getRecords().length, 2);

    // 古い記録をクリア
    idempotency.pruneOldRecords(today);

    const records = idempotency.getRecords();
    assert.equal(records.length, 1, 'Old record should be pruned');
    assert.equal(records[0].estimateId, 'EST-002', 'New record should remain');
  });

  await t.test('clears specific record by hash', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue = { estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5 };

    idempotency.recordNotification(overdue);
    const hash = idempotency.generateNotificationHash(overdue);

    assert.equal(idempotency.getRecords().length, 1);
    idempotency.clearRecord(hash);
    assert.equal(idempotency.getRecords().length, 0);
  });

  await t.test('clears all records', () => {
    const idempotency = new PaymentNotificationIdempotency();

    idempotency.recordNotification({ estimateId: 'EST-001', dueDate: '2026-10-01', daysOverdue: 5 });
    idempotency.recordNotification({ estimateId: 'EST-002', dueDate: '2026-10-02', daysOverdue: 3 });

    assert.equal(idempotency.getRecords().length, 2);
    idempotency.clearAll();
    assert.equal(idempotency.getRecords().length, 0);
  });

  await t.test('handles missing estimateId gracefully', () => {
    const idempotency = new PaymentNotificationIdempotency();
    const overdue = { estimateId: undefined, dueDate: '2026-10-01' };

    const hash = idempotency.generateNotificationHash(overdue);
    assert.ok(hash, 'Should generate hash even with missing estimateId');

    idempotency.recordNotification(overdue);
    assert.equal(idempotency.getRecords().length, 1);
  });
});
