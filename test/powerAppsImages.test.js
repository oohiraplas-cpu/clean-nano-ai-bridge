const test = require('node:test');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');
const { editImageSource, imageDataUri } = require('../src/powerAppsImages');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');
const { blobSha } = require('../src/stateContext');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAt8AAAAASUVORK5CYII=';
const SOURCE = '# keep comment\nScreens:\n  Home:\n    Properties:\n      Fill: =Color.White\n    Children:\n      - Title:\n          Control: Label@2.5.1\n          Properties:\n            Text: ="Keep me"\n';
const PARAMS = { operation: 'add', relativePath: 'Home.pa.yaml', screenName: 'Home', controlName: 'Logo', base64Content: PNG, contentType: 'image/png' };

test('adds a data URI image and edits layout/image while preserving other source lines', () => {
  const added = editImageSource(SOURCE, { ...PARAMS, properties: { Width: 200, AccessibleLabel: 'A "logo"' } });
  assert.ok(added.startsWith('# keep comment\n'));
  assert.ok(added.endsWith('            Text: ="Keep me"\n'));
  const logo = yaml.load(added).Screens.Home.Children[0].Logo;
  assert.equal(logo.Properties.Image, `="data:image/png;base64,${PNG}"`);
  assert.equal(logo.Properties.AccessibleLabel, '="A ""logo"""');
  const edited = editImageSource(added, { ...PARAMS, operation: 'edit', properties: { X: 42, Height: 75, ImagePosition: 'Fill' } });
  const result = yaml.load(edited).Screens.Home.Children[0].Logo;
  assert.equal(result.Properties.X, '=42');
  assert.equal(result.Properties.Height, '=75');
  assert.equal(result.Properties.ImagePosition, '=ImagePosition.Fill');
  assert.equal(edited.match(/- Logo:/g).length, 1);
});

test('can add to empty screen, rejects duplicates, non-image edits and invalid image inputs', () => {
  assert.ok(yaml.load(editImageSource('Screens:\n  Home:\n    Properties:\n      Fill: =Color.White\n', PARAMS)).Screens.Home.Children[0].Logo);
  assert.throws(() => editImageSource(editImageSource(SOURCE, PARAMS), PARAMS), /同名/);
  assert.throws(() => editImageSource(SOURCE, { ...PARAMS, operation: 'edit', controlName: 'Title' }), /Image/);
  assert.throws(() => imageDataUri(PNG, 'image/jpeg'), /一致/);
  assert.throws(() => imageDataUri('Zm9v', 'image/png'), /一致/);
  assert.throws(() => imageDataUri('not base64', 'image/png'), /Base64/);
  assert.throws(() => imageDataUri('A'.repeat(1500000), 'image/png'), /1MiB/);
  assert.throws(() => editImageSource(SOURCE, { ...PARAMS, properties: { OnSelect: '=Launch("x")' } }), /未対応/);
  assert.throws(() => editImageSource(SOURCE, { ...PARAMS, properties: { Height: 0 } }), /不正/);
});

test('edits nested image controls and preserves CRLF and adjacent screens', () => {
  const source = 'Screens:\r\n  Home:\r\n    Children:\r\n      - Group:\r\n          Control: GroupContainer@1.3.0\r\n          Children:\r\n            - Logo:\r\n                Control: Image@2.2.3\r\n                Properties:\r\n                  Image: =OldLogo\r\n                  Width: =100\r\n      - Label:\r\n          Control: Label@2.5.1\r\n          Properties:\r\n            Text: ="unchanged"\r\n  Other:\r\n    Properties:\r\n      Fill: =Color.Black\r\n';
  const result = editImageSource(source, { ...PARAMS, operation: 'edit', properties: { Height: 70 } });
  assert.equal(yaml.load(result).Screens.Home.Children[0].Group.Children[0].Logo.Properties.Height, '=70');
  assert.ok(result.endsWith('  Other:\r\n    Properties:\r\n      Fill: =Color.Black\r\n'));
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
});

test('binary media export stays Base64 and import creates new canonical files without double encoding', async () => {
  let content;
  const store = new PowerAppsGitStore({ githubToken: 'token', githubOwner: 'owner', githubRepo: 'repo', githubBranch: 'main', githubRoot: 'app/Source', fetchImpl: async (url, options = {}) => {
    if (options.method === 'PUT') {
      content = JSON.parse(options.body);
      assert.ok(url.endsWith('/app/Source/Assets/logo.png'));
      return Response.json({ commit: { sha: 'commit' } });
    }
    if (!content) return new Response('missing', { status: 404 });
    return Response.json({ type: 'file', sha: 'blob', encoding: 'base64', size: Buffer.from(PNG, 'base64').length, content: PNG });
  } });
  const imported = await store.powerAppsMediaAsset({ operation: 'import', relativePath: 'Assets/logo.png', base64Content: PNG, contentType: 'image/png', expectedBranch: 'main', message: 'add logo', approvedByHuman: true });
  assert.equal(imported.status, 'ok');
  assert.equal(content.content, PNG);
  assert.equal(content.branch, 'main');
  assert.equal(Object.hasOwn(content, 'sha'), false);
  const exported = await store.powerAppsMediaAsset({ operation: 'export', relativePath: 'Assets/logo.png' });
  assert.equal(exported.base64Content, PNG);
  assert.equal(exported.size, Buffer.from(PNG, 'base64').length);
  assert.equal((await store.powerAppsMediaAsset({ operation: 'import', relativePath: 'Assets/logo.png', base64Content: PNG, contentType: 'image/png', expectedBranch: 'main', message: 'overwrite', approvedByHuman: true })).error, 'MEDIA_ASSET_ALREADY_EXISTS');
  await assert.rejects(store.powerAppsMediaAsset({ operation: 'import', relativePath: 'Assets/new.png', base64Content: PNG, contentType: 'image/png', expectedBranch: 'old', message: 'wrong branch', approvedByHuman: true }), /branch/);
});

test('media list rejects directory candidates without treating them as corrupt image files', async () => {
  let reads = 0;
  const store = new PowerAppsGitStore({
    githubToken: 'token', githubOwner: 'owner', githubRepo: 'repo',
    githubBranch: 'main', githubRoot: 'app/Source',
    fetchImpl: async () => { reads++; throw new Error('directory must not be fetched'); }
  });
  const result = await store.powerAppsMediaAsset({
    operation: 'list', relativePaths: ['Assets']
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.assets[0].status, 'blocked');
  assert.equal(result.assets[0].error, 'UNSUPPORTED_MEDIA_TYPE');
  assert.equal(reads, 0);
});

test('MCP image editing requires a registered source session, rejects drift, and verifies Git without claiming publication', async t => {
  let content = SOURCE, commit = 'a'.repeat(40), writes = 0;
  const config = getConfig({});
  config.enforceStateManager = false; // Image writes stay fail-closed even in legacy mode.
  const gitStore = {
    canonicalBranch: 'main',
    assertCanonicalBranch(branch) { assert.equal(branch, 'main'); },
    getSourceFileMetadata: async () => ({ branch: 'main', canonicalBranch: 'main', sha: commit }),
    getSourceFile: async () => ({ status: 'ok', path: 'app/Home.pa.yaml', content, sha: blobSha(content), branch: 'main', canonicalBranch: 'main', writable: true }),
    applySourceFileChange: async (path, next, message, branch, expectedSha) => {
      assert.equal(expectedSha, blobSha(content));
      content = next; commit = 'b'.repeat(40); writes++;
      return { status: 'ok', sync: { status: 'skipped' } };
    }
  };
  const appStore = { getAppState: async () => ({ appId: 'app-id', environmentId: 'env-id' }) };
  const app = createApp(config, {}, appStore, gitStore, {}, {}, {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  async function call(name, args, session = 'image-session') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await response.json()).result;
  }
  const params = { ...PARAMS, branch: 'main' };
  assert.equal((await call('update_powerapps_image', params)).isError, true);
  assert.equal(writes, 0);
  const state = (await call('get_powerapps_state', {})).structuredContent;
  const source = (await call('get_powerapps_source', { relativePath: 'Home.pa.yaml', correlationId: state.correlationId, stateSessionId: state.stateSessionId })).structuredContent;
  const bound = { ...params, relativePath: source.path, stateContext: source.stateContext, stateSessionId: source.stateSessionId };
  assert.equal((await call('update_powerapps_image', bound, 'other-session')).isError, true);
  commit = 'c'.repeat(40);
  assert.equal((await call('update_powerapps_image', bound)).isError, true);
  assert.equal(writes, 0);
  commit = 'a'.repeat(40);
  // Image bytes are checked before applySourceFileChange. The legacy parser
  // accepts a JPEG signature; the draft gate must refuse it without a decoder.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  const unsafe = { ...bound, base64Content: jpeg, contentType: 'image/jpeg' };
  assert.equal((await call('update_powerapps_image', unsafe)).isError, true);
  assert.equal(writes, 0);
  const mismatched = { ...bound, contentType: 'image/jpeg' };
  assert.equal((await call('update_powerapps_image', mismatched)).isError, true);
  assert.equal(writes, 0);
  const result = await call('update_powerapps_image', bound);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.structuredContent.gitVerified, true);
  assert.equal(result.structuredContent.saved, false);
  assert.equal(result.structuredContent.published, false);
  assert.equal(writes, 1);
  assert.equal((await call('update_powerapps_image', bound)).isError, true);
});
