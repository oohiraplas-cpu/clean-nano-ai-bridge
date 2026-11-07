'use strict';
// Power Automate 参照アダプター（POWER_AUTOMATE_READ）: モックのDataverseで検証する。実環境は未接続。
const assert = require('node:assert/strict');
const test = require('node:test');
const { createPowerAutomateAdapter, CLOUD_FLOW_CATEGORY, summarizeDefinition } = require('../src/operations/powerAutomateAdapter');

const FLOW_ID = '11111111-2222-3333-4444-555555555555';

function mockDataverse(responder) {
  const calls = [];
  const client = {
    request: async (args) => {
      calls.push(args.pathAndQuery);
      return responder(args.pathAndQuery);
    }
  };
  return { dataverse: async () => ({ client }), calls };
}

function definitionFixture() {
  return {
    properties: {
      definition: {
        triggers: { When_a_row_is_added: { type: 'OpenApiConnection' } },
        actions: {
          Get_employee: {
            type: 'OpenApiConnection',
            inputs: { parameters: { siteUrl: "@parameters('SharePointSiteUrl')" } }
          },
          Call_webhook: {
            type: 'Http',
            inputs: { uri: 'https://example.invalid/hook' }
          }
        }
      },
      connectionReferences: {
        shared_sharepointonline: { id: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline', connectionName: 'conn-secret-id' }
      }
    }
  };
}

test('flows_list filters to cloud flows (category 5) and maps the on/off state', async () => {
  const { dataverse, calls } = mockDataverse(() => ({
    value: [{ workflowid: FLOW_ID, name: 'Employee intake', statecode: 1, statuscode: 2, modifiedon: '2026-11-01T00:00:00Z' }]
  }));
  const adapter = createPowerAutomateAdapter({ dataverse });
  const out = await adapter.call('flows_list', {});
  assert.equal(CLOUD_FLOW_CATEGORY, 5);
  assert.match(calls[0], /\$filter=category eq 5/);
  assert.deepEqual(out.items, [{ flowId: FLOW_ID, displayName: 'Employee intake', state: 'on', modifiedOn: '2026-11-01T00:00:00Z' }]);
  assert.equal(out.truncated, false);
});

test('flows_list state filter narrows the query', async () => {
  const { dataverse, calls } = mockDataverse(() => ({ value: [] }));
  const adapter = createPowerAutomateAdapter({ dataverse });
  await adapter.call('flows_list', { stateFilter: 'off' });
  assert.match(calls[0], /statecode eq 0/);
});

test('when Dataverse is not provisioned the adapter refuses with a reason code and makes no request', async () => {
  const adapter = createPowerAutomateAdapter({ dataverse: async () => ({ error: 'DATAVERSE_NOT_PROVISIONED' }) });
  await assert.rejects(() => adapter.call('flows_list', {}), (err) => err.code === 'DATAVERSE_NOT_PROVISIONED');
});

test('flow ids must be GUIDs and a bad id never reaches the Dataverse client', async () => {
  const { dataverse, calls } = mockDataverse(() => ({}));
  const adapter = createPowerAutomateAdapter({ dataverse });
  for (const bad of ['', 'x', "abc') or 1 eq 1", '../../etc']) {
    await assert.rejects(() => adapter.call('flow_get', { flowId: bad }), (err) => err.code === 'VALIDATION_FAILED');
  }
  assert.equal(calls.length, 0);
});

test('flow_definition_get returns only action names and types, never raw URLs or signatures', async () => {
  const { dataverse } = mockDataverse(() => ({ clientdata: JSON.stringify(definitionFixture()) }));
  const adapter = createPowerAutomateAdapter({ dataverse });
  const out = await adapter.call('flow_definition_get', { flowId: FLOW_ID });
  const text = JSON.stringify(out);
  assert.doesNotMatch(text, /sig=|example\.invalid|https?:\/\//);
  assert.doesNotMatch(text, /conn-secret-id/);
  assert.deepEqual(out.actions.map((a) => a.name).sort(), ['Call_webhook', 'Get_employee']);
  assert.deepEqual(out.triggers, [{ name: 'When_a_row_is_added', type: 'OpenApiConnection' }]);
});

test('connection references expose logical names and connector ids only, not connection ids', async () => {
  const { dataverse } = mockDataverse(() => ({ clientdata: JSON.stringify(definitionFixture()) }));
  const adapter = createPowerAutomateAdapter({ dataverse });
  const out = await adapter.call('flow_connection_references_get', { flowId: FLOW_ID });
  assert.deepEqual(out.connectors, [{ logicalName: 'shared_sharepointonline', connectorId: '/providers/Microsoft.PowerApps/apis/shared_sharepointonline' }]);
  assert.doesNotMatch(JSON.stringify(out), /conn-secret-id/);
});

test('environment variables are reported by name with values explicitly excluded', async () => {
  const { dataverse } = mockDataverse(() => ({ clientdata: JSON.stringify(definitionFixture()) }));
  const adapter = createPowerAutomateAdapter({ dataverse });
  const out = await adapter.call('flow_environment_variables_get', { flowId: FLOW_ID });
  assert.deepEqual(out.variables, ['SharePointSiteUrl']);
  assert.equal(out.valuesIncluded, false);
});

test('flow_validate passes a healthy definition and fails one that contains secret-like text, without echoing the value', async () => {
  const healthy = mockDataverse(() => ({ clientdata: JSON.stringify(definitionFixture()) }));
  const ok = await createPowerAutomateAdapter({ dataverse: healthy.dataverse }).call('flow_validate', { flowId: FLOW_ID });
  assert.equal(ok.verdict, 'PASS');

  const leaky = definitionFixture();
  leaky.properties.definition.actions.Get_employee.inputs.password = 'Password=dummy-value-12345';
  const bad = mockDataverse(() => ({ clientdata: JSON.stringify(leaky) }));
  const out = await createPowerAutomateAdapter({ dataverse: bad.dataverse }).call('flow_validate', { flowId: FLOW_ID });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.checks.some((c) => c.name === 'no_secret_like_text' && c.result === 'FAIL'));
  assert.doesNotMatch(JSON.stringify(out), /dummy-value-12345/);
});

test('flow_validate fails a definition that embeds a SAS signature, without echoing it', async () => {
  const withSas = definitionFixture();
  withSas.properties.definition.actions.Call_webhook.inputs.uri = 'https://example.invalid/hook?sig=dummy-signature-value';
  const m = mockDataverse(() => ({ clientdata: JSON.stringify(withSas) }));
  const out = await createPowerAutomateAdapter({ dataverse: m.dataverse }).call('flow_validate', { flowId: FLOW_ID });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.checks.some((c) => c.name === 'no_embedded_credential' && c.result === 'FAIL'));
  assert.doesNotMatch(JSON.stringify(out), /dummy-signature-value/);
});

test('flow_validate fails a definition with no trigger or no action', async () => {
  const empty = mockDataverse(() => ({ clientdata: JSON.stringify({ properties: { definition: { triggers: {}, actions: {} } } }) }));
  const out = await createPowerAutomateAdapter({ dataverse: empty.dataverse }).call('flow_validate', { flowId: FLOW_ID });
  assert.equal(out.verdict, 'FAIL');
  assert.ok(out.checks.find((c) => c.name === 'has_trigger').result === 'FAIL');
});

test('an unparseable definition is reported as not parseable rather than crashing', () => {
  const s = summarizeDefinition('{not json');
  assert.equal(s.parseable, false);
  assert.deepEqual(s.actions, []);
});

test('the adapter exposes read operations only', () => {
  const adapter = createPowerAutomateAdapter({ dataverse: async () => ({ error: 'DATAVERSE_NOT_PROVISIONED' }) });
  assert.deepEqual([...adapter.operations].sort(), [
    'flow_connection_references_get', 'flow_definition_get', 'flow_environment_variables_get', 'flow_get', 'flow_validate', 'flows_list'
  ]);
  for (const name of adapter.operations) assert.doesNotMatch(name, /create|update|delete|enable|disable|write|set/);
});

test('an unknown operation is refused', async () => {
  const adapter = createPowerAutomateAdapter({ dataverse: async () => ({ error: 'X' }) });
  await assert.rejects(() => adapter.call('flow_delete', {}), (err) => err.code === 'UNSUPPORTED_OPERATION');
});
