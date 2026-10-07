const yaml = require('js-yaml');
const crypto = require('node:crypto');
const { maskSecrets } = require('./secretMasking');

function normalizeSource(content) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('Invalid source size or type');
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const value = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a pa.yaml mapping');
  let nodes = 0;
  const active = new Set();
  function canonical(node, depth = 0) {
    if (++nodes > 50000 || depth > 100) throw new Error('Source complexity limit');
    if (typeof node === 'number' && (!Number.isFinite(node) || (Number.isInteger(node) && !Number.isSafeInteger(node)))) throw new Error('Unsafe numeric YAML value');
    if (!node || typeof node !== 'object') return node;
    if (active.has(node)) throw new Error('Cyclic YAML aliases');
    active.add(node);
    const result = Array.isArray(node) ? node.map(x => canonical(x, depth + 1))
      : Object.fromEntries(Object.keys(node).sort().map(k => [k, canonical(node[k], depth + 1)]));
    active.delete(node);
    return result;
  }
  const normalized = canonical(value);
  const serialized = JSON.stringify(normalized);
  return { text, value: normalized, serialized,
    hash: crypto.createHash('sha256').update(serialized).digest('hex') };
}

function propertyChanges(before, after, pointer = '', found = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return found;
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      propertyChanges(before[key], after[key], `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, found);
    }
  } else {
    // Values are intentionally omitted: formulas may contain secrets or endpoints.
    found.push({ property: maskSecrets(pointer || '/'), kind: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed' });
  }
  return found;
}

// Actual source line numbers only; never return source snippets. Mapping-order
// noise is separated by the semantic comparison before this function runs.
function changedLines(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  if (a.length > 2000 || b.length > 2000) return { available: false, reason: 'line_diff_limit', git: [], powerApps: [] };
  const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const git = [], powerApps = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i === a.length || rows[i][j + 1] >= rows[i + 1][j])) powerApps.push(++j);
    else git.push(++i);
  }
  return { available: true, git, powerApps };
}

function compareSources(gitContent, runtimeContent, targetFile) {
  const git = normalizeSource(gitContent), runtime = normalizeSource(runtimeContent);
  const identical = git.serialized === runtime.serialized;
  const presentationDifferent = gitContent !== runtimeContent;
  const properties = identical ? [] : propertyChanges(git.value, runtime.value);
  return { comparisonStatus: identical ? 'identical' : 'changed', hasDifferences: !identical,
    presentationOnly: identical && presentationDifferent,
    presentationDifferences: presentationDifferent,
    normalizedHashes: { git: git.hash, powerApps: runtime.hash },
    targetFile, changedProperties: properties.slice(0, 500),
    changedPropertiesTruncated: properties.length > 500,
    changedLines: identical ? { available: true, git: [], powerApps: [] } : changedLines(git.text, runtime.text),
    lineDiffIncludesPresentation: !identical && presentationDifferent };
}

module.exports = { normalizeSource, compareSources };
