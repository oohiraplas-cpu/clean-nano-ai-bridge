'use strict';
// Never return stderr, command arguments, environment variables, or tokens.
function classifyAzureCliFailure(error) {
  if (error?.code === 'ENOENT') return 'cli_missing';
  if (error?.code === 'ETIMEDOUT' || error?.killed === true) return 'cli_timeout';
  const detail = String(error?.stderr || '').toLowerCase();
  if (/please run ['"]?az login|not logged in|login required|az login/.test(detail)) return 'authentication_required';
  if (/authorizationfailed|does not have authorization|forbidden|permission denied|insufficient privileges/.test(detail)) return 'access_denied';
  if (/resourcenotfound|resource not found|could not be found/.test(detail)) return 'resource_not_found';
  if (/connection|network|dns|temporarily unavailable|timed out/.test(detail)) return 'network_unavailable';
  return 'cli_failure_unclassified';
}
module.exports = { classifyAzureCliFailure };
