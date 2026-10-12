const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { observeAzureDeploymentCommit } = require('../src/azureDeploymentCommitObservation');
const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Web/sites/clean-nano-ai-bridge';
test('Azure deployment observation never executes for a wrong resource', () => {
  let invoked = false;
  const result = observeAzureDeploymentCommit({ resourceId: resourceId.replace('clean-nano-ai-bridge','other'),
    run: () => { invoked = true; } });
  assert.equal(result.status, 'blocked');
  assert.equal(invoked, false);
});
test('opaque deployment ID is never treated as SHA', () => {
  const result = observeAzureDeploymentCommit({ resourceId, run: () => JSON.stringify([
    { active: true, id: 'a'.repeat(40) }]) });
  assert.equal(result.status, 'blocked');
  assert.equal(result.runningCodeVerified, false);
});
test('Azure commit candidate does not establish running code', () => {
  const result = observeAzureDeploymentCommit({ resourceId, run: (_cmd, args) => {
    assert.deepEqual(args.slice(0, 4), ['webapp','log','deployment','list']);
    return JSON.stringify([{ active: true, commitSha: 'A'.repeat(40) }]);
  } });
  assert.equal(result.status, 'observed_not_verified');
  assert.equal(result.candidateCommitSha, 'a'.repeat(40));
  assert.equal(result.runningCodeVerified, false);
  assert.equal(result.deploymentShaVerified, false);
});
test('duplicate active deployments and access errors fail closed without leaking errors', () => {
  assert.equal(observeAzureDeploymentCommit({ resourceId, run: () =>
    JSON.stringify([{active:true,commitSha:'a'.repeat(40)},{active:true,commitSha:'a'.repeat(40)}]) }).status,'blocked');
  const result = observeAzureDeploymentCommit({ resourceId, run: () => { throw Error('secret-value'); } });
  assert.equal(result.status, 'blocked');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
  const source = fs.readFileSync(path.join(__dirname,'../src/azureDeploymentCommitObservation.js'),'utf8');
  assert.doesNotMatch(source,/appsettings|list-secrets|access-token|role', 'assignment'/);
});


test('missing or null Azure CLI commitSha fails closed', () => {
  for (const row of [{active:true}, {active:true,commitSha:null}, {active:true,commitSha:''}, {active:true,commitSha:'deployment-opaque'}]) {
    const result = observeAzureDeploymentCommit({ resourceId, run: () => JSON.stringify([row]) });
    assert.equal(result.status, 'blocked');
    assert.equal(result.runningCodeVerified, false);
  }
});
test('no active and non-array Azure CLI response fail closed', () => {
  for (const payload of [[{active:false,commitSha:'a'.repeat(40)}], {value:[]}, null]) {
    const result = observeAzureDeploymentCommit({ resourceId, run: () => JSON.stringify(payload) });
    assert.equal(result.status, 'blocked');
  }
});
test('no unapproved CLI flags or secrets are used for deployment observation', () => {
  const result = observeAzureDeploymentCommit({ resourceId, run: (cmd, args) => {
    assert.equal(cmd, 'az');
    assert.deepEqual(args.slice(0, 4), ['webapp', 'log', 'deployment', 'list']);
    assert.ok(args.includes('--query'));
    assert.ok(!args.some(a => /appsettings|secret|token|config|role|set|update|create|delete/.test(a)));
    return JSON.stringify([]);
  } });
  assert.equal(result.status, 'blocked');
});
