const test=require('node:test');const assert=require('node:assert/strict');const {extractCandidate}=require('../src/equipmentOcrExtraction');
const master=[{customerNumber:'02-027652-20',receptionNumber:'91808',address:'中央区新川1-25-16'}];
test('帳票の顧客番号と住所を独立認識',()=>{const r=extractCandidate('受付番号 91808 お客さま番号 02-027652-20 中央区新川1-25-16',master);assert.equal(r.ok,true);assert.equal(r.saved,false)});
test('住所未認識はマスタ補完せず停止',()=>assert.equal(extractCandidate('お客さま番号 02-027652-20',master).ok,false));
test('候補が複数なら停止',()=>assert.equal(extractCandidate('お客さま番号 02-027652-20 お客さま番号 02-027653-20 中央区新川1-25-16',master).ok,false));
test('受付番号不一致は停止',()=>assert.equal(extractCandidate('受付番号 91809 お客さま番号 02-027652-20 中央区新川1-25-16',master).ok,false));
