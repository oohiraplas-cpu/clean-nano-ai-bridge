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
