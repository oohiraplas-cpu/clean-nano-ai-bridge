'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAzureReadTools } = require('../src/azureReadTools');

// Fake `az` runner: keyed by the first meaningful argument group.
function fakeRun(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const key = Object.keys(responses).find((k) => args.join(' ').startsWith(k));
    if (!key) throw Object.assign(new Error('az_unexpected'), { code: 'azure_read_unavailable' });
    const value = responses[key];
    return typeof value === 'function' ? value(args) : value;
  };
  return { run, calls };
}

const WEBAPP_LIST = [{ name: 'clean-nano-ai-bridge', resourceGroup: 'rg-cn' }];

test('the target is resolved by name and must be unique', async () => {
  const { run, calls } = fakeRun({
    'webapp list': WEBAPP_LIST,
    'webapp show': { name: 'clean-nano-ai-bridge', resourceGroup: 'rg-cn', state: 'Running', location: 'japanwest', kind: 'app', defaultHostName: 'x.azurewebsites.net' },
  });
  const tools = createAzureReadTools({ run });
  const app = await tools.getAppService();
  assert.equal(app.state, 'Running');
  assert.equal(calls[0][0], 'webapp');
  assert.equal(calls[0][1], 'list');
  assert.ok(calls[1].includes('--resource-group') && calls[1].includes('rg-cn'));
});

test('zero or several matching apps are rejected (fail-closed)', async () => {
  const none = createAzureReadTools({ run: fakeRun({ 'webapp list': [] }).run });
  await assert.rejects(none.getAppService(), { code: 'azure_target_unverified' });

  const many = createAzureReadTools({ run: fakeRun({ 'webapp list': [WEBAPP_LIST[0], WEBAPP_LIST[0]] }).run });
  await assert.rejects(many.getAppService(), { code: 'azure_target_unverified' });
});

test('a mismatched resource group in the show result is rejected', async () => {
  const tools = createAzureReadTools({
    run: fakeRun({
      'webapp list': WEBAPP_LIST,
      'webapp show': { name: 'clean-nano-ai-bridge', resourceGroup: 'other-rg' },
    }).run,
  });
  await assert.rejects(tools.getAppService(), { code: 'azure_target_unverified' });
});

test('the app service result never carries settings or secret-like fields', async () => {
  const tools = createAzureReadTools({
    run: fakeRun({
      'webapp list': WEBAPP_LIST,
      'webapp show': { name: 'clean-nano-ai-bridge', resourceGroup: 'rg-cn', state: 'Running', siteConfig: { appSettings: [{ name: 'SECRET', value: 'v' }] } },
    }).run,
  });
  const app = await tools.getAppService();
  assert.deepEqual(Object.keys(app).sort(), ['defaultHostName', 'kind', 'location', 'name', 'resourceGroup', 'state']);
  assert.equal(JSON.stringify(app).includes('SECRET'), false);
});

test('slots are listed with only name and state, capped at 20', async () => {
  const slots = Array.from({ length: 25 }, (_, i) => ({ name: `s${i}`, state: 'Running', hostNames: ['x'] }));
  const tools = createAzureReadTools({
    run: fakeRun({ 'webapp list': WEBAPP_LIST, 'webapp deployment slot list': slots }).run,
  });
  const result = await tools.listSlots();
  assert.equal(result.slots.length, 20);
  assert.deepEqual(Object.keys(result.slots[0]).sort(), ['name', 'state']);
});

test('subscription returns name, id and state only', async () => {
  const tools = createAzureReadTools({
    run: fakeRun({ 'account show': { name: 'sub', subscriptionId: 'abc', state: 'Enabled', tenantId: 't', user: { name: 'u' } } }).run,
  });
  const sub = await tools.getSubscription();
  assert.deepEqual(sub, { name: 'sub', subscriptionId: 'abc', state: 'Enabled' });
});

test('an az failure surfaces as an azure_ code without leaking details', async () => {
  const tools = createAzureReadTools({
    run: () => {
      throw new Error('AADSTS secret token detail');
    },
  });
  await assert.rejects(tools.getSubscription(), (err) => {
    assert.equal(err.code, 'azure_read_unavailable');
    assert.equal(err.message.includes('AADSTS'), false);
    return true;
  });
});
