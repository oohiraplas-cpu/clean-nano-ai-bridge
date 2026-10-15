'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createArmManagedIdentityTokenProvider}=require('../src/azureManagedIdentityAuth');
test('managed identity obtains ARM token only from local endpoint',async()=>{
 let req;
 const get=createArmManagedIdentityTokenProvider({env:{IDENTITY_ENDPOINT:'http://127.0.0.1:8081/msi/token',IDENTITY_HEADER:'local-secret'},fetchImpl:async(url,opts)=>{req={url,opts};return {ok:true,json:async()=>({access_token:'private-token'})};}});
 assert.equal(await get(),'private-token');
 assert.equal(new URL(req.url).searchParams.get('resource'),'https://management.azure.com/');
 assert.equal(req.opts.method,'GET');
 assert.equal(req.opts.redirect,'error');
 assert.equal(req.opts.headers['X-IDENTITY-HEADER'],'local-secret');
});
test('managed identity rejects remote endpoint and missing credentials',async()=>{
 const fn=()=>Promise.resolve({ok:true,json:async()=>({access_token:'token'})});
 await assert.rejects(createArmManagedIdentityTokenProvider({env:{IDENTITY_ENDPOINT:'https://evil.example/token',IDENTITY_HEADER:'secret'},fetchImpl:fn})());
 await assert.rejects(createArmManagedIdentityTokenProvider({env:{},fetchImpl:fn})());
});
