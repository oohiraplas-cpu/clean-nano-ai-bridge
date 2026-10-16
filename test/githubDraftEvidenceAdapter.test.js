'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {githubDraftEvidenceAdapter}=require('../src/githubDraftEvidenceAdapter');
const {executeApprovedDraft}=require('../src/approvedDraftExecution');
const base={requestId:'r',targetId:'app',environmentId:'env',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
test('GitHub CI evidence requires exact branch, SHA and completed success',async()=>{
 const plan={...base,operation:'ci_verify'};
 const request=async()=>({workflow_runs:[{head_sha:plan.headSha,head_branch:'draft/test',status:'completed',conclusion:'success',id:123}]});
 const adapter=githubDraftEvidenceAdapter({request,owner:'o',repo:'r',branch:'draft/test'});
 assert.equal((await executeApprovedDraft({plan,adapter})).status,'PASS');
 const wrong=githubDraftEvidenceAdapter({request:async()=>({workflow_runs:[{head_sha:plan.headSha,head_branch:'main',status:'completed',conclusion:'success',id:123}]}),owner:'o',repo:'r',branch:'draft/test'});
 assert.equal((await executeApprovedDraft({plan,adapter:wrong})).status,'BLOCKED');
});
test('Draft edit requires fresh HEAD, blob hash and verified write',async()=>{
 const plan={...base,operation:'draft_edit'};
 const content='updated';
 const blob=crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(content)+'\0'),Buffer.from(content)])).digest('hex');
 let wrote=false;
 const request=async(path,opts)=>{
  if(path.includes('/git/ref/'))return {object:{sha:wrote?'c'.repeat(40):plan.headSha}};
  if(opts?.method==='PUT'){wrote=true;return {commit:{sha:'c'.repeat(40),parents:[{sha:plan.headSha}]},content:{sha:blob}};}
  return wrote?{type:'file',sha:blob}:{type:'file',sha:'d'.repeat(40)};
 };
 const adapter=githubDraftEvidenceAdapter({request,owner:'o',repo:'r',branch:'draft/test'});
 assert.equal((await executeApprovedDraft({plan,adapter,evidence:{path:'src/test.js',content,message:'test'}})).status,'PASS');
 assert.equal(wrote,true);
});
test('No edit if head changed; no writes outside Draft',async()=>{
 const plan={...base,operation:'draft_edit'};let wrote=false;
 const request=async(path,opts)=>{if(opts?.method==='PUT')wrote=true;return {object:{sha:'c'.repeat(40)}}};
 const adapter=githubDraftEvidenceAdapter({request,owner:'o',repo:'r',branch:'draft/test'});
 assert.equal((await executeApprovedDraft({plan,adapter,evidence:{path:'src/a',content:'x',message:'x'}})).status,'BLOCKED');
 assert.equal(wrote,false);
 assert.throws(()=>githubDraftEvidenceAdapter({request,owner:'o',repo:'r',branch:'main'}));
});
