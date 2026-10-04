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
    || /\bSet\s*\(\s*'?\w*(?:secret|password|token|api[_-]?key|credential|connection[_-]?string)\w*'?\s*[,;]\s*"[^"]+"/i.test(text)
    || /\b\w*(?:secret|password|token|api[_-]?key|credential|connection[_-]?string)\w*[ \t]*[:=][ \t]*"[^"\r\n]+"/i.test(text)
    || /(?:client[_-]?secret|api[_-]?key|password|access[_-]?token)\s*[:=]\s*["']?[^\s"',;}]{6,}/i.test(text)) stop('secret_detected', 400);
}

const { tokens, bindDependencies, sourceRecovery } = require('./powerFxDependencies');

function analyzeStructure(files, secrets = []) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) stop('source_missing_or_limit', 422);
  assertNoSecrets(files, secrets);
  const entities = [], formulas = [], issues = [], confirmed = [], possible = [], transitions = [];
  const names = new Map();
  const definition = name => names.get(String(name).toLowerCase());
  let bytes = 0;
  const seenPaths = new Set();
  const editorReferences = [];
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
  const comparePath = (a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  for (const file of [...files].sort(comparePath)) {
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
    assertNoSecrets(doc, secrets);
    if (doc.EditorState?.ScreensOrder) {
      if (!Array.isArray(doc.EditorState.ScreensOrder) || doc.EditorState.ScreensOrder.some(n => typeof n !== 'string')) stop('invalid_editor_order', 422);
      for (const target of doc.EditorState.ScreensOrder) editorReferences.push({ file: file.relativePath, owner: 'EditorState', property: 'ScreensOrder', target });
    }
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
  const parseable = [];
  for (const f of formulas) {
    const ts = tokens(f.formula);
    const adjacentOperands = ts.some((t, i) => i > 0 && ['id', 'literal', 'number'].includes(t.kind) && ['id', 'literal', 'number'].includes(ts[i - 1].kind) && !['and', 'or', 'not', 'as', 'in', 'exactin'].includes(t.value.toLowerCase()) && !['and', 'or', 'not', 'as', 'in', 'exactin'].includes(ts[i - 1].value.toLowerCase()));
    if (scanFormula(f.formula).length || adjacentOperands || (ts.length > 1 && ['+', '-', '*', '/', '&', '=', '.', ',', ':'].includes(ts.at(-1)?.value))) {
      issues.push({ file: f.file, owner: f.owner, property: f.property, reason: 'formula_unparsable' });
    } else parseable.push(f);
  }
  const bound = bindDependencies(parseable, entities);
  issues.push(...bound.issues);
  confirmed.push(...bound.confirmed);
  possible.push(...bound.possible);
  transitions.push(...bound.transitions);
  for (const ref of editorReferences) if (definition(ref.target)?.kind !== 'screen') issues.push({ ...ref, reason: 'dangling_editor_screen' });
  const recovery = sourceRecovery({ issues, dependencies: bound.dependencies });
  // Static extraction never certifies runtime/data-source binding or all Power Fx semantics.
  return {
    status: issues.length ? 'blocked' : 'incomplete', scope: 'static_source',
    summary: { files: files.length, bytes, formulas: formulas.length, screens: entities.filter(e => e.kind === 'screen').length, controls: entities.filter(e => e.kind === 'control').length, transitionEdges: transitions.length },
    files: [...files].sort(comparePath).map(f => ({ relativePath: f.relativePath, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content) })),
    entities, transitions, confirmed, possible, issues,
    dependencies: bound.dependencies, symbolDefinitions: bound.symbolDefinitions,
    classification: { status: parseable.length === formulas.length && !bound.dependencies.some(d => d.blocksSourceRestore) ? 'classified' : 'incomplete', formulasAnalyzed: parseable.length, formulasSkipped: formulas.length - parseable.length, counts: bound.classificationCounts },
    recovery,
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
