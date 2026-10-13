'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PowerAppsGitStore}=require('../src/powerAppsGitStore');
const {createAuthenticatedDraftRunner}=require('../src/authenticatedDraftRunner');
const owner='o',repo='r',branch='draft/test',sha='b'.repeat(40);
const plan={requestId:'req',operation:'ci_verify',targetId:'o/r',environmentId:branch,baseSha:'a'.repeat(40),headSha:sha};
function storeWithMock(fetchImpl,token='fake-test-token') {
 return new PowerAppsGitStore({githubToken:token,githubOwner:owner,githubRepo:repo,githubBranch:branch,fetchImpl});
}
test('Existing authenticated GitHub transport provides verified CI evidence',async()=>{
 let authorization,requestUrl;
 const store=storeWithMock(async(url,options)=>{
   requestUrl=url;authorization=options.headers.authorization;
   return {ok:true,status:200,json:async()=>({workflow_runs:[{head_sha:sha,head_branch:branch,status:'completed',conclusion:'success',id:345}]})};
 });
 const run=createAuthenticatedDraftRunner({store,owner,repo,branch});
 const result=await run({plan});
 assert.equal(result.status,'PASS');
 assert.equal(result.evidenceId,'github-actions:345');
 assert.equal(authorization,'Bearer fake-test-token');
 assert.match(requestUrl,/^https:\/\/api\.github\.com\/repos\/o\/r\/actions\/runs/);
});
test('Missing token and mismatched repository or branch fail closed',async()=>{
 assert.throws(()=>createAuthenticatedDraftRunner({store:storeWithMock(async()=>{},''),owner,repo,branch}));
 const store=storeWithMock(async()=>{throw Error('must not call')});
 assert.throws(()=>createAuthenticatedDraftRunner({store,owner:'other',repo,branch}));
 const run=createAuthenticatedDraftRunner({store,owner,repo,branch});
 assert.equal((await run({plan:{...plan,environmentId:'main'}})).status,'BLOCKED');
 assert.equal((await run({plan:{...plan,operation:'powerapps_publish'}})).status,'BLOCKED');
});
test('GitHub API HTTP failure blocks CI verification',async()=>{
 const store=storeWithMock(async()=>({ok:false,status:403,text:async()=> 'forbidden'}));
 const run=createAuthenticatedDraftRunner({store,owner,repo,branch});
 assert.equal((await run({plan})).status,'BLOCKED');
});
