'use strict';
// Read-only release readiness assessment. No Azure, GitHub or Power Apps mutations.
const SHA = /^[a-f0-9]{40}$/i;
function assessParallelReleaseGate(input = {}) {
  const expected = typeof input.expectedSha === 'string' && SHA.test(input.expectedSha) ? input.expectedSha.toLowerCase() : null;
  const running = typeof input.runtimeSha === 'string' && SHA.test(input.runtimeSha) ? input.runtimeSha.toLowerCase() : null;
  const checks = Object.freeze({
    ci: input.ciConclusion === 'success' && input.ciHeadSha?.toLowerCase() === expected,
    arm: input.armResourceIdMatched === true && input.managedIdentityAuthenticated === true && input.effectiveRbacReadVerified === true,
    kudu: input.kuduReadAuthenticated === true && input.kuduDeploymentHistoryVerified === true,
    runtime: Boolean(expected && running && running === expected && input.runtimeArtifactIndependentlyAttested === true),
    backup: input.backupArtifactIndependentlyVerified === true,
    rollback: input.rollbackProcedureIndependentlyVerified === true,
    isolation: input.parallelTargetIsolatedFromProduction === true,
    approval: input.humanFinalApprovalVerified === true
  });
  const blockers = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return Object.freeze({ status: blockers.length ? 'blocked' : 'ready_for_separate_execution',
    checks, blockers, mayPublishAutomatically: false });
}
module.exports = { assessParallelReleaseGate };
