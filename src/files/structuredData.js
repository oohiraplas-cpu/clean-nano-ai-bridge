'use strict';

// JSON / YAML / XML の整形式検証（Lane 1 / structured_data_op）。
// - 入力は path（作業ルート内）か content のどちらか一方。上限 1MB。
// - XML は DTD / ENTITY 宣言を拒否する（XXE・ビリオン対策）。定義済みエンティティと数値参照のみ許可。
// - 検証のみを行い、解析結果や内容は返さない（エラー位置のみ）。

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { resolveInRoot, PathGuardError } = require('./pathGuard');
const { validateAction } = require('./actionSchema');
const { sha256, SNAPSHOT_DIR } = require('./fileOps');
const { containsLikelySecret } = require('../secretMasking');

const MAX_BYTES = 1024 * 1024;
const SOURCE_PROPS = { path: { type: 'string', maxLength: 1024 }, content: { type: 'string', maxLength: MAX_BYTES } };
const ACTION_SCHEMAS = Object.freeze({
  json_validate: { required: [], additionalProperties: false, properties: SOURCE_PROPS },
  yaml_validate: { required: [], additionalProperties: false, properties: SOURCE_PROPS },
  xml_validate: { required: [], additionalProperties: false, properties: SOURCE_PROPS }
});
const ACTIONS = Object.freeze(Object.keys(ACTION_SCHEMAS));
const PREDEFINED = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);
const NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;

function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return { line, column };
}

function checkJson(text) {
  try {
    JSON.parse(text);
    return [];
  } catch (error) {
    const m = /position (\d+)/.exec(error.message);
    const pos = m ? Number(m[1]) : 0;
    return [{ ...lineCol(text, pos), message: 'JSONの構文が不正です' }];
  }
}

function checkYaml(text) {
  try {
    yaml.load(text);
    return [];
  } catch (error) {
    const mark = error.mark || {};
    return [{ line: (mark.line ?? 0) + 1, column: (mark.column ?? 0) + 1, message: 'YAMLの構文が不正です' }];
  }
}

// 整形式の最小検査。DOCTYPE は拒否し、要素の入れ子・属性・エンティティを確認する。
function checkXml(text) {
  const errors = [];
  const fail = (index, message, code) => { errors.push({ ...lineCol(text, index), message, code }); return errors; };
  let i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return fail(text.search(/<!DOCTYPE|<!ENTITY/i), 'DTD・ENTITY 宣言は許可していません', 'XML_DTD_FORBIDDEN');
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const textEnd = lt === -1 ? text.length : lt;
    const chunk = text.slice(i, textEnd);
    if (stack.length === 0 && chunk.trim() !== '') return fail(i, 'ルート要素の外に文字があります', 'XML_MALFORMED');
    const entityRe = /&([^;\s&]*);?/g;
    let m;
    while ((m = entityRe.exec(chunk))) {
      const ref = m[1];
      const ok = /^#\d+$/.test(ref) || /^#x[0-9a-fA-F]+$/.test(ref) || PREDEFINED.has(ref);
      if (!ok || m[0].slice(-1) !== ';') return fail(i + m.index, '不正なエンティティ参照です', 'XML_BAD_ENTITY');
    }
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return fail(i, '処理命令が閉じていません', 'XML_MALFORMED');
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return fail(i, 'コメントが閉じていません', 'XML_MALFORMED');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return fail(i, 'CDATAはルート要素の内側に限ります', 'XML_MALFORMED');
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) return fail(i, 'CDATAが閉じていません', 'XML_MALFORMED');
      i = end + 3;
    } else if (text.startsWith('</', i)) {
      const m2 = /^<\/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*>/.exec(text.slice(i, i + 300));
      if (!m2) return fail(i, '終了タグの形式が不正です', 'XML_MALFORMED');
      if (stack.length === 0 || stack[stack.length - 1] !== m2[1]) return fail(i, `終了タグ </${m2[1]}> が対応していません`, 'XML_MALFORMED');
      stack.pop();
      if (stack.length === 0) rootClosed = true;
      i += m2[0].length;
    } else if (text[i] === '<') {
      const nm = NAME_RE.exec(text.slice(i + 1, i + 200));
      if (!nm) return fail(i, '開始タグの名前が不正です', 'XML_MALFORMED');
      if (rootClosed) return fail(i, 'ルート要素が複数あります', 'XML_MALFORMED');
      let j = i + 1 + nm[0].length;
      const seenAttr = new Set();
      for (;;) {
        const ws = /^\s*/.exec(text.slice(j, j + 1000))[0];
        j += ws.length;
        if (text.startsWith('/>', j)) { j += 2; if (stack.length === 0) { rootSeen = true; rootClosed = true; } break; }
        if (text[j] === '>') { j += 1; if (stack.length === 0) rootSeen = true; stack.push(nm[0]); break; }
        const am = /^([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/.exec(text.slice(j, j + 2000));
        if (!am || ws.length === 0) return fail(j, '属性の形式が不正です', 'XML_MALFORMED');
        if (seenAttr.has(am[1])) return fail(j, '属性が重複しています', 'XML_MALFORMED');
        seenAttr.add(am[1]);
        const value = am[3] ?? am[4] ?? '';
        if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) return fail(j, '属性値に不正なエンティティ参照があります', 'XML_BAD_ENTITY');
        j += am[0].length;
      }
      i = j;
      if (stack.length === 0 && rootSeen) rootClosed = true;
    }
  }
  if (stack.length > 0) return fail(text.length, `要素 <${stack[stack.length - 1]}> が閉じていません`, 'XML_MALFORMED');
  if (!rootSeen) return fail(0, 'ルート要素がありません', 'XML_MALFORMED');
  return errors;
}

function createStructuredData({ workRoot } = {}) {
  let root = null;
  try { root = workRoot ? fs.realpathSync(path.resolve(workRoot)) : null; } catch { root = null; }
  const usable = Boolean(root);
  const checkers = { json_validate: checkJson, yaml_validate: checkYaml, xml_validate: checkXml };
  const labels = { json_validate: 'JSON', yaml_validate: 'YAML', xml_validate: 'XML' };

  async function run(action, rawArgs) {
    if (!ACTIONS.includes(action)) return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', executed: false, message: `未知のactionです（対応: ${ACTIONS.join(', ')}）` };
    const problems = validateAction(ACTION_SCHEMAS[action], rawArgs);
    if (problems.length) return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', executed: false, message: problems.join('、') };
    const hasPath = typeof rawArgs.path === 'string';
    const hasContent = typeof rawArgs.content === 'string';
    if (hasPath === hasContent) return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', executed: false, message: 'path と content はどちらか一方を指定してください' };
    let text;
    let source;
    try {
      if (hasPath) {
        if (!usable) return { status: 'BLOCKED', reasonCode: 'ADAPTER_NOT_CONFIGURED', adapter: 'files', executed: false, message: '作業ルート（OPERATIONS_WORK_ROOT）が未設定のため、ファイルを読めません。', nextStep: '作業ルートを設定する。' };
        const abs = resolveInRoot(root, rawArgs.path);
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink() || !st.isFile()) return { status: 'FAIL', reasonCode: 'NOT_A_FILE', executed: false, message: '通常のファイルではありません。' };
        if (path.relative(root, abs).split(path.sep).includes(SNAPSHOT_DIR)) return { status: 'FAIL', reasonCode: 'PATH_RESERVED', executed: false, message: '予約領域は扱えません。' };
        if (st.size > MAX_BYTES) return { status: 'FAIL', reasonCode: 'TOO_LARGE', executed: false, message: '1MBを超えています。' };
        const buf = fs.readFileSync(abs);
        text = buf.toString('utf8');
        source = { kind: 'file', path: path.relative(root, abs).split(path.sep).join('/'), sha256: sha256(buf) };
      } else {
        if (Buffer.byteLength(rawArgs.content, 'utf8') > MAX_BYTES) return { status: 'FAIL', reasonCode: 'TOO_LARGE', executed: false, message: '1MBを超えています。' };
        text = rawArgs.content;
        source = { kind: 'content', sha256: sha256(Buffer.from(text, 'utf8')) };
      }
    } catch (error) {
      if (error instanceof PathGuardError) return { status: 'FAIL', reasonCode: error.code, executed: false, message: 'パスを確認できませんでした。' };
      return { status: 'FAIL', reasonCode: 'INTERNAL_ERROR', executed: false, message: '内部エラーが発生しました。' };
    }
    const errors = checkers[action](text);
    const errorList = errors.slice(0, 20).map((e) => ({ line: e.line, column: e.column, message: e.message, code: e.code || null }));
    const containsSecretLike = containsLikelySecret(text);
    if (errors.length === 0) {
      return { status: 'PASS', executed: true, format: labels[action], valid: true, source, reasonCode: null, secretLikeContentDetected: containsSecretLike };
    }
    return {
      status: 'FAIL', executed: true, format: labels[action], valid: false, source,
      reasonCode: 'INVALID_DOCUMENT', errors: errorList, secretLikeContentDetected: containsSecretLike,
      message: `${labels[action]}の整形式検証に失敗しました。`
    };
  }

  return { actions: ACTIONS, schemas: ACTION_SCHEMAS, run, usable, checkJson, checkYaml, checkXml };
}

module.exports = { createStructuredData, ACTION_SCHEMAS, ACTIONS, MAX_BYTES };
