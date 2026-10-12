const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyBeforeMutation } = require('../src/p0ExecutionEvidence');

const source = fs.readFileSync(path.join(__dirname, '../src/platformOrchestrator.js'), 'utf8');

test('orchestrator checks immutable P0 ledger evidence before deployment', () => {
  const gate = source.indexOf('const deploymentGate = await verifyBeforeMutation(');
  const deploy = source.indexOf('const deployment = await this._deployChanges({');
  assert.ok(gate > 0 && deploy > gate, 'P0 gate must precede deployment');
  assert.match(source.slice(gate, deploy), /if \(deploymentGate\.allowed !== true\)/);
  assert.match(source.slice(gate, deploy), /appId: target\.id/);
  assert.match(source.slice(gate, deploy), /environmentId: target\.environmentId/);
  assert.match(source.slice(gate, deploy), /targetSha: gitOps\.headSha/);
});

test('missing ledger or evidence blocks deployment approval', async () => {
  const result = await verifyBeforeMutation({
    ledger: null, operation: 'deploy', targetSha: 'a'.repeat(40),
    observedSha: 'a'.repeat(40), requestId: 'req', actorId: 'actor',
    backupVerified: true, testsPassed: true,
    expected: { appId: 'app', environmentId: 'env', changeHash: 'b'.repeat(40) }
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'ledger_not_configured');
});

test('orchestrator never marks publication complete when publish result is pending or failed', () => {
  const resultCheck = source.indexOf("if (publication?.published !== true || publication?.status !== 'published')");
  const publishLog = source.indexOf("this._logExecution('PUBLISHED', `公開完了`)");
  assert.ok(resultCheck > 0 && publishLog > resultCheck);
  assert.match(source.slice(resultCheck, publishLog), /return this\._returnBlocked\('公開未確認'/);
});
