'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function layout({registeredActiveWorkers,previewVerified,persistenceVerified}){
 if(!Number.isInteger(registeredActiveWorkers)||registeredActiveWorkers<1||previewVerified!==true||persistenceVerified!==true)return null;
 const columns=['人数','人工数',...(registeredActiveWorkers===1?['税別単価']:[]),'税別金額','消費税','税込合計'];
 return {columns,showRate:registeredActiveWorkers===1};
}
const base={registeredActiveWorkers:1,previewVerified:true,persistenceVerified:true};
test('D one worker has rate column',()=>assert.equal(layout(base).columns.includes('税別単価'),true));
test('D multiple workers omit rate column',()=>{for(const n of [2,3,9]){const r=layout({...base,registeredActiveWorkers:n});assert.equal(r.showRate,false);assert.equal(r.columns.includes('税別単価'),false)}});
test('D unknown worker count fails closed',()=>assert.equal(layout({...base,registeredActiveWorkers:undefined}),null));
test('D unverified PDF persistence fails closed',()=>assert.equal(layout({...base,persistenceVerified:false}),null));
