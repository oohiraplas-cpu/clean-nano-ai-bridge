// Read-only integration probe. Secret values and source content are never logged.
const assert = require('node:assert/strict');
const { STATE_CONTEXT_SCHEMA } = require('../src/stateContext');

async function main() {
  const url = process.env.BRIDGE_MCP_URL;
  if (!url || !/^https:\/\//.test(url)) throw new Error('BRIDGE_MCP_URL must be an explicit HTTPS test endpoint');
  const headers = { 'content-type': 'application/json' };
  if (process.env.BRIDGE_MCP_API_KEY) headers['x-api-key'] = process.env.BRIDGE_MCP_API_KEY;
  let id = 0;
  async function request(method, params) {
    const response = await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || body.result?.isError) throw new Error(`MCP operation failed: ${method}`);
    return body.result?.structuredContent || body.result;
  }
  const call = (name, args = {}) => request('tools/call', { name, arguments: args });
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'state-context-probe', version: '1.0.0' } });
  assert.ok(init.serverInfo);
  const tools = (await request('tools/list', {})).tools;
  assert.equal(tools.length, 51);
  for (const name of ['validate_powerapps_source', 'compare_powerapps_with_git']) assert.deepEqual(tools.find(t => t.name === name).inputSchema.properties.stateContext, STATE_CONTEXT_SCHEMA);
  const health = await call('health_check');
  assert.ok(health);
  const state = await call('get_powerapps_state');
  assert.ok(state.correlationId);
  assert.notEqual(state.correlationId, state.operationId);
  assert.equal(state.appId, 'f42a9b03-59b9-49d3-a33b-0a210cd3d51e');
  assert.equal(state.environmentId, '4d0aab59-43ec-ecf1-a9d1-869f2517adbb');
  const source = await call('get_powerapps_source', {
    relativePath: 'powerapps/CN_AI依頼台帳/Source/S1_Home.pa.yaml',
    correlationId: state.correlationId, stateSessionId: state.stateSessionId
  });
  assert.equal(source.stateContextComplete, true);
  assert.equal(source.branch, 'main');
  assert.equal(source.canonicalBranch, 'main');
  const args = { stateContext: source.stateContext, stateSessionId: source.stateSessionId };
  const valid = await call('validate_powerapps_source', { ...args, relativePath: source.path, expectedBranch: source.branch });
  assert.equal(valid.validationStatus, 'VALID');
  const compared = await call('compare_powerapps_with_git', { ...args, targetFile: source.path, targetApp: state.appId });
  assert.equal(compared.targetSha, source.sha);
  assert.equal(compared.correlationId, state.correlationId);
  console.log(JSON.stringify({ schema: 'PASS', validation: valid.validationStatus,
    branch: source.branch, sha: source.sha, path: source.path,
    comparisonStatus: compared.comparisonStatus, hasDifferences: compared.data.hasDifferences,
    comparisonVerified: compared.comparisonVerified, comparisonSources: compared.comparisonSources,
    changedProperties: compared.data.changedProperties, changedLines: compared.data.changedLines }, null, 2));
  assert.ok(['identical', 'changed'].includes(compared.comparisonStatus));
  assert.equal(compared.comparisonVerified, true);
}

main().catch(() => { console.error('Integration verification failed; check authentication, deployed schema and registered context. No sensitive response logged.'); process.exitCode = 1; });
