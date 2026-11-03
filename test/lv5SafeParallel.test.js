'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inventory,DOMAINS}=require('../src/lv5CapabilityAudit');
const {runReadBatch}=require('../src/lv5SafeParallel');
test('inventory distinguishes source discovery from verified operation',()=>{
 const r=inventory([{name:'powerapps_manage'},{name:'powerautomate_manage'},{name:'get_sharepoint_list'}]);
 assert.equal(DOMAINS.length,9);
 assert.equal(r.powerapps.status,'SOURCE_DISCOVERED_NOT_TESTED');
 assert.equal(r.powerpages.status,'UNVERIFIED');
 assert.throws(()=>inventory([{name:'x'},{name:'x'}]),/duplicate/);
});
test('parallel reads require authorization and registered handlers',async()=>{
 let count=0;
 const r=await runReadBatch([
  {domain:'powerapps',action:'get',target:'a'},
  {domain:'sharepoint',action:'list',target:'b'},
  {domain:'powerapps',action:'delete',target:'a'},
  {domain:'powerbi',action:'get',target:'c'}
 ],{authorize:async req=>req.domain!=='sharepoint',handlers:{powerapps:async()=>++count},maxConcurrent:2});
 assert.deepEqual(r.map(x=>x.status),['OBSERVED','BLOCKED','BLOCKED','BLOCKED']);
 assert.equal(count,1);
});
test('unknown and write operations never reach handlers',async()=>{
 let invoked=false;
 const r=await runReadBatch([{domain:'admin',action:'publish',target:'prod'},{domain:'unknown',action:'get',target:'x'}],{authorize:()=>true,handlers:{admin:()=>{invoked=true;}}});
 assert.equal(invoked,false);
 assert.deepEqual(r.map(x=>x.reason),['invalid_or_mutating_request','invalid_or_mutating_request']);
});
test('missing authorization callback fails closed',async()=>{
 await assert.rejects(()=>runReadBatch([{domain:'forms',action:'get',target:'f'}]),/authorization callback required/);
});
