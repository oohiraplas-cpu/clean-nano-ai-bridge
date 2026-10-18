const assert = require('node:assert/strict');
const test = require('node:test');
const { PaymentNotificationValidator } = require('../src/paymentNotificationValidator');

test('PaymentNotificationValidator', async (t) => {
  await t.test('validates valid overdue notification', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-09-01',
      daysOverdue: 8,
      amount: 100000
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  await t.test('rejects missing due date', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = { estimateId: 'EST-001', daysOverdue: 8 };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'missing_due_date'));
  });

  await t.test('rejects invalid date format', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = { estimateId: 'EST-001', dueDate: 'invalid-date', daysOverdue: 8 };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'invalid_date_format'));
  });

  await t.test('rejects future due date', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-11-01', // future date
      daysOverdue: -5
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'future_due_date'));
  });

  await t.test('rejects missing estimate ID', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = { estimateId: '', dueDate: '2026-09-01', daysOverdue: 8 };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'missing_estimate_id'));
  });

  await t.test('rejects already paid items', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-09-01',
      paidDate: '2026-09-15',
      daysOverdue: 8
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'already_paid'));
  });

  await t.test('rejects cancelled items', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-09-01',
      daysOverdue: 8,
      status: 'キャンセル'
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'cancelled_item'));
  });

  await t.test('recognizes cancelled status variants', () => {
    const validator = new PaymentNotificationValidator();
    const today = new Date('2026-10-09');

    const testCases = ['キャンセル', 'cancelled', 'cancel', 'キャンセル済み', 'CANCELLED'];

    for (const status of testCases) {
      const overdue = {
        estimateId: 'EST-001',
        dueDate: '2026-09-01',
        daysOverdue: 8,
        status
      };

      const result = validator.validateOverdueNotification(overdue, { today });
      assert.equal(result.valid, false, `Should reject status: ${status}`);
    }
  });

  await t.test('rejects blocklisted estimate IDs', () => {
    const validator = new PaymentNotificationValidator();
    validator.addToBlocklist('EST-BLOCKED');

    const overdue = {
      estimateId: 'EST-BLOCKED',
      dueDate: '2026-09-01',
      daysOverdue: 8
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'blocklisted'));
  });

  await t.test('validates allowlist', () => {
    const validator = new PaymentNotificationValidator({ allowlistDomains: ['EST-', 'INV-'] });

    const validOverdue = { estimateId: 'EST-001', dueDate: '2026-09-01', daysOverdue: 8 };
    const invalidOverdue = { estimateId: 'UNK-001', dueDate: '2026-09-01', daysOverdue: 8 };

    const result1 = validator.validateAllowlist(validOverdue);
    assert.equal(result1.allowed, true);

    const result2 = validator.validateAllowlist(invalidOverdue);
    assert.equal(result2.allowed, false);
  });

  await t.test('does not restrict when allowlist is empty', () => {
    const validator = new PaymentNotificationValidator({ allowlistDomains: [] });

    const overdue = { estimateId: 'ANY-001', dueDate: '2026-09-01', daysOverdue: 8 };

    const result = validator.validateAllowlist(overdue);
    assert.equal(result.allowed, true);
  });

  await t.test('validates batch of overdue items', () => {
    const validator = new PaymentNotificationValidator();
    const today = new Date('2026-10-09');

    const overdueList = [
      { estimateId: 'EST-001', dueDate: '2026-09-01', daysOverdue: 8 },
      { estimateId: 'EST-002', dueDate: '2026-09-05', daysOverdue: 4 },
      { estimateId: '', dueDate: '2026-09-10', daysOverdue: -1 }, // invalid
      { estimateId: 'EST-004', dueDate: '2026-09-01', paidDate: '2026-09-15', daysOverdue: 8 } // already paid
    ];

    const result = validator.validateOverdueList(overdueList, { today });

    assert.equal(result.validCount, 2);
    assert.equal(result.invalidCount, 2);
    assert.equal(result.valid.length, 2);
    assert.equal(result.invalid.length, 2);
    assert.ok(result.acceptanceRate.includes('%'));
  });

  await t.test('manages blocklist', () => {
    const validator = new PaymentNotificationValidator();

    validator.addToBlocklist('EST-BLOCKED');
    validator.addToBlocklist('EST-BLOCKED'); // duplicate

    const list = validator.getBlocklist();
    assert.equal(list.length, 1);
    assert.ok(list.includes('EST-BLOCKED'));
  });

  await t.test('manages allowlist', () => {
    const validator = new PaymentNotificationValidator();

    validator.addToAllowlist('EST-');
    validator.addToAllowlist('INV-');
    validator.addToAllowlist('EST-'); // duplicate

    const list = validator.getAllowlist();
    assert.equal(list.length, 2);
    assert.ok(list.includes('EST-'));
    assert.ok(list.includes('INV-'));
  });

  await t.test('rejects negative daysOverdue', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-10-20',
      daysOverdue: -5 // negative = future
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    // This will fail with future_due_date first, which is the correct behavior
    // but we can also check for negative_overdue_days when dueDate is in past
    assert.ok(result.issues.length > 0);
  });

  await t.test('detects negative daysOverdue for past due dates', () => {
    const validator = new PaymentNotificationValidator();
    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-09-01',
      daysOverdue: -5 // negative overdue with past due date = data inconsistency
    };
    const today = new Date('2026-10-09');

    const result = validator.validateOverdueNotification(overdue, { today });

    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => i.type === 'negative_overdue_days'));
  });

  await t.test('returns comprehensive validation report', () => {
    const validator = new PaymentNotificationValidator();
    const today = new Date('2026-10-09');

    const overdueList = [
      { estimateId: 'EST-001', dueDate: '2026-09-01', daysOverdue: 8 },
      { estimateId: 'EST-002', dueDate: '2026-09-05', daysOverdue: 4 },
      { estimateId: 'EST-003', dueDate: '2026-09-10', daysOverdue: -1 }
    ];

    const result = validator.validateOverdueList(overdueList, { today });

    assert.ok(result.validCount >= 0);
    assert.ok(result.invalidCount >= 0);
    assert.equal(result.validCount + result.invalidCount, overdueList.length);
    assert.ok(Array.isArray(result.valid));
    assert.ok(Array.isArray(result.invalid));
  });
});
