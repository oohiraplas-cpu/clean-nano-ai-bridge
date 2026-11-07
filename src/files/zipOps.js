'use strict';

// ZIP の検査・検証・展開・作成（Lane 1 / zip_op）。実処理は zipSafe.js に委譲する。
// - 入力ZIPは作業ルート内のみ。読むだけで変更しない（実行前後のSHA-256で確認）。
// - 展開は全件検証OKのときのみ、既存ファイルを上書きせず、ルート内の新規先にだけ行う。
// - 作成は作業ルート内の既存ファイルから行い、作成後に再検証する。
// - 自動実行は行わない（実行可能拡張子は zipSafe が拒否する）。

const fs = require('node:fs');
const path = require('node:path');
const { resolveInRoot, PathGuardError, checkRelative } = require('./pathGuard');
const { validateZip, extractZip, createZip, LIMITS_DEFAULT } = require('./zipSafe');
const { validateAction } = require('./actionSchema');
const { maskSecrets, containsLikelySecret } = require('../secretMasking');
const { sha256, SNAPSHOT_DIR } = require('./fileOps');

const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const PATH_SPEC = { type: 'string', maxLength: 1024 };
const ACTION_SCHEMAS = Object.freeze({
  zip_inspect: { required: ['path'], additionalProperties: false, properties: { path: PATH_SPEC } },
  zip_validate: { required: ['path'], additionalProperties: false, properties: { path: PATH_SPEC } },
  zip_extract: { required: ['path', 'destination'], additionalProperties: false, properties: { path: PATH_SPEC, destination: PATH_SPEC, dryRun: { type: 'boolean' } } },
  zip_create: { required: ['destination', 'sources'], additionalProperties: false, properties: { destination: PATH_SPEC, sources: { type: 'array', minItems: 1, maxItems: 200, items: PATH_SPEC }, dryRun: { type: 'boolean' } } }
});
const ACTIONS = Object.freeze(Object.keys(ACTION_SCHEMAS));

function fail(reasonCode, message, extra = {}) {
  return { status: 'FAIL', reasonCode, executed: false, message, ...extra };
}

function lstatOrNull(abs) {
  try { return fs.lstatSync(abs); } catch { return null; }
}

function locateFile(root, rel) {
  const abs = resolveInRoot(root, rel);
  const st = lstatOrNull(abs);
  if (st && st.isSymbolicLink()) throw new PathGuardError('SYMLINK_REFUSED');
  if (path.relative(root, abs).split(path.sep).includes(SNAPSHOT_DIR)) throw new PathGuardError('PATH_RESERVED');
  return { abs, st, rel: path.relative(root, abs).split(path.sep).join('/') };
}

function readZipFile(root, rel) {
  const { abs, st, rel: r } = locateFile(root, rel);
  if (!st) throw new PathGuardError('NOT_FOUND');
  if (!st.isFile()) return { error: fail('NOT_A_FILE', 'ZIPファイルではありません。', { path: r }) };
  if (st.size > MAX_ZIP_BYTES) return { error: fail('TOO_LARGE', 'ZIPファイルが上限（50MB）を超えています。', { path: r }) };
  return { abs, rel: r, buf: fs.readFileSync(abs) };
}

function createZipOps({ workRoot, idFactory } = {}) {
  let root = null;
  try { root = workRoot ? fs.realpathSync(path.resolve(workRoot)) : null; } catch { root = null; }
  const usable = Boolean(root && lstatOrNull(root) && lstatOrNull(root).isDirectory());

  function violationSummary(report) {
    return report.violations.slice(0, 50).map((v) => ({ name: v.name ? maskSecrets(String(v.name).slice(0, 200)) : null, code: v.code }));
  }

  const handlers = {
    zip_inspect(args) {
      const z = readZipFile(root, args.path);
      if (z.error) return z.error;
      const report = validateZip(z.buf);
      return {
        status: report.ok ? 'PASS' : 'FAIL', executed: true, path: z.rel, sha256: report.sha256, sizeBytes: z.buf.length,
        zipValid: report.ok, entryCount: report.entryCount ?? 0, totalUncompressedSize: report.totalUncompressedSize ?? 0,
        entries: (report.entries || []).slice(0, 500).map((e) => ({ ...e, name: maskSecrets(String(e.name).slice(0, 255)) })),
        violations: violationSummary(report), reasonCode: report.reasonCode
      };
    },

    zip_validate(args) {
      const z = readZipFile(root, args.path);
      if (z.error) return z.error;
      const report = validateZip(z.buf);
      const base = { path: z.rel, sha256: report.sha256, zipValid: report.ok, violations: violationSummary(report), reasonCode: report.reasonCode };
      return report.ok
        ? { status: 'PASS', executed: true, ...base, reasonCode: null }
        : { status: 'FAIL', executed: true, ...base, message: 'ZIPの検証で違反を検出しました。展開・取り込みは行いません。' };
    },

    zip_extract(args) {
      const z = readZipFile(root, args.path);
      if (z.error) return z.error;
      const before = sha256(z.buf);
      const report = validateZip(z.buf);
      if (!report.ok) return fail(report.reasonCode, 'ZIPの検証で違反を検出したため展開しません。', { path: z.rel, sha256: before, violations: violationSummary(report) });
      const dest = locateFile(root, args.destination);
      if (dest.st && !dest.st.isDirectory()) return fail('NOT_A_DIRECTORY', '展開先がディレクトリではありません。', { path: dest.rel });
      const plannedFiles = report.entries.filter((e) => e.kind === 'file').map((e) => ({ path: maskSecrets(String(e.name).slice(0, 255)), size: e.uncompressedSize }));
      const dryRun = args.dryRun !== false;
      if (dryRun) return { status: 'PASS', executed: false, dryRun: true, path: z.rel, destination: dest.rel, sha256: before, plannedFiles, rollbackAvailable: false, rollbackMethod: 'manual_delete', rollbackNote: '展開先の取消しは利用者の手動操作（自動の物理削除は行わない）' };
      const result = extractZip(z.buf, dest.abs);
      const after = sha256(fs.readFileSync(z.abs));
      if (!result.ok) return fail(result.reasonCode, '展開を中止しました（既存ファイルは変更していません）。', { path: z.rel, sha256: before, violations: result.violations.slice(0, 50), extractedBeforeFailure: result.extracted.length });
      return {
        status: 'PASS', executed: true, dryRun: false, path: z.rel, destination: dest.rel,
        sha256: before, sourceUnchanged: before === after,
        extracted: result.extracted.map((f) => ({ path: maskSecrets(f.path), size: f.size, sha256: f.sha256 })),
        rollbackAvailable: false, rollbackMethod: 'manual_delete'
      };
    },

    zip_create(args) {
      const dest = locateFile(root, args.destination);
      if (dest.st) return fail('TARGET_EXISTS', '既存のZIPは上書きしません。', { path: dest.rel });
      if (!dest.rel.toLowerCase().endsWith('.zip')) return fail('VALIDATION_FAILED', '出力先は .zip 拡張子で指定してください。');
      const files = [];
      let total = 0;
      for (const src of args.sources) {
        const { abs, st, rel } = locateFile(root, src);
        if (!st) return fail('NOT_FOUND', '元ファイルが見つかりません。', { path: rel });
        if (!st.isFile()) return fail('NOT_A_FILE', '元がファイルではありません（ディレクトリは指定できません）。', { path: rel });
        if (st.size > LIMITS_DEFAULT.maxEntryUncompressed) return fail('ENTRY_TOO_LARGE', '元ファイルが単一ファイル上限を超えています。', { path: rel });
        const data = fs.readFileSync(abs);
        if (!data.includes(0) && containsLikelySecret(data.toString('utf8'))) return fail('SECRET_DETECTED', '秘密情報らしき内容を含むためZIP作成を拒否しました。', { path: rel });
        total += data.length;
        if (total > LIMITS_DEFAULT.maxTotalUncompressed) return fail('TOTAL_SIZE_EXCEEDED', '合計サイズが上限を超えています。');
        // Validate using native paths, then encode archive entries with ZIP separators.
        files.push({ name: checkRelative(rel).split(path.sep).join('/'), data, sourceSha256: sha256(data) });
      }
      const names = files.map((f) => f.name);
      if (new Set(names).size !== names.length) return fail('DUPLICATE_NAME', '同じ名前の元ファイルが複数あります。');
      const dryRun = args.dryRun !== false;
      const plan = { destination: dest.rel, entries: files.map((f) => ({ name: f.name, size: f.data.length, sha256: f.sourceSha256 })), totalUncompressedSize: total };
      if (dryRun) return { status: 'PASS', executed: false, dryRun: true, plan, rollbackAvailable: false, rollbackMethod: 'manual_delete' };
      const zipBuf = createZip(files.map((f) => ({ name: f.name, data: f.data })));
      const check = validateZip(zipBuf);
      if (!check.ok) return fail(check.reasonCode, '作成したZIPの再検証に失敗したため保存しません。');
      fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
      fs.writeFileSync(dest.abs, zipBuf, { flag: 'wx' });
      const written = fs.readFileSync(dest.abs);
      if (sha256(written) !== check.sha256) return fail('VERIFY_MISMATCH', '保存後の再読取で内容が一致しませんでした。', { path: dest.rel });
      return { status: 'PASS', executed: true, dryRun: false, plan, path: dest.rel, sha256: check.sha256, verified: true, rollbackAvailable: false, rollbackMethod: 'manual_delete' };
    }
  };

  async function run(action, rawArgs) {
    if (!ACTIONS.includes(action)) return fail('VALIDATION_FAILED', `未知のactionです（対応: ${ACTIONS.join(', ')}）`);
    const problems = validateAction(ACTION_SCHEMAS[action], rawArgs);
    if (problems.length) return fail('VALIDATION_FAILED', problems.join('、'));
    if (!usable) return { status: 'BLOCKED', reasonCode: 'ADAPTER_NOT_CONFIGURED', adapter: 'files', executed: false, message: '作業ルート（OPERATIONS_WORK_ROOT）が未設定のためZIP操作は行いません。', nextStep: '作業ルートを OPERATIONS_WORK_ROOT に設定する。' };
    try {
      return handlers[action](rawArgs);
    } catch (error) {
      if (error instanceof PathGuardError) {
        const messages = { PATH_INVALID: 'パスの形式が不正です。', PATH_ABSOLUTE: '絶対パスは指定できません。', PATH_TRAVERSAL: '作業ルートの外へのパスは指定できません。', SYMLINK_ESCAPE: 'シンボリックリンク経由で作業ルート外へは出られません。', SYMLINK_REFUSED: 'シンボリックリンクは扱いません。', PATH_RESERVED: '予約領域は扱えません。', NOT_FOUND: '対象が見つかりません。' };
        return fail(error.code, messages[error.code] || 'パスを確認できませんでした。');
      }
      return fail('INTERNAL_ERROR', '内部エラーが発生しました。');
    }
  }

  return { actions: ACTIONS, schemas: ACTION_SCHEMAS, run, usable, idFactory };
}

module.exports = { createZipOps, ACTION_SCHEMAS, ACTIONS, MAX_ZIP_BYTES };
