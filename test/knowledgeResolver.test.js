const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AppTargetResolver } = require('../src/bridgeKnowledgeExtraction');

const APP_ID = '11111111-2222-3333-4444-555555555555';
const ENV_ID = 'env-test-0001';

function makeStores({ apps, dataverseFails = false, infoFails = false, envFails = false, existingPaths = {}, branches = ['main', 'sync/x'], canonical = 'main' } = {}) {
  const calls = [];
  const store = {
    environmentId: ENV_ID,
    async dataverseRequest(p) {
      calls.push(['dataverse', p]);
      if (dataverseFails) throw new Error('403 forbidden');
      return { value: apps ?? [{ canvasappid: APP_ID, displayname: 'CN_AI依頼台帳', status: 'Ready', lastpublishtime: '2026-09-23T00:00:00Z' }] };
    },
    async getAppInfo() {
      if (infoFails) throw new Error('config missing');
      return { appId: APP_ID, displayName: 'CN_AI依頼台帳', environmentId: ENV_ID };
    },
    async listEnvironments() {
      if (envFails) throw new Error('403 admin only');
      return [{ environmentId: ENV_ID, displayName: 'Test Env', type: 'Production' }];
    }
  };
  const git = {
    githubOwner: 'o', githubRepo: 'r', canonicalBranch: canonical,
    githubFallbackBranches: ['sync/x', 'main'],
    async githubRequest(p) {
      calls.push(['github', p]);
      if (p.includes('/branches')) return branches.map((name) => ({ name }));
      const m = p.match(/contents\/(.+)\?ref=(.+)$/);
      const key = `${decodeURIComponent(m[2])}::${decodeURIComponent(m[1])}`;
      if (existingPaths[key]) return [];
      throw new Error('GitHub API エラー (404): Not Found');
    }
  };
  return { store, git, calls };
}
const ROOT = 'powerapps/CN_AI依頼台帳/Source';

test('正式名で解決: appId/environment/branch/gitRootが揃い、ok・verified', async () => {
  const { store, git } = makeStores({ existingPaths: { [`main::${ROOT}`]: true } });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('CN_AI依頼台帳');
  assert.equal(r.status, 'ok');
  assert.equal(r.verified, true);
  assert.equal(r.data.appId, APP_ID);
  assert.equal(r.data.environmentId, ENV_ID);
  assert.equal(r.data.gitBranch, 'main');
  assert.equal(r.data.gitRoot, ROOT);
  assert.equal(r.data.rules.publishApprover.name, '野口英光');
  assert.equal(r.approvalRequired, true);
});

test('別名・全角半角・大小文字の揺れでも解決（解体工カレンダー→CN_AI依頼台帳）', async () => {
  const { store, git } = makeStores({ existingPaths: { [`main::${ROOT}`]: true } });
  const resolver = new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git });
  for (const q of ['解体工カレンダー', 'ＣＮ＿ＡＩ依頼台帳', 'cn_ai依頼台帳', '依頼台帳']) {
    const r = await resolver.resolve(q);
    assert.equal(r.data.appId, APP_ID, q);
  }
});

test('正本Branchにgitrootが無い場合は ok にせず partial、他Branchの存在を警告で示す', async () => {
  const { store, git } = makeStores({ existingPaths: { [`sync/x::${ROOT}`]: true } });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('CN_AI依頼台帳');
  assert.equal(r.status, 'partial');
  assert.equal(r.verified, false);
  assert.equal(r.data.sourceOnCanonicalBranch, false);
  assert.deepEqual(r.data.sourceFoundOnOtherBranches, ['sync/x']);
  assert.ok(r.warnings.some((w) => w.includes('正本Branch')));
});

test('存在しないアプリは not_found（候補一覧つき・IDを捏造しない）', async () => {
  const { store, git } = makeStores();
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('存在しない帳簿');
  assert.equal(r.status, 'not_found');
  assert.equal(r.data.appId, undefined);
  assert.deepEqual(r.data.availableApps, ['CN_AI依頼台帳']);
});

test('複数該当は ambiguous（候補を返し勝手に選ばない）', async () => {
  const apps = [
    { canvasappid: 'a-1', displayname: 'CN_電子日報_完成版' },
    { canvasappid: 'a-2', displayname: 'CN_CompanyOS_電子日報_スマホ_v1' }
  ];
  const { store, git } = makeStores({ apps });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('電子日報');
  assert.equal(r.status, 'ambiguous');
  assert.equal(r.data.candidates.length, 2);
});

test('一覧取得に失敗しても構成済みアプリで解決し、一覧は未確認と明示', async () => {
  const { store, git } = makeStores({ dataverseFails: true, existingPaths: { [`main::${ROOT}`]: true } });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('CN_AI依頼台帳');
  assert.equal(r.data.appId, APP_ID);
  assert.ok(r.warnings.some((w) => w.includes('一覧は未確認')));
});

test('一覧も構成済みアプリも取得不能なら unavailable（存在しないとは断定しない）', async () => {
  const { store, git } = makeStores({ dataverseFails: true, infoFails: true });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).resolve('CN_AI依頼台帳');
  assert.equal(r.status, 'unavailable');
  assert.ok(r.unconfirmed.length > 0);
});

test('Environment一覧が権限不足なら構成値のみ・verified=false（名称を捏造しない）', async () => {
  const { store, git } = makeStores({ envFails: true });
  const e = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).listEnvironments();
  assert.equal(e.verified, false);
  assert.equal(e.source, 'config');
  assert.equal(e.environments[0].displayName, null);
});

test('Branch一覧はGitHub取得値のみ。正本Branchが無ければ警告', async () => {
  const { store, git } = makeStores({ branches: ['sync/x'], canonical: 'main' });
  const b = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).listBranches();
  assert.deepEqual(b.branches, ['sync/x']);
  assert.ok(b.warnings.length === 1);
});

test('Knowledgeスナップショットは生成のみで、取得できなかった項目を明記', async () => {
  const { store, git } = makeStores({ envFails: true });
  const r = await new AppTargetResolver({ powerAppsStore: store, powerAppsGitStore: git }).exportKnowledgeSnapshot();
  assert.equal(r.status, 'partial');
  assert.ok(r.data.markdown.includes(APP_ID));
  assert.ok(r.data.markdown.includes('取得できなかった項目'));
});

test('ソースコードに固定のApp ID・Environment ID・仮置きコミットが残っていない', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridgeKnowledgeExtraction.js'), 'utf8');
  for (const bad of ['f42a9b03', 'a1b2c3d4', 'z9y8x7w6', 'env-prod', 'abc1234', 'feature/kaitekukou-calendar']) {
    assert.ok(!src.includes(bad), bad);
  }
});
