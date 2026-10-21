'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function calculate({laborUnits,rateMinor,taxNumerator,taxDenominator,rounding}){
 if(!Array.isArray(laborUnits)||laborUnits.length===0||laborUnits.some(x=>!Number.isInteger(x)||x<0)||!Number.isSafeInteger(rateMinor)||rateMinor<0||!Number.isInteger(taxNumerator)||taxNumerator<0||!Number.isInteger(taxDenominator)||taxDenominator<=0||rounding!=='floor')return null;
 const units=laborUnits.reduce((a,b)=>a+BigInt(b),0n);
 const subtotal=units*BigInt(rateMinor);
 const tax=subtotal*BigInt(taxNumerator)/BigInt(taxDenominator);
 return {subtotal:subtotal.toString(),tax:tax.toString(),total:(subtotal+tax).toString()};
}
test('B tax exclusive and tax calculation in integer minor units',()=>assert.deepEqual(calculate({laborUnits:[2,3],rateMinor:10000,taxNumerator:10,taxDenominator:100,rounding:'floor'}),{subtotal:'50000',tax:'5000',total:'55000'}));
test('B unknown rate rejected',()=>assert.equal(calculate({laborUnits:[1],rateMinor:undefined,taxNumerator:10,taxDenominator:100,rounding:'floor'}),null));
test('B unknown rounding rejected',()=>assert.equal(calculate({laborUnits:[1],rateMinor:100,taxNumerator:10,taxDenominator:100}),null));
test('B negative labor rejected',()=>assert.equal(calculate({laborUnits:[-1],rateMinor:100,taxNumerator:10,taxDenominator:100,rounding:'floor'}),null));
