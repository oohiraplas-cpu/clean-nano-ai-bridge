const assert = require('node:assert/strict');
const test = require('node:test');
const { getConfig, assertCnAiTarget, CN_AI_TARGET } = require('../src/config');

test('Power Apps target defaults fail closed', () => {
  const config = getConfig({});
  assert.equal(config.powerApps.orgUrl, '');
  assert.equal(config.powerApps.solutionUniqueName, '');
  assert.equal(config.powerApps.githubRoot, '');
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

test('canonical CN_AI target accepts exact values only', () => {
  const env = {
    POWERAPPS_APP_ID: CN_AI_TARGET.appId,
    POWERAPPS_ENVIRONMENT_ID: CN_AI_TARGET.environmentId,
    POWERAPPS_ORG_URL: CN_AI_TARGET.orgUrl,
    POWERAPPS_SOLUTION_UNIQUE_NAME: CN_AI_TARGET.solutionUniqueName,
    POWERAPPS_GITHUB_ROOT: CN_AI_TARGET.githubRoot
  };
  assert.equal(assertCnAiTarget(env), true);
  for (const key of Object.keys(env)) {
    assert.throws(() => assertCnAiTarget({ ...env, [key]: '' }), /CN_AI target mismatch/);
  }
  assert.throws(() => assertCnAiTarget({ ...env, POWERAPPS_APP_ID: 'other-app' }), /CN_AI target mismatch/);
});
