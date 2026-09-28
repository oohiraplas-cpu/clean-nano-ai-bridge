const test=require('node:test');const assert=require('node:assert/strict');
const {makeMonthlyStatements}=require('../src/monthlyFinancialStatements');
const accounts=[
 {id:'cash',type:'asset',verified:true},{id:'receivable',type:'asset',verified:true},
 {id:'payable',type:'liability',verified:true},{id:'capital',type:'equity',verified:true},
 {id:'sales',type:'revenue',verified:true},{id:'fuel',type:'expense',verified:true}];
const opening={asOf:'2026-08-31',verifiedByHuman:true,balances:{cash:10000,capital:10000}};
const entries=[
 {id:'sale',date:'2026-09-03',approvedByHuman:true,lines:[{accountId:'receivable',debitYen:5000,creditYen:0},{accountId:'sales',debitYen:0,creditYen:5000}]},
 {id:'receipt',date:'2026-09-28',approvedByHuman:true,lines:[{accountId:'fuel',debitYen:1200,creditYen:0},{accountId:'cash',debitYen:0,creditYen:1200}]}];
test('承認済み複式仕訳から損益表と一致する貸借対照表の下書き',()=>{
 const r=makeMonthlyStatements({month:'2026-09',opening,accounts,entries});
 assert.deepEqual(r.profitAndLoss,{revenueYen:5000,expenseYen:1200,profitYen:3800});
 assert.deepEqual(r.balanceSheet,{assetsYen:13800,liabilitiesYen:0,equityYen:10000,cumulativeProfitYen:3800});
 assert.equal(r.complete,false);assert.equal(r.finalizable,false);
});
test('期首不一致・不均衡仕訳・重複仕訳を停止',()=>{
 assert.equal(makeMonthlyStatements({month:'2026-09',opening:{...opening,balances:{cash:9000,capital:10000}},accounts,entries}).reason,'opening_not_balanced');
 assert.equal(makeMonthlyStatements({month:'2026-09',opening,accounts,entries:[{...entries[0],lines:[entries[0].lines[0]]}]}).reason,'journal_not_balanced');
 assert.equal(makeMonthlyStatements({month:'2026-09',opening,accounts,entries:[entries[0],entries[0]]}).reason,'duplicate_journal');
});
