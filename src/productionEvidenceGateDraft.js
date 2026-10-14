'use strict';
const crypto = require('node:crypto');
const sha1Blob = content => crypto.createHash('sha1').update('blob '+Buffer.byteLength(content)+'\0').update(content).digest('hex');
const sha256 = content => crypto.createHash('sha256').update(content).digest('hex');
function validateRuntimeObservation(observation, expected) {
  if (!observation || observation.status !== 'ok' || observation.source !== 'power-apps-saved-msapp' ||
      observation.appId !== expected.appId || observation.environment !== expected.environment ||
      observation.path !== expected.path || typeof observation.content !== 'string' ||
      observation.runtimeHash !== sha256(observation.content))
    return {status:'BLOCKED',reason:'runtime_source_unverified'};
  const blob = sha1Blob(observation.content);
  return {status:'PASS',sourceObservation:{path:observation.path,content:observation.content,sha:blob},runtimeHash:observation.runtimeHash};
}
function validateApprovalReservation(reservation, expected) {
  if (!reservation || reservation.reserved !== true || reservation.singleUseVerified !== true ||
      reservation.planHash !== expected.planHash || reservation.executionId !== expected.executionId ||
      reservation.persisted !== true || reservation.etagVerified !== true)
    return {status:'BLOCKED',reason:'durable_single_use_reservation_unverified'};
  return {status:'PASS'};
}
function validatePublishResponse(response, expectedAppId) {
  return response?.status === 'ok' && response.appId === expectedAppId &&
    typeof response.operationId === 'string' && response.operationId.length > 0
    ? {status:'PASS',operationId:response.operationId} : {status:'BLOCKED',reason:'publish_request_not_confirmed'};
}
function validatePublishedVersion(observed, expected) {
  if (!observed || observed.source !== 'independent_published_artifact' ||
      observed.appId !== expected.appId || observed.environmentId !== expected.environmentId ||
      !expected.version || observed.publishedVersion !== expected.version ||
      !expected.artifactHash || observed.artifactHash !== expected.artifactHash)
    return {status:'BLOCKED',reason:'published_artifact_not_verified'};
  return {status:'PASS'};
}
// Explicit adapters are supplied by trusted server code, never by MCP callers.
// Conditional write must be enforced by SharePoint using the current ETag.
async function reserveSharePointApproval({readItem,patchIfMatch,expected,executionId}) {
  if (typeof readItem!=='function'||typeof patchIfMatch!=='function'||
      !expected?.planHash||!executionId) return {status:'BLOCKED',reason:'approval_adapter_missing'};
  try {
    const before=await readItem();
    if (!before?.etag||before.status!=='approved'||before.revoked!==false||
        before.planHash!==expected.planHash||before.executionId)
      return {status:'BLOCKED',reason:'approval_not_available'};
    const write=await patchIfMatch({etag:before.etag,fields:{executionId,status:'reserved'}});
    if (write?.status!== 'ok') return {status:'BLOCKED',reason:'conditional_reservation_failed'};
    const after=await readItem();
    if (after?.executionId!==executionId||after.status!=='reserved'||
        after.planHash!==expected.planHash||after.revoked!==false||!after.etag||after.etag===before.etag)
      return {status:'BLOCKED',reason:'reservation_readback_mismatch'};
    return {status:'PASS',executionId,planHash:expected.planHash,
      reserved:true,singleUseVerified:true,persisted:true,etagVerified:true};
  } catch {return {status:'BLOCKED',reason:'approval_api_unavailable'};}
}
// The reader must independently fetch the deployed artifact; a caller-supplied
// publish response or a Dataverse appversion alone is insufficient.
async function verifyIndependentPublishedArtifact({readPublishedArtifact,expected}) {
  if(typeof readPublishedArtifact!=='function'||!expected?.artifactHash)
    return {status:'BLOCKED',reason:'published_reader_missing'};
  try {
    const observed=await readPublishedArtifact({appId:expected.appId,environmentId:expected.environmentId});
    if (!observed || observed.independentFetchVerified !== true ||
        typeof observed.artifactHash !== 'string' || !/^[a-f0-9]{64}$/i.test(observed.artifactHash) ||
        typeof expected.artifactHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expected.artifactHash))
      return {status:'BLOCKED',reason:'independent_artifact_evidence_missing'};
    return validatePublishedVersion(observed,expected);
  } catch {return {status:'BLOCKED',reason:'published_artifact_unavailable'};}
}
module.exports={validateRuntimeObservation,validateApprovalReservation,validatePublishResponse,validatePublishedVersion,reserveSharePointApproval,verifyIndependentPublishedArtifact};
