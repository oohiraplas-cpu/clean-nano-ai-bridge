'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAuthenticatedDraftAdapter}=require('../src/authenticatedDraftAdapter');
const {executeApprovedDraft}=require('../src/approvedDraftExecution');
const plan={requestId:'r',operation:'ci_verify',targetId:'app',environmentId:'env',baseSha:'a'.repeat(40),headSha:'b'.repeat(40)};
test('existing authenticated GitHub store can supply CI evidence without exposing token',async()=>{
 let calls=[];
 const gitStore={githubOwner:'o',githubRepo:'r',_assertGitHubConfig(){},async _githubRequest(path,options){calls.push({path,options});return {workflow_runs:[{head_sha:plan.headSha,head_branch:'draft/test',status:'completed',conclusion:'success',id:11}]};}};
 const adapter=createAuthenticatedDraftAdapter({gitStore,branch:'draft/test'});
 const result=await executeApprovedDraft({plan,adapter});
 assert.equal(result.status,'PASS');assert.equal(calls.length,1);assert.match(calls[0].path,/actions\/runs/);
 assert.equal(JSON.stringify(result).includes('token'),false);
});
test('missing authentication and non-draft branch are rejected',()=>{
 assert.throws(()=>createAuthenticatedDraftAdapter({gitStore:{},branch:'draft/test'}));
 const gitStore={githubOwner:'o',githubRepo:'r',_assertGitHubConfig(){},_githubRequest:async()=>({})};
 assert.throws(()=>createAuthenticatedDraftAdapter({gitStore,branch:'main'}));
});
