'use strict';

// 許可された作業ルート（OPERATIONS_WORK_ROOT）内だけで動くファイル操作（Lane 1）。
// - 全パスは pathGuard.resolveInRoot で検査し、シンボリックリンクは辿らず拒否する。
// - 上書きは overwrite=true の明示時のみ。上書き前に .cn-snapshots/<id>/ へ複製を残す。
// - 物理削除の操作は持たない。新規作成の取消しは利用者の手動操作として案内する。
// - 秘密値らしき内容は書込み・複写を拒否し、読取では伏せ字にする。
// - dryRun が既定。実行は dryRun=false の明示時のみ。実行後は再読取して SHA-256 で検証する。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveInRoot, PathGuardError } = require('./pathGuard');
const { validateAction } = require('./actionSchema');
const { maskSecrets, containsLikelySecret } = require('../secretMasking');

const LIMITS = Object.freeze({
  maxReadBytes: 2 * 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxHashBytes: 50 * 1024 * 1024,
  maxEntries: 1000,
  maxDepth: 6,
  maxDiffLines: 2000,
  maxSearchResults: 500
});
const SNAPSHOT_DIR = '.cn-snapshots';
const PATH_SPEC = { type: 'string', maxLength: 1024 };
const DRY_RUN = { type: 'boolean' };

// action ごとの個別入力スキーマ（未定義の項目は拒否する）。
const ACTION_SCHEMAS = Object.freeze({
  directory_list: { required: [], additionalProperties: false, properties: { path: PATH_SPEC, maxEntries: { type: 'integer', minimum: 1, maximum: LIMITS.maxEntries } } },
  folder_tree: { required: [], additionalProperties: false, properties: { path: PATH_SPEC, maxDepth: { type: 'integer', minimum: 1, maximum: LIMITS.maxDepth }, maxEntries: { type: 'integer', minimum: 1, maximum: LIMITS.maxEntries } } },
  file_search: { required: ['pattern'], additionalProperties: false, properties: { path: PATH_SPEC, pattern: { type: 'string', minLength: 1, maxLength: 200 }, maxResults: { type: 'integer', minimum: 1, maximum: LIMITS.maxSearchResults } } },
  file_metadata_get: { required: ['path'], additionalProperties: false, properties: { path: PATH_SPEC } },
  file_read: { required: ['path'], additionalProperties: false, properties: { path: PATH_SPEC, maxBytes: { type: 'integer', minimum: 1, maximum: LIMITS.maxReadBytes } } },
  file_write: { required: ['path', 'content'], additionalProperties: false, properties: { path: PATH_SPEC, content: { type: 'string', maxLength: LIMITS.maxWriteBytes }, overwrite: { type: 'boolean' }, dryRun: DRY_RUN } },
  file_copy: { required: ['source', 'destination'], additionalProperties: false, properties: { source: PATH_SPEC, destination: PATH_SPEC, overwrite: { type: 'boolean' }, dryRun: DRY_RUN } },
  file_diff: { required: ['left', 'right'], additionalProperties: false, properties: { left: PATH_SPEC, right: PATH_SPEC } },
  hash_sha256: { required: ['path'], additionalProperties: false, properties: { path: PATH_SPEC } }
});

const ACTIONS = Object.freeze(Object.keys(ACTION_SCHEMAS));

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fail(reasonCode, message, extra = {}) {
  return { status: 'FAIL', reasonCode, executed: false, message, ...extra };
}

function blocked(workRoot) {
  return {
    status: 'BLOCKED',
    reasonCode: 'ADAPTER_NOT_CONFIGURED',
    adapter: 'files',
    executed: false,
    message: workRoot ? '作業ルートが無効です。' : '作業ルート（OPERATIONS_WORK_ROOT）が未設定のため、ファイル操作は行いません。',
    nextStep: '作業ルートとなる既存ディレクトリを OPERATIONS_WORK_ROOT に設定する。'
  };
}

function lstatOrNull(abs) {
  try { return fs.lstatSync(abs); } catch { return null; }
}

// 相対パスを作業ルート内の絶対パスへ解決し、シンボリックリンクなら拒否する。
function locate(root, rel, { mustExist = false } = {}) {
  const abs = resolveInRoot(root, rel);
  const st = lstatOrNull(abs);
  if (st && st.isSymbolicLink()) throw new PathGuardError('SYMLINK_REFUSED');
  if (path.relative(root, abs).split(path.sep).includes(SNAPSHOT_DIR)) throw new PathGuardError('PATH_RESERVED');
  if (mustExist && !st) throw new PathGuardError('NOT_FOUND');
  return { abs, st, rel: path.relative(root, abs).split(path.sep).join('/') || '.' };
}

function mapGuardError(error) {
  if (error instanceof PathGuardError) {
    const messages = {
      PATH_INVALID: 'パスの形式が不正です。',
      PATH_ABSOLUTE: '絶対パスは指定できません。作業ルートからの相対パスで指定してください。',
      PATH_TRAVERSAL: '作業ルートの外へのパスは指定できません。',
      SYMLINK_ESCAPE: 'シンボリックリンク経由で作業ルートの外へ出ることはできません。',
      SYMLINK_REFUSED: 'シンボリックリンクは扱いません。',
      PATH_RESERVED: '予約領域（スナップショット）は直接扱えません。',
      NOT_FOUND: '対象が見つかりません。'
    };
    return fail(error.code, messages[error.code] || 'パスを確認できませんでした。');
  }
  return fail('INTERNAL_ERROR', '内部エラーが発生しました。');
}

function entryKind(dirent) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  return 'other';
}

function readBytesLimited(abs, maxBytes) {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, 0);
    return { buf, size, truncated: size > maxBytes };
  } finally {
    fs.closeSync(fd);
  }
}

function hashFile(abs, size) {
  if (size > LIMITS.maxHashBytes) return null;
  return sha256(fs.readFileSync(abs));
}

function collectTree(root, relDir, maxDepth, maxEntries, { depth = 1, out = [] } = {}) {
  if (depth > maxDepth) return { out, truncated: false };
  const abs = path.join(root, relDir);
  const names = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of names) {
    if (out.length >= maxEntries) return { out, truncated: true };
    const rel = relDir === '.' ? dirent.name : `${relDir}/${dirent.name}`;
    const kind = entryKind(dirent);
    out.push({ path: rel, kind, depth });
    if (kind === 'directory') {
      const sub = collectTree(root, rel, maxDepth, maxEntries, { depth: depth + 1, out });
      if (sub.truncated) return { out, truncated: true };
    }
  }
  return { out, truncated: false };
}

function lineDiff(leftLines, rightLines) {
  const n = leftLines.length;
  const m = rightLines.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = leftLines[i] === rightLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (leftLines[i] === rightLines[j]) { ops.push({ type: 'same' }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ type: 'removed', line: i + 1, text: leftLines[i] }); i += 1; }
    else { ops.push({ type: 'added', line: j + 1, text: rightLines[j] }); j += 1; }
  }
  while (i < n) { ops.push({ type: 'removed', line: i + 1, text: leftLines[i] }); i += 1; }
  while (j < m) { ops.push({ type: 'added', line: j + 1, text: rightLines[j] }); j += 1; }
  return ops;
}

function createFileOps({ workRoot, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID() } = {}) {
  const root = workRoot ? (() => { try { return fs.realpathSync(path.resolve(workRoot)); } catch { return null; } })() : null;
  const rootStat = root ? lstatOrNull(root) : null;
  const usable = Boolean(root && rootStat && rootStat.isDirectory());

  function readTextForCompare(rel) {
    const { abs, st } = locate(root, rel, { mustExist: true });
    if (!st.isFile()) throw new PathGuardError('NOT_A_FILE');
    const { buf, size, truncated } = readBytesLimited(abs, LIMITS.maxReadBytes);
    if (truncated) return { error: fail('TOO_LARGE', '比較対象が大きすぎます。', { path: rel }) };
    if (buf.includes(0)) return { error: fail('BINARY_FILE', 'バイナリファイルは比較できません。', { path: rel }) };
    return { text: buf.toString('utf8'), size, sha256: sha256(buf), rel };
  }

  const handlers = {
    directory_list(args) {
      const { abs, st, rel } = locate(root, args.path || '.', { mustExist: true });
      if (!st.isDirectory()) return fail('NOT_A_DIRECTORY', 'ディレクトリではありません。', { path: rel });
      const limit = args.maxEntries || 200;
      const dirents = fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      const entries = dirents.slice(0, limit).map((d) => {
        const s = lstatOrNull(path.join(abs, d.name));
        return { name: d.name, kind: entryKind(d), size: s && s.isFile() ? s.size : null, modifiedAt: s ? s.mtime.toISOString() : null };
      });
      return { status: 'PASS', executed: true, path: rel, entries, truncated: dirents.length > limit, total: dirents.length };
    },

    folder_tree(args) {
      const { abs, st, rel } = locate(root, args.path || '.', { mustExist: true });
      if (!st.isDirectory()) return fail('NOT_A_DIRECTORY', 'ディレクトリではありません。', { path: rel });
      const { out, truncated } = collectTree(abs, '.', args.maxDepth || 3, args.maxEntries || 300);
      return { status: 'PASS', executed: true, path: rel, nodes: out, truncated };
    },

    file_search(args) {
      const { abs, st, rel } = locate(root, args.path || '.', { mustExist: true });
      if (!st.isDirectory()) return fail('NOT_A_DIRECTORY', 'ディレクトリではありません。', { path: rel });
      const needle = args.pattern.toLowerCase();
      const limit = args.maxResults || 100;
      const matches = [];
      let truncated = false;
      const walk = (dir, depth) => {
        if (truncated || depth > LIMITS.maxDepth) return;
        for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (d.name === SNAPSHOT_DIR) continue;
          if (matches.length >= limit) { truncated = true; return; }
          const full = path.join(dir, d.name);
          if (d.name.toLowerCase().includes(needle)) matches.push({ path: path.relative(root, full).split(path.sep).join('/'), kind: entryKind(d) });
          if (d.isDirectory()) walk(full, depth + 1);
        }
      };
      walk(abs, 1);
      return { status: 'PASS', executed: true, path: rel, matches, truncated };
    },

    file_metadata_get(args) {
      const { abs, st, rel } = locate(root, args.path, { mustExist: true });
      const kind = st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
      const size = st.isFile() ? st.size : null;
      return {
        status: 'PASS', executed: true, path: rel, kind, size,
        modifiedAt: st.mtime.toISOString(), sha256: st.isFile() ? hashFile(abs, size) : null
      };
    },

    hash_sha256(args) {
      const { abs, st, rel } = locate(root, args.path, { mustExist: true });
      if (!st.isFile()) return fail('NOT_A_FILE', 'ファイルではありません。', { path: rel });
      const digest = hashFile(abs, st.size);
      if (digest === null) return fail('TOO_LARGE', 'ハッシュ計算の上限を超えています。', { path: rel });
      return { status: 'PASS', executed: true, path: rel, sha256: digest, size: st.size };
    },

    file_read(args) {
      const { abs, st, rel } = locate(root, args.path, { mustExist: true });
      if (!st.isFile()) return fail('NOT_A_FILE', 'ファイルではありません。', { path: rel });
      const limit = args.maxBytes || 1024 * 1024;
      const { buf, size, truncated } = readBytesLimited(abs, limit);
      if (buf.includes(0)) return { status: 'PASS', executed: true, path: rel, binary: true, size, sha256: hashFile(abs, size), content: null };
      const text = buf.toString('utf8');
      const secretsMasked = containsLikelySecret(text);
      return {
        status: 'PASS', executed: true, path: rel, binary: false, size, truncated,
        sha256: truncated ? null : sha256(buf),
        encoding: 'utf-8',
        content: secretsMasked ? maskSecrets(text) : text,
        secretsMasked
      };
    },

    file_write(args) {
      if (containsLikelySecret(args.content)) return fail('SECRET_DETECTED', '秘密情報らしき内容を含むため書き込みを拒否しました（内容は返しません）。');
      if (Buffer.byteLength(args.content, 'utf8') > LIMITS.maxWriteBytes) return fail('TOO_LARGE', '書込みサイズの上限を超えています。');
      const { abs, st, rel } = locate(root, args.path);
      if (st && !st.isFile()) return fail('NOT_A_FILE', '既存の対象がファイルではありません。', { path: rel });
      if (st && !args.overwrite) return fail('TARGET_EXISTS', '既存ファイルは上書きしません（overwrite=true で明示してください）。', { path: rel });
      const dryRun = args.dryRun !== false;
      const beforeSha = st ? sha256(fs.readFileSync(abs)) : null;
      const afterSha = sha256(Buffer.from(args.content, 'utf8'));
      const plan = { action: st ? 'overwrite' : 'create', path: rel, existed: Boolean(st), beforeSha256: beforeSha, afterSha256: afterSha, bytes: Buffer.byteLength(args.content, 'utf8') };
      const rollback = st
        ? { rollbackAvailable: true, rollbackMethod: 'snapshot_restore' }
        : { rollbackAvailable: false, rollbackMethod: 'manual_delete', rollbackNote: '新規作成の取消しは利用者の手動操作（自動の物理削除は行わない）' };
      if (dryRun) return { status: 'PASS', executed: false, dryRun: true, plan, ...rollback };
      let snapshotId = null;
      if (st) {
        snapshotId = idFactory();
        const snapAbs = path.join(root, SNAPSHOT_DIR, snapshotId, rel);
        fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
        fs.copyFileSync(abs, snapAbs, fs.constants.COPYFILE_EXCL);
        if (sha256(fs.readFileSync(snapAbs)) !== beforeSha) return fail('SNAPSHOT_MISMATCH', 'スナップショットの検証に失敗したため上書きしませんでした。');
      } else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
      }
      fs.writeFileSync(abs, args.content, { flag: st ? 'w' : 'wx' });
      const verifiedSha = sha256(fs.readFileSync(abs));
      if (verifiedSha !== afterSha) return fail('VERIFY_MISMATCH', '書込み後の再読取で内容が一致しませんでした。', { path: rel });
      return { status: 'PASS', executed: true, dryRun: false, plan, verified: true, afterSha256: verifiedSha, snapshotId, ...rollback, rollbackAvailable: Boolean(st), checkedAt: now() };
    },

    file_copy(args) {
      const src = locate(root, args.source, { mustExist: true });
      if (!src.st.isFile()) return fail('NOT_A_FILE', 'コピー元がファイルではありません。', { path: src.rel });
      const { buf, size } = readBytesLimited(src.abs, LIMITS.maxWriteBytes + 1);
      if (size > LIMITS.maxWriteBytes) return fail('TOO_LARGE', 'コピー元が大きすぎます。', { path: src.rel });
      if (buf.includes(0) === false && containsLikelySecret(buf.toString('utf8'))) return fail('SECRET_DETECTED', '秘密情報らしき内容を含むためコピーを拒否しました。');
      const dst = locate(root, args.destination);
      if (dst.st && !args.overwrite) return fail('TARGET_EXISTS', '既存ファイルは上書きしません（overwrite=true で明示してください）。', { path: dst.rel });
      const dryRun = args.dryRun !== false;
      const plan = { action: dst.st ? 'overwrite' : 'create', source: src.rel, destination: dst.rel, bytes: size, sha256: sha256(buf) };
      if (dryRun) return { status: 'PASS', executed: false, dryRun: true, plan, rollbackAvailable: Boolean(dst.st), rollbackMethod: dst.st ? 'snapshot_restore' : 'manual_delete' };
      let snapshotId = null;
      if (dst.st) {
        snapshotId = idFactory();
        const snapAbs = path.join(root, SNAPSHOT_DIR, snapshotId, dst.rel);
        fs.mkdirSync(path.dirname(snapAbs), { recursive: true });
        fs.copyFileSync(dst.abs, snapAbs, fs.constants.COPYFILE_EXCL);
      } else {
        fs.mkdirSync(path.dirname(dst.abs), { recursive: true });
      }
      fs.writeFileSync(dst.abs, buf, { flag: dst.st ? 'w' : 'wx' });
      const verifiedSha = sha256(fs.readFileSync(dst.abs));
      if (verifiedSha !== plan.sha256) return fail('VERIFY_MISMATCH', 'コピー後の再読取で内容が一致しませんでした。', { path: dst.rel });
      return { status: 'PASS', executed: true, dryRun: false, plan, verified: true, afterSha256: verifiedSha, snapshotId, rollbackAvailable: Boolean(dst.st), rollbackMethod: dst.st ? 'snapshot_restore' : 'manual_delete' };
    },

    file_diff(args) {
      const left = readTextForCompare(args.left);
      if (left.error) return left.error;
      const right = readTextForCompare(args.right);
      if (right.error) return right.error;
      const leftLines = left.text.split(/\r?\n/);
      const rightLines = right.text.split(/\r?\n/);
      if (leftLines.length > LIMITS.maxDiffLines || rightLines.length > LIMITS.maxDiffLines) {
        return fail('TOO_LARGE', '行数が比較の上限を超えています。');
      }
      const ops = lineDiff(leftLines, rightLines);
      const changes = ops.filter((op) => op.type !== 'same');
      const samples = changes.slice(0, 50).map((op) => ({ type: op.type, line: op.line, text: maskSecrets(String(op.text).slice(0, 200)) }));
      return {
        status: 'PASS', executed: true, left: left.rel, right: right.rel,
        leftSha256: left.sha256, rightSha256: right.sha256,
        identical: changes.length === 0,
        added: ops.filter((op) => op.type === 'added').length,
        removed: ops.filter((op) => op.type === 'removed').length,
        unchanged: ops.filter((op) => op.type === 'same').length,
        samples, samplesTruncated: changes.length > 50
      };
    }
  };

  async function run(action, rawArgs) {
    if (!ACTIONS.includes(action)) return fail('VALIDATION_FAILED', `未知のactionです（対応: ${ACTIONS.join(', ')}）`);
    const problems = validateAction(ACTION_SCHEMAS[action], rawArgs);
    if (problems.length) return fail('VALIDATION_FAILED', problems.join('、'));
    if (!usable) return blocked(workRoot);
    try {
      return handlers[action](rawArgs);
    } catch (error) {
      if (error instanceof PathGuardError) return mapGuardError(error);
      if (error && error.code === 'ENOENT') return fail('NOT_FOUND', '対象が見つかりません。');
      return fail('INTERNAL_ERROR', '内部エラーが発生しました。');
    }
  }

  return { actions: ACTIONS, schemas: ACTION_SCHEMAS, run, usable };
}

module.exports = { createFileOps, ACTION_SCHEMAS, ACTIONS, LIMITS, SNAPSHOT_DIR, lineDiff, sha256 };
