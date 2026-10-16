'use strict';

// Internal-only adapter bridge: the registered State Manager validator must be
// supplied by the server dispatcher, never by an MCP request or remote response.
async function readPacEvidenceWithRegisteredState({
  adapter, registeredRecord, validateRegisteredState, relativePath
} = {}) {
  if (typeof validateRegisteredState !== 'function'
      || !registeredRecord?.context || !registeredRecord?.source
      || typeof relativePath !== 'string'
      || relativePath !== registeredRecord.source.path
      || typeof adapter?.getSourceEvidence !== 'function')
    throw new Error('registered_state_evidence_required');
  // Registry validation must be repeated before and after the PAC read.
  const assertStateContext = () => {
    const current = validateRegisteredState();
    if (!current?.context || current.context !== registeredRecord.context
        || current.source !== registeredRecord.source)
      throw new Error('registered_state_changed');
  };
  assertStateContext();
  const result = await adapter.getSourceEvidence(relativePath, {
    stateContext: registeredRecord.context, assertStateContext
  });
  assertStateContext();
  if (result?.trustedAdapterVerified !== true || result?.status !== 'ok')
    throw new Error('trusted_pac_evidence_unavailable');
  // A trusted PAC fetch alone does not prove that the registered Git source matches.
  const crypto = require('node:crypto');
  const expectedHash = crypto.createHash('sha256').update(registeredRecord.source.content).digest('hex');
  if (typeof result.runtimeHash !== 'string' || result.runtimeHash !== expectedHash)
    throw new Error('pac_registered_source_mismatch');
  return result;
}

module.exports = { readPacEvidenceWithRegisteredState };
