const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp, MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');
const { INSPECTION_TOOLS, validateInspectionParams } = require('../src/powerAppsInspectionValidation');
const { PowerAppsStructureService, analyzeStructure, tokens, canonical } = require('../src/powerAppsStructureService');
const { PowerAppsImpactService } = require('../src/powerAppsImpactService');
const { ChangeSnapshotService } = require('../src/changeSnapshotService');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

const branch = 'feature/add-nine-mcp-tools';
const commitSha = '8b76bac42f695a03c96d9c3760d78efce65a7699';
const file = (relativePath, content) => ({ relativePath, content });
const home = `Screens:
  Home:
    Properties:
      OnVisible: =Navigate(Detail)
    Children:
      - Label1:
          Control: Text@1.0
          Properties:
            Text: ='Detail'.Name
`;
const detail = 'Screens:\n  Detail:\n    Properties:\n      Fill: =RGBA(0,0,0,1)\n';
const files = [file('Home.pa.yaml', home), file('Detail.pa.yaml', detail)];
function services(sourceFiles = files, options = {}) {
  const structure = new PowerAppsStructureService({ canonicalBranch: branch, sourceProvider: async () => ({ branch, commitSha, complete: true, files: sourceFiles }), ...options });
  const impact = new PowerAppsImpactService(structure);
  return { structure, impact };
}
function reason(code) { return error => error.payload?.reason === code; }

test('existing 28 tool names, order and contracts match exact base; append exactly three', () => {
  const legacy = { methods: MCP_METHODS.slice(0, 28), tools: MCP_PUBLIC_TOOLS.slice(0, 28) };
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(legacy)).digest('hex'), '34a6efd1821ea0a3430ac80b221a3874cbe1ced7997c285b675e14d147ec9535');
  assert.equal(MCP_METHODS.length, 31); assert.equal(MCP_PUBLIC_TOOLS.length, 31);
  assert.deepEqual(MCP_METHODS.slice(28), INSPECTION_TOOLS.map(t => t.name));
  assert.deepEqual(MCP_PUBLIC_TOOLS.slice(28), INSPECTION_TOOLS);
});

test('strict runtime schemas reject unknown properties, invalid types, paths, branch and change combinations', () => {
  for (const t of INSPECTION_TOOLS) assert.equal(t.inputSchema.additionalProperties, false);
  const valid = { branch, changes: [file('Home.pa.yaml', home)] };
  assert.equal(validateInspectionParams('analyze_change_impact', valid), null);
  for (const params of [null, [], { branch: null }, { branch, extra: 1 }, { branch: 'bad..ref' }, { branch: ' bad' }, { branch: 'bad/ref.lock' }, { branch: 'a\n' }]) assert.ok(validateInspectionParams('inspect_powerapps_structure', params));
  for (const changes of [[], [file('../Home.pa.yaml', home)], [file('/Home.pa.yaml', home)], [file('Home.pa.yaml', '')], [{ relativePath: 'Home.pa.yaml' }], [{ ...files[0], delete: true }], [{ ...files[0], extra: 1 }], [files[0], files[0]], [{ relativePath: 'Home.pa.yaml', delete: 'true' }]]) assert.ok(validateInspectionParams('analyze_change_impact', { branch, changes }));
  assert.equal(validateInspectionParams('analyze_change_impact', { branch, changes: [{ relativePath: 'Home.pa.yaml', delete: true }] }), null);
});

test('structure records hierarchy, byte/formula counts, source hashes and exact navigation separately from possible', async () => {
  const result = await services().structure.inspect({ branch });
  assert.equal(result.status, 'incomplete'); // Runtime is never certified by static inspection.
  assert.deepEqual(result.summary, { files: 2, bytes: Buffer.byteLength(home + detail), formulas: 3, screens: 2, controls: 1, transitionEdges: 1 });
  assert.equal(result.entities.find(e => e.name === 'Label1').parent, 'Home');
  assert.equal(result.transitions[0].target, 'Detail');
  assert.equal(result.files[0].sha256.length, 64);
  assert.ok(!JSON.stringify(result).includes('RGBA('));
  const dynamic = analyzeStructure([file('Home.pa.yaml', home.replace('Navigate(Detail)', 'Navigate(If(true, Detail, Home)); Back()')) , files[1]]);
  assert.equal(dynamic.transitions.length, 0);
  assert.ok(dynamic.possible.some(r => r.reason === 'dynamic_navigation'));
  assert.ok(dynamic.possible.some(r => r.reason === 'history_navigation'));
});

test('lexer excludes string/comment false positives and retains escaped quoted Unicode identifiers', () => {
  const ts = tokens(`="Navigate(Missing)" /* Label1.Text */ + '画面''名'.Text // Navigate(Other)\n`);
  assert.deepEqual(ts.filter(t => t.kind === 'id').map(t => t.value), ["画面'名", 'Text']);
  const r = analyzeStructure([file('Home.pa.yaml', home.replace('=Navigate(Detail)', '=Notify("Navigate(Missing)") // Navigate(Unknown)')), files[1]]);
  assert.equal(r.issues.length, 0); assert.equal(r.transitions.length, 0);
});

test('Power Fx case-insensitivity, unset export properties, scope shadowing and unknown symbols stay conservative', () => {
  const lower = analyzeStructure([file('Home.pa.yaml', home.replace('Navigate(Detail)', 'navigate(detail)')), files[1]]);
  assert.equal(lower.transitions[0].target, 'Detail');
  const scoped = analyzeStructure([file('Home.pa.yaml', home.replace('Navigate(Detail)', 'With({Detail:Home}, Navigate(Detail))')), files[1]]);
  assert.equal(scoped.transitions.length, 0); assert.ok(scoped.possible.some(p => p.reason === 'dynamic_navigation'));
  for (const expression of ['=', '=unknownVariable', '=UnverifiedFunction()']) {
    const r = analyzeStructure([file('Home.pa.yaml', home.replace('=Navigate(Detail)', expression)), files[1]]);
    assert.equal(r.status, 'incomplete'); assert.ok(r.possible.length);
  }
  const invalid = analyzeStructure([file('Home.pa.yaml', home.replace('=Navigate(Detail)', '=1+')), files[1]]);
  assert.equal(invalid.status, 'blocked');
});

test('branch mismatch and nonauthoritative/partial bundles stop before analysis', async () => {
  let calls = 0;
  const { structure } = services(files, { sourceProvider: async () => { calls++; return {}; } });
  await assert.rejects(structure.inspect({ branch: 'main' }), reason('branch_mismatch')); assert.equal(calls, 0);
  for (const invalid of [{ branch: 'main', complete: true, commitSha, files }, { branch, complete: false, commitSha, files }, { branch, complete: true, commitSha: 'missing', files }]) {
    await assert.rejects(services(files, { sourceProvider: async () => invalid }).structure.inspect({ branch }), reason('source_identity_or_completeness'));
  }
  const error = new Error('credential-bearing upstream response');
  await assert.rejects(services(files, { sourceProvider: async () => { throw error; } }).structure.inspect({ branch }), e => e.status === 502 && !e.message.includes('credential-bearing'));
});

test('broken navigation is blocked, unparsable sources/cycles/duplicate definitions are not successful', () => {
  const r = analyzeStructure([file('Home.pa.yaml', home.replace('Navigate(Detail)', 'Navigate(Missing)')), files[1]]);
  assert.equal(r.status, 'blocked'); assert.equal(r.issues[0].reason, 'dangling_screen');
  assert.throws(() => analyzeStructure([file('Home.pa.yaml', 'Screens: [')]), reason('source_parse_failed'));
  assert.throws(() => analyzeStructure([file('Home.pa.yaml', 'x: &x\n  child: *x\n')]), reason('source_alias_cycle'));
  assert.throws(() => analyzeStructure([...files, file('Again.pa.yaml', detail)]), reason('duplicate_definition'));
  assert.throws(() => analyzeStructure([]), reason('source_missing_or_limit'));
  const broken = analyzeStructure([file('Home.pa.yaml', home.replace('=Navigate(Detail)', '=Navigate(Detail')), files[1]]);
  assert.equal(broken.status, 'blocked'); assert.ok(broken.issues.some(i => i.reason === 'formula_unparsable'));
});

test('likely tokens and configured arbitrary secret values are rejected without echoing source', async () => {
  const synthetic = 'ghp_' + 'x'.repeat(30);
  assert.throws(() => analyzeStructure([file('Home.pa.yaml', home + '# ' + synthetic)]), e => e.payload.reason === 'secret_detected' && !e.message.includes(synthetic));
  const custom = 'configured-private-fixture';
  await assert.rejects(services([file('Home.pa.yaml', home + '# ' + custom)], { secrets: [custom] }).structure.inspect({ branch }), reason('secret_detected'));
  assert.throws(() => analyzeStructure([file('Home.pa.yaml', home + '\n# client_secret="syntheticfixture"')]), reason('secret_detected'));
});

test('impact analyzes whole app, identifies changed definitions and inbound dependencies, rejects missing targets', async () => {
  const { impact } = services();
  const r = await impact.analyze({ branch, changes: [file('Detail.pa.yaml', detail.replace('RGBA(0,0,0,1)', 'RGBA(1,1,1,1)'))] });
  assert.ok(r.confirmed.some(x => x.kind === 'direct_dependency' && x.owner === 'Home' && x.target === 'Detail'));
  assert.equal(r.status, 'incomplete'); assert.equal(r.after.screens, 2);
  await assert.rejects(impact.analyze({ branch, changes: [file('Missing.pa.yaml', detail)] }), reason('target_not_found'));
  const broken = await impact.analyze({ branch, changes: [{ relativePath: 'Detail.pa.yaml', delete: true }] });
  assert.equal(broken.status, 'blocked'); assert.ok(broken.issues.some(i => i.reason === 'dangling_screen'));
});

test('deleted controls formerly referenced by property or function become dangling references', async () => {
  const referencing = home.replace("='Detail'.Name", '=Label1.Text');
  const { impact } = services([file('Home.pa.yaml', referencing), files[1], file('Ref.pa.yaml', 'Screens:\n  Ref:\n    Properties:\n      OnVisible: =Reset(Label1)\n')]);
  const changed = referencing.slice(0, referencing.indexOf('    Children:'));
  const r = await impact.analyze({ branch, changes: [file('Home.pa.yaml', changed)] });
  assert.equal(r.status, 'blocked'); assert.ok(r.issues.some(i => i.reason === 'dangling_entity' && i.target === 'Label1'));
});

async function snapshots(t, sourceFiles = files, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inspection-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { structure, impact } = services(sourceFiles);
  return { directory, snapshot: new ChangeSnapshotService({ structureService: structure, impactService: impact, directory, ...extra }) };
}
test('snapshot SHA-256 matches canonical payload, atomic concurrent writes are idempotent and files are private', async t => {
  const { directory, snapshot } = await snapshots(t);
  snapshot.directory = path.join(directory, 'new', 'snapshots');
  const r = await Promise.all(Array.from({ length: 6 }, () => snapshot.create({ branch })));
  assert.equal(new Set(r.map(x => x.snapshotId)).size, 1);
  const again = await snapshot.create({ branch }); assert.equal(again.reused, true);
  const entries = await fs.readdir(snapshot.directory); assert.deepEqual(entries, [`${again.snapshotId}.json`]);
  const text = await fs.readFile(path.join(snapshot.directory, entries[0]), 'utf8');
  const envelope = JSON.parse(text);
  assert.equal(crypto.createHash('sha256').update(canonical(envelope.payload)).digest('hex'), again.snapshotId);
  assert.equal((await fs.stat(path.join(snapshot.directory, entries[0]))).mode & 0o777, 0o600);
  assert.equal(again.runtimeVerified, false);
  const changed = await snapshot.create({ branch, changes: [file('Detail.pa.yaml', detail.replace('0,0,0,1', '1,1,1,1'))] });
  assert.notEqual(changed.snapshotId, again.snapshotId);
});

test('snapshot detects source and envelope tampering and never overwrites evidence', async t => {
  for (const mutate of [e => { e.payload.before[0].content += '#tamper'; }, e => { e.algorithm = 'MD5'; }, e => { e.extra = 1; }]) {
    const { directory, snapshot } = await snapshots(t);
    const r = await snapshot.create({ branch }); const filePath = path.join(directory, `${r.snapshotId}.json`);
    const e = JSON.parse(await fs.readFile(filePath, 'utf8')); mutate(e); const tampered = canonical(e); await fs.writeFile(filePath, tampered);
    await assert.rejects(snapshot.create({ branch }), reason('snapshot_tampered'));
    assert.equal(await fs.readFile(filePath, 'utf8'), tampered);
  }
});

test('unsafe, nonignored, unconfigured paths and unresolved analyses do not create snapshots', async t => {
  const { directory, snapshot } = await snapshots(t);
  const destination = path.join(directory, 'linked'); await fs.symlink(directory, destination);
  snapshot.directory = destination; await assert.rejects(snapshot.create({ branch }), reason('snapshot_path_unsafe'));
  snapshot.directory = undefined; await assert.rejects(snapshot.create({ branch }), e => e.payload.status === 'not_configured');
  const unresolved = await snapshots(t, [file('Home.pa.yaml', home.replace('Navigate(Detail)', 'Back()')), files[1]]);
  await assert.rejects(unresolved.snapshot.create({ branch }), reason('snapshot_analysis_incomplete'));
  assert.deepEqual(await fs.readdir(unresolved.directory), []);
  const notIgnored = await fs.mkdtemp(path.join(process.cwd(), 'snapshot-test-local-'));
  t.after(() => fs.rm(notIgnored, { recursive: true, force: true }));
  snapshot.directory = notIgnored; await assert.rejects(snapshot.create({ branch }), reason('snapshot_not_git_ignored'));
});

function gitBlob(content) { return crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'); }
test('Git source bundle pins one commit, verifies blobs and rejects truncation or unsupported entries', async () => {
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    if (url.includes('/commits/')) return { ok: true, json: async () => ({ sha: commitSha }) };
    if (url.includes('/git/trees/')) return { ok: true, json: async () => ({ truncated: false, tree: files.map(f => ({ path: 'source/' + f.relativePath, type: 'blob', mode: '100644', size: Buffer.byteLength(f.content), sha: gitBlob(f.content) })) }) };
    const f = files.find(f => url.endsWith(gitBlob(f.content)));
    return { ok: true, json: async () => ({ sha: gitBlob(f.content), encoding: 'base64', content: Buffer.from(f.content).toString('base64') }) };
  };
  const store = new PowerAppsGitStore({ githubToken: 'synthetic', githubOwner: 'owner', githubRepo: 'repo', githubBranch: branch, githubRoot: 'source', fetchImpl });
  const bundle = await store.getSourceBundle(branch);
  assert.equal(bundle.complete, true); assert.equal(bundle.commitSha, commitSha); assert.deepEqual(bundle.files.map(f => f.relativePath).sort(), files.map(f => f.relativePath).sort());
  assert.ok(requests.find(u => u.includes(`/git/trees/${commitSha}`)));
  assert.ok(requests.every(u => !u.includes('main')));
  await assert.rejects(store.getSourceBundle('main'), e => e.status === 409);
  store._fetch = async url => ({ ok: true, json: async () => url.includes('/commits/') ? { sha: commitSha } : { truncated: true, tree: [] } });
  await assert.rejects(store.getSourceBundle(branch), e => e.status === 502);
  store._fetch = async url => {
    if (url.includes('/git/blobs/')) return { ok: true, json: async () => ({ sha: gitBlob(home), encoding: 'base64', content: Buffer.from('tampered').toString('base64') }) };
    return fetchImpl(url);
  };
  await assert.rejects(store.getSourceBundle(branch), e => e.status === 502);
  for (const entry of [{ path: 'source/Home.pa.yaml', type: 'blob', mode: '120000', size: 1, sha: gitBlob('x') }, { path: 'source/other.txt', type: 'blob', mode: '100644', size: 1, sha: gitBlob('x') }]) {
    store._fetch = async url => ({ ok: true, json: async () => url.includes('/commits/') ? { sha: commitSha } : { truncated: false, tree: [entry] } });
    await assert.rejects(store.getSourceBundle(branch), e => e.status === 422);
  }
  await assert.rejects(new PowerAppsGitStore({ githubBranch: branch }).getSourceBundle(branch), e => e.payload.status === 'not_configured');
});

test('new OpenAPI params schemas are identical to tool discovery and runtime schema source', async () => {
  const yaml = require('js-yaml');
  const doc = yaml.load(await fs.readFile(path.join(__dirname, '..', 'openapi.yaml'), 'utf8'));
  for (const [i, name] of ['InspectPowerAppsStructureParams', 'AnalyzeChangeImpactParams', 'CreateChangeSnapshotParams'].entries()) assert.deepEqual(doc.components.schemas[name], INSPECTION_TOOLS[i].inputSchema);
  for (const name of MCP_METHODS) assert.ok(doc.components.schemas.McpInput.properties.method.enum.includes(name));
});

test('JSON-RPC and legacy dispatch new tools with error/incomplete status without changing old contracts', async t => {
  const { directory, snapshot } = await snapshots(t);
  const { structure, impact } = services();
  const app = createApp({ corsOrigins: [], tasksFile: path.join(directory, 'tasks.json'), powerApps: { githubBranch: branch }, sharepoint: {}, powerAutomate: {} }, undefined, undefined, undefined, undefined, undefined, undefined, { structure, impact, snapshots: snapshot });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = body => fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const tool of INSPECTION_TOOLS) {
    const params = tool.name === 'analyze_change_impact' ? { branch, changes: [files[1]] } : { branch };
    const legacy = await post({ method: tool.name, params }); assert.equal(legacy.status, 200); assert.equal((await legacy.json()).accepted, true);
    const rpc = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool.name, arguments: params } });
    const body = await rpc.json(); assert.equal(body.result.isError, tool.name !== 'create_change_snapshot');
    const invalid = await post({ method: tool.name, params: { ...params, unexpected: true } }); assert.equal(invalid.status, 400);
    const mismatched = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool.name, arguments: { ...params, branch: 'main' } } });
    assert.equal((await mismatched.json()).result.isError, true);
  }
});
