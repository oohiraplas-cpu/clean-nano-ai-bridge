'use strict';
// Explicit opt-in Azure RBAC observation. Read-only. Assignment presence is NOT
// effective authorization proof; no secret, token or role mutation commands.
const { execFileSync } = require('node:child_process');
const RESOURCE = /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge$/i;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function observeRbac({ resourceId, principalId, run = execFileSync } = {}) {
  if (!RESOURCE.test(resourceId || '') || !GUID.test(principalId || ''))
    return Object.freeze({ status: 'blocked', reason: 'target_or_principal_unverified', effectiveRbacVerified: false });
  try {
    const raw = run('az', ['role', 'assignment', 'list',
      '--assignee-object-id', principalId, '--scope', resourceId, '--include-inherited',
      '--query', '[].{scope:scope,roleDefinitionId:roleDefinitionId,principalId:principalId}',
      '--only-show-errors', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error('invalid_result');
    const assignments = rows.slice(0, 50).filter(row => row && row.principalId?.toLowerCase() === principalId.toLowerCase())
      .map(row => ({
        scope: typeof row.scope === 'string' && row.scope.startsWith('/subscriptions/') ? row.scope.slice(0, 350) : null,
        roleDefinitionId: typeof row.roleDefinitionId === 'string' && row.roleDefinitionId.startsWith('/subscriptions/') ? row.roleDefinitionId.slice(0, 350) : null
      }));
    return Object.freeze({ status: 'observed_not_verified', assignmentCount: assignments.length,
      assignments, effectiveRbacVerified: false });
  } catch {
    return Object.freeze({ status: 'blocked', reason: 'rbac_observation_unavailable', effectiveRbacVerified: false });
  }
}
module.exports = { observeRbac };
