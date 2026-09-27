// Invoice calculation prototype. Not connected to production Power Apps.
// Amounts are integer yen; tax calculations require explicit contract-approved rules.
function calculateDraft({contract, entries}) {
  if (!contract || contract.verified !== true || !contract.closingDay || !contract.paymentTermsVerified || !contract.taxRuleVerified) {
    return {status:"blocked", reason:"contract_unverified"};
  }
  if (!Array.isArray(entries)) return {status:"blocked",reason:"entries_missing"};
  const seen = new Set();
  let laborYen=0, expensesYen=0;
  const lines=[];
  for (const e of entries) {
    if (!e.approved || !e.attendanceKey || !e.siteId || !e.workType || !e.workDate) return {status:"blocked",reason:"unapproved_or_incomplete_actual"};
    const key = [e.attendanceKey,e.siteId,e.workDate,e.workType].join("|");
    if(seen.has(key)) return {status:"blocked",reason:"duplicate_actual"};
    seen.add(key);
    const rule = contract.rates?.[e.workType]?.[e.shift];
    if (!rule || !Number.isInteger(rule.yenPerUnit) || rule.yenPerUnit < 0 || !Number.isInteger(rule.unitsNumerator) || !Number.isInteger(rule.unitsDenominator) || rule.unitsDenominator <= 0 || rule.unitsNumerator < 0) return {status:"blocked",reason:"rate_or_unit_missing"};
    const numerator=rule.yenPerUnit*rule.unitsNumerator;
    if(!Number.isSafeInteger(numerator) || numerator%rule.unitsDenominator!==0) return {status:"blocked",reason:"rounding_rule_required"};
    const labor=numerator/rule.unitsDenominator;
    if (!Array.isArray(e.expenses)) return {status:"blocked",reason:"expenses_unverified"};
    let expense=0;
    for(const x of e.expenses){
      if(!x.approved || !contract.allowedExpenseCodes?.includes(x.code) || !Number.isSafeInteger(x.yen) || x.yen<0) return {status:"blocked",reason:"expense_not_contract_approved"};
      expense+=x.yen;
    }
    laborYen+=labor;expensesYen+=expense;
    if(!Number.isSafeInteger(laborYen+expensesYen))return {status:"blocked",reason:"amount_overflow"};
    lines.push({key,siteId:e.siteId,workDate:e.workDate,workType:e.workType,shift:e.shift,laborYen:labor,expensesYen:expense});
  }
  return {status:"draft",laborYen,expensesYen,subtotalYen:laborYen+expensesYen,taxYen:null,totalYen:null,requires:["tax_calculation","accounting_review","president_approval"],lines};
}
function mayFinalize(invoice){
  return !!(invoice && invoice.status==="draft" && invoice.taxCalculated===true && invoice.accountingApproved===true && invoice.presidentApproved===true && invoice.contractVerified===true && invoice.reconciliationPassed===true);
}
module.exports={calculateDraft,mayFinalize};
