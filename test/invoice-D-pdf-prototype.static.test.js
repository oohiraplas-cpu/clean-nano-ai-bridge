'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
// Non-connected text layout prototype, NOT a generated PDF or production authorization.
function preview(snapshot){
 if(!snapshot||!Number.isInteger(snapshot.activeRegisteredWorkers)||snapshot.activeRegisteredWorkers<1||!snapshot.verified||!Number.isSafeInteger(snapshot.subtotalYen)||!Number.isSafeInteger(snapshot.taxYen)||!Number.isSafeInteger(snapshot.totalYen)||snapshot.totalYen!==snapshot.subtotalYen+snapshot.taxYen)return null;
 const showRate=snapshot.activeRegisteredWorkers===1;
 if(showRate&&!Number.isSafeInteger(snapshot.taxExclusiveRateYen))return null;
 const rows=[['対象人数',String(snapshot.activeRegisteredWorkers)],['人工数',String(snapshot.laborDisplay)],...(showRate?[['税別単価',String(snapshot.taxExclusiveRateYen)]]:[]),['税別請求額',String(snapshot.subtotalYen)],['消費税',String(snapshot.taxYen)],['税込合計',String(snapshot.totalYen)]];
 return rows.map(x=>x.join(':')).join('\n');
}
const base={activeRegisteredWorkers:1,verified:true,subtotalYen:100000,taxYen:10000,totalYen:110000,laborDisplay:'5',taxExclusiveRateYen:20000};
test('D one worker shows rate in static preview',()=>assert.match(preview(base),/税別単価:20000/));
test('D two workers entirely omit unit rate',()=>{const p=preview({...base,activeRegisteredWorkers:2});assert.doesNotMatch(p,/税別単価|20000/);assert.match(p,/税込合計:110000/)});
test('D unknown roster fails closed',()=>assert.equal(preview({...base,activeRegisteredWorkers:null}),null));
test('D unverified snapshot fails closed',()=>assert.equal(preview({...base,verified:false}),null));
test('D inconsistent totals fail closed',()=>assert.equal(preview({...base,totalYen:110001}),null));
test('D one worker missing rate fails closed',()=>assert.equal(preview({...base,taxExclusiveRateYen:undefined}),null));
