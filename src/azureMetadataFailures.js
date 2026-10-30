'use strict';
// Diagnostics only: never use these caller-visible labels as authorization evidence.
const stages = new Set(['target_lookup', 'identity_lookup', 'deployment_history', 'metadata_reader']);
const reasons = new Set(['cli_missing', 'timeout', 'cli_exit_nonzero', 'cli_execution_failed',
  'malformed_json', 'invalid_response', 'target_not_unique', 'resource_id_mismatch',
  'identity_unverified', 'collector_failed', 'reader_failed']);
function sanitizeMetadataFailures(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4).filter(item => item &&
    stages.has(item.stage) && reasons.has(item.reason))
    .map(item => ({ stage: item.stage, reason: item.reason }));
}
function metadataFailure(stage, reason) {
  const error = new Error('azure_metadata_unavailable');
  error.metadataFailures = sanitizeMetadataFailures([{ stage, reason }]);
  return error;
}
module.exports = { sanitizeMetadataFailures, metadataFailure };
