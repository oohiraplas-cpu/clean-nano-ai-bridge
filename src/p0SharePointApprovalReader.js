'use strict';
const { ApprovalLedger, isApprovalLedgerConfigured } = require('./approvalLedger');
// Read-only adapter for the existing SharePointReader. Never returns partial results.
function createP0SharePointApprovalLedger({ reader, config, now } = {}) {
  if (!reader || typeof reader.listItems !== 'function' || !isApprovalLedgerConfigured(config)) return new ApprovalLedger();
  return new ApprovalLedger({
    config, now,
    fetchRows: async () => {
      const result = await reader.listItems({ siteId: config.siteId, listId: config.listId, top: 200 });
      if (!result || result.status !== 'ok' || result.hasMore === true || !Array.isArray(result.items)) {
        throw new Error('approval_ledger_unavailable_or_incomplete');
      }
      // The existing ApprovalLedger performs exact request, step, tool and immutable binding checks.
      return result.items.map(item => item.fields);
    }
  });
}
module.exports = { createP0SharePointApprovalLedger };
