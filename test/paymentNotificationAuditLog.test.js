const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { PaymentNotificationAuditLog } = require('../src/paymentNotificationAuditLog');

test('PaymentNotificationAuditLog', async (t) => {
  const tempDir = path.join(__dirname, '..', 'data', 'temp-audit-log');
  const logPath = path.join(tempDir, 'audit.log');

  await t.test('creates log directory if not exists', () => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    assert.ok(fs.existsSync(tempDir), 'Log directory should be created');
  });

  await t.test('logs discovery operation', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logDiscovery(5, 'list-123', 'site-456');
    log.flush();

    const entries = log.readLog();
    assert.ok(entries.length > 0);
    assert.equal(entries[0].action, 'DISCOVERY');
    assert.equal(entries[0].details.sitesDiscovered, 5);
  });

  await t.test('logs data fetch operation', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logDataFetch(50, 'list-123', 'site-456');
    log.flush();

    const entries = log.readLog();
    const fetchEntry = entries.find(e => e.action === 'DATA_FETCH');
    assert.ok(fetchEntry);
    assert.equal(fetchEntry.details.itemsRetrieved, 50);
    assert.equal(fetchEntry.details.readOnlyMode, true);
  });

  await t.test('logs analysis operation', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logAnalysis(3, 5, 12, 1);
    log.flush();

    const entries = log.readLog();
    const analysisEntry = entries.find(e => e.action === 'ANALYSIS');
    assert.ok(analysisEntry);
    assert.equal(analysisEntry.details.results.overdueCount, 3);
    assert.equal(analysisEntry.details.results.pendingCount, 5);
  });

  await t.test('logs validation test results', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logValidation('overdue_detection', true, { itemsChecked: 10 });
    log.logValidation('duplicate_check', false, { duplicatesFound: 2 });
    log.flush();

    const entries = log.readLog();
    const validationEntries = entries.filter(e => e.action === 'VALIDATION');
    assert.equal(validationEntries.length, 2);
    assert.equal(validationEntries[1].details.status, 'PASS');
    assert.equal(validationEntries[0].details.status, 'FAIL');
  });

  await t.test('logs notification sent', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    const overdue = {
      estimateId: 'EST-001',
      dueDate: '2026-09-01',
      daysOverdue: 8,
      amount: 100000
    };

    log.logNotification('overdue_alert', overdue, 'sent');
    log.flush();

    const entries = log.readLog();
    const notifEntry = entries.find(e => e.action === 'NOTIFICATION');
    assert.ok(notifEntry);
    assert.equal(notifEntry.details.estimateId, 'EST-001');
    assert.equal(notifEntry.details.status, 'sent');
  });

  await t.test('logs notification skipped', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logNotificationSkipped('EST-001', 'within_24_hours');
    log.flush();

    const entries = log.readLog();
    const skippedEntry = entries.find(e => e.action === 'NOTIFICATION_SKIPPED');
    assert.ok(skippedEntry);
    assert.equal(skippedEntry.details.reason, 'within_24_hours');
  });

  await t.test('logs errors with context', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    const error = new Error('Connection failed');
    error.code = 'ECONNREFUSED';

    log.logError('fetch_sharepoint_data', error, { siteId: 'site-456' });
    log.flush();

    const entries = log.readLog();
    const errorEntry = entries.find(e => e.action === 'ERROR');
    assert.ok(errorEntry);
    assert.equal(errorEntry.details.errorMessage, 'Connection failed');
    assert.equal(errorEntry.details.context.siteId, 'site-456');
  });

  await t.test('logs Power Automate setup', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.logPowerAutomateSetup({
      flowName: 'Payment Monitoring Daily Alert',
      schedule: 'daily_08:00_JST',
      allowlist: ['EST-', 'INV-'],
      status: 'draft_created'
    });
    log.flush();

    const entries = log.readLog();
    const setupEntry = entries.find(e => e.action === 'POWER_AUTOMATE_SETUP');
    assert.ok(setupEntry);
    assert.equal(setupEntry.details.notificationEnabled, false);
    assert.equal(setupEntry.details.readOnlyMode, true);
  });

  await t.test('buffers entries and flushes on overflow', () => {
    const bufferLogPath = path.join(tempDir, 'buffer-test-overflow.log');
    if (fs.existsSync(bufferLogPath)) fs.unlinkSync(bufferLogPath);

    const log = new PaymentNotificationAuditLog({ logFilePath: bufferLogPath, maxEntriesInMemory: 2 });

    log.logDiscovery(1, 'list-1', 'site-1');
    log.logDataFetch(10, 'list-2', 'site-2');
    log.logAnalysis(1, 2, 3, 0);

    // メモリバッファにはANALYSISの1つが残っているはず
    assert.equal(log.memoryBuffer.length, 1);
    assert.equal(log.memoryBuffer[0].action, 'ANALYSIS');

    // 手動フラッシュ
    log.flush();

    // バッファが空になった
    assert.equal(log.memoryBuffer.length, 0);

    // ファイルに3つのエントリが書き込まれている
    const entries = log.readLog({ limit: 100 });
    assert.ok(entries.some(e => e.action === 'DISCOVERY'));
    assert.ok(entries.some(e => e.action === 'DATA_FETCH'));
    assert.ok(entries.some(e => e.action === 'ANALYSIS'));

    // クリーンアップ
    if (fs.existsSync(bufferLogPath)) fs.unlinkSync(bufferLogPath);
  });

  await t.test('filters log entries', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    const notificationEntries = log.filterLog(e => e.action === 'NOTIFICATION');
    const errorEntries = log.filterLog(e => e.action === 'ERROR');

    assert.ok(Array.isArray(notificationEntries));
    assert.ok(Array.isArray(errorEntries));
  });

  await t.test('summarizes log by action', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    const summary = log.summarizeByAction();

    assert.ok(typeof summary === 'object');
    assert.ok(Object.keys(summary).length > 0);
    assert.ok(summary['DISCOVERY'] >= 0);
  });

  await t.test('exports log to CSV format', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    const csv = log.exportToCSV({ limit: 10 });

    assert.ok(typeof csv === 'string');
    assert.ok(csv.includes('timestamp'));
    assert.ok(csv.includes('action'));
    assert.ok(csv.includes('\n'));
  });

  await t.test('flushes empty buffer without error', () => {
    const log = new PaymentNotificationAuditLog({ logFilePath: logPath });

    log.memoryBuffer = [];
    assert.doesNotThrow(() => log.flush());
  });

  await t.test('handles corrupted log entries gracefully', () => {
    const corruptPath = path.join(tempDir, 'corrupt.log');
    fs.writeFileSync(corruptPath, 'invalid json line\n{"valid": "entry"}');

    const log = new PaymentNotificationAuditLog({ logFilePath: corruptPath });
    const entries = log.readLog();

    // 無効な行はスキップされて、有効なエントリのみが返される
    assert.equal(entries.length, 1);
    assert.equal(entries[0].valid, 'entry');
  });

  await t.test('handles missing log file gracefully', () => {
    const missingPath = path.join(tempDir, 'missing.log');

    const log = new PaymentNotificationAuditLog({ logFilePath: missingPath });
    const entries = log.readLog();

    assert.deepEqual(entries, []);
  });

  // クリーンアップ
  await t.test('cleanup', () => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
