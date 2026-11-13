const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeToolContract } = require('../src/toolContractSummary');
const { PUBLISHED_TOOLS } = require('../src/server');

test('identical published list matches the checkout whatever its size', () => {
  const summary = summarizeToolContract(PUBLISHED_TOOLS, PUBLISHED_TOOLS);
  assert.equal(summary.matchesCheckout, true);
  assert.equal(summary.countMatchesCheckout, true);
  assert.equal(summary.count, PUBLISHED_TOOLS.length);
  assert.equal(summary.expectedCount, PUBLISHED_TOOLS.length);
  assert.deepEqual(summary.missingFromProduction, []);
  assert.deepEqual(summary.extraInProduction, []);
  assert.ok(!('first28MatchesCheckout' in summary));
});

test('a stale deployment is reported by tool name and fails the contract match', () => {
  const expected = [{ name: 'a', inputSchema: { v: 2 } }, { name: 'b' }, { name: 'c' }];
  const stale = [{ name: 'a', inputSchema: { v: 1 } }, { name: 'b' }, { name: 'old' }];
  const summary = summarizeToolContract(stale, expected);
  assert.equal(summary.matchesCheckout, false);
  assert.equal(summary.countMatchesCheckout, true);
  assert.deepEqual(summary.missingFromProduction, ['c']);
  assert.deepEqual(summary.extraInProduction, ['old']);
});

test('a missing or malformed listing never matches and does not throw', () => {
  for (const bad of [undefined, null, {}, 'x']) {
    const summary = summarizeToolContract(bad, [{ name: 'a' }]);
    assert.equal(summary.matchesCheckout, false);
    assert.equal(summary.countMatchesCheckout, false);
    assert.equal(summary.contractSha256, null);
    assert.equal(summary.count, 0);
  }
});

test('reported name lists are capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `t${i}` }));
  assert.equal(summarizeToolContract([], many).missingFromProduction.length, 50);
});
