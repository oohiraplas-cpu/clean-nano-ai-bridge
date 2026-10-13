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
module.exports={validateRuntimeObservation,validateApprovalReservation,validatePublishResponse,validatePublishedVersion};
