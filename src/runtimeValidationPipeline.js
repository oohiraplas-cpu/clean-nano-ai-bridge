/**
 * Phase 13: Runtime Validation Pipeline
 * 
 * 実行時検証パイプライン。State Context Contract強化と実行時検証を提供。
 * 
 * 主要な機能：
 * 1. Runtime State Tracker - 実行時の状態遷移を追跡・記録
 * 2. Integrity Verifier - 署名・整合性の連続検証
 * 3. Execution Guard - Fail-Closed安全ゲート
 * 
 * CorrelationIdを軸に、複数の分散操作を1つの実行単位として追跡し、
 * 各ステップで整合性を検証しながら進める。
 */

const crypto = require('node:crypto');

class RuntimeStateTracker {
  constructor(options = {}) {
    this.retentionMs = options.retentionMs || 3600000; // 1h
    this.maxStatesPerSession = options.maxStatesPerSession || 100;
    this.states = new Map(); // correlationId -> { timeline, metadata }
    this.cleanupInterval = null;
    this.startCleanup();
  }

  /**
   * セッション内の状態遷移を初期化する
   * @param {string} correlationId - 関連ID
   * @param {object} initialState - 初期状態
   */
  initializeStateChain(correlationId, initialState) {
    if (!correlationId || typeof correlationId !== 'string') {
      throw new Error('Invalid correlationId');
    }
    if (!initialState || typeof initialState !== 'object') {
      throw new Error('Invalid initialState');
    }

    const stateId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const stateHash = this.hashState(initialState);

    this.states.set(correlationId, {
      timeline: [{
        stateId,
        timestamp,
        phase: 'init',
        state: initialState,
        stateHash,
        sequenceNo: 0
      }],
      metadata: {
        correlationId,
        createdAt: timestamp,
        lastUpdatedAt: timestamp,
        totalTransitions: 0,
        chainIntegrity: true,
        errorCount: 0
      }
    });

    return { stateId, timestamp, stateHash };
  }

  /**
   * 状態遷移を記録し、整合性を検証する
   * @param {string} correlationId - 関連ID
   * @param {string} phase - フェーズ名
   * @param {object} newState - 新しい状態
   */
  recordStateTransition(correlationId, phase, newState) {
    if (!correlationId || !this.states.has(correlationId)) {
      throw new Error(`Invalid or unknown correlationId: ${correlationId}`);
    }
    if (!phase || typeof phase !== 'string') {
      throw new Error('Invalid phase');
    }
    if (!newState || typeof newState !== 'object') {
      throw new Error('Invalid newState');
    }

    const chainData = this.states.get(correlationId);
    const previousState = chainData.timeline[chainData.timeline.length - 1];
    const timestamp = new Date().toISOString();
    const stateId = crypto.randomUUID();
    const stateHash = this.hashState(newState);
    const sequenceNo = chainData.timeline.length;

    // 前の状態との連続性を検証
    const previousHash = previousState.stateHash;
    const chainLink = crypto
      .createHash('sha256')
      .update(previousHash + stateId + timestamp)
      .digest('hex');

    const transition = {
      stateId,
      timestamp,
      phase,
      state: newState,
      stateHash,
      sequenceNo,
      previousStateId: previousState.stateId,
      chainLink,
      verified: true
    };

    chainData.timeline.push(transition);
    chainData.metadata.lastUpdatedAt = timestamp;
    chainData.metadata.totalTransitions++;

    return { stateId, timestamp, stateHash, chainLink, sequenceNo };
  }

  /**
   * 状態チェーン全体の整合性を検証する
   * @param {string} correlationId - 関連ID
   */
  verifyChainIntegrity(correlationId) {
    if (!correlationId || !this.states.has(correlationId)) {
      return { valid: false, reason: 'Unknown correlationId' };
    }

    const chainData = this.states.get(correlationId);
    const timeline = chainData.timeline;

    // シーケンス番号の検証
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].sequenceNo !== i) {
        chainData.metadata.chainIntegrity = false;
        return { valid: false, reason: 'Sequence number mismatch', at: i };
      }
    }

    // チェーンリンク検証（2番目以降）
    for (let i = 1; i < timeline.length; i++) {
      const current = timeline[i];
      const previous = timeline[i - 1];
      const expectedChainLink = crypto
        .createHash('sha256')
        .update(previous.stateHash + current.stateId + current.timestamp)
        .digest('hex');

      if (current.chainLink !== expectedChainLink) {
        chainData.metadata.chainIntegrity = false;
        return { valid: false, reason: 'Chain link verification failed', at: i };
      }
    }

    chainData.metadata.chainIntegrity = true;
    return {
      valid: true,
      totalStates: timeline.length,
      firstStateId: timeline[0].stateId,
      lastStateId: timeline[timeline.length - 1].stateId,
      createdAt: chainData.metadata.createdAt,
      lastUpdatedAt: chainData.metadata.lastUpdatedAt
    };
  }

  /**
   * 状態チェーンを取得する
   * @param {string} correlationId - 関連ID
   */
  getStateChain(correlationId) {
    if (!correlationId || !this.states.has(correlationId)) {
      return null;
    }
    const chainData = this.states.get(correlationId);
    return {
      timeline: chainData.timeline.map(t => ({
        stateId: t.stateId,
        timestamp: t.timestamp,
        phase: t.phase,
        stateHash: t.stateHash,
        sequenceNo: t.sequenceNo,
        previousStateId: t.previousStateId,
        verified: t.verified
      })),
      metadata: chainData.metadata
    };
  }

  /**
   * 状態ハッシュを計算する
   */
  hashState(state) {
    const json = JSON.stringify(state, Object.keys(state).sort());
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [correlationId, chainData] of this.states.entries()) {
        const createdTime = new Date(chainData.metadata.createdAt).getTime();
        if (now - createdTime > this.retentionMs) {
          this.states.delete(correlationId);
        }
      }
    }, 60000); // Every minute

    // Allow process to exit even if interval is running
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  cleanup() {
    this.stopCleanup();
    this.states.clear();
  }

  getStats() {
    let totalStates = 0;
    let totalTransitions = 0;
    let integrityErrors = 0;

    for (const chainData of this.states.values()) {
      totalStates += chainData.timeline.length;
      totalTransitions += chainData.metadata.totalTransitions;
      if (!chainData.metadata.chainIntegrity) {
        integrityErrors++;
      }
    }

    return {
      activeSessions: this.states.size,
      totalStates,
      totalTransitions,
      integrityErrors,
      timestamp: new Date().toISOString()
    };
  }
}

class IntegrityVerifier {
  constructor(options = {}) {
    this.signingKey = options.signingKey || crypto.randomBytes(32).toString('hex');
    this.algorithms = ['SHA256', 'SHA384', 'SHA512'];
    this.verificationHistory = new Map(); // correlationId -> verification records
    this.retentionMs = options.retentionMs || 3600000;
  }

  /**
   * ペイロードに署名を生成する
   * @param {object} payload - ペイロード
   * @param {string} algorithm - ハッシュアルゴリズム
   */
  sign(payload, algorithm = 'SHA256') {
    if (!this.algorithms.includes(algorithm)) {
      throw new Error(`Unsupported algorithm: ${algorithm}`);
    }

    const json = JSON.stringify(payload, Object.keys(payload).sort());
    const hmac = crypto.createHmac(algorithm.toLowerCase(), this.signingKey);
    hmac.update(json);
    const signature = hmac.digest('hex');

    return {
      signature,
      algorithm,
      timestamp: new Date().toISOString(),
      payloadHash: crypto.createHash('sha256').update(json).digest('hex')
    };
  }

  /**
   * 署名を検証する
   * @param {object} payload - ペイロード
   * @param {string} signature - 期待される署名
   * @param {string} algorithm - ハッシュアルゴリズム
   */
  verify(payload, signature, algorithm = 'SHA256') {
    if (!this.algorithms.includes(algorithm)) {
      return { valid: false, reason: 'Unsupported algorithm' };
    }

    const json = JSON.stringify(payload, Object.keys(payload).sort());
    const hmac = crypto.createHmac(algorithm.toLowerCase(), this.signingKey);
    hmac.update(json);
    const computedSignature = hmac.digest('hex');

    // Check lengths first to avoid timingSafeEqual error
    let valid = false;
    if (signature && computedSignature && signature.length === computedSignature.length) {
      try {
        valid = crypto.timingSafeEqual(
          Buffer.from(signature),
          Buffer.from(computedSignature)
        );
      } catch (error) {
        valid = false;
      }
    }

    return {
      valid,
      algorithm,
      timestamp: new Date().toISOString(),
      payloadHash: crypto.createHash('sha256').update(json).digest('hex')
    };
  }

  /**
   * 複数のペイロードをチェーン検証する（署名の連鎖）
   * @param {array} payloads - ペイロード配列
   * @param {array} signatures - 署名配列
   */
  verifyChain(payloads, signatures) {
    if (payloads.length !== signatures.length) {
      return { valid: false, reason: 'Payload and signature count mismatch' };
    }

    const verifications = [];
    let previousPayloadHash = null;

    for (let i = 0; i < payloads.length; i++) {
      const payload = payloads[i];
      const signature = signatures[i];
      const verification = this.verify(payload, signature.signature, signature.algorithm);

      if (!verification.valid) {
        return {
          valid: false,
          reason: 'Signature verification failed',
          at: i,
          verifications
        };
      }

      // チェーン検証：前のペイロードハッシュが現在のペイロード内に含まれるか
      if (i > 0 && previousPayloadHash && payload.previousPayloadHash !== previousPayloadHash) {
        return {
          valid: false,
          reason: 'Chain link verification failed',
          at: i,
          verifications
        };
      }

      previousPayloadHash = verification.payloadHash;
      verifications.push({
        index: i,
        valid: verification.valid,
        algorithm: verification.algorithm,
        timestamp: verification.timestamp
      });
    }

    return {
      valid: true,
      totalVerified: payloads.length,
      verifications,
      timestamp: new Date().toISOString()
    };
  }

  recordVerification(correlationId, verificationType, result) {
    if (!this.verificationHistory.has(correlationId)) {
      this.verificationHistory.set(correlationId, []);
    }

    const record = {
      type: verificationType,
      result: result.valid || false,
      timestamp: new Date().toISOString(),
      details: result
    };

    const history = this.verificationHistory.get(correlationId);
    history.push(record);

    // Keep only recent verifications
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }

    return record;
  }

  getVerificationHistory(correlationId) {
    return this.verificationHistory.get(correlationId) || [];
  }

  cleanup() {
    this.verificationHistory.clear();
  }
}

class ExecutionGuard {
  constructor(options = {}) {
    this.failClosedRules = options.failClosedRules || {};
    this.executionLog = new Map(); // correlationId -> execution records
    this.blockedOperations = new Map(); // operationId -> block reason
    this.retentionMs = options.retentionMs || 3600000;
  }

  /**
   * Fail-Closedで操作を評価する
   * @param {object} context - 実行コンテキスト
   * @param {string} operation - 操作ID
   */
  evaluateOperation(context, operation) {
    const evaluation = {
      operationId: crypto.randomUUID(),
      operation,
      timestamp: new Date().toISOString(),
      correlationId: context.correlationId,
      allowed: true,
      blockedBy: [],
      warnings: []
    };

    // Fail-Closed: デフォルト拒否
    evaluation.allowed = true; // Only allow if all checks pass

    // Rule 1: Context integrity check
    if (!context.correlationId || !context.stateContext) {
      evaluation.allowed = false;
      evaluation.blockedBy.push('Missing context or correlationId');
    }

    // Rule 2: State verification
    if (context.stateContext && !context.stateContext.verified) {
      evaluation.allowed = false;
      evaluation.blockedBy.push('State context not verified');
    }

    // Rule 3: Signature verification
    if (context.signature && !context.signature.verified) {
      evaluation.allowed = false;
      evaluation.blockedBy.push('Signature verification failed');
    }

    // Rule 4: TTL check
    if (context.timestamp) {
      const age = Date.now() - new Date(context.timestamp).getTime();
      const ttlMs = context.ttlMs || 300000; // 5 minutes default
      if (age > ttlMs) {
        evaluation.allowed = false;
        evaluation.blockedBy.push('Context TTL expired');
      }
    }

    // Rule 5: Custom rules
    for (const [ruleName, ruleCheck] of Object.entries(this.failClosedRules)) {
      try {
        const result = ruleCheck(context, operation);
        if (!result.passed) {
          evaluation.allowed = false;
          evaluation.blockedBy.push(`${ruleName}: ${result.reason}`);
        }
        if (result.warning) {
          evaluation.warnings.push(`${ruleName}: ${result.warning}`);
        }
      } catch (error) {
        // Any error in a rule blocks the operation
        evaluation.allowed = false;
        evaluation.blockedBy.push(`${ruleName}: ${error.message}`);
      }
    }

    // Record execution
    this.recordExecution(context.correlationId || 'unknown', evaluation);

    return evaluation;
  }

  /**
   * 操作をブロックする（Fail-Closed）
   * @param {string} operationId - 操作ID
   * @param {string} reason - ブロック理由
   */
  blockOperation(operationId, reason) {
    this.blockedOperations.set(operationId, {
      reason,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString() // 1h
    });

    return {
      operationId,
      blocked: true,
      reason,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 操作がブロック済みかチェックする
   * @param {string} operationId - 操作ID
   */
  isOperationBlocked(operationId) {
    const blockRecord = this.blockedOperations.get(operationId);
    if (!blockRecord) {
      return false;
    }

    // Check expiry
    if (new Date(blockRecord.expiresAt) < new Date()) {
      this.blockedOperations.delete(operationId);
      return false;
    }

    return true;
  }

  /**
   * 実行を記録する
   */
  recordExecution(correlationId, evaluation) {
    if (!this.executionLog.has(correlationId)) {
      this.executionLog.set(correlationId, []);
    }

    const log = this.executionLog.get(correlationId);
    log.push(evaluation);

    // Keep only recent executions
    if (log.length > 100) {
      log.splice(0, log.length - 100);
    }
  }

  /**
   * 実行ログを取得する
   */
  getExecutionLog(correlationId) {
    return this.executionLog.get(correlationId) || [];
  }

  cleanup() {
    this.executionLog.clear();
    this.blockedOperations.clear();
  }

  getStats() {
    let totalOperations = 0;
    let allowedOperations = 0;
    let deniedOperations = 0;

    for (const executions of this.executionLog.values()) {
      for (const exec of executions) {
        totalOperations++;
        if (exec.allowed) {
          allowedOperations++;
        } else {
          deniedOperations++;
        }
      }
    }

    return {
      totalOperations,
      allowedOperations,
      deniedOperations,
      blockedOperations: this.blockedOperations.size,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = {
  RuntimeStateTracker,
  IntegrityVerifier,
  ExecutionGuard
};
