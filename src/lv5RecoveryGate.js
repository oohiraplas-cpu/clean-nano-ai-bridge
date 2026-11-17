'use strict';
// Pure decision gate. Never executes rollback, retry, deployment or mutation.
const MUTATING = new Set(['rollback','retry_write','restore','deploy','publish','save','repair','delete','permission_change']);
function assessRecovery({action,context,approval,evidence}={}) {
 if (typeof action!=='string' || !action) return {status:'BLOCKED',reason:'action_missing'};
 if (!MUTATING.has(action)) return {status:'BLOCKED',reason:'action_not_allowlisted'};
 if (!context || context.environment!=='isolated' || context.production===true)
  return {status:'BLOCKED',reason:'isolation_unverified'};
 if (!context.branch || context.branch==='main' || !/^[a-f0-9]{40}$/.test(context.sourceSha||''))
  return {status:'BLOCKED',reason:'source_identity_unverified'};
 if (!approval || approval.verified!==true || approval.action!==action || approval.branch!==context.branch || approval.sourceSha!==context.sourceSha)
  return {status:'BLOCKED',reason:'human_approval_unverified'};
 if (!evidence || evidence.snapshotVerified!==true || evidence.auditReady!==true || evidence.premiumFreeVerified!==true)
  return {status:'BLOCKED',reason:'recovery_evidence_incomplete'};
 return {status:'ELIGIBLE_FOR_SEPARATE_AUTHORIZATION',reason:'decision_only_no_execution'};
}
module.exports={assessRecovery,MUTATING};
