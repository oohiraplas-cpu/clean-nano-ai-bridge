'use strict';

const {dateKey} = require('./calendarDocumentAggregation');

function classify(document, rules) {
  // Rules must be reviewed accounting mappings, not labels invented from OCR.
  const matching = rules.filter(rule => rule.verified === true &&
    rule.vendorId === document.vendorId &&
    (!rule.expenseCode || rule.expenseCode === document.expenseCode));
  const categories = [...new Set(matching.map(rule => rule.category))];
  return categories.length === 1 ? categories[0] : null;
}

function monthlyDraft({month, documents, rules = [], revenue = []}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || !Array.isArray(documents) || !Array.isArray(rules) || !Array.isArray(revenue))
    return {status:'blocked', reason:'input_invalid'};

  const seen = new Set(), accepted = [], review = [], excluded = [];
  let expenseYen = 0;
  const totalsByCategory = {};
  for (const d of documents) {
    if (!dateKey(d?.calendarDate) || !d.calendarId || !d.fileId || !d.fileHash || !Number.isSafeInteger(d.amountYen) || d.amountYen < 0) {
      review.push({fileId:d?.fileId ?? null, reason:'incomplete_or_invalid'}); continue;
    }
    if (!d.calendarDate.startsWith(`${month}-`)) continue;
    if (d.type !== 'receipt') { excluded.push({fileId:d.fileId, reason:'statement_not_receipt'}); continue; }
    if (seen.has(d.fileHash)) { review.push({fileId:d.fileId, reason:'duplicate_across_calendars'}); continue; }
    seen.add(d.fileHash);
    if (d.approvedByHuman !== true || d.businessUseVerified !== true) {
      review.push({fileId:d.fileId, reason:'receipt_unapproved'}); continue;
    }
    const category = classify(d, rules);
    if (!category) { review.push({fileId:d.fileId, reason:'account_unclassified'}); continue; }
    expenseYen += d.amountYen;
    totalsByCategory[category] = (totalsByCategory[category] || 0) + d.amountYen;
    if (!Number.isSafeInteger(expenseYen) || !Number.isSafeInteger(totalsByCategory[category])) return {status:'blocked', reason:'amount_overflow'};
    accepted.push({fileId:d.fileId, calendarId:d.calendarId, calendarDate:d.calendarDate, category, amountYen:d.amountYen});
  }
  // Revenue may only come from a separately verified ledger. Missing revenue
  // never silently becomes zero, and OCR receipts do not create sales.
  const verifiedRevenue = revenue.filter(r => r.month === month && r.approvedByHuman === true && Number.isSafeInteger(r.amountYen) && r.amountYen >= 0);
  const revenueYen = verifiedRevenue.length ? verifiedRevenue.reduce((sum,r)=>sum+r.amountYen,0) : null;
  if (revenueYen !== null && !Number.isSafeInteger(revenueYen)) return {status:'blocked', reason:'amount_overflow'};
  return {status:'draft', month, expenseYen, totalsByCategory, revenueYen,
    operatingDifferenceYen: revenueYen === null ? null : revenueYen - expenseYen,
    accepted, review, excluded,
    requires:['accounting_review','bank_reconciliation','tax_review','closing_approval'],
    finalizable:false};
}

module.exports = {classify, monthlyDraft};
