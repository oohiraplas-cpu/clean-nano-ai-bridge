'use strict';
// Readback verifier for the Draft SharePoint mutation executor.
// Rejects incomplete pages, ambiguous columns and partial field matches.
function exactFields(actual, expected) {
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.entries(expected).every(([key,value]) => Object.prototype.hasOwnProperty.call(actual,key) && JSON.stringify(actual[key])===JSON.stringify(value));
}
function createSharePointReadback(writer) {
  return async function readback({plan,result}) {
    if (!writer || !plan || !result) return false;
    try {
      switch(plan.operation) {
        case 'create_list': {
          if (!result.id || typeof writer.getList !== 'function') return false;
          const actual=await writer.getList(plan.siteId,result.id);
          return actual?.id===result.id && actual?.displayName===plan.params.displayName;
        }
        case 'create_column': {
          if (!result.id || typeof writer.getColumns !== 'function') return false;
          const columns=await writer.getColumns(plan.siteId,plan.listId);
          if (!Array.isArray(columns?.value) || columns['@odata.nextLink']) return false;
          const found=columns.value.filter(c=>c.id===result.id && c.name===plan.params.name);
          return found.length===1 && found[0].displayName===plan.params.displayName &&
            ['text','number','boolean','dateTime','choice'].filter(t=>Object.hasOwn(plan.params.columnDefinition,t)).every(t=>found[0][t]!==undefined);
        }
        case 'create_item': {
          if (!result.id || typeof writer.getItemFields !== 'function') return false;
          const fields=await writer.getItemFields(plan.siteId,plan.listId,result.id);
          return exactFields(fields,plan.params.fields);
        }
        case 'update_item': {
          if (typeof writer.getItemFields !== 'function') return false;
          const fields=await writer.getItemFields(plan.siteId,plan.listId,plan.itemId);
          return exactFields(fields,plan.params.fields);
        }
        default: return false;
      }
    } catch { return false; }
  };
}
module.exports={createSharePointReadback};
