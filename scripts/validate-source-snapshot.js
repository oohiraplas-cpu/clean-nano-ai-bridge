// Validate a real source-only archive. Never mutate tracked source or application services.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { localSource } = require('./local-source');
const { PowerAppsStructureService, canonical, sha256 } = require('../src/powerAppsStructureService');
const { PowerAppsImpactService } = require('../src/powerAppsImpactService');
const { ChangeSnapshotService } = require('../src/changeSnapshotService');
async function main() {
  const bundle = localSource();
  const structure = new PowerAppsStructureService({ canonicalBranch: bundle.branch, sourceProvider: async () => bundle });
  const impact = new PowerAppsImpactService(structure);
  const directory = path.resolve('data/change-snapshots');
  const service = new ChangeSnapshotService({ structureService: structure, impactService: impact, directory });
  const inspected = await structure.inspect({ branch: bundle.branch });
  assert.equal(inspected.recovery.allowed, true);
  assert.equal(inspected.classification.formulasSkipped, 0);
  const proposed = await impact.analyze({ branch: bundle.branch, changes: [bundle.files.find(f => f.relativePath === 'Home.pa.yaml')] });
  assert.equal(proposed.recovery.allowed, true);
  const first = await service.create({ branch: bundle.branch, recoveryScope: 'source_files_only' });
  const repeated = await service.create({ branch: bundle.branch });
  assert.equal(first.snapshotId, repeated.snapshotId); assert.equal(repeated.reused, true);
  const snapshotPath = path.join(directory, `${first.snapshotId}.json`);
  const envelope = await service.readVerified(snapshotPath, first.snapshotId);
  const expected = new Map(bundle.files.map(f => [f.relativePath, Buffer.from(f.content, 'utf8')]));
  for (const side of ['before', 'after']) {
    assert.equal(envelope.payload[side].length, expected.size);
    for (const f of envelope.payload[side]) {
      const restoredBytes = Buffer.from(f.content, 'utf8');
      assert.deepEqual(restoredBytes, expected.get(f.relativePath));
      assert.equal(f.bytes, restoredBytes.length); assert.equal(f.sha256, sha256(restoredBytes));
    }
  }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'source-snapshot-proof-'));
  try {
    const clone = JSON.parse(canonical(envelope));
    clone.payload.before[0].content += '\n# intentional test tampering\n';
    const copy = path.join(scratch, 'tampered.json');
    await fs.writeFile(copy, canonical(clone), { mode: 0o600 });
    await assert.rejects(service.readVerified(copy, first.snapshotId), e => e.payload?.reason === 'snapshot_tampered');
    // Even a recomputed envelope hash must not excuse invalid per-file hashes/manifests.
    clone.snapshotId = sha256(canonical(clone.payload));
    await fs.writeFile(copy, canonical(clone));
    await assert.rejects(service.readVerified(copy, clone.snapshotId), e => e.payload?.reason === 'snapshot_tampered');
    await service.readVerified(snapshotPath, first.snapshotId); // original preserved
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  console.log(JSON.stringify({ snapshotId: first.snapshotId, commitSha: bundle.commitSha,
    scope: first.scope, analysisStatus: inspected.status, classificationStatus: inspected.classification.status,
    sourceSnapshotAllowed: true, sourceFiles: expected.size, bytes: inspected.summary.bytes,
    completeness: 'verified_byte_for_byte_before_and_after', idempotency: 'passed', tamperDetection: 'passed',
    applicationRecovery: first.applicationRecovery, excludedRuntimeDependencyCount: first.excludedRuntimeDependencyCount,
    exclusions: first.exclusions }, null, 2));
}
main().catch(error => { console.error('Source snapshot validation failed:', error.payload?.reason || error.code || 'assertion_failed'); process.exitCode = 1; });
