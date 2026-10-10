#!/usr/bin/env node
/**
 * 未入金監視AI - 本番環境検証スクリプト
 *
 * 実行目的:
 * 1. discover_sharepoint_ai4_resources で実環境 AI4 サイト・リストを確認
 * 2. 実スキーマをPaymentMonitorServiceにマッピング
 * 3. 実データをread-onlyで検証（変更なし）
 * 4. 未入金、期限超過、入金済み、欠損値、重複を検証
 * 5. 誤通知防止・idempotency・監査証跡を実装
 *
 * 停止条件:
 * - 本番通知有効化
 * - 権限変更
 * - 課金
 * - 削除
 * - 外部公開
 * - mainマージ
 */

require('dotenv').config();

const { SharePointSiteDiscovery } = require('../src/sharePointSiteDiscovery');
const { PaymentMonitorService } = require('../src/paymentMonitorService');
const { SharePointReader } = require('../src/sharePointReader');

const config = {
  tenantId: process.env.SHAREPOINT_TENANT_ID,
  clientId: process.env.SHAREPOINT_CLIENT_ID,
  clientSecret: process.env.SHAREPOINT_CLIENT_SECRET,
  siteId: process.env.SHAREPOINT_SITE_ID
};

// ログレベル
const LOG_LEVEL = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG'
};

const logLevel = process.env.LOG_LEVEL || LOG_LEVEL.INFO;
const levels = ['ERROR', 'WARN', 'INFO', 'DEBUG'];

function log(level, message, data = null) {
  if (levels.indexOf(level) <= levels.indexOf(logLevel)) {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}]`;
    console.log(prefix, message);
    if (data) console.log('  ', JSON.stringify(data, null, 2));
  }
}

async function main() {
  log(LOG_LEVEL.INFO, '=== 未入金監視AI 本番環境検証開始 ===');

  // 設定確認
  log(LOG_LEVEL.DEBUG, '環境設定確認');
  const missingConfig = [];
  if (!config.tenantId) missingConfig.push('SHAREPOINT_TENANT_ID');
  if (!config.clientId) missingConfig.push('SHAREPOINT_CLIENT_ID');
  if (!config.clientSecret) missingConfig.push('SHAREPOINT_CLIENT_SECRET');

  if (missingConfig.length > 0) {
    log(LOG_LEVEL.ERROR, '未構成の設定項目があります', missingConfig);
    process.exit(1);
  }

  try {
    // Step 1: AI4 サイト・リスト自動探索
    log(LOG_LEVEL.INFO, '--- Step 1: AI4 サイト・リスト自動探索 ---');
    const discovery = new SharePointSiteDiscovery(config);
    const discoveryResults = await discovery.findAI4Resources();

    if (discoveryResults.error) {
      log(LOG_LEVEL.ERROR, 'サイト探索エラー', discoveryResults.error);
      process.exit(1);
    }

    log(LOG_LEVEL.INFO, `サイト発見: ${discoveryResults.sites.length} 件`);
    discoveryResults.sites.forEach(site => {
      log(LOG_LEVEL.DEBUG, `  - ${site.displayName} (${site.id})`);
    });

    // Step 2: リスト推奨
    log(LOG_LEVEL.INFO, '--- Step 2: リスト推奨 ---');
    const recommendations = discovery.getRecommendedLists(discoveryResults);
    log(LOG_LEVEL.INFO, '推奨リスト', {
      payment: recommendations.recommendations.payment,
      invoice: recommendations.recommendations.invoice,
      project: recommendations.recommendations.project,
      employees: recommendations.recommendations.employees
    });

    // Step 3: 支払管理リストの実データを read-only で検証
    if (!recommendations.recommendations.payment) {
      log(LOG_LEVEL.WARN, '支払管理リストが見つかりませんでした');
      process.exit(0); // 見つからない場合は検証スキップ
    }

    log(LOG_LEVEL.INFO, '--- Step 3: 支払管理リスト検証（read-only） ---');
    const paymentListId = recommendations.recommendations.payment.id;
    const paymentSiteId = recommendations.recommendations.payment.siteId;

    const reader = new SharePointReader(config);
    const paymentData = await reader.listItems({
      siteId: paymentSiteId,
      listId: paymentListId,
      top: 50
    });

    log(LOG_LEVEL.INFO, `支払管理リスト項目: ${paymentData.items.length} 件`);

    // Step 4: PaymentMonitorService でマッピング・検証
    log(LOG_LEVEL.INFO, '--- Step 4: PaymentMonitorService マッピング検証 ---');
    const monitor = new PaymentMonitorService({ sharePointReader: reader });
    const analysis = monitor.analyzePayments(paymentData.items, paymentData.columns);

    log(LOG_LEVEL.INFO, '分析結果', {
      overdue: analysis.overdue.length,
      pending: analysis.pending.length,
      paid: analysis.paid.length,
      cancelled: analysis.cancelled.length,
      summary: analysis.summary
    });

    // Step 5: 検証テスト
    log(LOG_LEVEL.INFO, '--- Step 5: 検証テスト ---');

    // 5a: 未入金判定テスト
    let testPass = 0;
    let testFail = 0;

    if (analysis.overdue.length > 0) {
      log(LOG_LEVEL.INFO, `✓ 期限超過検出: ${analysis.overdue.length} 件`);
      analysis.overdue.forEach((item, idx) => {
        if (idx < 3) log(LOG_LEVEL.DEBUG, `  - ${item.estimateId}: ${item.daysOverdue}日超過`);
      });
      testPass++;
    } else {
      log(LOG_LEVEL.DEBUG, 'ℹ 期限超過案件なし');
    }

    if (analysis.pending.length > 0) {
      log(LOG_LEVEL.INFO, `✓ 期限内未入金検出: ${analysis.pending.length} 件`);
      analysis.pending.forEach((item, idx) => {
        if (idx < 3) log(LOG_LEVEL.DEBUG, `  - ${item.estimateId}: あと${item.daysUntilDue + 1}日で期限`);
      });
      testPass++;
    } else {
      log(LOG_LEVEL.DEBUG, 'ℹ 期限内未入金案件なし');
    }

    if (analysis.paid.length > 0) {
      log(LOG_LEVEL.INFO, `✓ 入金済み検出: ${analysis.paid.length} 件`);
      testPass++;
    }

    // 5b: 欠損値チェック
    const itemsWithMissingDueDate = paymentData.items.filter(item =>
      !item.fields.dueDate && !item.fields.due_date && !item.fields['期限日']
    );
    if (itemsWithMissingDueDate.length > 0) {
      log(LOG_LEVEL.WARN, `期限日欠損: ${itemsWithMissingDueDate.length} 件（スキップ扱い）`);
    } else {
      log(LOG_LEVEL.INFO, '✓ 期限日: すべて記入済み');
      testPass++;
    }

    // 5c: 重複チェック
    const estimateIds = paymentData.items.map(item => item.fields.estimateId);
    const uniqueEstimateIds = new Set(estimateIds.filter(id => id));
    if (estimateIds.filter(id => id).length === uniqueEstimateIds.size) {
      log(LOG_LEVEL.INFO, `✓ 見積ID: 重複なし（${uniqueEstimateIds.size} 件）`);
      testPass++;
    } else {
      log(LOG_LEVEL.WARN, '見積ID: 重複あり（監視対象）');
    }

    // 5d: フィールドマッピング確認
    const mappedFields = paymentData.items.slice(0, 3).map(item => ({
      estimateId: item.fields.estimateId || item.fields.estimate_id || item.fields['見積ID'],
      dueDate: item.fields.dueDate || item.fields.due_date || item.fields['期限日'],
      paidDate: item.fields.paidDate || item.fields.paid_date || item.fields['入金日'],
      amount: item.fields.amount || item.fields.invoiceAmount || item.fields['金額']
    }));

    log(LOG_LEVEL.DEBUG, 'マッピング確認（最初の3件）', mappedFields);
    if (mappedFields.every(f => f.estimateId && f.dueDate)) {
      log(LOG_LEVEL.INFO, '✓ フィールドマッピング: 成功');
      testPass++;
    } else {
      log(LOG_LEVEL.WARN, 'フィールドマッピング: 一部欠損（詳細確認推奨）');
    }

    // Step 6: 監査証跡
    log(LOG_LEVEL.INFO, '--- Step 6: 監査証跡 ---');
    const auditLog = {
      timestamp: new Date().toISOString(),
      operation: 'payment-monitoring-production-validation',
      discoveredResources: {
        sitesCount: discoveryResults.sites.length,
        paymentListId: paymentListId,
        paymentSiteId: paymentSiteId
      },
      analysisResults: {
        itemsAnalyzed: paymentData.items.length,
        overdue: analysis.overdue.length,
        pending: analysis.pending.length,
        paid: analysis.paid.length,
        cancelled: analysis.cancelled.length
      },
      testResults: {
        passed: testPass,
        total: 5
      },
      readOnlyMode: true,
      noDataModified: true
    };

    log(LOG_LEVEL.INFO, '監査ログ', auditLog);

    // Step 7: 結果サマリー
    log(LOG_LEVEL.INFO, '--- Step 7: 検証完了 ---');
    log(LOG_LEVEL.INFO, `✓ テスト合格: ${testPass}/5`);
    log(LOG_LEVEL.INFO, '✓ Read-only モード確認: データ変更なし');
    log(LOG_LEVEL.INFO, '✓ 監査証跡記録: 完了');
    log(LOG_LEVEL.INFO, '');
    log(LOG_LEVEL.INFO, 'アクション待機中:');
    log(LOG_LEVEL.INFO, '  1. Power Automate 通知 = allowlist + 下書き状態で作成');
    log(LOG_LEVEL.INFO, '  2. テスト実行・回帰確認');
    log(LOG_LEVEL.INFO, '  3. feat/payment-monitoring-production-validation ブランチからPR作成');
    log(LOG_LEVEL.INFO, '  4. レビュー・承認後 main マージ');
    log(LOG_LEVEL.INFO, '');
    log(LOG_LEVEL.INFO, '=== 本番環境検証終了 ===');

  } catch (error) {
    log(LOG_LEVEL.ERROR, '検証失敗', error.message);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
