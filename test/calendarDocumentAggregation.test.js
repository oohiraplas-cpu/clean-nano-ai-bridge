const test = require('node:test');
const assert = require('node:assert/strict');
const {dateKey,validateDocument,monthlyTotal} = require('../src/calendarDocumentAggregation');
const receipt = {type:'receipt',calendarId:'equipment',calendarDate:'2026-09-28',fileId:'file-1',fileHash:'hash-1',amountYen:1200,category:'燃料費'};

test('選択日を保持し、重複・存在しない日付・未確定金額は停止', () => {
  assert.equal(dateKey('2026-02-30'), null);
  assert.equal(validateDocument(receipt).ok, true);
  assert.equal(validateDocument(receipt).saved, false);
  assert.equal(validateDocument(receipt,[receipt]).ok, false);
  assert.equal(validateDocument({...receipt,calendarDate:'2026-02-30'}).ok, false);
  assert.equal(validateDocument({...receipt,amountYen:'1200'}).ok, false);
});

test('月次集計は同一カレンダー・承認済み・契約で認めた領収書のみ', () => {
  const rows=[{...receipt,approvedByHuman:true,contractExpenseAllowed:true},
    {...receipt,fileHash:'hash-2',approvedByHuman:false,contractExpenseAllowed:true},
    {...receipt,fileHash:'hash-3',approvedByHuman:true,contractExpenseAllowed:false},
    {...receipt,type:'statement',approvedByHuman:true,contractExpenseAllowed:true},
    {...receipt,calendarId:'other',approvedByHuman:true,contractExpenseAllowed:true}];
  assert.equal(monthlyTotal(rows,{calendarId:'equipment',month:'2026-09',category:'燃料費'}),1200);
});
