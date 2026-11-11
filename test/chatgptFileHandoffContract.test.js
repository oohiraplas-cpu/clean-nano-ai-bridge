'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {receive,requireVerifiedPayload,capabilityResult,CODES}=require('../src/integrations/chatgpt/fileHandoffContract');
test('conversation reference alone never passes',()=>{
  const m=receive({reference:'ConversationFileReference:abc',fileName:'logo.png',mimeType:'image/png',operationId:'op-1'});
  assert.equal(m.status,'BLOCKED');assert.equal(m.reasonCode,CODES.CONTENT_UNAVAILABLE);
});
test('real bytes get checksum and revalidation detects corruption',()=>{
  const bytes=Buffer.from([137,80,78,71,1]);
  const m=receive({bytes,fileName:'logo.png',mimeType:'image/png',operationId:'op-1'});
  assert.equal(m.status,'RECEIVED');
  assert.equal(requireVerifiedPayload(m,bytes).status,'VERIFIED');
  assert.equal(requireVerifiedPayload(m,Buffer.from('different')).status,'BLOCKED');
});
test('invalid mime and empty bytes rejected',()=>{
  assert.equal(receive({bytes:Buffer.from('abc'),fileName:'x.png',mimeType:'text/plain',operationId:'o'}).status,'BLOCKED');
  assert.equal(receive({bytes:Buffer.alloc(0),fileName:'x.json',mimeType:'application/json',operationId:'o'}).status,'BLOCKED');
});
test('capability contract refuses unsupported PASS',()=>{
  const x={provider:'CN-POWER-MCP',capability:'file.register',operationClass:'WRITE',riskLevel:'CONTROLLED',available:true,authenticated:true,authorized:true,approvalRequired:true,additionalCost:false,operationId:'o',status:'PASS',reasonCode:null,evidence:null,rollback:null};
  assert.throws(()=>capabilityResult(x),/unsupported PASS/);
  assert.equal(capabilityResult({...x,status:'BLOCKED',reasonCode:CODES.APPROVAL_PENDING}).status,'BLOCKED');
});
