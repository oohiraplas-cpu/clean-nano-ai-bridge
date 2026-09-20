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
