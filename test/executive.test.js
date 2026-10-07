const test = require('node:test');
const assert = require('node:assert/strict');
const { getExecutivePolicy, getExecutiveBrief, getSharePointListSchema, listRegisteredPowerAutomateFlows } = require('../src/bridgeEnhancedFeatures');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const { PowerAutomateRunner } = require('../src/powerAutomateRunner');
const { AppTargetResolver } = require('../src/bridgeKnowledgeExtraction');

test('Executive priorities, fourteen roles and approval rules remain immutable across calls', () => {
  const result = getExecutivePolicy({ query: '銀行融資と未入金' });
  assert.deepEqual(result.data.policy.priorities, ['利益', '入金回収', 'キャッシュフロー', '安全', '品質', '業務効率', '売上']);
  assert.equal(result.data.policy.roles.length, 14);
  assert.deepEqual(result.data.routing.roles, ['CFO AI', '銀行融資AI']);
  assert.equal(result.data.routing.executionState, '未実行');
  assert.ok(result.data.policy.humanApprovalActions.includes('本番公開'));
  result.data.policy.priorities.pop();
  assert.equal(getExecutivePolicy().data.policy.priorities.length, 7);
  assert.throws(() => getExecutivePolicy({ query: 5 }));
});

test('no sources means missing data, never synthetic financial values', async () => {
  const result = await getExecutiveBrief();
  assert.equal(result.data.executionState, '未実行');
  assert.equal(result.verified, false);
  assert.equal(result.data.originalValues.length, 0);
  assert.equal(result.data.calculatedValues.length, 0);
  assert.equal(result.data.missingData.length, 24);
});

const source = { metric: '売上', listName: 'existing', field: 'Amount', top: 2 };
const reader = { async listItems() { return { status: 'ok', siteId: 'site', listId: 'list', columns: [{ name: 'Amount' }], items: [{ itemId: '1', fields: { Amount: 0 } }, { itemId: '2', fields: {} }], hasMore: true }; } };
test('actual columns and zero values are preserved; partial results never become whole-company totals', async () => {
  const result = await getExecutiveBrief({ sharePointReader: reader, sources: [source] });
  assert.equal(result.data.originalValues[0].records[0].value, 0);
  assert.equal(result.data.originalValues[0].records[1].value, null);
  assert.equal(result.data.originalValues[0].complete, false);
  assert.equal(result.data.calculatedValues.length, 0);
  assert.equal(result.data.missingData.some(x => x.metric === '売上'), false);
  assert.equal(result.verified, false);
});
test('validate all requested sources before any upstream read', async () => {
  let calls = 0;
  const sharePointReader = { listItems() { calls++; } };
  for (const bad of [{...source, metric: 'invented'}, {...source, top: 201}, {...source, field: ''}, {...source, listName: ''}]) {
    await assert.rejects(getExecutiveBrief({ sharePointReader, sources: [source, bad] }));
  }
  await assert.rejects(getExecutiveBrief({ sources: Array(9).fill(source) }));
  assert.equal(calls, 0);
});
test('missing column and upstream failures remain unconfirmed and never expose error secrets', async () => {
  const result = await getExecutiveBrief({ sources: [source], sharePointReader: { async listItems() { throw new Error('client_secret=do-not-return-this-secret'); } } });
  assert.equal(result.status, 'partial');
  assert.equal(result.verified, false);
  assert.equal(result.data.originalValues.length, 0);
  assert.equal(JSON.stringify(result).includes('do-not-return-this-secret'), false);
  const wrong = await getExecutiveBrief({ sources: [{ ...source, field: 'Unknown' }], sharePointReader: reader });
  assert.equal(wrong.data.originalValues.length, 0);
  assert.equal(wrong.data.missingData.length, 24);
});

test('original value responses redact configured secrets and strong credential formats', async () => {
  const result = await getExecutiveBrief({ sources: [source], sharePointReader: {
    clientSecret: 'configured-secret-value', async listItems() { return { status: 'ok', columns: [{ name: 'Amount' }], items: [{ itemId: '1', fields: { Amount: 'configured-secret-value' } }] }; }
  } });
  assert.equal(JSON.stringify(result).includes('configured-secret-value'), false);
});
test('schema adapter supports the actual SharePointReader response and unsupported adapter is not success', async () => {
  const good = await getSharePointListSchema({ sharePointReader: { async listColumns() { return { columns: [{ name: 'Amount', type: 'number' }] }; } }, siteId: 'site', listId: 'list' });
  assert.equal(good.verified, true);
  assert.equal(good.data.schema.columnCount, 1);
  const bad = await getSharePointListSchema({ sharePointReader: {}, siteId: 'site', listId: 'list' });
  assert.equal(bad.verified, false);
});
test('registered flows reflect actual config without URLs; unsupported adapter is unverified', async () => {
  const result = await listRegisteredPowerAutomateFlows({ powerAutomateRunner: new PowerAutomateRunner({ flows: { existing: 'https://example.com?sig=private' } }) });
  assert.equal(result.data.flowCount, 1);
  assert.equal(result.data.flows[0].requiresApproval, true);
  assert.equal(JSON.stringify(result).includes('sig='), false);
  assert.equal((await listRegisteredPowerAutomateFlows({ powerAutomateRunner: {} })).verified, false);
});
test('GitHub main is canonical and fallback branch writes remain fail-closed', async () => {
  const store = new PowerAppsGitStore({ githubBranch: 'main' });
  assert.deepEqual(store.assertCanonicalBranch('main', '公開'), { checked: true, branch: 'main' });
  assert.throws(() => store.assertCanonicalBranch(undefined, '保存'), /State Lock未成立/);
  assert.throws(() => store.assertCanonicalBranch('', '保存'), /State Lock未成立/);
  assert.throws(() => store.assertCanonicalBranch('sync/old-review', '更新'), /branch不一致/);
});
test('live target resolution treats GitHub main existing source as canonical repository parity', async () => {
  const resolver = new AppTargetResolver({ powerAppsStore: { environmentId: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb', async dataverseRequest() { return { value: [{ canvasappid: 'app', displayname: 'CN_AI依頼台帳' }] }; } }, powerAppsGitStore: { canonicalBranch: 'main', githubOwner: 'oohiraplas-cpu', githubRepo: 'clean-nano-ai-bridge', sourceControl: { provider: 'GitHub', repository: 'clean-nano-ai-bridge', branch: 'main', folder: 'powerapps/CN_AI依頼台帳/Source', powerAppsAuthority: 'github_only' }, async githubRequest() { return []; } } });
  const result = await resolver.resolve('CN_AI依頼台帳');
  assert.equal(result.verified, true);
  assert.equal(result.data.writesAllowed, true);
  assert.equal(result.data.sourceControl.provider, 'GitHub');
});
