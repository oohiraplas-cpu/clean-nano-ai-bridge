'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EXPECTED, checkTarget, checkArtifact, getBackup } = require('../scripts/diagnose-backup');
test('rejects wrong app/environment/solution and unset defaults', () => {
  assert.equal(checkTarget({}).every(x => x.status === 'pass'), false);
  const good = { POWERAPPS_APP_ID: EXPECTED.appId, POWERAPPS_ENVIRONMENT_ID: EXPECTED.environmentId, POWERAPPS_SOLUTION_UNIQUE_NAME: EXPECTED.solution };
  assert.equal(checkTarget(good).every(x => x.status === 'pass'), true);
  assert.equal(checkTarget({...good, POWERAPPS_APP_ID: 'other'})[0].status, 'fail');
});
test('validates artifact identity, expiry, content length and digest', () => {
  const a = { name: EXPECTED.artifact, expired: false, size_in_bytes: 100, digest: 'sha256:' + 'a'.repeat(64), expires_at: '2026-10-26T00:00:00Z' };
  assert.equal(checkArtifact(a, new Date('2026-09-27')).status, 'pass');
  assert.equal(checkArtifact({...a, expired: true}, new Date('2026-09-27')).status, 'fail');
  assert.equal(checkArtifact({...a, size_in_bytes: 0}, new Date('2026-09-27')).status, 'fail');
  assert.equal(checkArtifact({...a, digest: 'bad'}, new Date('2026-09-27')).status, 'fail');
  assert.equal(checkArtifact(a, new Date('2026-11-01')).status, 'fail');
});
test('uses read-only GitHub artifacts API and never prints token', async () => {
  let requested;
  const a = { name: EXPECTED.artifact };
  const result = await getBackup('36268367241', 'secret', async (url, options) => {
    requested = { url, options };
    return { ok: true, json: async () => ({ artifacts: [a] }) };
  });
  assert.deepEqual(result, a);
  assert.match(requested.url, /\/actions\/runs\/36268367241\/artifacts/);
  assert.equal(requested.options.method, undefined);
  await assert.rejects(getBackup('bad', 'secret'), /numeric/);
});
