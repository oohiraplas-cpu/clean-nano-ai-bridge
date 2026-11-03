'use strict';
// Read-only capability inventory. Never dispatches a Power Platform operation.
const DOMAINS = Object.freeze(['powerapps','powerautomate','sharepoint','dataverse','copilotstudio','powerpages','powerbi','forms','admin']);
const RULES = Object.freeze({
 powerapps:/powerapps|canvas|powerfx/i,
 powerautomate:/powerautomate|power_automate|flow_/i,
 sharepoint:/sharepoint|employee_ledger/i,
 dataverse:/dataverse/i,
 copilotstudio:/copilot|agent_registry/i,
 powerpages:/powerpages|power_pages/i,
 powerbi:/powerbi|power_bi/i,
 forms:/microsoftforms|forms_/i,
 admin:/environment|permissions|deployment/i
});
function inventory(definitions) {
 if (!Array.isArray(definitions)) throw new TypeError('tool definitions required');
 const result = Object.fromEntries(DOMAINS.map(d=>[d,{tools:[],status:'UNVERIFIED'}]));
 const seen = new Set();
 for (const item of definitions) {
  if (!item || typeof item.name !== 'string' || !item.name || seen.has(item.name)) throw new Error('invalid or duplicate tool');
  seen.add(item.name);
  for (const domain of DOMAINS) if (RULES[domain].test(item.name)) result[domain].tools.push(item.name);
 }
 for (const domain of DOMAINS) if (result[domain].tools.length) result[domain].status='SOURCE_DISCOVERED_NOT_TESTED';
 return result;
}
module.exports={DOMAINS,inventory};
