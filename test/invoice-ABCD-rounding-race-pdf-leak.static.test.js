'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
function calc(lines,rateYen,basisPoints,roundingStage){
 if(!['invoice','line'].includes(roundingStage)||!Array.isArray(lines)||!lines.every(x=>Number.isInteger(x)&&x>=0)||!Number.isSafeInteger(rateYen)||rateYen<0||!Number.isInteger(basisPoints)||basisPoints<0)return null;
 const n=lines.map(x=>BigInt(x)*BigInt(rateYen));
 const subtotal=roundingStage==='line'?n.reduce((s,x)=>s+x/1000n,0n):n.reduce((s,x)=>s+x,0n)/1000n;
 return {subtotal:subtotal.toString(),tax:(subtotal*BigInt(basisPoints)/10000n).toString()};
}
function claim(key,requestId,serverUnique,stored){
 if(!key||!requestId||!serverUnique)return 'DENY';
 if(!stored)return 'CREATE_ATTEMPT';
 if(stored.key===key&&stored.requestId===requestId&&stored.status==='Committed')return 'REPLAY';
 return 'CONFLICT';
}
function sanitizedPdfPayload({workers,subtotal,tax,total,rate}){
 if(!Number.isInteger(workers)||workers<1)return null;
 const out={workers,subtotal,tax,total};
 if(workers===1)out.rate=rate;
 out.metadata={documentType:'invoice',version:1};
 return out;
}
test('invoice vs line rounding differ and must be specified',()=>{const lines=[500,500];assert.deepEqual(calc(lines,1,1000,'invoice'),{subtotal:'1',tax:'0'});assert.deepEqual(calc(lines,1,1000,'line'),{subtotal:'0',tax:'0'})});
test('rounding stage missing denied',()=>assert.equal(calc([1000],100,1000,undefined),null));
test('concurrent second request conflicts after first reservation',()=>assert.equal(claim('p1:L1','r2',true,{key:'p1:L1',requestId:'r1',status:'Reserved'}),'CONFLICT'));
test('same committed request is replay not new claim',()=>assert.equal(claim('p1:L1','r1',true,{key:'p1:L1',requestId:'r1',status:'Committed'}),'REPLAY'));
test('unproven server uniqueness denied',()=>assert.equal(claim('p1:L1','r1',false,null),'DENY'));
test('multiple worker serialized payload excludes rate and untrusted metadata',()=>{const o=sanitizedPdfPayload({workers:2,subtotal:'1000',tax:'100',total:'1100',rate:77777});assert.equal(JSON.stringify(o).includes('77777'),false);assert.equal(JSON.stringify(o).includes('unitRate'),false)});
test('single worker includes rate',()=>assert.equal(sanitizedPdfPayload({workers:1,subtotal:'1000',tax:'100',total:'1100',rate:77777}).rate,77777));
test('zero workers rejected',()=>assert.equal(sanitizedPdfPayload({workers:0,subtotal:'0',tax:'0',total:'0',rate:1}),null));
