const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const { PowerAppsChangeWorkflow, computeLineDiff, findNonStyleChanges } = require('../src/powerAppsChangeWorkflow');
const { gitBlobSha } = require('../src/powerAppsChangeValidation');

const ROOT = 'powerapps/app/Source';
const FILE = 'Screen1.pa.yaml';
const BEFORE = `Screen1 As screen:
    Header As rectangle:
        Fill: =RGBA(255, 255, 255, 1)
        Height: =80
    Btn As button:
        Text: ="保存"
        Fill: =RGBA(0, 0, 255, 1)
        Color: =RGBA(0, 0, 0, 1)
        OnSelect: |-
            =Navigate(Screen2)
        DisplayMode: =DisplayMode.Edit
`;
const AFTER_STYLE = BEFORE
  .replace('Fill: =RGBA(255, 255, 255, 1)', 'Fill: =RGBA(0, 0, 0, 1)')
  .replace('Fill: =RGBA(0, 0, 255, 1)', 'Fill: =RGBA(112, 48, 160, 1)')
  .replace('Color: =RGBA(0, 0, 0, 1)', 'Color: =RGBA(255, 255, 255, 1)');
const STYLE_CHANGES = {
  description: 'ブラック×パープル',
  removed: ['Fill: =RGBA(255, 255, 255, 1)', 'Fill: =RGBA(0, 0, 255, 1)', 'Color: =RGBA(0, 0, 0, 1)'],
  added: ['Fill: =RGBA(0, 0, 0, 1)', 'Fill: =RGBA(112, 48, 160, 1)', 'Color: =RGBA(255, 255, 255, 1)']
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

// 状態を持つGitHub/Dataverseモック。PUTはshaが一致しなければ409（実GitHubと同じ競合挙動）。
function makeEnv({ files = { [`${ROOT}/${FILE}`]: BEFORE }, putStatus } = {}) {
  const branches = { main: { ...files } };
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ method, url });
    if (url.includes('/oauth2/v2.0/token')) return json({ access_token: 'mock', expires_in: 3600 });
    if (url.includes('/solutions?')) return json({ value: [{ uniquename: 'S' }] });
    if (url.endsWith('RefreshChangesFromGit') || url.endsWith('PullChangesFromGit')) return json({});
    if (url.includes('api.github.com') && url.includes('/contents/')) {
      const parsed = new URL(url);
      const filePath = decodeURIComponent(parsed.pathname.split('/contents/')[1]);
      if (method === 'PUT') {
        if (putStatus) return json({ message: 'boom' }, putStatus);
        const body = JSON.parse(options.body);
        const current = branches[body.branch]?.[filePath];
        if (current === undefined || gitBlobSha(current) !== body.sha) return json({ message: 'sha mismatch' }, 409);
        branches[body.branch][filePath] = Buffer.from(body.content, 'base64').toString('utf8');
        return json({ commit: { sha: 'c' }, content: { sha: gitBlobSha(branches[body.branch][filePath]) } });
      }
      const content = branches[parsed.searchParams.get('ref')]?.[filePath];
      if (content === undefined) return json({ message: 'Not Found' }, 404);
      return json({ type: 'file', sha: gitBlobSha(content), content: Buffer.from(content).toString('base64') });
    }
    return json({ message: 'unexpected' }, 500);
  };
  return { branches, calls, fetchImpl };
}

async function makeWorkflow(t, envOptions = {}, overrides = {}) {
  const env = makeEnv(envOptions);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-'));
  const logPath = path.join(dir, 'ops.jsonl');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const git = new PowerAppsGitStore({
    githubToken: 'ghp_secrettoken0000000000000000', githubOwner: 'o', githubRepo: 'r', githubBranch: 'main', githubRoot: ROOT,
    githubFallbackBranches: [], githubFallbackRoots: [], fetchImpl: env.fetchImpl,
    tenantId: 't', clientId: 'c', clientSecret: 's', orgUrl: 'https://org.crm.dynamics.com', solutionUniqueName: 'S'
  });
  const app = {
    publishes: 0,
    async getAppState() { return overrides.state || { status: 'ok', versionNumber: '1.2' }; },
    async publishApp() { this.publishes += 1; return overrides.publishResult || { status: 'ok' }; }
  };
  const workflow = new PowerAppsChangeWorkflow({ gitStore: git, appStore: app, logPath, environmentId: 'env-1', appId: 'app-1', ...overrides.workflow });
  const audit = async () => (await fs.readFile(logPath, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { env, workflow, app, audit, logPath };
}

const saveParams = (extra = {}) => ({
  requestId: 'req-1', target: FILE, changeType: 'STYLE', expectedBranch: 'main', expectedHash: gitBlobSha(BEFORE),
  content: AFTER_STYLE, changes: STYLE_CHANGES, actor: 'CNAI', ...extra
});
const approval = (afterHash, extra = {}) => ({
  requestId: 'req-1', publishApproved: true, approvedBy: '野口英光', approvalScope: { requestId: 'req-1', relativePath: `${ROOT}/${FILE}`, afterHash }, ...extra
});

test('STYLE保存: 予定差分と実差分が一致すれば保存し、保存後のソース・State・復旧点・監査を確認できる', async (t) => {
  const { workflow, env, audit } = await makeWorkflow(t);
  const r = await workflow.save(saveParams());
  assert.equal(r.status, 'OK', r.message);
  assert.equal(r.saved, true);
  assert.equal(r.published, false);
  assert.equal(r.validated, true);
  assert.equal(r.version, '1.2');
  assert.equal(r.sourceHash, gitBlobSha(AFTER_STYLE));
  assert.equal(r.rollbackAvailable, true);
  assert.equal(r.environment, 'env-1');
  assert.equal(env.branches.main[`${ROOT}/${FILE}`], AFTER_STYLE);
  const events = (await audit()).map((e) => e.event);
  assert.deepEqual(events, ['prepared', 'saved']);
  for (const key of ['status', 'requestId', 'tool', 'target', 'environment', 'branch', 'sourceHash', 'changed', 'validated', 'saved', 'published', 'version', 'errorCode', 'message', 'timestamp', 'auditId', 'rollbackAvailable']) {
    assert.ok(key in r, key);
  }
});

test('同一RequestId再実行: 二重保存・二重監査を起こさず、実状態を確認して再利用する', async (t) => {
  const { workflow, env, audit } = await makeWorkflow(t);
  await workflow.save(saveParams());
  const puts = () => env.calls.filter((c) => c.method === 'PUT').length;
  const before = puts();
  const again = await workflow.save(saveParams());
  assert.equal(again.status, 'OK');
  assert.equal(again.replayed, true);
  assert.equal(puts(), before);
  assert.equal((await audit()).length, 2);
  // 同一requestIdで内容が異なる場合は拒否
  const other = await workflow.save(saveParams({ content: AFTER_STYLE.replace('0, 0, 0, 1', '9, 9, 9, 1') }));
  assert.equal(other.saved, false);
  assert.equal(other.errorCode, 'SOURCE_CONFLICT');
});

test('並行する同一RequestIdでも直列化され1回だけ保存される', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  const [a, b] = await Promise.all([workflow.save(saveParams()), workflow.save(saveParams())]);
  assert.equal(env.calls.filter((c) => c.method === 'PUT').length, 1);
  assert.deepEqual([a.status, b.status], ['OK', 'OK']);
});

test('安全停止: Branch不一致・sourceHash競合・ファイル不存在・不正入力は保存しない', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  const puts = () => env.calls.filter((c) => c.method === 'PUT').length;

  const branch = await workflow.save(saveParams({ requestId: 'b1', expectedBranch: 'sync/old' }));
  assert.equal(branch.errorCode, 'BRANCH_MISMATCH');
  assert.equal(branch.status, 'BLOCKED');

  const conflict = await workflow.save(saveParams({ requestId: 'c1', expectedHash: 'a'.repeat(40) }));
  assert.equal(conflict.status, 'CONFLICT');
  assert.equal(conflict.errorCode, 'SOURCE_CONFLICT');

  const probeStart = env.calls.length;
  await workflow.git.getSourceFile('Nope.pa.yaml').catch(() => {});
  const singleLookup = env.calls.length - probeStart;
  const callsBefore = env.calls.length;
  const missing = await workflow.save(saveParams({ requestId: 'm1', target: 'Nope.pa.yaml' }));
  assert.equal(missing.errorCode, 'FILE_NOT_FOUND');
  assert.equal(env.calls.length - callsBefore, singleLookup, '404は再試行しない（探索1回分のみ）');

  const invalid = await workflow.save({ requestId: 'x', content: 1 });
  assert.equal(invalid.errorCode, 'VALIDATION_FAILED');
  const badType = await workflow.save(saveParams({ requestId: 't1', changeType: 'MAGIC' }));
  assert.equal(badType.errorCode, 'VALIDATION_FAILED');
  assert.equal(puts(), 0);
});

test('安全停止: Power Fx/YAML構文エラー・秘密値混入は検証失敗で保存しない', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  const broken = await workflow.save(saveParams({ requestId: 'v1', content: 'a: [unclosed', changes: { description: 'x', added: ['a: [unclosed'], removed: [] } }));
  assert.equal(broken.errorCode, 'VALIDATION_FAILED');
  const secret = AFTER_STYLE.replace('Text: ="保存"', 'Text: ="ghp_abcdefghijklmnopqrstuvwxyz0123456789"');
  const leaked = await workflow.save(saveParams({ requestId: 'v2', content: secret, changes: { description: 'x', added: [], removed: [] } }));
  assert.equal(leaked.errorCode, 'VALIDATION_FAILED');
  assert.equal(env.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('指示外差分: 予定差分と不一致、またはSTYLEで外観以外（OnSelect/Visible/ナビゲーション/コントロール名）を変えたら保存しない', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  const mismatch = await workflow.save(saveParams({ requestId: 'u1', changes: { ...STYLE_CHANGES, added: [...STYLE_CHANGES.added.slice(1), 'Fill: =Red'] } }));
  assert.equal(mismatch.errorCode, 'UNEXPECTED_DIFF');

  const onSelect = AFTER_STYLE.replace('=Navigate(Screen2)', '=Navigate(Screen3)');
  const planned = computeLineDiff(BEFORE, onSelect);
  const nav = await workflow.save(saveParams({ requestId: 'u2', content: onSelect, changes: { description: 'x', ...planned } }));
  assert.equal(nav.errorCode, 'UNEXPECTED_DIFF');
  assert.match(nav.message, /OnSelect/);

  const renamed = AFTER_STYLE.replace('Btn As button:', 'Btn2 As button:');
  const renamedPlan = computeLineDiff(BEFORE, renamed);
  const rename = await workflow.save(saveParams({ requestId: 'u3', content: renamed, changes: { description: 'x', ...renamedPlan } }));
  assert.equal(rename.errorCode, 'UNEXPECTED_DIFF');

  const sneaky = AFTER_STYLE.replace('Fill: =RGBA(112, 48, 160, 1)', 'Fill: =If(Patch(T, Defaults(T)), Red, Blue)');
  const sneakyPlan = computeLineDiff(BEFORE, sneaky);
  const patch = await workflow.save(saveParams({ requestId: 'u4', content: sneaky, changes: { description: 'x', ...sneakyPlan } }));
  assert.equal(patch.errorCode, 'UNEXPECTED_DIFF');
  assert.equal(env.calls.filter((c) => c.method === 'PUT').length, 0);

  // 同じ変更でもchangeType=FORMULAなら（予定差分が一致すれば）通る = STYLE制限はSTYLEのみ
  const formula = await workflow.save(saveParams({ requestId: 'u5', changeType: 'FORMULA', content: onSelect, changes: { description: 'x', ...planned } }));
  assert.equal(formula.status, 'OK');
});

test('findNonStyleChanges: 複数行の外観式は外観として扱い、DisplayModeやItemsの変更は検出する', () => {
  const before = 'B As button:\n    Fill: |-\n        =If(a,\n          Red, Blue)\n    Items: =Tbl\n';
  const okAfter = 'B As button:\n    Fill: |-\n        =If(a,\n          Black, Blue)\n    Items: =Tbl\n';
  assert.deepEqual(findNonStyleChanges('A.pa.yaml', before, okAfter, computeLineDiff(before, okAfter)), []);
  const badAfter = before.replace('=Tbl', '=Other');
  assert.equal(findNonStyleChanges('A.pa.yaml', before, badAfter, computeLineDiff(before, badAfter)).length, 2);
  assert.equal(findNonStyleChanges('canvasmanifest.json', '{}', '{"a":1}', computeLineDiff('{}', '{"a":1}')).length, 1);
});

test('保存失敗・競合: PUT失敗はSAVE_FAILED、保存時の競合はSOURCE_CONFLICT。秘密値は監査に出ない', async (t) => {
  const failing = await makeWorkflow(t, { putStatus: 500 });
  const failed = await failing.workflow.save(saveParams());
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'SAVE_FAILED');
  assert.equal(failed.saved, false);
  const conflicted = await makeWorkflow(t, { putStatus: 409 });
  const c = await conflicted.workflow.save(saveParams());
  assert.equal(c.errorCode, 'SOURCE_CONFLICT');
  const raw = await fs.readFile(failing.logPath, 'utf8');
  assert.ok(!raw.includes('ghp_secrettoken'), '監査に秘密値を含めない');
});

test('公開承認の強制: 無承認・承認範囲不一致・AI承認者・未保存は公開しない。承認一致なら公開しStateを確認、再実行で二重公開しない', async (t) => {
  const { workflow, app, audit } = await makeWorkflow(t);
  const unsaved = await workflow.publish(approval(gitBlobSha(AFTER_STYLE)));
  assert.equal(unsaved.published, false, '保存記録がないrequestIdは公開しない');

  const saved = await workflow.save(saveParams());
  const none = await workflow.publish({ requestId: 'req-1' });
  assert.equal(none.status, 'APPROVAL_REQUIRED');
  assert.equal(none.errorCode, 'PUBLISH_NOT_APPROVED');
  const noFlag = await workflow.publish(approval(saved.sourceHash, { publishApproved: false }));
  assert.equal(noFlag.status, 'APPROVAL_REQUIRED');
  const wrongHash = await workflow.publish(approval('f'.repeat(40)));
  assert.equal(wrongHash.errorCode, 'PUBLISH_NOT_APPROVED');
  const wrongPath = await workflow.publish(approval(saved.sourceHash, { approvalScope: { requestId: 'req-1', relativePath: 'Other.pa.yaml', afterHash: saved.sourceHash } }));
  assert.equal(wrongPath.errorCode, 'PUBLISH_NOT_APPROVED');
  const bot = await workflow.publish(approval(saved.sourceHash, { approvedBy: 'Claude' }));
  assert.equal(bot.status, 'APPROVAL_REQUIRED');
  assert.equal(app.publishes, 0);

  const ok = await workflow.publish(approval(saved.sourceHash));
  assert.equal(ok.status, 'OK', ok.message);
  assert.equal(ok.published, true);
  assert.equal(ok.version, '1.2');
  const again = await workflow.publish(approval(saved.sourceHash));
  assert.equal(again.replayed, true);
  assert.equal(app.publishes, 1);
  assert.equal((await audit()).filter((e) => e.event === 'published').length, 1);
  const published = (await audit()).find((e) => e.event === 'published');
  assert.equal(published.approvedBy, '野口英光');
});

test('公開前にソースが変わっていたらCONFLICT、公開失敗はPUBLISH_FAILED、Branch不一致は公開しない', async (t) => {
  const a = await makeWorkflow(t);
  const saved = await a.workflow.save(saveParams());
  a.env.branches.main[`${ROOT}/${FILE}`] = `${AFTER_STYLE}# someone else\n`;
  const changed = await a.workflow.publish(approval(saved.sourceHash));
  assert.equal(changed.status, 'CONFLICT');
  assert.equal(a.app.publishes, 0);

  const b = await makeWorkflow(t, {}, { publishResult: { status: 'error', error: 'Bearer abcdefghijklmnop failed' } });
  const savedB = await b.workflow.save(saveParams());
  const failed = await b.workflow.publish(approval(savedB.sourceHash));
  assert.equal(failed.errorCode, 'PUBLISH_FAILED');
  assert.equal(failed.published, false);
  assert.ok(!(await fs.readFile(b.logPath, 'utf8')).includes('abcdefghijklmnop'), '原文は秘密値をマスクして監査へ');

  const branch = await b.workflow.publish(approval(savedB.sourceHash, { branch: 'sync/old' }));
  assert.equal(branch.errorCode, 'BRANCH_MISMATCH');
});

test('公開後のState確認に失敗したらPARTIAL（成功値で埋めない）', async (t) => {
  const { workflow } = await makeWorkflow(t, {}, { state: { status: 'error' } });
  const saved = await workflow.save(saveParams());
  assert.equal(saved.status, 'PARTIAL');
  assert.equal(saved.saved, true);
  assert.equal(saved.version, null);
});

test('ロールバック: 復旧点へ戻し、公開状態は変更せず、再実行で二重復旧しない。他の変更があればCONFLICT', async (t) => {
  const { workflow, env, app, audit } = await makeWorkflow(t);
  const saved = await workflow.save(saveParams());
  await workflow.publish(approval(saved.sourceHash));
  const rb = await workflow.rollback({ requestId: 'req-1', expectedBranch: 'main' });
  assert.equal(rb.status, 'OK', rb.message);
  assert.equal(env.branches.main[`${ROOT}/${FILE}`], BEFORE);
  assert.equal(rb.publishStateChanged, false);
  assert.equal(rb.publishRequiresApproval, true);
  assert.equal(app.publishes, 1, 'ロールバックは公開しない');
  const again = await workflow.rollback({ requestId: 'req-1', expectedBranch: 'main' });
  assert.equal(again.replayed, true);
  assert.equal((await audit()).filter((e) => e.event === 'rolled_back').length, 1);
  const afterRollbackPublish = await workflow.publish(approval(saved.sourceHash, { requestId: 'req-1' }));
  assert.equal(afterRollbackPublish.published, false, '復旧済みの変更は公開させない');

  const other = await makeWorkflow(t);
  await other.workflow.save(saveParams());
  other.env.branches.main[`${ROOT}/${FILE}`] += '# later\n';
  const conflict = await other.workflow.rollback({ requestId: 'req-1', expectedBranch: 'main' });
  assert.equal(conflict.status, 'CONFLICT');
});

test('ロールバック失敗系: 復旧点なし・Branch不一致・復旧書き込み失敗はROLLBACK_FAILED/BRANCH_MISMATCH', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  assert.equal((await workflow.rollback({ requestId: 'ghost', expectedBranch: 'main' })).errorCode, 'ROLLBACK_FAILED');
  assert.equal((await workflow.rollback({ requestId: 'req-1', expectedBranch: 'x' })).errorCode, 'BRANCH_MISMATCH');
  await workflow.save(saveParams());
  const realFetch = env.fetchImpl;
  workflow.git._fetch = async (url, options = {}) => (options.method === 'PUT' ? json({ message: 'down' }, 500) : realFetch(url, options));
  const failed = await workflow.rollback({ requestId: 'req-1', expectedBranch: 'main' });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.errorCode, 'ROLLBACK_FAILED');
});

test('get_powerapps_audit: requestId単位で変更・保存・公開・復旧を返し、復旧点の本文は返さない', async (t) => {
  const { workflow } = await makeWorkflow(t);
  const saved = await workflow.save(saveParams());
  await workflow.publish(approval(saved.sourceHash));
  const audit = await workflow.getAudit({ requestId: 'req-1' });
  assert.equal(audit.status, 'OK');
  assert.deepEqual(audit.requests['req-1'].events, ['prepared', 'saved', 'published']);
  assert.equal(audit.rollbackAvailable, true);
  const text = JSON.stringify(audit);
  assert.ok(!text.includes('Navigate(Screen2)'), '復旧点の本文は返さない');
  const prepared = audit.entries.find((e) => e.event === 'prepared');
  assert.equal(prepared.beforeHash, gitBlobSha(BEFORE));
  assert.equal(prepared.afterHash, gitBlobSha(AFTER_STYLE));
  assert.equal(prepared.actor, 'CNAI');
  assert.ok(prepared.diff.added.length === 3 && prepared.diff.removed.length === 3);
  assert.equal((await workflow.getAudit({ requestId: 'none' })).status, 'NOT_EXECUTED');
});

test('対象解決: appNameが曖昧・不存在・未確認なら保存しない', async (t) => {
  for (const [status, code] of [['ambiguous', 'TARGET_AMBIGUOUS'], ['not_found', 'TARGET_NOT_FOUND'], ['unavailable', 'STATE_CHECK_FAILED']]) {
    const { workflow, env } = await makeWorkflow(t, {}, { workflow: { resolveTarget: async () => ({ status, data: {} }) } });
    const r = await workflow.save(saveParams({ appName: 'CN_AI依頼台帳' }));
    assert.equal(r.errorCode, code);
    assert.equal(env.calls.filter((c) => c.method === 'PUT').length, 0);
  }
  const ok = await makeWorkflow(t, {}, { workflow: { resolveTarget: async () => ({ status: 'ok', data: {} }) } });
  assert.equal((await ok.workflow.save(saveParams({ appName: 'CN_AI依頼台帳' }))).status, 'OK');
});

test('一時的な通信障害は読み取りのみ1回再試行する', async (t) => {
  const { workflow, env } = await makeWorkflow(t);
  const realFetch = env.fetchImpl;
  let failedOnce = false;
  workflow.git._fetch = async (url, options = {}) => {
    if (!failedOnce && (options.method || 'GET') === 'GET' && url.includes('/contents/')) { failedOnce = true; return json({ message: 'unavailable' }, 503); }
    return realFetch(url, options);
  };
  const r = await workflow.save(saveParams());
  assert.equal(r.status, 'OK');
  assert.equal(failedOnce, true);
});
