'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApprovalGate}=require('../src/connectionApprovalGate');
function request(){return {source:'trusted_server',status:'pending',presentedToUser:true,requestId:'req-abcdef12',subjectId:'user-1',service:'azure',action:'rotate_credential',expiresAt:Date.now()+60000};}
test('approval is identity bound and single use',()=>{
 const gate=createApprovalGate();
 assert.equal(gate.register(request()).status,'PARTIAL');
 assert.equal(gate.consume({requestId:'req-abcdef12',subjectId:'other',utterance:'承認する'}).status,'BLOCKED');
 assert.equal(gate.consume({requestId:'req-abcdef12',subjectId:'user-1',utterance:'承認する'}).reason,'approval_consumed_no_write');
 assert.equal(gate.consume({requestId:'req-abcdef12',subjectId:'user-1',utterance:'承認する'}).status,'BLOCKED');
});
test('expired and invalid requests are rejected',()=>{
 const gate=createApprovalGate();
 assert.equal(gate.register({...request(),expiresAt:0}).status,'BLOCKED');
 assert.equal(gate.register({...request(),source:'client'}).status,'BLOCKED');
});
