const test=require('node:test');
const assert=require('node:assert/strict');
const {monthlyDraft}=require('../src/monthlyAccountingDraft');
const base={type:'receipt',calendarId:'demolition',calendarDate:'2026-09-28',fileId:'r1',fileHash:'hash1',amountYen:1200,vendorId:'fuel-vendor',expenseCode:'fuel',approvedByHuman:true,businessUseVerified:true};
const rules=[{verified:true,vendorId:'fuel-vendor',expenseCode:'fuel',category:'燃料費'}];

test('各カレンダーの領収書を月次に集め、明細と重複を計上しない',()=>{
 const documents=[base,{...base,calendarId:'equipment',fileId:'r2',fileHash:'hash2',amountYen:800},
  {...base,calendarId:'operations',fileId:'r3',type:'statement',fileHash:'hash3',amountYen:2000},
  {...base,calendarId:'operations',fileId:'r4',fileHash:'hash1'},
  {...base,calendarId:'operations',fileId:'r5',fileHash:'hash5',calendarDate:'2026-10-01'}];
 const result=monthlyDraft({month:'2026-09',documents,rules});
 assert.equal(result.status,'draft'); assert.equal(result.expenseYen,2000);
 assert.equal(result.totalsByCategory['燃料費'],2000);
 assert.equal(result.accepted.length,2); assert.equal(result.review[0].reason,'duplicate_across_calendars');
 assert.equal(result.revenueYen,null); assert.equal(result.operatingDifferenceYen,null);
 assert.equal(result.finalizable,false);
});

test('未承認・私用・未確認費目は保留し、収入は承認済み台帳だけ',()=>{
 const documents=[{...base,approvedByHuman:false},
  {...base,fileId:'r2',fileHash:'hash2',businessUseVerified:false},
  {...base,fileId:'r3',fileHash:'hash3',vendorId:'unknown'}];
 const result=monthlyDraft({month:'2026-09',documents,rules,revenue:[
  {month:'2026-09',amountYen:10000,approvedByHuman:true},
  {month:'2026-09',amountYen:5000,approvedByHuman:false}]});
 assert.equal(result.expenseYen,0); assert.equal(result.review.length,3);
 assert.equal(result.revenueYen,10000); assert.equal(result.finalizable,false);
});
