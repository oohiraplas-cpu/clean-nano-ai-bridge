'use strict';
// Never use a successful API dispatch or local operation log as independent proof.
async function verifyPowerAppsMutation({ operation, store, operationResult, expectedAppId, expectedEnvironmentId, expectedVersion, independentlyReadPublishedVersion, independentlyReadSavedVersion } = {}) {
  const deny = reason => Object.freeze({ verified: false, reason });
  if (!['save', 'publish'].includes(operation)) return deny('unsupported_operation');
  if (!operationResult || operationResult.status !== 'ok' || !operationResult.operationId || operationResult.appId !== expectedAppId) return deny('operation_result_unverified');
  if (!store || typeof store.getAppState !== 'function') return deny('state_reader_unavailable');
  let state;
  try { state = await store.getAppState(); } catch { return deny('state_read_failed'); }
  if (state?.status !== 'ok' || state.appId !== expectedAppId || state.environmentId !== expectedEnvironmentId || !expectedVersion || state.versionNumber !== expectedVersion) return deny('state_mismatch');
  const independentReader = operation === 'publish' ? independentlyReadPublishedVersion : independentlyReadSavedVersion;
  if (typeof independentReader !== 'function') return deny('independent_evidence_unavailable');
  let evidence;
  try { evidence = await independentReader({ appId: expectedAppId, environmentId: expectedEnvironmentId, operationId: operationResult.operationId }); }
  catch { return deny('independent_evidence_read_failed'); }
  if (!evidence || evidence.verified !== true || evidence.version !== expectedVersion || evidence.appId !== expectedAppId || evidence.environmentId !== expectedEnvironmentId || evidence.operationId !== operationResult.operationId) return deny('independent_evidence_mismatch');
  return Object.freeze({ verified: true, operation, version: expectedVersion });
}
module.exports = { verifyPowerAppsMutation };
