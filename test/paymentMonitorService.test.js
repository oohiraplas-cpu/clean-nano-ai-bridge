const test = require('node:test');
const assert = require('node:assert');
const { PaymentMonitorService } = require('../src/paymentMonitorService');

test('PaymentMonitorService', async (t) => {
  const today = new Date('2026-10-09');

  await t.test('未入金判定 - 期限内', () => {
    const service = new PaymentMonitorService();
    // 期限: 2026-10-15（あと6日）
    const result = service.calculatePaymentStatus('2026-10-15', null, today);
    assert.strictEqual(result.status, 'pending');
    assert.strictEqual(result.daysUntilDue, 6);
    assert.strictEqual(result.daysOverdue, 0);
  });

  await t.test('未入金判定 - 期限超過', () => {
    const service = new PaymentMonitorService();
    // 期限: 2026-10-05（4日超過）
    const result = service.calculatePaymentStatus('2026-10-05', null, today);
    assert.strictEqual(result.status, 'overdue');
    assert.strictEqual(result.daysOverdue, 4);
  });

  await t.test('入金済み判定 - 期限内入金', () => {
    const service = new PaymentMonitorService();
    const result = service.calculatePaymentStatus('2026-10-10', '2026-10-09', today);
    assert.strictEqual(result.status, 'paid');
    assert.match(result.statusLabel, /期限内入金/);
  });

  await t.test('入金済み判定 - 遅延入金', () => {
    const service = new PaymentMonitorService();
    const result = service.calculatePaymentStatus('2026-10-05', '2026-10-07', today);
    assert.strictEqual(result.status, 'paid');
    assert.match(result.statusLabel, /遅延入金/);
  });

  await t.test('支払いデータ分析', () => {
    const service = new PaymentMonitorService();

    const mockItems = [
      // 期限超過（4日）、未入金
      {
        itemId: '1',
        fields: {
          estimateId: 'EST-001',
          invoiceId: 'INV-001',
          dueDate: '2026-10-05',
          paidDate: null,
          amount: 100000
        }
      },
      // 期限内（6日）、未入金
      {
        itemId: '2',
        fields: {
          estimateId: 'EST-002',
          invoiceId: 'INV-002',
          dueDate: '2026-10-15',
          paidDate: null,
          amount: 50000
        }
      },
      // 入金済み、期限内
      {
        itemId: '3',
        fields: {
          estimateId: 'EST-003',
          invoiceId: 'INV-003',
          dueDate: '2026-10-08',
          paidDate: '2026-10-08',
          amount: 75000
        }
      },
      // キャンセル
      {
        itemId: '4',
        fields: {
          estimateId: 'EST-004',
          invoiceId: 'INV-004',
          dueDate: '2026-10-20',
          paidDate: null,
          amount: 25000,
          status: 'キャンセル'
        }
      }
    ];

    const analysis = service.analyzePayments(mockItems, [], today);

    assert.strictEqual(analysis.overdue.length, 1, '期限超過: 1件');
    assert.strictEqual(analysis.pending.length, 1, '期限内未入金: 1件');
    assert.strictEqual(analysis.paid.length, 1, '入金済み: 1件');
    assert.strictEqual(analysis.cancelled.length, 1, 'キャンセル: 1件');

    assert.strictEqual(analysis.overdue[0].estimateId, 'EST-001');
    assert.strictEqual(analysis.overdue[0].daysOverdue, 4);

    assert.strictEqual(analysis.summary.total, 4);
    assert.strictEqual(analysis.summary.overdueCount, 1);
    assert.strictEqual(analysis.summary.pendingCount, 1);
    assert.strictEqual(analysis.summary.paidCount, 1);
    assert.strictEqual(analysis.summary.cancelledCount, 1);
    // totalAmount はキャンセルを除いた実績金額（225000 = 100000 + 50000 + 75000）
    assert.strictEqual(analysis.summary.totalAmount, 225000);
    assert.strictEqual(analysis.summary.overdueAmount, 100000);
    assert.strictEqual(analysis.summary.overdueRate, '44.4');
  });

  await t.test('ソート: 期限超過は超過日数が長い順', () => {
    const service = new PaymentMonitorService();

    const mockItems = [
      {
        itemId: '1',
        fields: {
          estimateId: 'EST-001',
          dueDate: '2026-10-05',
          paidDate: null,
          amount: 100000
        }
      },
      {
        itemId: '2',
        fields: {
          estimateId: 'EST-002',
          dueDate: '2026-10-01',
          paidDate: null,
          amount: 50000
        }
      }
    ];

    const analysis = service.analyzePayments(mockItems, [], today);

    assert.strictEqual(analysis.overdue.length, 2);
    assert.strictEqual(analysis.overdue[0].estimateId, 'EST-002'); // 8日超過（先）
    assert.strictEqual(analysis.overdue[1].estimateId, 'EST-001'); // 4日超過（後）
  });

  await t.test('ソート: 期限内未入金は期限が近い順', () => {
    const service = new PaymentMonitorService();

    const mockItems = [
      {
        itemId: '1',
        fields: {
          estimateId: 'EST-001',
          dueDate: '2026-10-20',
          paidDate: null,
          amount: 100000
        }
      },
      {
        itemId: '2',
        fields: {
          estimateId: 'EST-002',
          dueDate: '2026-10-12',
          paidDate: null,
          amount: 50000
        }
      }
    ];

    const analysis = service.analyzePayments(mockItems, [], today);

    assert.strictEqual(analysis.pending.length, 2);
    assert.strictEqual(analysis.pending[0].estimateId, 'EST-002'); // 3日後（先）
    assert.strictEqual(analysis.pending[1].estimateId, 'EST-001'); // 11日後（後）
  });

  await t.test('日付パース - ISO 8601', () => {
    const service = new PaymentMonitorService();
    const dateStr = '2026-10-09T12:34:56Z';
    const result = service.calculatePaymentStatus(dateStr, null, new Date('2026-10-09'));
    assert.strictEqual(result.status, 'pending');
  });

  await t.test('期限未設定', () => {
    const service = new PaymentMonitorService();
    const result = service.calculatePaymentStatus(null, null, today);
    assert.strictEqual(result.status, 'unknown');
    assert.match(result.statusLabel, /期限未設定/);
  });

  await t.test('generatePaymentReport - エラーハンドリング', async () => {
    const mockReader = {
      listItems: async () => {
        throw new Error('接続エラー');
      }
    };

    const service = new PaymentMonitorService({
      sharePointReader: mockReader
    });

    const report = await service.generatePaymentReport();
    assert.strictEqual(report.errors.length, 1);
    assert.match(report.errors[0], /接続エラー/);
    assert.deepStrictEqual(report.analysis.summary, null);
  });

  await t.test('getOverduePayments - 抽出と要約', async () => {
    const mockReader = {
      listItems: async () => ({
        items: [
          {
            itemId: '1',
            fields: {
              estimateId: 'EST-001',
              invoiceId: 'INV-001',
              dueDate: '2026-10-05',
              paidDate: null,
              amount: 100000
            }
          }
        ],
        columns: []
      })
    };

    const service = new PaymentMonitorService({
      sharePointReader: mockReader
    });

    // getOverduePayments は内部で analyzePayments を呼び出すが、today 固定値を使うため
    // ここでは期限超過が発生する状態を確認（相対的な期限チェック）
    const result = await service.getOverduePayments();
    assert.strictEqual(result.status, 'ok');
    assert.strictEqual(result.overdue.length, 1);
    assert.strictEqual(result.overdue[0].estimateId, 'EST-001');
    // daysOverdue は today（実行時刻） - '2026-10-05' で決まるため、固定値チェックは不可
    // 代わりに期限超過フラグ（daysOverdue > 0）のみチェック
    assert(result.overdue[0].daysOverdue >= 0, 'daysOverdue >= 0');
    assert.strictEqual(result.summary.count, 1, 'overdue count');
    assert.strictEqual(result.summary.totalAmount, 100000, 'overdueAmount');
  });
});
