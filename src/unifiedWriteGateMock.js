'use strict';
// Mock-only common gate. Not connected to MCP handlers and cannot authorize production WRITE.
const crypto = require('node:crypto');
const { validateStateContext } = require('./stateManager');
const { isReadOnlyOperation } = require('./platformManage');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
};
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
async function evaluateMockUnifiedWrite({ tool, operation, params = {}, stateContext, stateSessionId, scope, registry, ledger, approval, binding, premiumScan, resolvedArtifact } = {}) {
  const deny = (reason) => ({ allowed: false, reason });
  if (typeof tool !== 'string' || typeof operation !== 'string' || isReadOnlyOperation(tool, operation)) return deny('not_unified_write');
  if (!registry || !ledger || typeof ledger.check !== 'function' || typeof premiumScan !== 'function') return deny('gate_unconfigured');
  if (!scope || !stateSessionId || !stateContext) return deny('state_missing');
  const basic = validateStateContext('update_powerapps_app', {}, stateContext);
  if (!basic.isValid) return deny('state_invalid');
  try { registry.validate(stateContext, stateSessionId, scope, params, tool); } catch { return deny('state_registry_rejected'); }
  if (!approval || !approval.requestId || !Number.isInteger(approval.stepIndex)) return deny('approval_missing');
  if (!binding || binding.tool !== tool || binding.operation !== operation ||
      binding.scope !== scope || binding.appId !== stateContext.appId ||
      binding.environment !== stateContext.environment ||
      binding.sha !== stateContext.sha || binding.paramsDigest !== digest(params)) return deny('binding_mismatch');
  const checked = await ledger.check({ requestId: approval.requestId, stepIndex: approval.stepIndex, tool });
  if (!checked.approved) return deny('approval_rejected');
  if (resolvedArtifact == null) return deny('artifact_unverified');
  try { if (premiumScan(resolvedArtifact).length) return deny('premium_or_unknown'); } catch { return deny('premium_scan_failed'); }
  // Design-only result; does NOT call handlers, enable WRITE, or mutate data.
  return { allowed: true, reason: 'mock_gate_only_no_execution' };
}
module.exports = { evaluateMockUnifiedWrite, digest };
