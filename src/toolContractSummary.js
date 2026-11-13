'use strict';
const crypto = require('node:crypto');

const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_NAMES = 50;

// Compares the tool list a deployment publishes with the list in the checkout.
// The gate is `matchesCheckout` (the whole contract); the count is whatever the checkout publishes,
// never a fixed number. Only tool names are reported (a catalog, not response bodies or settings).
function summarizeToolContract(actual, expected) {
  const published = Array.isArray(actual) ? actual : null;
  const expectedNames = expected.map((tool) => tool.name);
  const actualNames = published ? published.map((tool) => tool.name) : [];
  const actualSet = new Set(actualNames);
  const expectedSet = new Set(expectedNames);
  return {
    count: actualNames.length,
    expectedCount: expectedNames.length,
    countMatchesCheckout: published !== null && actualNames.length === expectedNames.length,
    names: actualNames,
    contractSha256: published ? hash(published) : null,
    matchesCheckout: published !== null && hash(published) === hash(expected),
    missingFromProduction: expectedNames.filter((name) => !actualSet.has(name)).slice(0, MAX_NAMES),
    extraInProduction: actualNames.filter((name) => !expectedSet.has(name)).slice(0, MAX_NAMES)
  };
}

module.exports = { summarizeToolContract };
