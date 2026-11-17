'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'auth-diagnose-readonly.yml');
const source = fs.readFileSync(workflowPath, 'utf8');
const workflow = yaml.load(source);

test('Azure diagnosis remains manual, read-only and without secret metadata output', () => {
  assert.deepEqual(Object.keys(workflow.on || {}), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions['id-token'], 'write');
  const job = workflow.jobs.diagnose;
  assert.equal(job.environment, 'production');
  const script = job.steps.find(step => step.run)?.run;
  assert.ok(script);
  assert.match(script, /az webapp auth show/);
  assert.match(script, /az webapp config appsettings list/);
  assert.doesNotMatch(script, /\.value\s*\|\s*length\(@\)/);
  assert.doesNotMatch(script, /echo.*(?:length|value|secret|token|password)/i);
  assert.doesNotMatch(script, /az\s+(?:webapp\s+(?:config\s+appsettings\s+set|auth\s+update)|role\s+assignment\s+create)/);
  assert.doesNotMatch(script, /curl\s+.*(?:-d|--data)/);
});
