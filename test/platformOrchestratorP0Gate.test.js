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

test('publish is denied unless P0 approval evidence is verified before publish', () => {
  const gate = source.indexOf("const publicationGate = await verifyBeforeMutation(");
  const publish = source.indexOf("const publication = await this._publishChanges({");
  assert.ok(gate > 0 && publish > gate);
  assert.match(source.slice(gate, publish), /operation: 'publish'/);
  assert.match(source.slice(gate, publish), /if \(publicationGate\.allowed !== true\)/);
  assert.match(source.slice(gate, publish), /appId: target\.id/);
  assert.match(source.slice(gate, publish), /environmentId: target\.environmentId/);
});

test('handler does not inject caller-supplied mutation evidence', () => {
  const handler = fs.readFileSync(path.join(__dirname, '../src/powerPlatformRequestHandler.js'), 'utf8');
  assert.match(handler, /approvalLedger: config\?\.p0Execution\?\.ledger \|\| null/);
  assert.match(handler, /getMutationEvidence: typeof config\?\.p0Execution\?\.getEvidence === 'function'/);
});

test('orchestrator independently reads evidence and rejects mismatched targets', () => {
  assert.match(source, /await this\.getMutationEvidence\(\{ operation: 'deploy'/);
  assert.match(source, /await this\.getMutationEvidence\(\{ operation: 'publish'/);
  assert.match(source, /evidence\.targetSha !== gitOps\.headSha/);
  assert.match(source, /publicationEvidence\.environmentId !== target\.environmentId/);
  assert.match(source, /evidence_target_mismatch/);
});

test('deploy and publish require fresh SHA and single-use reservation before mutation', () => {
  for (const [operation, call] of [['deploy', 'const deployment = await this._deployChanges({'], ['publish', 'const publication = await this._publishChanges({']]) {
    const start = source.indexOf("operation: '" + operation + "',");
    const mutate = source.indexOf(call);
    assert.ok(start > 0 && mutate > start);
    const region = source.slice(start, mutate);
    assert.match(region, /await this\.readCurrentSha\(/);
    assert.match(region, /await this\.reserveApproval\(/);
    assert.match(region, /head_changed/);
    assert.match(region, /approval_not_reserved/);
    assert.match(region, /reservation_unavailable/);
  }
});

test('handler only accepts explicitly injected SHA and reservation providers', () => {
  const handler = fs.readFileSync(path.join(__dirname, '../src/powerPlatformRequestHandler.js'), 'utf8');
  assert.match(handler, /readCurrentSha: typeof config\?\.p0Execution\?\.readCurrentSha === 'function'/);
  assert.match(handler, /reserveApproval: typeof config\?\.p0Execution\?\.reserveApproval === 'function'/);
});

test('reservation contract requires single-use, active approval and exact operation binding', () => {
  const deploy = source.slice(source.indexOf("const reservation = await this.reserveApproval({ operation: 'deploy'"));
  const publish = source.slice(source.indexOf("const reservation = await this.reserveApproval({ operation: 'publish'"));
  for (const region of [deploy, publish]) {
    assert.match(region, /reservation\?\.singleUseVerified !== true/);
    assert.match(region, /reservation\?\.approvalActiveVerified !== true/);
    assert.match(region, /reservation\?\.targetSha !== gitOps\.headSha/);
    assert.match(region, /reservation\?\.requestId !== requestIdLocal/);
  }
  assert.match(deploy, /reservation\?\.operation !== 'deploy'/);
  assert.match(publish, /reservation\?\.operation !== 'publish'/);
});
