'use strict';

// 許可された作業ルート内だけを扱うためのパス検査（Lane A）。
// - 相対パスの正規化後に、ルート外へ出ないことを確認する（パストラバーサル防止）。
// - 既存の実体は realpath で解決し、シンボリックリンクでルート外へ出ることを防ぐ。
// - 絶対パス、ドライブ文字、NUL文字、制御文字は拒否する。

const fs = require('node:fs');
const path = require('node:path');

class PathGuardError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PathGuardError';
    this.code = code;
  }
}

function checkRelative(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1024) throw new PathGuardError('PATH_INVALID');
  if (/[\u0000-\u001f\u007f]/.test(relPath)) throw new PathGuardError('PATH_INVALID');
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath) || relPath.startsWith('\\\\')) {
    throw new PathGuardError('PATH_ABSOLUTE');
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.includes('..')) throw new PathGuardError('PATH_TRAVERSAL');
  return segments.filter((s) => s.length > 0 && s !== '.').join(path.sep);
}

// ルート（実体）を基準に、相対パスの実際の場所を返す。存在しない場合は親まで実体を確認する。
function resolveInRoot(rootDir, relPath) {
  const root = fs.realpathSync(path.resolve(rootDir));
  const rel = checkRelative(relPath);
  const candidate = path.resolve(root, rel);
  if (!isInside(root, candidate)) throw new PathGuardError('PATH_TRAVERSAL');
  // 既存部分のシンボリックリンクを実体に解決し、ルート外なら拒否する。
  let probe = candidate;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (!isInside(root, real)) throw new PathGuardError('SYMLINK_ESCAPE');
  return candidate;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

module.exports = { resolveInRoot, checkRelative, isInside, PathGuardError };
