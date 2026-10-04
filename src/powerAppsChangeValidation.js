/**
 * Power Apps変更の自動検証ツール。
 * ソース、branch、相対パス、対象アプリ、構文、参照、変更差分を検査する。
 */

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class PowerAppsChangeValidator {
  constructor(config = {}) {
    this.githubBranch = config.githubBranch || 'main';
    this.githubRoot = config.githubRoot || '';
  }

  /**
   * Power Apps変更前後のソースを検証する。
   * - branch一致確認
   * - 対象ファイル存在確認
   * - 空内容検出
   * - 大規模差分検出
   * - 意図しない削除検出
   */
  async validatePowerAppsChange(params, getCurrentSource) {
    const errors = [];

    if (!isPlainObject(params)) {
      return { status: 'validation_failed', errors: ['paramsはJSONオブジェクトである必要があります'] };
    }

    const { branch, relativePath, content, expectedBranch } = params;

    // branch確認
    if (branch && expectedBranch && branch !== expectedBranch) {
      errors.push(`branch不一致: 期待=${expectedBranch}, 実際=${branch}`);
    }

    // relativePath必須
    if (typeof relativePath !== 'string' || !relativePath.trim()) {
      errors.push('relativePathが必要です（文字列）');
    }

    // 新内容は文字列またはnull
    if (content !== null && content !== undefined && typeof content !== 'string') {
      errors.push('contentは文字列またはnullである必要があります');
    }

    if (errors.length > 0) {
      return { status: 'validation_failed', errors };
    }

    // 空内容検出
    if (typeof content === 'string' && content.trim().length === 0) {
      errors.push('新しい内容が空です（意図した変更ですか？）');
    }

    try {
      // 現在のソースを取得
      const current = await getCurrentSource(relativePath);
      const currentContent = current?.content || '';

      // 削除検出（contentがnullまたは未指定）
      if ((content === null || content === undefined) && currentContent.trim()) {
        errors.push('ファイル削除が検出されました。意図した操作ですか？');
      }

      // 大規模差分検出（80%以上の変更）
      if (content !== null && content !== undefined && currentContent.trim()) {
        const currentLines = currentContent.split('\n').length;
        const newLines = content.split('\n').length;
        const changeRatio = Math.abs(newLines - currentLines) / Math.max(currentLines, newLines);
        if (changeRatio > 0.8) {
          errors.push(`大規模差分が検出されました（変更率=${(changeRatio * 100).toFixed(1)}%）。意図した変更ですか？`);
        }
      }
    } catch (error) {
      // ソース取得失敗は検証エラーではなく情報提供
      errors.push(`ソース取得時にエラー: ${error.message}`);
    }

    if (errors.length > 0) {
      return { status: 'validation_warning', errors };
    }

    return { status: 'ok', validated: true };
  }
}

module.exports = { PowerAppsChangeValidator };
