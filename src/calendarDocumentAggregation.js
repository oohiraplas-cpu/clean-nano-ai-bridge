'use strict';

// A calendar date is the attachment's accounting date, independent of upload
// time. File bytes and SharePoint writes belong to a verified storage adapter.
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function validateDocument(doc, existing = []) {
  const errors = [];
  if (!doc || !['receipt', 'statement'].includes(doc.type)) errors.push('帳票区分を確認してください');
  if (!doc || !dateKey(doc.calendarDate)) errors.push('カレンダーの日付を確認してください');
  if (!doc || !doc.calendarId || !doc.fileId || !doc.fileHash) errors.push('カレンダーまたは添付ファイルがありません');
  if (!doc || !Number.isSafeInteger(doc.amountYen) || doc.amountYen < 0) errors.push('金額を確認してください');
  if (doc?.fileHash && existing.some(row => row.calendarId === doc.calendarId && row.calendarDate === doc.calendarDate && row.fileHash === doc.fileHash))
    errors.push('同じ日付に同じファイルが登録されています');
  return {ok: errors.length === 0, errors, requiresHumanApproval: true, saved: false};
}

function monthlyTotal(rows, { calendarId, month, category }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || !calendarId) throw new Error('対象カレンダーまたは月が不正です');
  return rows.filter(row => row.calendarId === calendarId && row.calendarDate?.startsWith(`${month}-`) && row.category === category && row.approvedByHuman === true && row.contractExpenseAllowed === true && row.type === 'receipt' && Number.isSafeInteger(row.amountYen))
    .reduce((sum, row) => sum + row.amountYen, 0);
}

module.exports = {dateKey, validateDocument, monthlyTotal};
