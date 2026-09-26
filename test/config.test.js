const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../src/config');

test('Git同期先は明示設定がなければ空にする', () => {
  const config = getConfig({});
  assert.equal(config.powerApps.orgUrl, '');
  assert.equal(config.powerApps.solutionUniqueName, '');
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

test('本番隔離設定のソース参照先は17ファイル復元ブランチに固定', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');
  assert.match(source, /const CN_AI_BRANCH = 'sync\\/cn-aiiraidaicho-backup17-review-20260926'/);
  assert.match(source, /const CN_AI_APP_ID = 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e'/);
});
