const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverPowerAppsStructure, resolveAppTargetById, resolveSourceRoot, validateDiscoveryParams, parseManifest } = require('../src/powerAppsDiscovery');

const APP_ID = '11111111-2222-3333-4444-555555555555';
const ENV_ID = '4d0aab59-43ec-ecf1-a9d1-869f2517adbb';
const ROOT = 'powerapps/CN_AI依頼台帳/Source';

const S1 = `Screens:
  S1_Home:
    Properties:
      OnVisible: =Set(a, 1)
    Children:
      - Btn1:
          Control: Classic/Button@2.2.0
          Properties:
            OnSelect: =Navigate(S2_Calendar, ScreenTransition.None)
      - Btn2:
          Control: Classic/Button@2.2.0
          Properties:
            OnSelect: =Navigate(S9_Missing, ScreenTransition.None)
`;
const S2 = `Screens:
  S2_Calendar:
    Properties:
      OnVisible: =Set(b, 2)
    Children:
      - Btn3:
          Control: Classic/Button@2.2.0
          Properties:
            OnSelect: =Navigate(S1_Home, ScreenTransition.None)
`;
const S5 = `Screens:
  S5_Salary:
    Properties:
      OnVisible: =Set(c, 3)
`;

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function makeGithub(files, calls = []) {
  return async (path) => {
    calls.push(path);
    if (path.includes('/contents/') && !path.includes('.pa.yaml')) {
      return Object.keys(files).map(name => ({ type: 'file', name }));
    }
    const name = decodeURIComponent(path.split('/').pop().split('?')[0]);
    if (!(name in files)) throw new Error('GitHub API エラー (404): not found');
    return { type: 'file', content: b64(files[name]) };
  };
}

function appInfo(displayName) {
  return async ({ appId, environmentId }) => ({ appId, environmentId, displayName, publisher: 'x' });
}

test('validateDiscoveryParams requires appId GUID and environmentId', () => {
  assert.deepEqual(validateDiscoveryParams({ appId: APP_ID, environmentId: ENV_ID }), []);
  assert.equal(validateDiscoveryParams({ appId: 'bad', environmentId: ENV_ID }).length, 1);
  assert.equal(validateDiscoveryParams({ appId: APP_ID }).length, 1);
});

test('resolveSourceRoot resolves only registered apps and never guesses', () => {
  assert.equal(resolveSourceRoot('CN_AI依頼台帳').gitRoot, ROOT);
  assert.equal(resolveSourceRoot('解体工カレンダー').gitRoot, ROOT);
  assert.equal(resolveSourceRoot('CN_AI依頼台帳_ほか'), null);
  assert.equal(resolveSourceRoot('未登録アプリ'), null);
});

test('discovers screens, navigation edges, missing targets and unreferenced screens (read-only)', async () => {
  const calls = [];
  const files = { 'S1_Home.pa.yaml': S1, 'S2_Calendar.pa.yaml': S2, 'S5_Salary.pa.yaml': S5, 'App.pa.yaml': 'App:\n' };
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('CN_AI依頼台帳'),
    githubRequest: makeGithub(files, calls),
    owner: 'oohiraplas-cpu', repo: 'clean-nano-ai-bridge', branch: 'main'
  });
  const s = result.data.structure;
  assert.equal(result.status, 'ok');
  assert.equal(result.verified, true);
  assert.equal(s.sourceRoot, ROOT);
  assert.equal(s.hasManifest, true);
  assert.deepEqual(s.screens.list.map(x => x.name).sort(), ['S1_Home', 'S2_Calendar', 'S5_Salary']);
  assert.deepEqual(s.missingTargets, [{ name: 'S9_Missing', referencedFrom: ['S1_Home'] }]);
  assert.deepEqual(s.unreferencedScreens, ['S5_Salary']);
  assert.ok(s.navigationMap.edges.some(e => e.from === 'S1_Home' && e.to === 'S2_Calendar'));
  assert.ok(s.navigationMap.edges.some(e => e.from === 'S2_Calendar' && e.to === 'S1_Home'));
  assert.ok(s.controls.byScreen.S1_Home.length > 0);
  // すべてGET相当（pathのみ渡す。書込みオプションは使わない）
  assert.ok(calls.every(p => typeof p === 'string' && p.startsWith('/repos/')));
});

test('unregistered app name: no source listing is attempted, reported as unconfirmed', async () => {
  const calls = [];
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('未登録アプリ'),
    githubRequest: makeGithub({}, calls),
    owner: 'o', repo: 'r', branch: 'main'
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.verified, false);
  assert.equal(calls.length, 0);
  assert.match(result.unconfirmed[0], /未登録/);
});

test('appId/environmentId are not compared with any configured single app', async () => {
  // 別のApp/Environmentを指定しても、固定値との比較で弾かれないこと（単一アプリ前提の廃止）
  const otherApp = '99999999-8888-7777-6666-555555555555';
  const result = await discoverPowerAppsStructure({
    appId: otherApp, environmentId: 'Default-aa0b99c9-b756-4611-970a-6c31013c42e3',
    getAppInfo: appInfo('CN_AI依頼台帳'),
    githubRequest: makeGithub({ 'S1_Home.pa.yaml': S1 }),
    owner: 'o', repo: 'r', branch: 'main'
  });
  assert.equal(result.data.structure.appId, otherApp);
  assert.equal(result.errors.length, 0);
});

test('management lookup failure is an error, not a success', async () => {
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: async () => { throw new Error('403 forbidden'); },
    githubRequest: makeGithub({}),
    owner: 'o', repo: 'r', branch: 'main'
  });
  assert.equal(result.status, 'error');
  assert.equal(result.verified, false);
});

test('unparseable source is reported as unconfirmed and not counted as verified', async () => {
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('CN_AI依頼台帳'),
    githubRequest: makeGithub({ 'S1_Home.pa.yaml': S1, 'Bad.pa.yaml': 'not: [valid' }),
    owner: 'o', repo: 'r', branch: 'main'
  });
  assert.equal(result.verified, false);
  assert.ok(result.unconfirmed.some(m => m.startsWith('Bad.pa.yaml')));
});

test('invalid input returns error without any upstream call', async () => {
  let called = false;
  const result = await discoverPowerAppsStructure({
    appId: 'nope', environmentId: '',
    getAppInfo: async () => { called = true; return {}; },
    githubRequest: async () => { called = true; return []; }
  });
  assert.equal(result.status, 'error');
  assert.equal(called, false);
});

const APP_YAML = `App:
  Properties:
    OnStart: =Set(gblBoot, true); Navigate(S1_Home, ScreenTransition.None)
    StartScreen: =S1_Home
`;

test('resolveAppTargetById resolves a registered app from App ID + Environment ID', async () => {
  const result = await resolveAppTargetById({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('CN_AI依頼台帳'),
    canonicalBranch: 'main'
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.verified, true);
  assert.equal(result.data.gitRoot, ROOT);
  assert.equal(result.data.canonicalBranch, 'main');
  assert.equal(result.data.displayName, 'CN_AI依頼台帳');
});

test('resolveAppTargetById: unregistered app is partial and unconfirmed, never guessed', async () => {
  const result = await resolveAppTargetById({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('未登録アプリ'), canonicalBranch: 'main'
  });
  assert.equal(result.status, 'partial');
  assert.equal(result.verified, false);
  assert.equal(result.data.gitRoot, null);
  assert.match(result.unconfirmed[0], /未登録/);
});

test('resolveAppTargetById: invalid input and management failure are errors', async () => {
  const bad = await resolveAppTargetById({ appId: 'x', environmentId: '', getAppInfo: async () => ({}) });
  assert.equal(bad.status, 'error');
  const failed = await resolveAppTargetById({ appId: APP_ID, environmentId: ENV_ID, getAppInfo: async () => { throw new Error('boom'); } });
  assert.equal(failed.status, 'error');
  assert.equal(failed.verified, false);
});

test('parseManifest extracts startup navigation and start screen from App.pa.yaml', () => {
  const m = parseManifest(APP_YAML);
  assert.equal(m.startScreen, 'S1_Home');
  assert.equal(m.hasOnStart, true);
  assert.deepEqual(m.navigations, [{ from: 'App', to: 'S1_Home', property: 'OnStart' }]);
});

test('parseManifest rejects a file without an App section', () => {
  assert.throws(() => parseManifest('Screens:\n  S1:\n    Properties: {}\n'));
});

test('discovery includes manifest navigation and flags a missing startup target', async () => {
  const manifestWithMissing = `App:
  Properties:
    OnStart: =Navigate(S0_Gone, ScreenTransition.None)
`;
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('CN_AI依頼台帳'),
    githubRequest: makeGithub({ 'S1_Home.pa.yaml': S1, 'S2_Calendar.pa.yaml': S2, 'App.pa.yaml': manifestWithMissing }),
    owner: 'o', repo: 'r', branch: 'main'
  });
  const s = result.data.structure;
  assert.equal(s.manifest.navigations[0].to, 'S0_Gone');
  assert.ok(s.missingTargets.some(t => t.name === 'S0_Gone' && t.referencedFrom.includes('App')));
  assert.ok(s.navigationMap.edges.some(e => e.from === 'App' && e.to === 'S0_Gone'));
});

test('discovery reports an unparseable manifest as unconfirmed without failing screens', async () => {
  const result = await discoverPowerAppsStructure({
    appId: APP_ID, environmentId: ENV_ID,
    getAppInfo: appInfo('CN_AI依頼台帳'),
    githubRequest: makeGithub({ 'S1_Home.pa.yaml': S1, 'App.pa.yaml': 'Screens: {}\n' }),
    owner: 'o', repo: 'r', branch: 'main'
  });
  assert.equal(result.data.structure.screens.count, 1);
  assert.ok(result.unconfirmed.some(m => m.startsWith('App.pa.yaml')));
});
