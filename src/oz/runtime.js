'use strict';
// Server-owned OZ adapter. Do not pass caller-supplied authority fields here.
const { createOzRouter } = require('./router');
const { createOperationsMcp, CATALOG } = require('../operationsMcp');

const READ_TOOLS = new Set(CATALOG.filter(x => x.meta.category === 'READ').map(x => x.name));
const ALLOWED = new Set(['OZ_EXECUTE', 'OZ_QUERY', 'OZ_CONTROL']);
function blocked(reasonCode) { return { status: 'BLOCKED', reasonCode }; }
function createOzRuntime(config = {}, deps = {}) {
  const operations = deps.operations || createOperationsMcp(config, deps);
  async function dispatch(input, authority = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('INVALID_INPUT');
    const { entry, operation, payload = {} } = input;
    if (!ALLOWED.has(entry) || typeof operation !== 'string' ||
        !payload || typeof payload !== 'object' || Array.isArray(payload)) return blocked('INVALID_INPUT');
    if (authority.transportAuthenticated !== true) return blocked('AUTH_REQUIRED');
    if (entry === 'OZ_CONTROL') {
      if (operation === 'capabilities') return { status: 'CONFIRMED', entries: [...ALLOWED], readOnlyOperations: [...READ_TOOLS] };
      return blocked('CONTROL_NOT_CONFIGURED');
    }
    if (entry === 'OZ_QUERY' && !READ_TOOLS.has(operation)) return blocked('QUERY_READ_ONLY');
    if (entry === 'OZ_EXECUTE') {
      // All writes remain disabled until a server-side identity, durable approval,
      // snapshot and rollback verifier are integrated. Caller flags cannot unlock them.
      if (!READ_TOOLS.has(operation)) return blocked('WRITE_LANE_NOT_AUTHORIZED');
    }
    if (!READ_TOOLS.has(operation)) return blocked('LANE_NOT_CONFIGURED');
    // Reuse existing audited operations runtime; never implement another DAG engine.
    try {
      const result = await operations.callTool(operation, payload);
      return result || blocked('EMPTY_RESULT');
    } catch {
      return blocked('LANE_FAILED');
    }
  }
  return Object.freeze({ dispatch });
}
module.exports = { createOzRuntime };
