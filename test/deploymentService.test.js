const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DeploymentService } = require('../src/deploymentService');

const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const TEST_URL = 'https://bridge-test.example.com';
const PROD_URL = 'https://bridge.example.com';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 呼び出しを記録するfetchモック。routesは [判定関数, 応答生成関数] の配列。 */
function createFetch(routes = []) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
    calls.push(call);
    for (const [matches, respond] of routes) {
      if (matches(call)) return respond(call);
    }
    return json({ message: 'unexpected request' }, 599);
  };
  return { calls, fetchImpl };
}

const isDispatch = (c) => c.method === 'POST' && c.url.includes('/dispatches');
const isCommit = (c) => c.url.includes('/commits/');
const isHealth = (url) => (c) => c.url === `${url}/health`;
const isRuns = (c) => /\/workflows\/[^/]+\/runs\?/.test(c.url);
const isJobs = (c) => /\/actions\/runs\/\d+\/jobs/.test(c.url);

async function createService({ config = {}, routes = [], withProduction = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deployment-service-'));
  const mock = createFetch(routes);
  const service = new DeploymentService({
    githubToken: 'ghp_' + 'x'.repeat(30), githubOwner: 'owner', githubRepo: 'repo',
    allowedBranches: ['main'],
    testWorkflow: 'deploy-test.yml', testEnvironmentName: 'test', testBaseUrl: TEST_URL,
    ...(withProduction ? { productionWorkflow: 'deploy-prod.yml', productionEnvironmentName: 'production', productionBaseUrl: PROD_URL } : {}),
    historyPath: path.join(directory, 'deployments.jsonl'),
    healthAttempts: 2, healthRetryDelayMs: 0,
    fetchImpl: mock.fetchImpl,
    ...config
  }, { sleep: async () => {}, now: () => new Date('2026-10-05T00:00:00.000Z') });
  return { service, calls: mock.calls, historyPath: path.join(directory, 'deployments.jsonl') };
}

async function readHistory(historyPath) {
  return (await fs.readFile(historyPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
}

const okDispatch = [isDispatch, () => new Response(null, { status: 204 })];
const okCommit = [isCommit, () => json({ sha: SHA })];
const healthyTest = [isHealth(TEST_URL), () => json({ status: 'ok', version: '1.2.3' })];

// ---- deploy_to_test ----

test('deploy_to_test: テスト環境へworkflow_dispatchし、履歴に記録する', async () => {
  const { service, calls, historyPath } = await createService({ routes: [okCommit, okDispatch] });
  const result = await service.deployToTest({ branch: 'main' });

  assert.equal(result.status, 'dispatched');
  assert.equal(result.environment, 'test');
  assert.equal(result.environmentKind, 'test');
  assert.equal(result.ref, SHA);
  assert.ok(result.deploymentId);

  const dispatch = calls.find(isDispatch);
  assert.ok(dispatch.url.endsWith('/repos/owner/repo/actions/workflows/deploy-test.yml/dispatches'));
  assert.deepEqual(dispatch.body, { ref: 'main', inputs: { environment: 'test', git_ref: SHA } });
  assert.match(dispatch.headers.authorization, /^Bearer ghp_/);

  const history = await readHistory(historyPath);
  assert.equal(history.length, 1);
  assert.deepEqual({ action: history[0].action, environment: history[0].environment, ref: history[0].ref, deploymentId: history[0].deploymentId },
    { action: 'deploy', environment: 'test', ref: SHA, deploymentId: result.deploymentId });
});

test('deploy_to_test: refを指定した場合はブランチ先頭を解決せず、そのコミットを使う', async () => {
  const { service, calls } = await createService({ routes: [okDispatch] });
  const result = await service.deployToTest({ branch: 'main', ref: OLD_SHA.toUpperCase() });
  assert.equal(result.ref, OLD_SHA);
  assert.equal(calls.some(isCommit), false);
});

test('deploy_to_test: 本番環境（名前・設定名・prod表記）は拒否し、外部通信しない', async () => {
  const { service, calls } = await createService({ withProduction: true, routes: [okCommit, okDispatch] });
  for (const environment of ['production', 'prod', 'Production-East', 'PROD']) {
    await assert.rejects(
      service.deployToTest({ branch: 'main', environment }),
      (error) => error.status === 403 && error.payload.reason === 'production_environment_not_allowed',
      environment
    );
  }
  assert.equal(calls.length, 0);
});

test('deploy_to_test: 環境不明（未構成の環境名）は拒否し、外部通信しない', async () => {
  const { service, calls } = await createService({ routes: [okCommit, okDispatch] });
  await assert.rejects(
    service.deployToTest({ branch: 'main', environment: 'staging-unknown' }),
    (error) => error.status === 403 && error.payload.reason === 'unknown_environment'
  );
  assert.equal(calls.length, 0);
});

test('deploy_to_test: テスト環境の設定が本番と同一・本番相当なら拒否する', async () => {
  for (const config of [
    { testWorkflow: 'deploy-prod.yml' },
    { testBaseUrl: PROD_URL },
    { testEnvironmentName: 'production-like' }
  ]) {
    const { service, calls } = await createService({ withProduction: true, config, routes: [okCommit, okDispatch] });
    await assert.rejects(
      service.deployToTest({ branch: 'main' }),
      (error) => error.status === 403 && error.payload.reason === 'test_environment_looks_like_production',
      JSON.stringify(config)
    );
    assert.equal(calls.length, 0);
  }
});

test('deploy_to_test: 設定不足はnot_configured（status・reason・missingConfiguration）で拒否し、ダミー成功にしない', async () => {
  const { service, calls } = await createService({
    config: { githubToken: '', githubRepo: '', testWorkflow: '', testEnvironmentName: '', testBaseUrl: '' },
    routes: [okCommit, okDispatch]
  });
  await assert.rejects(
    service.deployToTest({ branch: 'main' }),
    (error) => error.status === 503
      && error.payload.status === 'not_configured'
      && typeof error.payload.reason === 'string'
      && ['DEPLOY_GITHUB_TOKEN', 'DEPLOY_GITHUB_REPO', 'DEPLOY_TEST_WORKFLOW', 'DEPLOY_TEST_ENVIRONMENT_NAME']
        .every((name) => error.payload.missingConfiguration.includes(name))
  );
  assert.equal(calls.length, 0);
});

test('deploy_to_test: branch不一致は拒否し、dispatchしない', async () => {
  const { service, calls } = await createService({ routes: [okCommit, okDispatch] });
  await assert.rejects(
    service.deployToTest({ branch: 'sync/cn-aiiraidaicho-live-review-20260926' }),
    (error) => error.status === 409 && error.payload.status === 'branch_mismatch' && error.payload.allowedBranches[0] === 'main'
  );
  assert.equal(calls.length, 0);
});

for (const status of [404, 409, 429, 500]) {
  test(`deploy_to_test: 上流${status}はHTTP statusを保持したエラー（502）にし、トークンをマスクする`, async () => {
    const token = 'ghp_' + 'x'.repeat(30);
    const { service, historyPath } = await createService({
      routes: [okCommit, [isDispatch, () => json({ message: `failure with ${token}` }, status)]]
    });
    await assert.rejects(
      service.deployToTest({ branch: 'main' }),
      (error) => error.status === 502
        && error.upstream.httpStatus === status
        && error.retryable === (status === 429 || status >= 500)
        && !error.message.includes(token)
        && !JSON.stringify(error.upstream).includes(token)
    );
    await assert.rejects(fs.readFile(historyPath), { code: 'ENOENT' }, 'dispatch失敗時は履歴を記録しない');
  });
}

test('deploy_to_test: ブランチ先頭コミットが解決できない場合は失敗する', async () => {
  const { service } = await createService({ routes: [[isCommit, () => json({ message: 'Not Found' }, 404)], okDispatch] });
  await assert.rejects(service.deployToTest({ branch: 'main' }), (error) => error.upstream.httpStatus === 404);
});

// ---- verify_deployment ----

test('verify_deployment: health・バージョンが正常ならverifiedで、デプロイを確認済みとして履歴に残す', async () => {
  const run = { id: 77, status: 'completed', conclusion: 'success', created_at: '2026-10-05T00:00:05.000Z' };
  const { service, historyPath } = await createService({
    routes: [okCommit, okDispatch, healthyTest, [isRuns, () => json({ workflow_runs: [run] })]]
  });
  const deployed = await service.deployToTest({ branch: 'main' });
  const result = await service.verifyDeployment({ deploymentId: deployed.deploymentId, expectedVersion: '1.2.3' });

  assert.equal(result.status, 'verified');
  assert.equal(result.verified, true);
  assert.equal(result.health.httpStatus, 200);
  assert.deepEqual(result.checks.map((c) => `${c.name}:${c.status}`),
    ['environment:passed', 'health_http:passed', 'health_body:passed', 'version:passed', 'deployment_result:passed']);
  const history = await readHistory(historyPath);
  assert.deepEqual(history.map((h) => h.action), ['deploy', 'verify']);
  assert.equal(history[1].status, 'verified');
});

test('verify_deployment: healthのHTTP状態が異常ならfailedで、確認済みとして記録しない', async () => {
  const { service, historyPath } = await createService({
    routes: [okCommit, okDispatch, [isHealth(TEST_URL), () => json({ status: 'error' }, 503)], [isRuns, () => json({ workflow_runs: [] })]]
  });
  const deployed = await service.deployToTest({ branch: 'main' });
  const result = await service.verifyDeployment({ deploymentId: deployed.deploymentId });
  assert.equal(result.status, 'failed');
  assert.equal(result.verified, false);
  assert.equal(result.health.httpStatus, 503);
  assert.equal(result.checks.find((c) => c.name === 'health_http').status, 'failed');
  assert.ok(result.errors.some((e) => e.includes('503')));
  assert.equal((await readHistory(historyPath)).length, 1);
});

test('verify_deployment: healthの応答内容が異常（status!=="ok"・JSONでない）ならfailed', async () => {
  for (const respond of [() => json({ status: 'degraded' }), () => new Response('<html>Bad Gateway</html>', { status: 200 })]) {
    const { service } = await createService({ routes: [[isHealth(TEST_URL), respond]] });
    const result = await service.verifyDeployment({});
    assert.equal(result.status, 'failed');
    assert.equal(result.checks.find((c) => c.name === 'health_http').status, 'passed');
    assert.equal(result.checks.find((c) => c.name === 'health_body').status, 'failed');
  }
});

test('verify_deployment: healthに接続できない場合はfailed（秘密値はマスク）', async () => {
  const token = 'ghp_' + 'x'.repeat(30);
  const { service } = await createService({ routes: [[isHealth(TEST_URL), () => { throw new Error(`connect ECONNREFUSED token=${token}`); }]] });
  const result = await service.verifyDeployment({});
  assert.equal(result.status, 'failed');
  assert.equal(result.health.reachable, false);
  assert.ok(!JSON.stringify(result).includes(token));
});

test('verify_deployment: バージョン不一致・version未報告はfailed', async () => {
  const mismatch = await createService({ routes: [healthyTest] });
  const wrong = await mismatch.service.verifyDeployment({ expectedVersion: '9.9.9' });
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.checks.find((c) => c.name === 'version').actual, '1.2.3');

  const unreported = await createService({ routes: [[isHealth(TEST_URL), () => json({ status: 'ok' })]] });
  const missing = await unreported.service.verifyDeployment({ expectedVersion: '1.2.3' });
  assert.equal(missing.status, 'failed');
  assert.match(missing.checks.find((c) => c.name === 'version').reason, /versionが含まれていない/);
});

test('verify_deployment: デプロイ実行中・run未発見は確認できないためincomplete（成功扱いにしない）', async () => {
  for (const runs of [[{ id: 1, status: 'in_progress', conclusion: null, created_at: '2026-10-05T00:00:05.000Z' }], []]) {
    const { service, historyPath } = await createService({
      routes: [okCommit, okDispatch, healthyTest, [isRuns, () => json({ workflow_runs: runs })]]
    });
    const deployed = await service.deployToTest({ branch: 'main' });
    const result = await service.verifyDeployment({ deploymentId: deployed.deploymentId });
    assert.equal(result.status, 'incomplete');
    assert.equal(result.verified, false);
    assert.ok(result.notVerified.length >= 1);
    assert.equal((await readHistory(historyPath)).length, 1, '未確認のままverified履歴を作らない');
  }
});

test('verify_deployment: デプロイ結果が失敗(conclusion=failure)ならfailed', async () => {
  const run = { id: 5, status: 'completed', conclusion: 'failure', created_at: '2026-10-05T00:00:05.000Z' };
  const { service } = await createService({ routes: [okCommit, okDispatch, healthyTest, [isRuns, () => json({ workflow_runs: [run] })]] });
  const deployed = await service.deployToTest({ branch: 'main' });
  const result = await service.verifyDeployment({ deploymentId: deployed.deploymentId });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((c) => c.name === 'deployment_result').conclusion, 'failure');
});

test('verify_deployment: 存在しないdeploymentId・環境不明・本番名の誤指定・設定不足を明確に拒否する', async () => {
  const { service } = await createService({ routes: [healthyTest] });
  await assert.rejects(service.verifyDeployment({ deploymentId: 'does-not-exist' }),
    (error) => error.status === 404 && error.payload.status === 'deployment_not_found');
  await assert.rejects(service.verifyDeployment({ environment: 'unknown-env' }),
    (error) => error.status === 403 && error.payload.reason === 'unknown_environment');
  await assert.rejects(service.verifyDeployment({ environment: 'production' }),
    (error) => error.status === 403, '本番が未構成なら環境不明として拒否');

  const unconfigured = await createService({ config: { testBaseUrl: '' }, routes: [healthyTest] });
  await assert.rejects(unconfigured.service.verifyDeployment({}),
    (error) => error.payload.status === 'not_configured' && error.payload.missingConfiguration.includes('DEPLOY_TEST_BASE_URL'));
});

test('verify_deployment: 本番環境は読み取り（health確認）のみ可能', async () => {
  const { service, calls } = await createService({ withProduction: true, routes: [[isHealth(PROD_URL), () => json({ status: 'ok' })]] });
  const result = await service.verifyDeployment({ environment: 'production' });
  assert.equal(result.status, 'verified');
  assert.equal(result.environmentKind, 'production');
  assert.ok(calls.every((c) => c.method === 'GET'));
});

// ---- get_deployment_logs ----

test('get_deployment_logs: run・job・stepを返し、ログ本文中のトークン・接続文字列・APIキーをマスクする', async () => {
  const token = 'ghp_' + 'x'.repeat(30);
  const run = { id: 9, run_number: 3, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_branch: 'main', head_sha: SHA, created_at: '2026-10-05T00:00:05.000Z', html_url: 'https://github.com/owner/repo/actions/runs/9' };
  const logText = [
    'Deploying...',
    `Authorization: Bearer ${token}`,
    'Server=tcp:db.example.net;Database=app;User Id=admin;Password=p4ss-w0rd!;',
    'MCP_API_KEY=very-secret-api-key',
    'Done'
  ].join('\n');
  const { service } = await createService({
    routes: [
      [isRuns, () => json({ workflow_runs: [run] })],
      [isJobs, () => json({ jobs: [{ id: 11, name: 'deploy', status: 'completed', conclusion: 'success', started_at: 'a', completed_at: 'b', steps: [{ name: 'Checkout', status: 'completed', conclusion: 'success' }] }] })],
      [(c) => c.url.endsWith('/actions/jobs/11/logs'), () => new Response(logText, { status: 200 })]
    ]
  });
  const result = await service.getDeploymentLogs({ includeJobLogs: true });

  assert.equal(result.status, 'ok');
  assert.equal(result.masked, true);
  assert.equal(result.selectedRun.id, 9);
  assert.equal(result.jobs[0].steps[0].name, 'Checkout');
  const serialized = JSON.stringify(result);
  for (const leaked of [token, 'p4ss-w0rd!', 'very-secret-api-key']) assert.ok(!serialized.includes(leaked), `${leaked} が漏えい`);
  assert.ok(result.jobs[0].logTail.includes('Deploying...'));
});

test('get_deployment_logs: ログ取得失敗はjob単位で報告し、全体は失敗にしない／run未発見は明示する', async () => {
  const run = { id: 9, status: 'completed', conclusion: 'success', created_at: '2026-10-05T00:00:05.000Z' };
  const failing = await createService({
    routes: [[isRuns, () => json({ workflow_runs: [run] })], [isJobs, () => json({ jobs: [{ id: 11, name: 'deploy', steps: [] }] })], [(c) => c.url.includes('/logs'), () => json({ message: 'Gone' }, 410)]]
  });
  const result = await failing.service.getDeploymentLogs({ includeJobLogs: true });
  assert.match(result.jobs[0].logError, /410/);

  const empty = await createService({ routes: [[isRuns, () => json({ workflow_runs: [] })]] });
  const none = await empty.service.getDeploymentLogs({});
  assert.equal(none.selectedRun, null);
  assert.ok(none.message);
});

test('get_deployment_logs: 上流404/409/429/500は502で詳細を保持、設定不足・不明環境・不明deploymentIdは明確に拒否', async () => {
  for (const status of [404, 409, 429, 500]) {
    const { service } = await createService({ routes: [[isRuns, () => json({ message: 'boom' }, status)]] });
    await assert.rejects(service.getDeploymentLogs({}), (error) => error.status === 502 && error.upstream.httpStatus === status);
  }
  const { service } = await createService({ routes: [] });
  await assert.rejects(service.getDeploymentLogs({ environment: 'nope' }), (error) => error.payload.reason === 'unknown_environment');
  await assert.rejects(service.getDeploymentLogs({ deploymentId: 'missing' }), (error) => error.status === 404);
  const unconfigured = await createService({ config: { githubToken: '', testWorkflow: '' } });
  await assert.rejects(unconfigured.service.getDeploymentLogs({}),
    (error) => error.payload.status === 'not_configured' && error.payload.missingConfiguration.includes('DEPLOY_GITHUB_TOKEN'));
});

// ---- rollback_deployment ----

/** deploy → verify(verified) まで済ませ、復旧元として使えるdeploymentIdを返す。 */
async function seedVerifiedDeployment(context, sha = SHA) {
  const deployed = await context.service.deployToTest({ branch: 'main', ref: sha });
  const run = { id: 1, status: 'completed', conclusion: 'success', created_at: '2026-10-05T00:00:05.000Z' };
  context.runs.splice(0, context.runs.length, run);
  const verified = await context.service.verifyDeployment({ deploymentId: deployed.deploymentId });
  assert.equal(verified.status, 'verified');
  return deployed.deploymentId;
}

async function createRollbackContext(options = {}) {
  const runs = [];
  const healthRoute = options.healthRoute || healthyTest;
  const context = await createService({
    withProduction: options.withProduction,
    config: options.config,
    routes: [okCommit, okDispatch, healthRoute, [isRuns, () => json({ workflow_runs: runs })]]
  });
  context.runs = runs;
  return context;
}

test('rollback_deployment: 確認済みの復旧元へ戻し、復旧後にhealthを再確認する', async () => {
  const context = await createRollbackContext();
  const source = await seedVerifiedDeployment(context, OLD_SHA);
  await context.service.deployToTest({ branch: 'main', ref: SHA });
  context.calls.length = 0;

  const result = await context.service.rollbackDeployment({ targetDeploymentId: source });
  assert.equal(result.status, 'ok');
  assert.equal(result.healthVerified, true);
  assert.equal(result.rollbackOf, source);
  assert.equal(result.ref, OLD_SHA);

  const dispatch = context.calls.find(isDispatch);
  assert.deepEqual(dispatch.body, { ref: 'main', inputs: { environment: 'test', git_ref: OLD_SHA } });
  const dispatchIndex = context.calls.findIndex(isDispatch);
  const healthIndex = context.calls.findIndex((c) => c.url === `${TEST_URL}/health`);
  assert.ok(healthIndex > dispatchIndex, '復旧(dispatch)の後にhealthを再確認する');

  const history = await readHistory(context.historyPath);
  assert.equal(history.at(-1).action, 'rollback');
  assert.equal(history.at(-1).rollbackOf, source);
});

test('rollback_deployment: 復旧後のhealthが異常ならhealth_check_failed（成功扱いにしない）で、再試行する', async () => {
  let healthCalls = 0;
  const context = await createRollbackContext({
    healthRoute: [isHealth(TEST_URL), () => { healthCalls += 1; return healthCalls <= 1 ? json({ status: 'ok' }) : json({ status: 'error' }, 500); }]
  });
  const source = await seedVerifiedDeployment(context);
  healthCalls = 1;
  const result = await context.service.rollbackDeployment({ targetDeploymentId: source });
  assert.equal(result.status, 'health_check_failed');
  assert.equal(result.healthVerified, false);
  assert.equal(result.health.httpStatus, 500);
  assert.equal(healthCalls, 3, 'healthAttempts=2回の再確認が行われる');
});

test('rollback_deployment: 復旧元が存在しない・未確認・別環境の場合は拒否し、dispatchしない', async () => {
  const context = await createRollbackContext();
  await assert.rejects(context.service.rollbackDeployment({ targetDeploymentId: 'unknown-id' }),
    (error) => error.status === 404 && error.payload.status === 'rollback_source_not_found');

  const unverified = await context.service.deployToTest({ branch: 'main' });
  context.calls.length = 0;
  await assert.rejects(context.service.rollbackDeployment({ targetDeploymentId: unverified.deploymentId }),
    (error) => error.status === 409 && error.payload.status === 'rollback_source_not_verified');
  assert.equal(context.calls.some(isDispatch), false);
});

test('rollback_deployment: 本番はapprovedByHuman:true必須。未承認は拒否し、承認済みなら実行する', async () => {
  const context = await createRollbackContext({ withProduction: true });
  const healthyProd = [isHealth(PROD_URL), () => json({ status: 'ok' })];
  context.service._fetch = createFetch([okCommit, okDispatch, healthyTest, healthyProd, [isRuns, () => json({ workflow_runs: context.runs })]]).fetchImpl;
  await assert.rejects(context.service.rollbackDeployment({ environment: 'production', targetDeploymentId: 'any' }),
    (error) => error.status === 403 && error.payload.status === 'approval_required');
  await assert.rejects(context.service.rollbackDeployment({ environment: 'production', targetDeploymentId: 'any', approvedByHuman: false }),
    (error) => error.payload.status === 'approval_required');

  // 本番の確認済み復旧元を履歴に用意して、承認付きで実行する。
  await fs.writeFile(context.historyPath, [
    { action: 'deploy', deploymentId: 'prod-1', environment: 'production', environmentKind: 'production', branch: 'main', ref: OLD_SHA, requestedAt: '2026-10-04T00:00:00.000Z' },
    { action: 'verify', deploymentId: 'prod-1', environment: 'production', status: 'verified' }
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const calls = [];
  context.service._fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/dispatches')) return new Response(null, { status: 204 });
    return json({ status: 'ok' });
  };
  const result = await context.service.rollbackDeployment({ environment: 'production', targetDeploymentId: 'prod-1', approvedByHuman: true });
  assert.equal(result.status, 'ok');
  assert.equal(result.environmentKind, 'production');
  assert.ok(calls.find((c) => c.url.includes('deploy-prod.yml')), '本番用workflowを使う');
  assert.equal((await readHistory(context.historyPath)).at(-1).approvedByHuman, true);
});

test('rollback_deployment: 本番が未構成の環境名は拒否し、設定不足はnot_configured', async () => {
  const context = await createRollbackContext();
  await assert.rejects(context.service.rollbackDeployment({ environment: 'production', targetDeploymentId: 'x', approvedByHuman: true }),
    (error) => error.payload.reason === 'unknown_environment');
  const unconfigured = await createService({ config: { githubToken: '', testBaseUrl: '' } });
  await assert.rejects(unconfigured.service.rollbackDeployment({ targetDeploymentId: 'x' }),
    (error) => error.payload.status === 'not_configured'
      && error.payload.missingConfiguration.includes('DEPLOY_GITHUB_TOKEN')
      && error.payload.missingConfiguration.includes('DEPLOY_TEST_BASE_URL'));
});
