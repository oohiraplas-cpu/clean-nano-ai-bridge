'use strict';
// Deterministic extraction from OCR engine text. Ambiguous fields are rejected.
const {validateOcrCandidate} = require('./equipmentOcrValidation');
const customerPattern = /(?:お客さま番号|お客様番号|顧客番号)[^0-9０-９]{0,8}([0-9０-９]{2})[\s-]*([0-9０-９]{6})[\s-]*([0-9０-９]{2})/gu;
const receptionPattern = /(?:受付番号|通知No\.?)[^0-9０-９]{0,8}([0-9０-９]{5})/gu;
function uniqueMatches(text, re, map) {
 const matches=[...String(text||'').matchAll(re)].map(map);
 return [...new Set(matches)];
}
function extractCandidate(text, masterRows) {
 const numbers=uniqueMatches(text,customerPattern,m=>[m[1],m[2],m[3]].join('-').normalize('NFKC'));
 const receptions=uniqueMatches(text,receptionPattern,m=>m[1].normalize('NFKC'));
 if(numbers.length!==1) return {ok:false,errors:[numbers.length?'顧客番号候補が複数あります':'顧客番号を一意に認識できません'],saved:false};
 const matches=masterRows.filter(row=>String(row.customerNumber||'').replace(/[^0-9]/g,'')===numbers[0].replace(/[^0-9]/g,''));
 if(matches.length!==1)return {ok:false,errors:[matches.length?'マスタの顧客番号が重複しています':'マスタに該当する顧客番号がありません'],saved:false};
 const row=matches[0];
 if(receptions.length && (receptions.length!==1||receptions[0]!==String(row.receptionNumber)))return {ok:false,errors:['受付番号が一致しません'],saved:false};
 // OCR address must be independently present; master address must not be silently copied as recognized text.
 const address=String(row.address||'');
 if(!address||!String(text).normalize('NFKC').replace(/\s+/g,'').includes(address.normalize('NFKC').replace(/\s+/g,'')))return {ok:false,errors:['住所を独立して認識・照合できません'],saved:false};
 const validated=validateOcrCandidate({customerNumber:numbers[0],address},masterRows);
 return {...validated,source:'ocr-text',receptionNumber:row.receptionNumber,requiresHumanApproval:true,saved:false};
}
module.exports={extractCandidate};
