const assert = require('node:assert/strict');
const test = require('node:test');
const { getConfig } = require('../src/config');

test('既存CN_CompanyOS環境をPower Apps Git同期の既定値にする', () => {
  const config = getConfig({});
  assert.equal(config.powerApps.orgUrl, 'https://orgcf455a58.crm7.dynamics.com');
  assert.equal(config.powerApps.solutionUniqueName, 'CN_CompanyOS');
});

test('環境変数でPower Apps Git同期先を上書きできる', () => {
  const config = getConfig({
    POWERAPPS_ORG_URL: 'https://override.crm.dynamics.com',
    POWERAPPS_SOLUTION_UNIQUE_NAME: 'OverrideSolution'
  });
  assert.equal(config.powerApps.orgUrl, 'https://override.crm.dynamics.com');
  assert.equal(config.powerApps.solutionUniqueName, 'OverrideSolution');
});

test('SHAREPOINT_EMPLOYEE_LEDGER_LIST_IDが未設定なら空文字になる', () => {
  const config = getConfig({});
  assert.equal(config.sharepoint.employeeLedgerListId, '');
});

test('環境変数でCN_社員台帳のリストIDを設定できる', () => {
  const config = getConfig({ SHAREPOINT_EMPLOYEE_LEDGER_LIST_ID: 'list-employee-ledger-1' });
  assert.equal(config.sharepoint.employeeLedgerListId, 'list-employee-ledger-1');
});

test('デプロイ連携の設定は未設定なら空で、本番やテスト環境を暗黙に補完しない', () => {
  const { deployment } = getConfig({});
  assert.equal(deployment.githubToken, '');
  assert.equal(deployment.testWorkflow, '');
  assert.equal(deployment.testEnvironmentName, '');
  assert.equal(deployment.testBaseUrl, '');
  assert.equal(deployment.productionWorkflow, '');
  assert.equal(deployment.productionEnvironmentName, '');
  assert.equal(deployment.productionBaseUrl, '');
  assert.deepEqual(deployment.allowedBranches, ['main']);
  assert.equal(deployment.healthAttempts, 3);
  assert.equal(deployment.healthRetryDelayMs, 5000);
});

test('デプロイ連携の設定を環境変数で上書きできる（URL末尾スラッシュは除去、許可branchはCSV）', () => {
  const { deployment } = getConfig({
    DEPLOY_GITHUB_TOKEN: 'token-value', DEPLOY_GITHUB_OWNER: 'o', DEPLOY_GITHUB_REPO: 'r',
    DEPLOY_ALLOWED_BRANCHES: 'main, release/1.0 ,',
    DEPLOY_TEST_WORKFLOW: 'deploy-test.yml', DEPLOY_TEST_ENVIRONMENT_NAME: 'test', DEPLOY_TEST_BASE_URL: 'https://t.example.com//',
    DEPLOY_PRODUCTION_WORKFLOW: 'deploy-prod.yml', DEPLOY_PRODUCTION_ENVIRONMENT_NAME: 'production', DEPLOY_PRODUCTION_BASE_URL: 'https://p.example.com/',
    DEPLOY_HEALTH_ATTEMPTS: '5', DEPLOY_HEALTH_RETRY_DELAY_MS: '0', DEPLOY_HISTORY_PATH: '/tmp/history.jsonl'
  });
  assert.equal(deployment.githubToken, 'token-value');
  assert.deepEqual(deployment.allowedBranches, ['main', 'release/1.0']);
  assert.equal(deployment.testBaseUrl, 'https://t.example.com');
  assert.equal(deployment.productionBaseUrl, 'https://p.example.com');
  assert.equal(deployment.healthAttempts, 5);
  assert.equal(deployment.healthRetryDelayMs, 0);
  assert.equal(deployment.historyPath, '/tmp/history.jsonl');
});

test('デプロイ用GitHubトークンはPower Appsソース用トークンを流用しない', () => {
  const { deployment } = getConfig({ POWERAPPS_GITHUB_TOKEN: 'powerapps-token' });
  assert.equal(deployment.githubToken, '');
});

test('許可branchの既定はPower Apps正本branch、不正なヘルスチェック設定は既定値に戻る', () => {
  assert.deepEqual(getConfig({ POWERAPPS_GITHUB_BRANCH: 'release' }).deployment.allowedBranches, ['release']);
  const { deployment } = getConfig({ DEPLOY_HEALTH_ATTEMPTS: 'abc', DEPLOY_HEALTH_RETRY_DELAY_MS: '-1' });
  assert.equal(deployment.healthAttempts, 3);
  assert.equal(deployment.healthRetryDelayMs, 5000);
});

test('権限管理の許可リストは未設定なら空（付与系は未構成として拒否される）、設定時は正規化される', () => {
  assert.deepEqual(getConfig({}).permissions, { allowedPrincipalDomains: [], allowedDataverseRoles: [] });
  const { permissions } = getConfig({
    PERMISSIONS_ALLOWED_PRINCIPAL_DOMAINS: 'Example.com, contoso.com',
    PERMISSIONS_ALLOWED_DATAVERSE_ROLES: 'Basic User, Environment Maker'
  });
  assert.deepEqual(permissions.allowedPrincipalDomains, ['example.com', 'contoso.com']);
  assert.deepEqual(permissions.allowedDataverseRoles, ['Basic User', 'Environment Maker']);
});
