'use strict';
// ChatGPT integration boundary only. Does not mutate existing MCP dispatch.
const crypto = require('node:crypto');
const TYPES = Object.freeze({
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.pdf':'application/pdf',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv':'text/csv','.txt':'text/plain','.json':'application/json'
});
const CODES = Object.freeze({
  NOT_IMPLEMENTED:'NOT_IMPLEMENTED',UNAUTHENTICATED:'UNAUTHENTICATED',
  PERMISSION_DENIED:'PERMISSION_DENIED',APPROVAL_PENDING:'APPROVAL_PENDING',
  INPUT_REQUIRED:'INPUT_REQUIRED',PROVIDER_UNAVAILABLE:'PROVIDER_UNAVAILABLE',
  CONTENT_UNAVAILABLE:'CONTENT_UNAVAILABLE',VALIDATION_FAILED:'VALIDATION_FAILED'
});
const OPERATIONS = Object.freeze(['READ','WRITE','EXECUTE','DELETE','PUBLISH']);
const RISKS = Object.freeze(['SAFE','CONTROLLED','HIGH_RISK']);
function capabilityResult(x) {
  const required=['provider','capability','operationClass','riskLevel','available','authenticated',
    'authorized','approvalRequired','additionalCost','operationId','status','reasonCode','evidence','rollback'];
  if (!x || required.some(k=>!Object.hasOwn(x,k))) throw new Error('incomplete capability contract');
  if (!OPERATIONS.includes(x.operationClass)||!RISKS.includes(x.riskLevel)) throw new Error('invalid classification');
  if (x.status==='PASS' && (!x.available||!x.authenticated||!x.authorized||x.additionalCost!==false||x.evidence==null))
    throw new Error('unsupported PASS');
  return Object.freeze({...x});
}
function fileMetadata({fileId,fileName,mimeType,size,checksum,source,destination,operationId,status,reasonCode}) {
  return Object.freeze({fileId,fileName,mimeType,size,checksum,source,destination,operationId,status,reasonCode});
}
function receive({reference,bytes,fileName,mimeType,operationId,source='chatgpt',destination=null,maxBytes=20*1024*1024}) {
  const ext = typeof fileName==='string' ? fileName.toLowerCase().match(/\.[^.]+$/)?.[0] : null;
  const allowed = TYPES[ext];
  const b = Buffer.isBuffer(bytes) ? bytes : null;
  const base={fileId:null,fileName,mimeType,size:b?.length??null,checksum:null,source,destination,operationId,
    status:'BLOCKED',reasonCode:CODES.INPUT_REQUIRED};
  if (!b) return fileMetadata({...base,reasonCode:CODES.CONTENT_UNAVAILABLE});
  if (!allowed || mimeType!==allowed || b.length===0 || b.length>maxBytes)
    return fileMetadata({...base,reasonCode:CODES.VALIDATION_FAILED});
  // Never return PASS based solely on a ConversationFileReference or metadata.
  const checksum=crypto.createHash('sha256').update(b).digest('hex');
  const fileId='sha256:'+checksum;
  return fileMetadata({...base,fileId,size:b.length,checksum,status:'RECEIVED',reasonCode:null});
}
function requireVerifiedPayload(metadata,bytes) {
  if (!metadata || metadata.status!=='RECEIVED'||!Buffer.isBuffer(bytes))
    return {status:'BLOCKED',reasonCode:CODES.CONTENT_UNAVAILABLE};
  const checksum=crypto.createHash('sha256').update(bytes).digest('hex');
  return checksum===metadata.checksum && bytes.length===metadata.size
    ? {status:'VERIFIED',reasonCode:null}
    : {status:'BLOCKED',reasonCode:CODES.VALIDATION_FAILED};
}
module.exports={TYPES,CODES,OPERATIONS,RISKS,capabilityResult,fileMetadata,receive,requireVerifiedPayload};
