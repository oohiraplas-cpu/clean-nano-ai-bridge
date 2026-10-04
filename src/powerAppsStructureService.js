const crypto = require('node:crypto');
const yaml = require('js-yaml');
const { scanFormula } = require('./powerAppsStaticTests');
const { containsLikelySecret, maskSecrets } = require('./secretMasking');
const { bridgeError } = require('./errors');

const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function stop(reason, status = 409, extra = {}) {
  throw bridgeError(`安全停止: ${reason}`, status, { status: 'blocked', reason, ...extra });
}
function assertNoSecrets(value, secrets = []) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { assertNoSecrets(key, secrets); assertNoSecrets(item, secrets); }
    return;
  }
  if (typeof value !== 'string') return;
  const text = typeof value === 'string' ? value : canonical(value);
  if (containsLikelySecret(text) || maskSecrets(text, secrets) !== text
    || secrets.some(secret => typeof secret === 'string' && secret.length > 0 && text.includes(secret))
    || /(?:client[_-]?secret|api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[^\s"',;}]{6,}/i.test(text)) stop('secret_detected', 400);
}

// Lexer: preserve identifiers (including quoted Power Fx names), ignore literals/comments.
// This is a bounded static subset, not a Power Fx compiler or runtime proof.
function tokens(formula) {
  const found = [];
  let i = 0;
  while (i < formula.length) {
    const rest = formula.slice(i);
    if (rest.startsWith('//')) { const end = rest.indexOf('\n'); i += end < 0 ? rest.length : end; continue; }
    if (rest.startsWith('/*')) { const end = rest.indexOf('*/', 2); i += end < 0 ? rest.length : end + 2; continue; }
    const ch = formula[i];
    if (ch === '"' || ch === "'") {
      const quote = ch; let name = ''; i++;
      while (i < formula.length) {
        if (formula[i] === quote) {
          if (formula[i + 1] === quote) { name += quote; i += 2; continue; }
          i++; break;
        }
        name += formula[i++];
      }
      found.push({ kind: quote === '"' ? 'literal' : 'id', value: quote === '"' ? '' : name });
      continue;
    }
    const id = rest.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (id) { found.push({ kind: 'id', value: id[0] }); i += id[0].length; continue; }
    if (!/\s/.test(ch)) found.push({ kind: 'punct', value: ch });
    i++;
  }
  return found;
}
const BUILTINS = new Set(['Parent', 'Self', 'ThisItem', 'ThisRecord', 'App', 'User', 'Color', 'ScreenTransition', 'NotificationType', 'TimeUnit', 'JSONFormat', 'DisplayMode', 'FormMode', 'Align', 'Font', 'FontWeight', 'VerticalAlign', 'Layout', 'BorderStyle', 'DataSourceInfo', 'ErrorKind', 'Match', 'MatchOptions', 'SortOrder', 'DateTimeFormat', 'StartOfWeek', 'TraceSeverity', 'PenMode', 'ImagePosition', 'TextMode', 'AutoHeight', 'LayoutDirection', 'LayoutAlignItems', 'LayoutJustifyContent', 'LayoutOverflow', 'SelectedDate', 'Calendar', 'Clock', 'Location', 'Acceleration', 'Compass', 'Connection']);
const STATIC_FUNCTIONS = new Set(['rgba', 'rgb', 'colorvalue', 'navigate', 'back', 'reset', 'resetform', 'submitform', 'editform', 'newform', 'select', 'pdf', 'notify', 'if', 'switch', 'and', 'or', 'not', 'blank', 'isblank', 'isempty', 'iserror', 'coalesce', 'text', 'value', 'trim', 'len', 'round', 'roundup', 'rounddown', 'min', 'max', 'abs', 'sum', 'count', 'countrows', 'concatenate', 'concat', 'left', 'right', 'mid', 'lower', 'upper', 'substitute', 'table', 'today', 'now', 'date', 'datevalue', 'dateadd', 'year', 'month', 'day', 'hour', 'minute', 'second']);
const BUILTIN_NAMES = new Set([...BUILTINS].map(n => n.toLowerCase()));
const ENTITY_FUNCTIONS = new Set(['pdf', 'reset', 'resetform', 'submitform', 'editform', 'newform', 'select']);

function analyzeStructure(files, secrets = []) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) stop('source_missing_or_limit', 422);
  assertNoSecrets(files, secrets);
  const entities = [], formulas = [], issues = [], confirmed = [], possible = [], transitions = [];
  const names = new Map();
  const definition = name => names.get(String(name).toLowerCase());
  let bytes = 0;
  const seenPaths = new Set();
  function entity(kind, name, file, parent, screen) {
    if (definition(name)) stop('duplicate_definition', 422);
    const item = { kind, name, file, parent, screen };
    names.set(name.toLowerCase(), item); entities.push(item); return item;
  }
  function expressions(value, file, owner, at) {
    if (typeof value === 'string' && value.trimStart().startsWith('=')) {
      formulas.push({ file, owner, property: at.join('/'), formula: value });
    } else if (Array.isArray(value)) value.forEach((v, i) => expressions(v, file, owner, [...at, String(i)]));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) expressions(v, file, owner, [...at, k]);
  }
  function children(value, file, parent, screen) {
    if (value === undefined) return;
    if (!Array.isArray(value)) stop('invalid_children', 422);
    for (const child of value) {
      if (!child || typeof child !== 'object' || Object.keys(child).length !== 1) stop('invalid_control', 422);
      const [name, body] = Object.entries(child)[0];
      if (!body || typeof body.Control !== 'string') stop('invalid_control', 422);
      entity('control', name, file, parent, screen);
      expressions(body.Properties, file, name, ['Properties']);
      children(body.Children, file, name, screen);
      for (const key of Object.keys(body)) if (!['Properties', 'Children', 'Control', 'Variant', 'Layout'].includes(key)) expressions(body[key], file, name, [key]);
    }
  }
  for (const file of [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    if (!file || typeof file.relativePath !== 'string' || typeof file.content !== 'string' || !/^[^\\:\x00-\x1f]+\.(?:yaml|yml|json)$/.test(file.relativePath)
      || file.relativePath.startsWith('/') || file.relativePath.split('/').some(p => !p || p === '.' || p === '..') || seenPaths.has(file.relativePath)) stop('invalid_source_file', 422);
    seenPaths.add(file.relativePath);
    bytes += Buffer.byteLength(file.content);
    if (bytes > 4000000 || Buffer.byteLength(file.content) > 1000000) stop('source_limit', 413);
    let doc;
    try { doc = file.relativePath.endsWith('.json') ? JSON.parse(file.content) : yaml.load(file.content, { schema: yaml.JSON_SCHEMA, maxAliasCount: 0 }); }
    catch { stop('source_parse_failed', 422, { file: file.relativePath }); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) stop('source_parse_failed', 422);
    // Reject YAML alias cycles and excessive expansion before walking untrusted documents.
    let visited = 0;
    const active = new Set();
    function bounded(v, depth = 0) {
      if (++visited > 100000 || depth > 80) stop('source_complexity_limit', 413);
      if (v && typeof v === 'object') {
        if (active.has(v)) stop('source_alias_cycle', 422);
        active.add(v); for (const x of Object.values(v)) bounded(x, depth + 1); active.delete(v);
      }
    }
    bounded(doc);
    if (doc.Screens) {
      if (typeof doc.Screens !== 'object' || Array.isArray(doc.Screens)) stop('invalid_screens', 422);
      for (const [name, body] of Object.entries(doc.Screens)) {
        if (!body || typeof body !== 'object') stop('invalid_screen', 422);
        entity('screen', name, file.relativePath, null, name);
        expressions(body.Properties, file.relativePath, name, ['Properties']);
        children(body.Children, file.relativePath, name, name);
      }
    }
    // App and editor metadata are included in formula/byte counts, but not invented screens.
    for (const [key, value] of Object.entries(doc)) if (key !== 'Screens') expressions(value, file.relativePath, key, [key]);
  }
  if (!entities.some(e => e.kind === 'screen')) stop('no_screens', 422);
  for (const f of formulas) {
    const location = { file: f.file, owner: f.owner, property: f.property };
    if (scanFormula(f.formula).length) { issues.push({ ...location, reason: 'formula_unparsable' }); continue; }
    if (/\$@?"/.test(f.formula)) { possible.push({ ...location, reason: 'interpolation_not_analyzed' }); continue; }
    const ts = tokens(f.formula);
    // Canvas exports can contain '=' with no expression for unset properties.
    if (ts.length <= 1) { possible.push({ ...location, reason: 'empty_property_expression' }); continue; }
    if (['+', '-', '*', '/', '&', '=', '.', ',', ':'].includes(ts.at(-1)?.value)) { issues.push({ ...location, reason: 'formula_unparsable' }); continue; }
    const lexicalScope = ts.some(t => t.kind === 'id' && ['with', 'forall', 'as'].includes(t.value.toLowerCase()));
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      if (t.kind !== 'id') continue;
      if (t.value.toLowerCase() === 'navigate' && ts[i + 1]?.value === '(' && ts[i - 1]?.value !== '.') {
        const dest = ts[i + 2];
        if (!lexicalScope && dest?.kind === 'id' && [',', ')', ';'].includes(ts[i + 3]?.value)) {
          const target = dest.value;
          if (definition(target)?.kind !== 'screen') issues.push({ ...location, reason: 'dangling_screen', target });
          else { transitions.push({ ...location, target: definition(target).name }); confirmed.push({ ...location, target: definition(target).name, kind: 'navigation' }); }
        } else possible.push({ ...location, reason: 'dynamic_navigation' });
      }
      if (t.value.toLowerCase() === 'back' && ts[i + 1]?.value === '(' && ts[i - 1]?.value !== '.') possible.push({ ...location, reason: 'history_navigation' });
      if (definition(t.value) && ts[i - 1]?.value !== '.' && ![':', '('].includes(ts[i + 1]?.value)) {
        if (lexicalScope) possible.push({ ...location, target: t.value, reason: 'scoped_reference' });
        else confirmed.push({ ...location, target: definition(t.value).name, kind: 'entity_reference' });
      } else if (ts[i + 1]?.value === '.' && ts[i - 1]?.value !== '.' && !BUILTIN_NAMES.has(t.value.toLowerCase()) && !definition(t.value)) {
        possible.push({ ...location, target: t.value, reason: 'external_or_record_reference' });
      }
      if (!definition(t.value) && ts[i - 1]?.value === '(' && ENTITY_FUNCTIONS.has(ts[i - 2]?.value.toLowerCase())) possible.push({ ...location, target: t.value, reason: 'unresolved_entity_argument' });
      if (!definition(t.value) && !BUILTIN_NAMES.has(t.value.toLowerCase()) && ts[i - 1]?.value !== '.' && ts[i + 1]?.value !== '.' && ts[i + 1]?.value !== ':' && !['true', 'false', 'and', 'or', 'not', 'as', 'in', 'exactin'].includes(t.value.toLowerCase())) {
        if (ts[i + 1]?.value !== '(') possible.push({ ...location, target: t.value, reason: 'unresolved_symbol' });
        else if (!STATIC_FUNCTIONS.has(t.value.toLowerCase())) possible.push({ ...location, target: t.value, reason: 'function_semantics_unverified' });
      }
      if (['set', 'updatecontext', 'collect', 'clearcollect', 'patch', 'remove', 'removeif', 'with', 'forall'].includes(t.value.toLowerCase()) && ts[i + 1]?.value === '(') possible.push({ ...location, reason: 'state_or_data_dependency' });
    }
  }
  // Static extraction never certifies runtime/data-source binding or all Power Fx semantics.
  return {
    status: issues.length ? 'blocked' : 'incomplete', scope: 'static_source',
    summary: { files: files.length, bytes, formulas: formulas.length, screens: entities.filter(e => e.kind === 'screen').length, controls: entities.filter(e => e.kind === 'control').length, transitionEdges: transitions.length },
    files: [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map(f => ({ relativePath: f.relativePath, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content) })),
    entities, transitions, confirmed, possible, issues,
    limitations: ['Static subset only; Power Fx compiler, runtime, data-source binding and dynamic dependencies are not verified.']
  };
}

class PowerAppsStructureService {
  constructor({ sourceProvider, canonicalBranch, secrets = [] }) { Object.assign(this, { sourceProvider, canonicalBranch, secrets }); }
  async load(branch) {
    assertNoSecrets(branch, this.secrets);
    if (branch !== this.canonicalBranch) stop('branch_mismatch');
    let bundle;
    try { bundle = await this.sourceProvider(branch); }
    catch (error) {
      if (error.payload?.status === 'not_configured') throw error;
      // Never reflect upstream response bodies, paths or credential-bearing exceptions.
      stop('source_unavailable', error.status === 404 ? 404 : 502);
    }
    if (!bundle || bundle.branch !== branch || !/^[0-9a-f]{40}$/i.test(bundle.commitSha || '') || bundle.complete !== true) stop('source_identity_or_completeness');
    const structure = analyzeStructure(bundle.files, this.secrets);
    return { bundle, structure };
  }
  async inspect(params) {
    const { bundle, structure } = await this.load(params.branch);
    return { ...structure, branch: bundle.branch, commitSha: bundle.commitSha };
  }
}
module.exports = { PowerAppsStructureService, analyzeStructure, tokens, canonical, sha256, stop, assertNoSecrets };
