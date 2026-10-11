const test = require('node:test');
const assert = require('node:assert/strict');
const { getCapabilityRegistry } = require('../src/capabilityRegistry');
test('registration and supplied schemas cannot certify live capabilities', () => {
  const registry = getCapabilityRegistry([{ name: 'get_powerapps_app', inputSchema: { type: 'object' }, verified: true }], 'a'.repeat(40));
  assert.equal(registry.capabilities.length, 144);
  assert.ok(registry.capabilities.every(x => x.status === 'UNVERIFIED'));
  assert.equal(registry.methods.find(x => x.toolName === 'get_powerapps_app').status, 'UNVERIFIED');
  assert.deepEqual(registry.synchronizationEligibleTools, []);
  assert.equal(registry.cnaiTools, null);
});
test('Bridge health and similarly named methods do not certify Azure or Flow capabilities', () => {
  const registry = getCapabilityRegistry([{ name: 'health_check' }, { name: 'list_registered_power_automate_flows' }]);
  assert.equal(registry.methods.find(x => x.targetSystem === 'Azure' && x.toolName === 'health_check').status, 'NOT_IMPLEMENTED');
  assert.equal(registry.methods.find(x => x.toolName === 'list_flows').status, 'NOT_IMPLEMENTED');
  assert.ok(registry.methods.every(x => x.synchronizationEligible === false));
});
