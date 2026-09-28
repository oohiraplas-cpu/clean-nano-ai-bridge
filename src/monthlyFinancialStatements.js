'use strict';

const {dateKey} = require('./calendarDocumentAggregation');
const TYPES = new Set(['asset','liability','equity','revenue','expense']);

function makeMonthlyStatements({month, opening, accounts, entries, coverageVerifiedByHuman = false, bankReconciledByHuman = false}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '') || !opening || !Array.isArray(accounts) || !Array.isArray(entries))
    return {status:'blocked', reason:'input_invalid'};
  const accountById = new Map();
  for (const a of accounts) {
    if (!a?.id || !TYPES.has(a.type) || a.verified !== true || accountById.has(a.id))
      return {status:'blocked', reason:'chart_unverified'};
    accountById.set(a.id,a);
  }
  if (!dateKey(opening.asOf) || opening.asOf >= `${month}-01` ||
      !opening.verifiedByHuman || !opening.balances || typeof opening.balances !== 'object')
    return {status:'blocked', reason:'opening_balance_unverified'};
  const balances = {};
  for (const [id, amount] of Object.entries(opening.balances)) {
    const account = accountById.get(id);
    if (!account || !['asset','liability','equity'].includes(account.type) || !Number.isSafeInteger(amount))
      return {status:'blocked', reason:'opening_balance_invalid'};
    balances[id] = amount;
  }
  const sumType = (type, values=balances) => accounts.filter(a=>a.type===type).reduce((sum,a)=>sum+(values[a.id]||0),0);
  if (sumType('asset') !== sumType('liability') + sumType('equity'))
    return {status:'blocked', reason:'opening_not_balanced'};
  const monthly = {}, seen = new Set(), review = [];
  for (const e of entries) {
    if (!dateKey(e?.date) || !e.id || !Array.isArray(e.lines) || !e.lines.length || e.date <= opening.asOf || e.date > `${month}-31`)
      return {status:'blocked', reason:'journal_period_invalid'};
    if (seen.has(e.id)) return {status:'blocked', reason:'duplicate_journal'};
    seen.add(e.id);
    if (e.approvedByHuman !== true) {review.push({id:e.id,reason:'unapproved_journal'});continue;}
    let debits=0, credits=0;
    for (const line of e.lines) {
      if (!accountById.has(line?.accountId) || !Number.isSafeInteger(line.debitYen) || line.debitYen < 0 ||
          !Number.isSafeInteger(line.creditYen) || line.creditYen < 0 || line.debitYen === line.creditYen)
        return {status:'blocked', reason:'journal_line_invalid'};
      debits += line.debitYen; credits += line.creditYen;
      if (!Number.isSafeInteger(debits) || !Number.isSafeInteger(credits)) return {status:'blocked',reason:'amount_overflow'};
    }
    if (debits !== credits) return {status:'blocked', reason:'journal_not_balanced'};
    for (const line of e.lines) {
      const type=accountById.get(line.accountId).type;
      const delta=['asset','expense'].includes(type) ? line.debitYen-line.creditYen : line.creditYen-line.debitYen;
      balances[line.accountId]=(balances[line.accountId]||0)+delta;
      if (e.date.startsWith(`${month}-`)) monthly[line.accountId]=(monthly[line.accountId]||0)+delta;
      if (!Number.isSafeInteger(balances[line.accountId]) || !Number.isSafeInteger(monthly[line.accountId]||0))
        return {status:'blocked',reason:'amount_overflow'};
    }
  }
  const revenueYen=sumType('revenue',monthly), expenseYen=sumType('expense',monthly);
  const cumulativeProfitYen=sumType('revenue')-sumType('expense');
  const assetsYen=sumType('asset'), liabilitiesYen=sumType('liability'), equityYen=sumType('equity');
  if (![revenueYen,expenseYen,cumulativeProfitYen,assetsYen,liabilitiesYen,equityYen].every(Number.isSafeInteger) ||
      assetsYen !== liabilitiesYen+equityYen+cumulativeProfitYen)
    return {status:'blocked',reason:'balance_sheet_not_balanced'};
  return {status:'draft', month,
    profitAndLoss:{revenueYen,expenseYen,profitYen:revenueYen-expenseYen},
    balanceSheet:{assetsYen,liabilitiesYen,equityYen,cumulativeProfitYen},
    review, complete:review.length===0 && coverageVerifiedByHuman && bankReconciledByHuman,
    finalizable:false, requires:['accounting_review','tax_review','closing_approval']};
}

module.exports={makeMonthlyStatements};
