'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createDirectoryHumanVerifier}=require('../src/sharePointDirectoryVerifierDraft');
const {createSharePointApprovalStore}=require('../src/sharePointApprovalStoreDraft');
const id='12345678-1234-4234-8234-123456789abc';
const keys=['status','revoked','operation','siteId','listId','itemId','runtimeCommitSha','changeHash','approver','approvedAt','expiresAt','executionId','executionStatus','executionResult'];
const fieldMap=Object.fromEntries(keys.map(k=>[k,k]));
function fixture({accountEnabled=true,allow=true,fail=false}={}){
 let lookups=0;
 const verifyDirectoryHuman=createDirectoryHumanVerifier({allowedObjectIds:[allow?id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],fetchDirectoryUser:async()=>{lookups++;if(fail)throw Error('directory unavailable');return {id,accountEnabled};}});
 const writer={graphBaseUrl:'https://graph.microsoft.com/v1.0',_getAccessToken:async()=> 'token',_fetch:async()=>({ok:true,headers:{get:()=> '"3"'},json:async()=>({approver:id,status:'APPROVED'})})};
 return {store:createSharePointApprovalStore({writer,siteId:'site',listId:'list',fieldMap,verifyDirectoryHuman}),lookups:()=>lookups};
}
test('Graph approval store verifies original human twice with fresh lookups',async()=>{const {store,lookups}=fixture();const snapshot=await store.read('1');assert.equal(await store.verifyHuman(snapshot),true);assert.equal(await store.verifyHuman(snapshot),true);assert.equal(lookups(),2);});
test('Graph approval store rejects disabled, unlisted and unavailable directory identities',async()=>{for(const options of [{accountEnabled:false},{allow:false},{fail:true}]){const {store}=fixture(options);assert.equal(await store.verifyHuman(await store.read('1')),false);}});
