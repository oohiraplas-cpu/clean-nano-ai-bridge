/**
 * run_powerapps_testsの静的検査。Power Apps Studio / Test Engineは実行しない。
 * 実行不能・検証材料が不足している項目は成功扱いにせず、status:'skipped'とreasonを返す。
 */
const yaml = require('js-yaml');

const BUILTIN_PREFIXES = new Set([
  'Parent', 'Self', 'ThisItem', 'ThisRecord', 'App', 'User', 'Connection', 'Language', 'Param',
  'NotificationType', 'Color', 'ScreenTransition', 'Acceleration', 'Compass', 'Location', 'Calendar', 'Clock'
]);
const CRITICAL_FILES = new Set(['app.pa.yaml', 'canvasmanifest.json']);
const NAME = '[\\w\\u0080-\\uFFFF]';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function collectFormulas(node, found = []) {
  if (typeof node === 'string') {
    if (node.trimStart().startsWith('=')) found.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) collectFormulas(item, found);
  } else if (isPlainObject(node)) {
    for (const value of Object.values(node)) collectFormulas(value, found);
  }
  return found;
}

/** Power Fx式の括弧・引用符の対応を走査する。 */
function scanFormula(formula) {
  const problems = [];
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      const kind = ch === '"' ? '文字列' : '引用符付き識別子';
      let closed = false;
      i += 1;
      while (i < formula.length) {
        if (formula[i] === ch) {
          if (formula[i + 1] === ch) { i += 2; continue; }
          closed = true;
          i += 1;
          break;
        }
        i += 1;
      }
      if (!closed) problems.push({ type: 'quotes', message: `${kind}の引用符が閉じていません` });
      continue;
    }
    if (ch === '/' && formula[i + 1] === '/') {
      while (i < formula.length && formula[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && formula[i + 1] === '*') {
      const end = formula.indexOf('*/', i + 2);
      if (end === -1) { problems.push({ type: 'brackets', message: 'ブロックコメントが閉じていません' }); break; }
      i = end + 2;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (pairs[ch]) {
      if (stack.pop() !== pairs[ch]) problems.push({ type: 'brackets', message: `対応しない閉じ括弧 ${ch} があります` });
    }
    i += 1;
  }
  if (stack.length) problems.push({ type: 'brackets', message: `閉じられていない括弧があります（${stack.join('')}）` });
  return problems;
}

/** 文字列とコメントを取り除いた式（参照抽出用）。 */
function stripStringsAndComments(formula) {
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      i += 1;
      while (i < formula.length) {
        if (formula[i] === '"') { if (formula[i + 1] === '"') { i += 2; continue; } i += 1; break; }
        i += 1;
      }
      out += '""';
    } else if (ch === '/' && formula[i + 1] === '/') {
      while (i < formula.length && formula[i] !== '\n') i += 1;
    } else if (ch === '/' && formula[i + 1] === '*') {
      const end = formula.indexOf('*/', i + 2);
      i = end === -1 ? formula.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function unquoteIdentifier(name) {
  return name.startsWith("'") ? name.slice(1, -1).replace(/''/g, "'") : name;
}

function collectDefinitions(doc, file, screens, controls, duplicates) {
  const seenInFile = new Set();
  function register(kind, name, registry) {
    const key = `${kind}:${name}`;
    if (seenInFile.has(key)) duplicates.push({ file, message: `${kind === 'screen' ? '画面' : 'コントロール'}名が同一ファイル内で重複しています: ${name}` });
    seenInFile.add(key);
    if (registry.has(name) && registry.get(name) !== file) {
      duplicates.push({ file, message: `${kind === 'screen' ? '画面' : 'コントロール'}名が他ファイル(${registry.get(name)})と重複しています: ${name}` });
    }
    registry.set(name, file);
  }
  function walkChildren(children) {
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (!isPlainObject(child)) continue;
      for (const [name, body] of Object.entries(child)) {
        register('control', name, controls);
        if (isPlainObject(body)) walkChildren(body.Children);
      }
    }
  }
  if (isPlainObject(doc?.Screens)) {
    for (const [name, body] of Object.entries(doc.Screens)) {
      register('screen', name, screens);
      if (isPlainObject(body)) walkChildren(body.Children);
    }
  }
}

function result(id, name, status, extra = {}) {
  return { id, name, status, ...extra };
}

/**
 * @param {{files: Array<{relativePath: string, content?: string, delete?: boolean}>, knownScreens?: string[], knownDataSources?: string[]}} params
 */
function runStaticTests(params) {
  const files = params.files;
  const knownScreens = Array.isArray(params.knownScreens) ? params.knownScreens : null;
  const knownDataSources = Array.isArray(params.knownDataSources) ? params.knownDataSources : null;

  const syntaxFindings = [];
  const bracketFindings = [];
  const quoteFindings = [];
  const duplicateFindings = [];
  const formulaFiles = [];
  const screens = new Map();
  const controls = new Map();
  const deleted = [];
  let parsedFiles = 0;
  let formulaCount = 0;
  let skippedFormulas = 0;
  let unparsableTypeFiles = 0;

  for (const file of files) {
    const lower = file.relativePath.toLowerCase();
    if (file.delete === true) { deleted.push(file.relativePath); continue; }
    let doc;
    try {
      if (lower.endsWith('.json')) doc = JSON.parse(file.content);
      else if (lower.endsWith('.yaml') || lower.endsWith('.yml')) doc = yaml.load(file.content);
      else { unparsableTypeFiles += 1; continue; }
      parsedFiles += 1;
    } catch (error) {
      syntaxFindings.push({ file: file.relativePath, message: String(error.message).split('\n')[0].slice(0, 200) });
      continue;
    }
    collectDefinitions(doc, file.relativePath, screens, controls, duplicateFindings);
    for (const formula of collectFormulas(doc)) {
      formulaCount += 1;
      if (/\$@?"/.test(formula)) { skippedFormulas += 1; continue; }
      for (const problem of scanFormula(formula)) {
        const finding = { file: file.relativePath, message: problem.message, formula: formula.trim().slice(0, 80) };
        (problem.type === 'quotes' ? quoteFindings : bracketFindings).push(finding);
      }
      formulaFiles.push({ file: file.relativePath, code: stripStringsAndComments(formula) });
    }
  }

  const checks = [];

  // 1. 構文
  if (parsedFiles === 0 && syntaxFindings.length === 0) {
    checks.push(result('syntax', '構文（YAML/JSON）', 'skipped', { reason: 'YAML/JSONとして解析できるファイルがありません' }));
  } else {
    checks.push(result('syntax', '構文（YAML/JSON）', syntaxFindings.length ? 'failed' : 'passed', { findings: syntaxFindings, filesParsed: parsedFiles }));
  }

  // 2/3. 括弧・引用符
  const scanSkipReason = skippedFormulas > 0 ? `文字列補間式（$"..."）${skippedFormulas}件は走査対象外です` : null;
  for (const [id, name, findings] of [['brackets', '括弧の対応', bracketFindings], ['quotes', '引用符の対応', quoteFindings]]) {
    if (findings.length) checks.push(result(id, name, 'failed', { findings, formulasChecked: formulaCount - skippedFormulas }));
    else if (formulaCount === 0) checks.push(result(id, name, 'skipped', { reason: '検査対象のPower Fx式（=で始まる値）がありません' }));
    else if (scanSkipReason) checks.push(result(id, name, 'skipped', { reason: scanSkipReason, formulasChecked: formulaCount - skippedFormulas }));
    else checks.push(result(id, name, 'passed', { formulasChecked: formulaCount }));
  }

  // 4. 参照（画面・コントロール名の重複定義）
  checks.push(parsedFiles === 0
    ? result('duplicate_definitions', '画面・コントロール名の重複定義', 'skipped', { reason: '解析できるファイルがありません' })
    : result('duplicate_definitions', '画面・コントロール名の重複定義', duplicateFindings.length ? 'failed' : 'passed', { findings: duplicateFindings }));

  // 5. 画面遷移（Navigate先）
  const navigatePattern = new RegExp(`\\bNavigate\\s*\\(\\s*('(?:[^']|'')+'|[A-Za-z_\\u0080-\\uFFFF]${NAME}*)`, 'g');
  const targets = [];
  for (const { file, code } of formulaFiles) {
    for (const match of code.matchAll(navigatePattern)) targets.push({ file, target: unquoteIdentifier(match[1]) });
  }
  const definedScreens = new Set([...screens.keys(), ...(knownScreens || [])]);
  const unresolved = targets.filter(({ target }) => !definedScreens.has(target));
  if (targets.length === 0) {
    checks.push(result('screen_transitions', '画面遷移（Navigate先の存在）', 'passed', { navigateCalls: 0 }));
  } else if (unresolved.length === 0) {
    checks.push(result('screen_transitions', '画面遷移（Navigate先の存在）', 'passed', { navigateCalls: targets.length }));
  } else if (knownScreens) {
    checks.push(result('screen_transitions', '画面遷移（Navigate先の存在）', 'failed', {
      findings: unresolved.map(({ file, target }) => ({ file, message: `存在しない画面へ遷移しています: ${target}` }))
    }));
  } else {
    checks.push(result('screen_transitions', '画面遷移（Navigate先の存在）', 'skipped', {
      reason: 'knownScreens未指定のため、提供ファイルに無い画面は検証できません',
      unresolvedTargets: [...new Set(unresolved.map(({ target }) => target))]
    }));
  }

  // 6. データソース（コネクタ呼び出し形式の参照）
  const callPattern = new RegExp(`(?<![\\w.\\u0080-\\uFFFF])([A-Za-z_]${NAME}*)\\.[A-Za-z_]${NAME}*\\s*\\(`, 'g');
  const dataSourceRefs = [];
  for (const { file, code } of formulaFiles) {
    for (const match of code.matchAll(callPattern)) {
      const name = match[1];
      if (!BUILTIN_PREFIXES.has(name) && !controls.has(name) && !screens.has(name)) dataSourceRefs.push({ file, name });
    }
  }
  const unknownRefs = knownDataSources ? dataSourceRefs.filter(({ name }) => !knownDataSources.includes(name)) : dataSourceRefs;
  if (dataSourceRefs.length === 0) {
    checks.push(result('data_sources', 'データソース参照', 'passed', { references: 0 }));
  } else if (!knownDataSources) {
    checks.push(result('data_sources', 'データソース参照', 'skipped', {
      reason: 'knownDataSources未指定のため、データソース/コネクタの存在は検証できません',
      referencedNames: [...new Set(dataSourceRefs.map(({ name }) => name))]
    }));
  } else if (unknownRefs.length) {
    checks.push(result('data_sources', 'データソース参照', 'failed', {
      findings: unknownRefs.map(({ file, name }) => ({ file, message: `未登録のデータソース/コネクタを参照しています: ${name}` }))
    }));
  } else {
    checks.push(result('data_sources', 'データソース参照', 'passed', { references: dataSourceRefs.length }));
  }

  // 7. 危険な削除
  const deletionFindings = [];
  for (const path of deleted) {
    const base = path.split('/').pop();
    if (CRITICAL_FILES.has(base.toLowerCase())) deletionFindings.push({ file: path, message: `重要ファイルの削除です: ${base}` });
    const stem = base.replace(/\.pa\.ya?ml$|\.ya?ml$|\.json$/i, '');
    if (targets.some(({ target }) => target === stem)) {
      deletionFindings.push({ file: path, message: `削除対象と同名の画面(${stem})へ遷移する式が残っています（ファイル名一致による推定）` });
    }
  }
  checks.push(result('dangerous_deletions', '危険な削除', deletionFindings.length ? 'failed' : 'passed', {
    filesDeleted: deleted.length, findings: deletionFindings
  }));

  // 8. Power Apps Test Engine（未構成）
  checks.push(result('power_apps_test_engine', 'Power Appsアプリ実行テスト（Test Engine/Studio）', 'skipped', {
    reason: 'Test Engine/Studioによる実行テストは未構成のため実行していません'
  }));

  const failed = checks.filter((c) => c.status === 'failed').length;
  const skipped = checks.filter((c) => c.status === 'skipped').length;
  const passed = checks.filter((c) => c.status === 'passed').length;
  return {
    status: failed > 0 ? 'failed' : (skipped > 0 ? 'incomplete' : 'passed'),
    scope: 'static_analysis',
    summary: { total: checks.length, passed, failed, skipped },
    filesChecked: files.length,
    formulasChecked: formulaCount,
    checks,
    notice: 'skippedの項目は未検証です（成功扱いではありません）。'
  };
}

module.exports = { runStaticTests, scanFormula, collectFormulas };
