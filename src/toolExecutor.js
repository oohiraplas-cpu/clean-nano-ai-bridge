/**
 * 実ツール実行器（Tool Executor / Result Verifier）
 *
 * - 接続（connector）が登録されていないツールは、実行せず BLOCKED_TOOL_CONNECTION を返す。
 *   ダミー成功にはしない。
 * - 接続のある場合も、結果は Result Verifier で検証する。検証されない結果は成功扱いにしない。
 * - 例外の詳細は外部に出さない（コードのみを返す）。
 */

const BLOCKED_TOOL_CONNECTION = 'BLOCKED_TOOL_CONNECTION';

/**
 * 結果を検証する。verified === true かつ証跡（evidence）を伴うもののみ OK。
 * @param {string} tool
 * @param {unknown} outcome - 接続が返した結果 { verified: boolean, evidence?: string }
 */
function verifyResult(tool, outcome) {
  if (!outcome || typeof outcome !== 'object') return { status: 'FAILED', tool, reason: 'no_result' };
  if (outcome.verified !== true) return { status: 'FAILED', tool, reason: 'verification_failed' };
  return {
    status: 'OK',
    tool,
    evidence: typeof outcome.evidence === 'string' ? outcome.evidence : null
  };
}

class ToolExecutor {
  /**
   * @param {object} [options]
   * @param {Record<string, (input: {requestId: string, stepIndex: number, tool: string}) => Promise<object>>} [options.connectors]
   */
  constructor({ connectors = {} } = {}) {
    this.connectors = connectors;
  }

  async execute({ requestId, stepIndex, tool }) {
    const connector = Object.prototype.hasOwnProperty.call(this.connectors, tool) ? this.connectors[tool] : null;
    if (typeof connector !== 'function') {
      return { status: BLOCKED_TOOL_CONNECTION, tool, reason: 'tool_not_connected' };
    }
    try {
      const outcome = await connector({ requestId, stepIndex, tool });
      return verifyResult(tool, outcome);
    } catch {
      return { status: 'FAILED', tool, reason: 'tool_error' };
    }
  }
}

module.exports = { ToolExecutor, BLOCKED_TOOL_CONNECTION, verifyResult };
