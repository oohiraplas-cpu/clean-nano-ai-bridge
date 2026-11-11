const assert = require('node:assert/strict');
const test = require('node:test');
const { STATE_CONTEXT_SCHEMA, REQUIRED_STATE_FIELDS } = require('../src/stateContext');

const BASE = {
  appId: 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e',
  environment: '4d0aab59-43ec-ecf1-a9d1-869f2517adbb',
  branch: 'main',
  canonicalBranch: 'main',
  sha: 'a'.repeat(40),
  correlationId: '11111111-1111-4111-8111-111111111111'
};

// Minimal JSON-schema check for this schema's keywords (type, minLength, maxLength, pattern, required, additionalProperties)
function check(context) {
  const errors = [];
  for (const f of STATE_CONTEXT_SCHEMA.required) if (!(f in context)) errors.push(`${f}: missing`);
  for (const [k, v] of Object.entries(context)) {
    const p = STATE_CONTEXT_SCHEMA.properties[k];
    if (!p) { errors.push(`${k}: not allowed`); continue; }
    if (p.type === 'string' && typeof v !== 'string') errors.push(`${k}: must be string`);
    if (p.minLength && typeof v === 'string' && v.length < p.minLength) errors.push(`${k}: too short`);
    if (p.maxLength && typeof v === 'string' && v.length > p.maxLength) errors.push(`${k}: too long`);
    if (p.pattern && typeof v === 'string' && !new RegExp(p.pattern).test(v)) errors.push(`${k}: pattern`);
  }
  return errors;
}

test('A1: required fields are unchanged', () => {
  assert.deepEqual([...REQUIRED_STATE_FIELDS], ['appId', 'environment', 'branch', 'canonicalBranch', 'sha', 'correlationId']);
});

test('A1: legacy 6-field context still validates', () => {
  assert.deepEqual(check(BASE), []);
});

test('A1: new optional fields are accepted but not required', () => {
  assert.deepEqual(check({ ...BASE, contextVersion: '2.0.0', operationId: 'op-00000001', idempotencyKey: 'key-1' }), []);
  for (const f of ['contextVersion', 'operationId', 'idempotencyKey']) {
    assert.ok(!STATE_CONTEXT_SCHEMA.required.includes(f));
  }
});

test('A1: unknown fields are still rejected (additionalProperties false)', () => {
  assert.notDeepEqual(check({ ...BASE, unknownField: 'x' }), []);
});

test('A1: optional field constraints are enforced', () => {
  assert.notDeepEqual(check({ ...BASE, operationId: 'short' }), []);
  assert.notDeepEqual(check({ ...BASE, idempotencyKey: 'x'.repeat(129) }), []);
});
