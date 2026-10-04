/**
 * Power Apps変更の自動検証。
 * - validateChange: 変更前後のソースを静的に検査する（validate_powerapps_change）
 * - verifySaveResult: 保存後のアプリ状態と正本ソースを再取得して検証する（verify_save_result）
 * 外部APIには直接触れず、必要な取得処理は呼び出し側から注入する。
 */
const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { containsLikelySecret } = require('./secretMasking');
const { notConfiguredError } = require('./errors');

const LARGE_DIFF_WARN_RATIO = 0.5;
const LARGE_DIFF_ERROR_RATIO = 0.8;
// 数行しかないファイルは1行の変更でも変更率が高くなるため、大規模差分の判定対象から外す。
const LARGE_DIFF_MIN_LINES = 10;
const ALLOWED_EXTENSIONS = ['.pa.yaml', '.yaml', '.yml', '.json'];
const CRITICAL_FILES = new Set(['app.pa.yaml', 'canvasmanifest.json']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitLines(text) {
  const normalized = String(text).replace(/\r\n/g, '\n').replace(/\n$/, '');
  return normalized === '' ? [] : normalized.split('\n');
}

/**
 * 行単位の差分量（順序を無視した多重集合比較）。厳密なdiffではなく、大規模変更の検出用の近似。
 * changeRatio: 0（同一）〜1（全行が異なる）。
 */
function diffStats(currentText, nextText) {
  const before = splitLines(currentText);
  const after = splitLines(nextText);
  const counts = new Map();
  for (const line of before) counts.set(line, (counts.get(line) || 0) + 1);
  let common = 0;
  for (const line of after) {
    const remaining = counts.get(line) || 0;
    if (remaining > 0) {
      counts.set(line, remaining - 1);
      common += 1;
    }
  }
  const removed = before.length - common;
  const added = after.length - common;
  const total = before.length + after.length;
  return {
    linesBefore: before.length,
    linesAfter: after.length,
    added,
    removed,
    changeRatio: total === 0 ? 0 : Number(((added + removed) / total).toFixed(3))
  };
}

function checkRelativePath(relativePath, errors, warnings) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    errors.push('relativePathが必要です（空でない文字列）');
    return false;
  }
  if (relativePath.length > 300) errors.push('relativePathが長すぎます（300文字以内）');
  if (relativePath.includes('\\')) errors.push('relativePathにバックスラッシュは使用できません');
  if (relativePath.split('/').includes('..') || relativePath.includes('..')) errors.push('relativePathに..は使用できません');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(relativePath)) errors.push('relativePathに制御文字は使用できません');
  if (/^[A-Za-z]:/.test(relativePath)) errors.push('relativePathにドライブ指定は使用できません');
  if (relativePath.includes('//')) errors.push('relativePathに連続スラッシュは使用できません');
  if (relativePath.startsWith('/')) warnings.push('relativePathの先頭スラッシュは正規化されます');
  const lower = relativePath.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    errors.push(`対象ファイルの拡張子が許可されていません（許可: ${ALLOWED_EXTENSIONS.join(', ')}）`);
  }
  return true;
}

function checkSyntax(relativePath, content, errors) {
  const lower = String(relativePath).toLowerCase();
  try {
    if (lower.endsWith('.json')) JSON.parse(content);
    else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) yaml.load(content);
  } catch (error) {
    errors.push(`更新内容の構文エラー: ${String(error.message).split('\n')[0].slice(0, 200)}`);
  }
}

/**
 * @param {object} params
 *   branch, relativePath, content(更新内容), currentContent(現在内容), currentExists, delete, create, allowLargeDiff
 * @param {{canonicalBranch: string}} context
 * @returns {{valid: boolean, errors: string[], warnings: string[], summary: object}}
 */
function validateChange(params, context = {}) {
  const errors = [];
  const warnings = [];
  const canonicalBranch = context.canonicalBranch || 'main';
  const isDelete = params.delete === true;
  const summary = {
    branch: params.branch ?? null,
    canonicalBranch,
    relativePath: params.relativePath ?? null,
    operation: isDelete ? 'delete' : 'update',
    currentExists: null,
    diffChecked: false
  };

  if (typeof params.branch !== 'string' || !params.branch.trim()) {
    errors.push('branchが必要です（空でない文字列）');
  } else if (params.branch !== canonicalBranch) {
    errors.push(`branch不一致: 正本branchは${canonicalBranch}ですが、指定は${params.branch}です`);
  }

  checkRelativePath(params.relativePath, errors, warnings);

  if (typeof params.currentContent === 'string') summary.currentExists = true;
  else if (params.currentExists === true || params.currentExists === false) summary.currentExists = params.currentExists;
  const exists = summary.currentExists;

  if (isDelete) {
    if (params.content !== undefined && params.content !== null) errors.push('delete:trueとcontentは同時に指定できません');
    if (exists === false) errors.push('削除対象のファイルが存在しません');
    const base = String(params.relativePath || '').split('/').pop().toLowerCase();
    if (CRITICAL_FILES.has(base)) errors.push(`重要ファイルの削除は拒否されます: ${base}`);
    else warnings.push('ファイル削除が指定されています。意図した操作か確認してください');
  } else {
    if (typeof params.content !== 'string') {
      errors.push('更新内容content（文字列）が必要です。ファイル削除はdelete:trueを指定してください');
    } else {
      if (params.content.trim().length === 0) errors.push('更新内容が空です');
      if (params.content.charCodeAt(0) === 0xfeff) warnings.push('更新内容の先頭にBOMがあります');
      if (containsLikelySecret(params.content)) errors.push('更新内容に秘密値（トークン・秘密鍵・接続文字列等）らしき文字列が含まれています');
      if (params.content.trim().length > 0) checkSyntax(params.relativePath, params.content, errors);
    }
    if (exists === false) {
      summary.operation = 'create';
      if (params.create !== true) errors.push('対象ファイルが存在しません（新規作成する場合はcreate:trueを指定してください）');
    }
  }

  if (typeof params.currentContent === 'string' && typeof params.content === 'string' && !isDelete) {
    const stats = diffStats(params.currentContent, params.content);
    Object.assign(summary, stats, { diffChecked: true });
    if (stats.added === 0 && stats.removed === 0) {
      warnings.push('現在内容と更新内容に差分がありません');
    } else if (Math.max(stats.linesBefore, stats.linesAfter) < LARGE_DIFF_MIN_LINES) {
      // 小さなファイルは大規模差分判定の対象外
    } else if (stats.changeRatio >= LARGE_DIFF_ERROR_RATIO && params.allowLargeDiff !== true) {
      errors.push(`大規模差分です（変更率${(stats.changeRatio * 100).toFixed(1)}%）。意図した変更であればallowLargeDiff:trueを指定してください`);
    } else if (stats.changeRatio >= LARGE_DIFF_WARN_RATIO) {
      warnings.push(`変更率が高い差分です（${(stats.changeRatio * 100).toFixed(1)}%）`);
    }
  } else if (!isDelete && typeof params.content === 'string' && exists !== false) {
    warnings.push('現在内容を取得できなかったため、差分・大規模差分の検査は実行していません（diffChecked=false）');
  }

  summary.errorCount = errors.length;
  summary.warningCount = warnings.length;
  return { valid: errors.length === 0, errors, warnings, summary };
}

function gitBlobSha(content) {
  const body = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
}

function parseMissingFromMessage(message) {
  const text = String(message);
  const match = text.match(/[:：]\s*([A-Z0-9_/, ]+)$/);
  if (match) return match[1].split(',').map((value) => value.trim()).filter(Boolean);
  if (text.includes('environmentId') || text.includes('appId')) return ['POWERAPPS_ENVIRONMENT_ID', 'POWERAPPS_APP_ID'];
  return [];
}

/**
 * 保存後の検証。アプリ状態と正本ソースを再取得し、branch・パス・期待SHA/内容・エラー状態を確認する。
 * いずれかが取得できない／一致しない場合は成功扱いにしない。
 */
async function verifySaveResult(params, deps) {
  const canonicalBranch = deps.canonicalBranch || 'main';
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, status: passed ? 'passed' : 'failed', ...detail });

  let source = null;
  try {
    source = await deps.getSourceFile(params.relativePath);
  } catch (error) {
    if (/設定が不足|未設定/.test(String(error.message))) {
      throw notConfiguredError('正本ソースの取得に必要なGitHub設定が不足しています', parseMissingFromMessage(error.message));
    }
    const notFound = /\(404\)/.test(String(error.message));
    add('source_fetch', false, {
      reason: notFound ? '正本ソースが存在しません（対象不存在）' : `正本ソースの取得に失敗しました: ${String(error.message).slice(0, 200)}`
    });
  }

  if (source) {
    add('branch', source.branch === canonicalBranch && (params.branch === undefined || params.branch === canonicalBranch), {
      expected: canonicalBranch, actualSourceBranch: source.branch, requestedBranch: params.branch ?? null
    });
    const normalized = String(params.relativePath).replace(/^\/+/, '');
    add('relative_path', source.path === normalized || source.path.endsWith(`/${normalized}`), {
      expected: normalized, actual: source.path
    });
    if (params.expectedSha !== undefined) {
      add('expected_sha', source.sha === params.expectedSha, {
        reason: source.sha === params.expectedSha ? undefined : '保存未反映: 正本ソースのSHAが期待値と一致しません',
        expected: params.expectedSha, actual: source.sha
      });
    }
    if (params.expectedContent !== undefined) {
      const matches = source.content === params.expectedContent;
      add('expected_content', matches, {
        reason: matches ? undefined : '保存未反映: 正本ソースの内容が期待値と一致しません',
        expectedSha: gitBlobSha(params.expectedContent), actualSha: source.sha
      });
    }
  }

  let appState = null;
  try {
    appState = await deps.getAppState();
    add('app_state', appState && appState.status === 'ok', {
      reason: appState && appState.status === 'ok' ? undefined : 'アプリ状態がエラーです',
      versionNumber: appState?.versionNumber ?? null
    });
  } catch (error) {
    if (/設定が不足|未設定/.test(String(error.message))) {
      throw notConfiguredError('アプリ状態の取得に必要なPower Apps設定が不足しています', parseMissingFromMessage(error.message));
    }
    add('app_state', false, { reason: `アプリ状態を取得できません: ${String(error.message).slice(0, 200)}`, upstream: error.upstream });
  }

  const errors = checks.filter((check) => check.status === 'failed').map((check) => check.reason || `${check.name}が不一致です`);
  return {
    status: errors.length === 0 ? 'verified' : 'failed',
    verified: errors.length === 0,
    relativePath: params.relativePath,
    canonicalBranch,
    sourceSha: source?.sha ?? null,
    checks,
    errors
  };
}

class PowerAppsChangeValidator {
  constructor(config = {}) {
    this.canonicalBranch = config.githubBranch || 'main';
  }

  validate(params) {
    return validateChange(params, { canonicalBranch: this.canonicalBranch });
  }
}

module.exports = { PowerAppsChangeValidator, validateChange, verifySaveResult, diffStats, gitBlobSha, isPlainObject };
