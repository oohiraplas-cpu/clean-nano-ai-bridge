/**
 * Phase 7 DONE Engine
 * 実行完成判定エンジン
 *
 * ルール:
 * - Commit/Push/Deploy/Save/Publish成功 ≠ DONE
 * - Evidence なし = DONE 禁止
 * - State 不一致 = DONE 禁止
 *
 * DONE条件 12項目:
 * 1. State一致
 * 2. Branch一致
 * 3. SHA一致
 * 4. Save確認
 * 5. Publish確認
 * 6. Re-read確認
 * 7. Runtime確認
 * 8. 権限確認
 * 9. 画面確認
 * 10. 証跡取得
 * 11. 監査記録
 * 12. 重大エラー0
 */

class DoneEngine {
  constructor() {
    this.conditions = [
      'state_match',
      'branch_match',
      'sha_match',
      'save_confirmed',
      'publish_confirmed',
      'reread_confirmed',
      'runtime_confirmed',
      'permission_confirmed',
      'screen_confirmed',
      'evidence_captured',
      'audit_logged',
      'no_critical_errors'
    ];
  }

  /**
   * DONE判定メイン処理
   * @param {Object} params
   * @param {string} params.appId
   * @param {string} params.environment
   * @param {string} params.branch
   * @param {string} params.sha
   * @param {string} params.runtimeSha
   * @param {string} params.correlationId
   * @param {Object} params.evidence
   * @param {Object} params.runtime
   * @returns {Object} { done, passed, failed, evidence, next }
   */
  async check(params) {
    const {
      appId,
      environment,
      branch,
      sha,
      runtimeSha,
      correlationId,
      evidence = {},
      runtime = {}
    } = params;

    const results = {
      done: false,
      passed: [],
      failed: [],
      evidence: evidence,
      next: [],
      timestamp: new Date().toISOString()
    };

    // 1. State一致確認
    if (this._validateStateMatch(runtime, { branch, environment })) {
      results.passed.push('state_match');
    } else {
      results.failed.push('state_match');
      results.next.push('Runtime State と入力パラメータが不一致');
    }

    // 2. Branch一致確認
    if (runtime.branch === branch && runtime.canonicalBranch === branch) {
      results.passed.push('branch_match');
    } else {
      results.failed.push('branch_match');
      results.next.push(`Branch不一致: runtime=${runtime.branch}, input=${branch}`);
    }

    // 3. SHA一致確認
    if (runtimeSha && sha && runtimeSha.startsWith(sha.substring(0, 8))) {
      results.passed.push('sha_match');
    } else {
      results.failed.push('sha_match');
      results.next.push(`SHA不一致: runtime=${runtimeSha}, input=${sha}`);
    }

    // 4. Save確認
    if (evidence.save_timestamp && evidence.save_status === 'success') {
      results.passed.push('save_confirmed');
    } else {
      results.failed.push('save_confirmed');
      results.next.push('Save操作が未実行または失敗');
    }

    // 5. Publish確認
    if (evidence.publish_timestamp && evidence.publish_status === 'success') {
      results.passed.push('publish_confirmed');
    } else {
      results.failed.push('publish_confirmed');
      results.next.push('Publish操作が未実行または失敗');
    }

    // 6. Re-read確認
    if (evidence.reread_timestamp && evidence.reread_status === 'success') {
      results.passed.push('reread_confirmed');
    } else {
      results.failed.push('reread_confirmed');
      results.next.push('Re-read確認が未実行');
    }

    // 7. Runtime確認
    if (runtime.status === 'ok' && runtime.responseTime) {
      results.passed.push('runtime_confirmed');
    } else {
      results.failed.push('runtime_confirmed');
      results.next.push('Runtime応答が未確認');
    }

    // 8. 権限確認
    if (evidence.permission_check && evidence.permission_status === 'confirmed') {
      results.passed.push('permission_confirmed');
    } else {
      results.failed.push('permission_confirmed');
      results.next.push('権限確認が未実行');
    }

    // 9. 画面確認
    if (evidence.screenshot_timestamp || evidence.screen_verified === true) {
      results.passed.push('screen_confirmed');
    } else {
      results.failed.push('screen_confirmed');
      results.next.push('画面表示確認が未実行');
    }

    // 10. 証跡取得
    const evidenceItems = [
      evidence.correlationId,
      evidence.runtime_sha,
      evidence.response_body,
      evidence.state_snapshot,
      evidence.publish_result
    ];
    if (evidenceItems.filter(Boolean).length >= 3) {
      results.passed.push('evidence_captured');
    } else {
      results.failed.push('evidence_captured');
      results.next.push('必要な証跡が不足（最低3項目必須）');
    }

    // 11. 監査記録
    if (evidence.audit_log && Array.isArray(evidence.audit_log) && evidence.audit_log.length > 0) {
      results.passed.push('audit_logged');
    } else {
      results.failed.push('audit_logged');
      results.next.push('監査ログが記録されていない');
    }

    // 12. 重大エラー0
    const criticalErrors = evidence.errors?.filter(e => e.severity === 'critical') || [];
    if (criticalErrors.length === 0) {
      results.passed.push('no_critical_errors');
    } else {
      results.failed.push('no_critical_errors');
      results.next.push(`重大エラーが${criticalErrors.length}件存在`);
    }

    // 最終判定: 全12項目PASS && Evidence完全
    results.done = results.passed.length === 12 && results.failed.length === 0;

    return results;
  }

  /**
   * State一致検証
   */
  _validateStateMatch(runtime, input) {
    if (!runtime || !input) return false;
    return (
      runtime.branch === input.branch &&
      runtime.environment === input.environment &&
      runtime.canonicalBranch === input.branch
    );
  }

  /**
   * Evidence検証
   */
  validateEvidence(evidence) {
    const required = [
      'correlationId',
      'runtime_sha',
      'response_body',
      'state_snapshot',
      'publish_result',
      'timestamp'
    ];

    const missing = required.filter(key => !evidence[key]);
    return {
      valid: missing.length === 0,
      missing
    };
  }

  /**
   * DONE判定結果をフォーマット
   */
  formatResult(checkResult) {
    return {
      '【DONE】': checkResult.done ? 'true ✅' : 'false ❌',
      '【PASSED】': `${checkResult.passed.length}/12`,
      '【FAILED】': checkResult.failed.length > 0 ? checkResult.failed : 'none',
      '【EVIDENCE】': Object.keys(checkResult.evidence).length,
      '【NEXT】': checkResult.next.length > 0 ? checkResult.next : 'none',
      '【TIMESTAMP】': checkResult.timestamp
    };
  }
}

module.exports = DoneEngine;
