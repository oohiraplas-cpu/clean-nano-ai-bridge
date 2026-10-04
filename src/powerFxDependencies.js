// Static binding evidence, not a Power Fx compiler or a test of live connections.
// Registry: Microsoft Power Fx function reference; names are case-insensitive.
const FUNCTIONS = new Set(('RGBA RGB ColorValue ColorFade Navigate Back Reset ResetForm SubmitForm EditForm NewForm Select PDF Notify If Switch And Or Not Blank IsBlank IsEmpty IsError Coalesce Text Value Trim Len Round RoundUp RoundDown Min Max Abs Sum Count CountRows Concatenate Concat Left Right Mid Lower Upper Substitute Table Today Now Date DateValue DateAdd DateDiff DateTime Year Month Day Hour Minute Second Weekday Set UpdateContext Collect ClearCollect Clear Patch Remove RemoveIf With ForAll Filter LookUp First Last Choices IsMatch Concurrent Find SortByColumns Sort Distinct Print Launch EncodeUrl Char UniChar JSON DataSourceInfo Defaults Sequence AddColumns DropColumns ShowColumns RenameColumns Search GroupBy Ungroup CountIf Average IsNumeric Mod Split TrimEnds StartsWith EndsWith Refresh Errors IfError Update UpdateIf').toLowerCase().split(' '));
FUNCTIONS.add('user');
const NAMESPACES = new Set(('App User Color ScreenTransition NotificationType TimeUnit JSONFormat DisplayMode FormMode Align Font FontWeight VerticalAlign Layout BorderStyle DataSourceInfo ErrorKind Match MatchOptions SortOrder DateTimeFormat StartOfWeek TraceSeverity PenMode ImagePosition TextMode LayoutDirection LayoutAlignItems LayoutJustifyContent LayoutOverflow Calendar Clock Location Acceleration Compass Connection Icon Live TextFormat').toLowerCase().split(' '));
const ROW_FUNCTIONS = new Set('filter lookup concat distinct forall sum average countif addcolumns sort'.split(' '));
const ENTITY_FUNCTIONS = new Set('pdf reset resetform submitform editform newform select'.split(' '));
const KEYWORDS = new Set('true false and or not as in exactin'.split(' '));
const lower = value => String(value).toLowerCase();

function tokens(formula) {
  const found = [];
  let i = 0;
  while (i < formula.length) {
    const rest = formula.slice(i);
    if (rest.startsWith('//')) { const end = rest.search(/[\r\n]/); i += end < 0 ? rest.length : end; continue; }
    if (rest.startsWith('/*')) { const end = rest.indexOf('*/', 2); i += end < 0 ? rest.length : end + 2; continue; }
    const ch = formula[i];
    // Interpolation is explicitly unsupported; never silently erase expressions embedded in it.
    if (rest.startsWith('$"') || rest.startsWith('$@"')) { found.push({ kind: 'unsupported', value: 'interpolation' }); i++; continue; }
    if (ch === '"' || ch === "'") {
      let name = ''; const quote = ch; i++;
      while (i < formula.length) {
        if (formula[i] === quote) {
          if (formula[i + 1] === quote) { name += quote; i += 2; continue; }
          i++; break;
        }
        name += formula[i++];
      }
      found.push({ kind: quote === '"' ? 'literal' : 'id', value: quote === '"' ? '' : name, quoted: quote === "'" }); continue;
    }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) { found.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    const id = rest.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (id) { found.push({ kind: 'id', value: id[0] }); i += id[0].length; continue; }
    if (!/\s/.test(ch)) found.push({ kind: 'punct', value: ch });
    i++;
  }
  return found;
}

function syntax(ts) {
  const pairs = new Map(), stack = [];
  for (let i = 0; i < ts.length; i++) {
    if (['(', '{', '['].includes(ts[i].value)) stack.push(i);
    if ([')', '}', ']'].includes(ts[i].value)) { const open = stack.pop(); if (open !== undefined) { pairs.set(open, i); pairs.set(i, open); } }
  }
  const calls = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].kind !== 'id' || ts[i + 1]?.value !== '(' || !pairs.has(i + 1)) continue;
    const close = pairs.get(i + 1), args = []; let start = i + 2, j = start;
    while (j < close) {
      if (pairs.has(j) && pairs.get(j) > j) { j = pairs.get(j) + 1; continue; }
      if ([',', ';'].includes(ts[j].value)) { args.push([start, j]); start = j + 1; }
      j++;
    }
    if (start < close) args.push([start, close]);
    calls.push({ index: i, name: lower(ts[i].value), args, close, qualified: ts[i - 1]?.value === '.' });
  }
  return { pairs, calls };
}

function recordKeys(ts, range, pairs) {
  if (!range || ts[range[0]]?.value !== '{' || pairs.get(range[0]) !== range[1] - 1) return [];
  const keys = []; let i = range[0] + 1;
  while (i < range[1] - 1) {
    if (ts[i]?.kind === 'id' && ts[i + 1]?.value === ':') keys.push(i);
    if (pairs.has(i) && pairs.get(i) > i) i = pairs.get(i) + 1; else i++;
  }
  return keys;
}

function bindDependencies(formulas, entities) {
  const byName = new Map(entities.map(e => [lower(e.name), e]));
  const byFormula = new Map(formulas.map(f => [`${f.file}\0${f.owner}\0${f.property}`, f]));
  const parsed = formulas.map(f => ({ ...f, ts: tokens(f.formula) }));
  for (const f of parsed) Object.assign(f, syntax(f.ts));
  const symbolDefinitions = [], declarationTokens = new Map(), symbols = new Map(), externalTables = new Map();
  const dependencies = [], confirmed = [], possible = [], issues = [], transitions = [];
  const bindings = new Map(parsed.map(f => [f, new Map()]));
  const classificationCounts = {};
  const location = f => ({ file: f.file, owner: f.owner, property: f.property });
  const screenOf = f => byName.get(lower(f.owner))?.screen || null;
  function declared(f, index, kind, screen = null) {
    const name = f.ts[index]?.value;
    if (!name || f.ts[index].kind !== 'id') return;
    const key = `${kind === 'context_variable' ? `context:${lower(screen)}` : 'global'}:${lower(name)}`;
    const evidence = { ...location(f), tokenIndex: index, kind: 'declaration' };
    const definition = { name, kind, screen, evidence };
    symbolDefinitions.push(definition);
    if (!symbols.has(key)) symbols.set(key, definition);
    if (!declarationTokens.has(f)) declarationTokens.set(f, new Set());
    declarationTokens.get(f).add(index);
  }
  // Declaration pass covers the entire bundle, regardless of traversal/use-before-assignment order.
  for (const f of parsed) {
    for (const call of f.calls.filter(c => !c.qualified)) {
      const first = call.args[0];
      if ((call.name === 'set' && (call.args.length !== 2 || !first || first[1] - first[0] !== 1 || f.ts[first[0]]?.kind !== 'id')) || (['collect', 'clearcollect'].includes(call.name) && call.args.length < 2) || (call.name === 'updatecontext' && call.args.length !== 1)) {
        issues.push({ ...location(f), reason: 'invalid_declaration_call', target: f.ts[call.index].value }); continue;
      }
      if (['set', 'collect', 'clearcollect'].includes(call.name) && first && first[1] - first[0] === 1) declared(f, first[0], call.name === 'set' ? 'global_variable' : 'collection');
      if (call.name === 'updatecontext') {
        if (!screenOf(f)) issues.push({ ...location(f), reason: 'context_owner_missing' });
        else for (const index of recordKeys(f.ts, first, f.pairs)) declared(f, index, 'context_variable', screenOf(f));
      }
      if (call.name === 'navigate' && call.args[0]?.[1] - call.args[0]?.[0] === 1) {
        const target = byName.get(lower(f.ts[call.args[0][0]].value));
        if (target?.kind === 'screen') for (const index of recordKeys(f.ts, call.args[2], f.pairs)) declared(f, index, 'context_variable', target.name);
      }
    }
    // DataSource expressions and explicit [@...] table references are evidence of external bindings,
    // not proof that the remote table/connector or schema actually exists.
  }
  for (const f of parsed) {
    const rootIds = f.ts.filter(t => t.kind === 'id');
    if (f.property.endsWith('/DataSource') && rootIds.length === 1 && !symbols.has(`global:${lower(rootIds[0].value)}`)) externalTables.set(lower(rootIds[0].value), { ...location(f), tokenIndex: f.ts.indexOf(rootIds[0]) });
    for (const call of f.calls.filter(c => !c.qualified && ['datasourceinfo', 'choices', 'defaults'].includes(c.name))) {
      const first = call.args[0];
      if (first && f.ts[first[0]]?.value === '[' && f.ts[first[0] + 1]?.value === '@' && f.ts[first[0] + 2]?.kind === 'id') externalTables.set(lower(f.ts[first[0] + 2].value), { ...location(f), tokenIndex: first[0] + 2 });
    }
  }
  function add(f, index, category, resolution, options = {}) {
    const item = {
      ...location(f), tokenIndex: index, target: options.target ?? f.ts[index]?.value ?? null,
      category, resolution,
      requiredForSourceRestore: options.blocking === true || ['symbol_declaration', 'source_symbol_reference', 'entity_reference', 'qualified_entity_reference', 'control_context_reference', 'local_record_reference'].includes(category),
      blocksSourceRestore: options.blocking === true,
      requiredForApplicationRestore: options.application !== false,
      rationale: options.rationale || (options.blocking ? 'No source definition or supported binding evidence; source recovery safety cannot be established.' : 'All source definitions and expressions are preserved byte-for-byte; this runtime binding/value is not needed to restore those files.'),
      ...options.extra
    };
    dependencies.push(item); bindings.get(f).set(index, item); classificationCounts[category] = (classificationCounts[category] || 0) + 1;
    if (resolution === 'confirmed') confirmed.push({ ...item, kind: category });
    else possible.push({ ...item, reason: category });
    return item;
  }
  for (const f of parsed) {
    const { ts } = f;
    if (ts.length <= 1) { add(f, 0, 'unset_export_property', 'confirmed', { application: false, target: null, rationale: 'Exported unset property contains no dependency; the exact empty expression is retained.' }); continue; }
    if (ts.some(t => t.kind === 'unsupported')) { add(f, 0, 'unsupported_formula', 'unresolved', { blocking: true, target: null }); continue; }
    const localScopes = [];
    for (const call of f.calls.filter(c => !c.qualified)) {
      if (call.name === 'with' && call.args[1]) {
        const keys = recordKeys(ts, call.args[0], f.pairs);
        localScopes.push({ range: call.args[1], names: new Set(keys.map(k => lower(ts[k].value))), unknownFields: !keys.length && ts[call.args[0]?.[0]]?.value !== '{', source: location(f), kind: 'with_record' });
      }
      if (ROW_FUNCTIONS.has(call.name)) {
        const aliasIndex = call.args[0] && ts.slice(...call.args[0]).findIndex(t => lower(t.value) === 'as');
        const alias = aliasIndex >= 0 ? ts[call.args[0][0] + aliasIndex + 1]?.value : null;
        for (const range of call.args.slice(1)) localScopes.push({ range, names: new Set(alias ? [lower(alias)] : []), unknownFields: true, source: { ...location(f), tokenIndex: call.args[0]?.[0], function: call.name }, kind: 'row_scope' });
      }
    }
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (t.kind !== 'id') continue;
      const name = lower(t.value);
      if (KEYWORDS.has(name)) continue;
      if (ts[i - 1]?.value === '.') {
        const binding = bindings.get(f).get(i - 2);
        const root = binding && ['entity_reference', 'qualified_entity_reference', 'control_context_reference'].includes(binding.category) && byName.get(lower(binding.target));
        if (root) {
          const child = byName.get(name);
          if (child && (lower(child.screen) === lower(root.name) || lower(child.parent) === lower(root.name))) add(f, i, 'qualified_entity_reference', 'confirmed', { target: child.name, application: false, extra: { root: root.name }, rationale: 'Qualified member resolves to a captured control in this screen/parent hierarchy.' });
          else add(f, i, 'qualified_member_reference', 'unverified', { extra: { root: root.name }, rationale: 'Member/property binding is not compiled. The root definition is captured; previous known child-definition loss is checked by impact analysis.' });
        }
        continue;
      }
      const scopes = localScopes.filter(s => i >= s.range[0] && i < s.range[1]).sort((a, b) => (a.range[1] - a.range[0]) - (b.range[1] - b.range[0]));
      const explicitGlobal = ts[i - 1]?.value === '@' && ts[i - 2]?.value === '[';
      const shadow = !explicitGlobal && scopes.find(s => s.names.has(name));
      const symbol = (!explicitGlobal && symbols.get(`context:${lower(screenOf(f))}:${name}`)) || symbols.get(`global:${name}`);
      const entity = byName.get(name);
      const call = f.calls.find(c => c.index === i);
      const parentCall = f.calls.filter(c => c.args.some(([a, b]) => i >= a && i < b)).sort((a, b) => (a.close - a.index) - (b.close - b.index))[0];
      if (declarationTokens.get(f)?.has(i)) { add(f, i, 'symbol_declaration', 'confirmed', { application: false, extra: { symbolKind: symbol?.kind || 'context_variable' }, rationale: 'Set/Collect/ClearCollect/UpdateContext/Navigate context declaration is present in captured source.' }); continue; }
      if (ts[i + 1]?.value === ':' || lower(ts[i - 1]?.value) === 'as') continue; // record keys/alias declarations
      if (shadow) { add(f, i, 'local_record_reference', 'confirmed', { application: false, extra: { binding: shadow.kind }, rationale: 'The identifier is declared in the enclosing record/alias scope, whose expression is captured.' }); continue; }
      if (call && !call.qualified) {
        if (!FUNCTIONS.has(name)) { add(f, i, 'unsupported_function', 'unresolved', { blocking: true }); continue; }
        classificationCounts.builtin_function = (classificationCounts.builtin_function || 0) + 1;
        if (name === 'back') add(f, i, 'history_navigation', 'unverified', { target: null, rationale: 'Back depends on transient session history. No source definition is missing; history is outside file recovery.' });
        if (name === 'navigate') {
          const first = call.args[0], dest = first && ts[first[0]];
          if (first && first[1] - first[0] === 1 && dest.kind === 'id' && !scopes.some(s => s.names.has(lower(dest.value))) && byName.get(lower(dest.value))?.kind === 'screen') {
            const target = byName.get(lower(dest.value)).name;
            transitions.push({ ...location(f), target });
          } else if (first && first[1] - first[0] === 1 && dest.kind === 'id' && !symbols.has(`global:${lower(dest.value)}`) && !symbols.has(`context:${lower(screenOf(f))}:${lower(dest.value)}`) && !scopes.some(s => s.names.has(lower(dest.value)))) {
            issues.push({ ...location(f), reason: 'dangling_screen', target: dest.value });
          } else add(f, i, 'dynamic_navigation', 'unverified', { target: null, rationale: 'Destination is computed from captured expressions. Actual navigation requires runtime evaluation, not additional source bytes.' });
        }
        continue;
      }
      if (['self', 'parent'].includes(name)) {
        const owner = byName.get(lower(f.owner)); const target = name === 'self' ? owner?.name : owner?.parent;
        add(f, i, 'control_context_reference', 'confirmed', { target: target || t.value, application: false, rationale: 'Self/Parent resolves through the captured owner/parent control hierarchy.' }); continue;
      }
      if (['thisitem', 'thisrecord'].includes(name)) { add(f, i, 'record_context_reference', 'unverified', { rationale: 'Power Fx implicit record scope; field values/schema come from runtime Items/DataSource, not source-file contents.' }); continue; }
      if (parentCall?.name === 'datasourceinfo' && parentCall.args[2] && i >= parentCall.args[2][0] && i < parentCall.args[2][1]) {
        add(f, i, 'external_column_reference', 'unverified', { extra: { evidence: { ...location(f), tokenIndex: parentCall.args[0]?.[0] } }, rationale: 'Third DataSourceInfo argument is a column identifier; its remote schema is absent. The reference is captured, remote columns are outside file recovery.' }); continue;
      }
      if (NAMESPACES.has(name)) { classificationCounts.builtin_namespace = (classificationCounts.builtin_namespace || 0) + 1; continue; }
      // Record-scope names precede globals in Power Fx. With literal keys are precise; row schemas
      // absent from this export cannot be guessed. Preserve both alternatives when a global exists.
      if (!explicitGlobal && scopes.some(s => s.unknownFields) && !externalTables.has(name)) {
        add(f, i, symbol ? 'row_field_or_symbol' : entity ? 'row_field_or_entity' : 'row_field_reference', 'unverified', { extra: { evidence: scopes.find(s => s.unknownFields).source, ...(symbol ? { symbolDefinition: symbol.evidence } : {}), ...(entity ? { entityDefinition: { file: entity.file, name: entity.name } } : {}) }, rationale: 'Identifier occurs in a table/record scope. Field existence and possible shadowing need runtime schema; the table expression and any source symbol/entity definition are captured.' }); continue;
      }
      if (symbol) { add(f, i, 'source_symbol_reference', 'confirmed', { application: false, extra: { symbolKind: symbol.kind, screen: symbol.screen, definition: symbol.evidence }, rationale: 'Matching global/collection or screen-local context declaration is present in captured source.' }); continue; }
      if (entity) { add(f, i, 'entity_reference', 'confirmed', { target: entity.name, application: false, rationale: 'Screen/control definition is present in captured source.' }); continue; }
      if (externalTables.has(name)) { add(f, i, 'external_data_source', 'unverified', { extra: { evidence: externalTables.get(name), bindingVerified: false }, rationale: 'DataSource or [@...] binding is referenced explicitly; connection/schema/data are absent. File restoration retains the name and formulas without recreating that service.' }); continue; }
      if (ts[i + 1]?.value === '.' && ts[i + 2]?.kind === 'id' && ts[i + 3]?.value === '(') {
        add(f, i, 'external_callable_binding', 'unverified', { extra: { bindingVerified: false }, rationale: 'Qualified callable usage proves an external/namespace binding is required, not that it exists. Connection metadata/credentials are outside file recovery and are not guessed.' }); continue;
      }
      if (f.property.startsWith('Properties/Items.') && byFormula.has(`${f.file}\0${f.owner}\0Properties/Items`)) {
        add(f, i, 'item_projection_field', 'unverified', { extra: { evidence: { ...location(f), property: 'Properties/Items' } }, rationale: 'Items projection refers to a row supplied by captured Items; field schema is runtime-dependent.' }); continue;
      }
      if ((['Image', 'BackgroundImage', 'Theme'].includes(f.property.split('/').at(-1)) && ts.filter(x => x.kind !== 'punct').length === 1) || name === 'sampleimage') {
        add(f, i, 'external_resource', 'unverified', { extra: { bindingVerified: false }, rationale: 'Exported image/theme resource reference has no resource payload in this source bundle. It is required for full app recovery, excluded from exact source-file recovery.' }); continue;
      }
      const entityArgument = parentCall && ENTITY_FUNCTIONS.has(parentCall.name) && parentCall.args[0]?.[0] === i;
      if (entityArgument) issues.push({ ...location(f), reason: 'dangling_entity', target: t.value });
      add(f, i, ts[i + 1]?.value === '.' ? 'unbound_member_root' : 'unresolved_symbol', 'unresolved', { blocking: true });
    }
  }
  return { confirmed, possible, dependencies, symbolDefinitions, issues, transitions, classificationCounts };
}

function sourceRecovery(analysis) {
  const blockers = [...analysis.issues, ...analysis.dependencies.filter(d => d.blocksSourceRestore)];
  const exclusions = analysis.dependencies.filter(d => d.resolution !== 'confirmed' && !d.blocksSourceRestore);
  return {
    scope: 'source_files_only', allowed: blockers.length === 0, blockers,
    rationale: 'Only the exact captured source files are restored. Source definitions/formulas and dependency evidence are retained; existing app/environment bindings are prerequisites, never recreated or inferred.',
    applicationRecovery: 'not_verified', externalBindingsVerified: false,
    excludedRuntimeDependencyCount: exclusions.length,
    exclusions: [...new Set(exclusions.map(d => d.category))].sort()
  };
}
module.exports = { tokens, bindDependencies, sourceRecovery };
