const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { analyzeStructure, PowerAppsStructureService, canonical, sha256, tokens } = require('../src/powerAppsStructureService');
const { PowerAppsImpactService } = require('../src/powerAppsImpactService');
const { ChangeSnapshotService } = require('../src/changeSnapshotService');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const branch = 'feature/add-powerapps-inspection-safety-tools';
const commitSha = '8b76bac42f695a03c96d9c3760d78efce65a7699';
const file = (relativePath, content) => ({ relativePath, content });
const screen = (name, expression) => file(`${name}.pa.yaml`, JSON.stringify({ Screens: { [name]: { Properties: { OnVisible: '=' + expression } } } }));
function services(files, directory) {
  const structure = new PowerAppsStructureService({ canonicalBranch: branch, sourceProvider: async () => ({ branch, commitSha, complete: true, files }) });
  const impact = new PowerAppsImpactService(structure);
  return { structure, impact, snapshots: new ChangeSnapshotService({ structureService: structure, impactService: impact, directory }) };
}
const reason = expected => error => error.payload?.reason === expected;

test('global variables, collections and declarations across files bind before use', () => {
  const files = [screen('A', 'Notify(total); CountRows(rows)'), screen('Z', 'Set(total,1); ClearCollect(rows,Table({Value:1}))')];
  const result = analyzeStructure(files);
  assert.equal(result.recovery.allowed, true);
  assert.ok(result.confirmed.some(d => d.category === 'source_symbol_reference' && d.target === 'total' && d.definition.file === 'Z.pa.yaml'));
  assert.ok(result.symbolDefinitions.some(d => d.name === 'rows' && d.kind === 'collection'));
  assert.equal(result.possible.some(d => d.category === 'unsupported_function'), false);
});

test('screen context is local; [@name] resolves globals rather than same-name context', () => {
  const result = analyzeStructure([screen('A', 'Set(v,1); UpdateContext({v:2}); Notify(v); Notify([@v])')]);
  const reads = result.dependencies.filter(d => d.target === 'v' && d.category === 'source_symbol_reference');
  assert.deepEqual(reads.map(d => d.symbolKind), ['context_variable', 'global_variable']);
  const missing = analyzeStructure([screen('A', 'UpdateContext({ctx:1})'), screen('B', 'Notify(ctx)')]);
  assert.equal(missing.recovery.allowed, false);
  assert.ok(missing.recovery.blockers.some(b => b.target === 'ctx' && b.category === 'unresolved_symbol'));
});

test('Navigate third argument declares context only in destination screen', () => {
  const result = analyzeStructure([screen('A', 'Navigate(B, ScreenTransition.None, {ctx:1})'), screen('B', 'Notify(ctx)')]);
  assert.equal(result.recovery.allowed, true);
  assert.ok(result.symbolDefinitions.some(s => s.name === 'ctx' && s.screen === 'B'));
});

test('With keys and nested row aliases bind locally without hiding sibling missing names', () => {
  const result = analyzeStructure([screen('A', 'With({x:1}, x+1); Set(rows,Table({Value:1})); Set(threshold,0); Filter(rows As R, R.Value > [@threshold])')]);
  assert.equal(result.recovery.allowed, true);
  assert.ok(result.confirmed.some(d => d.category === 'local_record_reference' && d.target === 'R'));
  const outOfScope = analyzeStructure([screen('A', 'With({x:1}, x+1); Notify(x)')]);
  assert.equal(outOfScope.recovery.allowed, false);
  const siblingMissing = analyzeStructure([screen('A', 'With({x:1}, x+missing)')]);
  assert.equal(siblingMissing.recovery.allowed, false);
});

test('external table columns and connector calls are evidenced exclusions, not declared live bindings', () => {
  const result = analyzeStructure([screen('A', 'DataSourceInfo([@Ledger],DataSourceInfo.DisplayName,EmployeeName); Filter([@Ledger], Amount>0); Bridge.GetTasks(); Back()')]);
  assert.equal(result.status, 'incomplete'); assert.equal(result.recovery.allowed, true);
  for (const category of ['external_data_source', 'external_column_reference', 'external_callable_binding', 'row_field_reference', 'history_navigation']) {
    const d = result.dependencies.find(d => d.category === category);
    assert.ok(d, category); assert.equal(d.resolution, 'unverified'); assert.equal(d.blocksSourceRestore, false);
    assert.equal(d.requiredForApplicationRestore, true); assert.ok(d.rationale);
  }
  assert.equal(result.recovery.applicationRecovery, 'not_verified');
});

test('qualified child references and definition removal preserve safe stop', async () => {
  const home = file('Home.pa.yaml', 'Screens:\n  Home:\n    Children:\n      - Label1:\n          Control: Text@1\n          Properties:\n            Text: ="one"\n');
  const other = screen('Other', 'Notify(Home.Label1.Text)');
  const { structure, impact } = services([home, other]);
  const before = await structure.inspect({ branch });
  assert.ok(before.confirmed.some(d => d.category === 'qualified_entity_reference' && d.target === 'Label1'));
  const result = await impact.analyze({ branch, changes: [file('Home.pa.yaml', 'Screens:\n  Home:\n    Properties:\n      Fill: =Color.White\n')] });
  assert.equal(result.recovery.allowed, false); assert.ok(result.issues.some(i => i.reason === 'dangling_entity'));
  const shadow = analyzeStructure([home, screen('Other', 'With({Home:{Label1:1}}, Home.Label1)')]);
  assert.equal(shadow.confirmed.some(d => d.owner === 'Other' && d.category === 'qualified_entity_reference'), false);
});

test('removed global definitions cannot be disguised as row fields or external callable bindings', async () => {
  for (const expression of ['Notify(v)', 'Filter(Table({Value:1}),v>0)', 'v.Get()']) {
    const original = screen('A', 'Set(v,1); ' + expression);
    const { impact } = services([original]);
    const r = await impact.analyze({ branch, changes: [screen('A', expression)] });
    assert.equal(r.recovery.allowed, false); assert.ok(r.issues.some(i => i.reason === 'removed_symbol_definition'));
  }
});

test('lexer handles numeric literals, CR comments and unsupported interpolation honestly', () => {
  assert.equal(tokens('=1e3 + .25').some(t => t.kind === 'id'), false);
  const result = analyzeStructure([screen('A', '// ignore Set(fake,1)\r Set(real,1); Notify(real)')]);
  assert.equal(result.recovery.allowed, true); assert.equal(result.symbolDefinitions.some(d => d.name === 'fake'), false);
  const unsupported = analyzeStructure([screen('A', '$"{missing}"')]);
  assert.equal(unsupported.recovery.allowed, false); assert.ok(unsupported.possible.some(d => d.category === 'unsupported_formula'));
  for (const expression of ['1 2', 'Set(v,1,2)', 'Set(v,)', 'Set(1,2)', 'UpdateContext({ctx:1})']) {
    const files = expression.startsWith('UpdateContext') ? [file('App.pa.yaml','App:\n  Properties:\n    OnStart: ='+expression), screen('A','1')] : [screen('A', expression)];
    assert.equal(analyzeStructure(files).recovery.allowed, false, expression);
  }
});

test('empty properties and Back history permit source-only snapshots with recorded exclusions', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-only-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = [screen('A', 'Back(); Bridge.GetTasks()')];
  const { snapshots } = services(files, directory);
  const r = await snapshots.create({ branch, recoveryScope: 'source_files_only' });
  assert.equal(r.status, 'saved'); assert.equal(r.scope, 'source_files_only');
  assert.equal(r.applicationRecovery, 'not_verified'); assert.ok(r.exclusions.includes('history_navigation'));
  await assert.rejects(snapshots.create({ branch, recoveryScope: 'application' }), reason('snapshot_recovery_scope_unsupported'));
  const archive = await snapshots.readVerified(path.join(directory, `${r.snapshotId}.json`), r.snapshotId);
  assert.equal(archive.payload.analysis.before.status, 'incomplete');
  assert.equal(archive.payload.analysis.before.recovery.allowed, true);
});

test('secret literal assignments and missing symbols still block before saving', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'no-secret-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const expression of ['Set(apiKey,"synthetic")', 'UpdateContext({client_secret:"x"})', 'Set(token,"synthetic")']) {
    const { snapshots } = services([screen('A', expression)], directory);
    await assert.rejects(snapshots.create({ branch }), reason('secret_detected'));
    assert.deepEqual(await fs.readdir(directory), []);
  }
  await assert.rejects(services([screen('A','missing.Text')],directory).snapshots.create({ branch }), reason('snapshot_analysis_incomplete'));
});

test('manifest completeness rejects even rehashed archives with incorrect per-file checksums or totals', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { snapshots } = services([screen('A','1')],directory);
  const saved = await snapshots.create({ branch }); const originalPath = path.join(directory, saved.snapshotId+'.json');
  const original = await snapshots.readVerified(originalPath, saved.snapshotId);
  for (const mutate of [e => { e.payload.before[0].sha256='0'.repeat(64); }, e => { e.payload.analysis.after.summary.files++; }, e => { e.payload.after=[]; }]) {
    const copy = JSON.parse(canonical(original)); mutate(copy); copy.snapshotId=sha256(canonical(copy.payload));
    const filePath=path.join(directory,'tamper-proof.json'); await fs.writeFile(filePath,canonical(copy),{mode:0o600});
    await assert.rejects(snapshots.readVerified(filePath,copy.snapshotId),reason('snapshot_tampered'));
  }
  await snapshots.readVerified(originalPath,saved.snapshotId);
});

test('remote source decode preserves UTF-8 BOM for exact byte recovery', async () => {
  const content='\ufeff'+screen('A','1').content; const bytes=Buffer.from(content);
  const hash=crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const store=new PowerAppsGitStore({githubToken:'synthetic',githubOwner:'owner',githubRepo:'repo',githubRoot:'source',githubBranch:branch});
  store._githubRequest=async url=>url.includes('/commits/')?{sha:commitSha}:url.includes('/git/trees/')?{truncated:false,tree:[{path:'source/A.pa.yaml',type:'blob',mode:'100644',size:bytes.length,sha:hash}]}:{sha:hash,encoding:'base64',content:bytes.toString('base64')};
  const bundle=await store.getSourceBundle(branch); assert.deepEqual(Buffer.from(bundle.files[0].content),bytes);
});
