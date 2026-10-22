'use strict';
// Runs the existing offline benchmark inside the repository's existing node --test CI job.
// Does not start Bridge or access any external services.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('offline performance baseline: state registry, cache and 1000 jobs', {timeout: 30000}, t => {
  const script = path.resolve(__dirname, '../benchmark/lightweightCoordinator.bench.js');
  const run = spawnSync(process.execPath, ['--expose-gc', script], {encoding:'utf8',timeout:25000,maxBuffer:1024*1024,env:{...process.env,NODE_ENV:'test'}});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const rows = run.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(rows.map(row=>row.label), ['state_registry_1000','sha_cache_10000','six_lane_dispatch_1000']);
  for (const row of rows) {
    assert.ok(Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0);
    assert.ok(Number.isFinite(row.heapDeltaKiB));
    t.diagnostic(JSON.stringify(row));
  }
  assert.equal(rows[2].operations,1000);
  assert.equal(rows[2].blocked,0);
});
