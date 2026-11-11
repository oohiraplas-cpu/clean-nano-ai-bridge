'use strict';
// CNAI Router: minimal local orchestration core.
//
// request -> classify -> route selection (with free-route fallback for paid routes)
// -> policy/risk gate -> dispatch (adapter boundary) -> verification -> audit -> checkpoint -> response.
//
// Scope: in-process state only (same model as windowsJobs/executionQueue; a Bridge restart clears it).
// This module never claims an unconfirmed result is COMPLETED, and it never fabricates execution
// against a system it cannot reach (most concretely: externalAiReference / blockedPaidRoute).
//
// Reused, not reimplemented:
//  - windowsJobs.js for the windowsExecutor route (submit/риск gate already exists there).
//  - secretMasking.js for anything stored in the audit trail or echoed back.

const crypto = require('node:crypto');
const windowsJobs = require('./windowsJobs');
const { maskDeep, maskSecrets } = require('./secretMasking');

const ROUTES = Object.freeze([
  'microsoft365',
  'sharepoint',
  'powerPlatformStandard',
  'operationsMcp',
  'windowsExecutor',
  'localCode',
  'externalAiReference',
  'blockedPaidRoute'
]);

const EXECUTION_STATUSES = Object.freeze([
  'RECEIVED', 'CLASSIFIED', 'ROUTED', 'QUEUED', 'RUNNING', 'VERIFYING',
  'COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'ROLLED_BACK'
]);

const RESUMABLE_STATUSES = Object.freeze(['FAILED', 'BLOCKED']);
const MAX_HISTORY = 200;

const PLATFORM_ROUTE_MAP = Object.freeze({
  microsoft365: 'microsoft365', m365: 'microsoft365', teams: 'microsoft365', outlook: 'microsoft365',
  sharepoint: 'sharepoint',
  powerapps: 'powerPlatformStandard', powerautomate: 'powerPlatformStandard',
  powerplatform: 'powerPlatformStandard', copilotstudio: 'powerPlatformStandard',
  operationsmcp: 'operationsMcp', mcp: 'operationsMcp',
  windows: 'windowsExecutor', executor: 'windowsExecutor', windowsexecutor: 'windowsExecutor',
  code: 'localCode', git: 'localCode', test: 'localCode', ci: 'localCode', local: 'localCode',
  chatgpt: 'externalAiReference', gemini: 'externalAiReference', rakuten: 'externalAiReference',
  japanai: 'externalAiReference', externalai: 'externalAiReference',
  premium: 'blockedPaidRoute', paid: 'blockedPaidRoute'
});

// Known free, already-licensed alternative per capability, used only when a paid/unreachable
// route was selected. Unknown capability -> no silent guess -> the task (not the whole router) BLOCKS.
const CAPABILITY_FREE_ROUTE = Object.freeze({
  general_question: 'microsoft365',
  document_search: 'sharepoint',
  workflow_automation: 'powerPlatformStandard',
  code_task: 'localCode',
  background_job: 'windowsExecutor'
});

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function notFoundError(message) {
  return requestError(message, 404);
}

function now() {
  return new Date().toISOString();
}

function asTrimmedString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function createRouterState() {
  return { requests: new Map(), byIdempotencyKey: new Map() };
}

// Process-wide router used by the HTTP routes and the MCP tool.
const defaultState = createRouterState();

function pushCapped(list, entry) {
  list.push(entry);
  if (list.length > MAX_HISTORY) list.shift();
}

function audit(record, event, detail) {
  pushCapped(record.auditTrail, { event, detail: maskDeep(detail ?? null), timestamp: now() });
}

function checkpoint(record, stage) {
  pushCapped(record.checkpointHistory, { stage, timestamp: now() });
  record.checkpointId = `${record.requestId}#${record.checkpointHistory.length}`;
}

function classify(input) {
  const requestType = asTrimmedString(input.requestType);
  if (!requestType) throw requestError('requestTypeは必須です');

  const explicitRoute = asTrimmedString(input.route);
  if (explicitRoute && !ROUTES.includes(explicitRoute)) throw requestError(`routeは${ROUTES.join(', ')}のいずれかである必要があります`);

  const platformHint = asTrimmedString(input.platformHint)?.toLowerCase() || null;
  const mappedRoute = platformHint ? PLATFORM_ROUTE_MAP[platformHint] : null;
  const route = explicitRoute || mappedRoute;
  if (!route) throw requestError('platformHintまたはrouteのいずれかを指定してください（未知のplatformHintから推測はしません）');

  const riskLevel = windowsJobs.normalizeRiskLevel(input.riskLevel) || 'LOW';

  return { requestType, platformHint, riskLevel, route };
}

function findFreeAlternative(requiredCapability) {
  const capability = asTrimmedString(requiredCapability);
  return (capability && CAPABILITY_FREE_ROUTE[capability]) || null;
}

function computeInitialCostClass(route, input) {
  if (route === 'blockedPaidRoute') return 'PAID';
  if (route === 'externalAiReference') return input.costHint === 'FREE' ? 'FREE' : 'PAID';
  return 'FREE';
}

/** Route selection: paid/unreachable routes are swapped for a free alternative when one exists. */
function selectRoute(classification, input) {
  let selectedRoute = classification.route;
  let costClass = computeInitialCostClass(selectedRoute, input);
  let fallbackRoute = null;

  const needsFallback = selectedRoute === 'blockedPaidRoute'
    || (selectedRoute === 'externalAiReference' && costClass === 'PAID' && input.allowPaid !== true);

  if (needsFallback) {
    const candidate = findFreeAlternative(input.requiredCapability);
    if (candidate) {
      fallbackRoute = candidate;
      selectedRoute = candidate;
      costClass = 'FREE';
    }
    // else: stays on the paid/unreachable route; dispatch() will BLOCK this task only.
  }

  return { selectedRoute, fallbackRoute, costClass };
}

function externalAiDescriptor(record, input) {
  return {
    provider: record.platformHint || 'unknown',
    availability: 'unavailable_from_this_session',
    costClass: record.costClass,
    requiredCapability: asTrimmedString(input.requiredCapability),
    fallbackRoute: record.fallbackRoute,
    verificationStatus: 'UNVERIFIED'
  };
}

async function dispatch(record, input, adapters) {
  if (record.selectedRoute === 'blockedPaidRoute') {
    return { success: false, verified: false, errorCode: 'PAID_ROUTE_BLOCKED', errorSummary: '追加課金が発生するRouteで、無料の代替Routeが見つかりませんでした（このタスクのみBLOCKED）' };
  }

  if (record.selectedRoute === 'externalAiReference') {
    const descriptor = adapters.externalAiReference
      ? await adapters.externalAiReference(record, input)
      : externalAiDescriptor(record, input);
    const available = descriptor.availability === 'available';
    return {
      success: available,
      verified: false,
      output: descriptor,
      errorCode: available ? null : 'EXTERNAL_AI_UNAVAILABLE',
      errorSummary: available ? null : `外部AI(${descriptor.provider})はこのセッションから実接続できません（実行済みとして報告しません）`
    };
  }

  const adapter = adapters[record.selectedRoute];
  if (!adapter) {
    return { success: false, verified: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorSummary: `${record.selectedRoute} 用のアダプターが未設定です` };
  }

  try {
    const result = await adapter(record, input);
    return {
      success: result?.success !== false,
      verified: result?.verified === true,
      output: result,
      errorCode: result?.errorCode || null,
      errorSummary: result?.errorSummary || null
    };
  } catch (err) {
    return { success: false, verified: false, errorCode: 'ADAPTER_ERROR', errorSummary: err.message };
  }
}

function deriveStatus(dispatchResult) {
  if (dispatchResult.success && dispatchResult.verified) return { executionStatus: 'COMPLETED', verificationStatus: 'VERIFIED' };
  if (dispatchResult.success && !dispatchResult.verified) return { executionStatus: 'PARTIAL', verificationStatus: 'UNVERIFIED' };
  const blockingCodes = ['ADAPTER_NOT_CONFIGURED', 'HUMAN_APPROVAL_REQUIRED', 'PAID_ROUTE_BLOCKED', 'EXTERNAL_AI_UNAVAILABLE'];
  if (blockingCodes.includes(dispatchResult.errorCode)) return { executionStatus: 'BLOCKED', verificationStatus: 'UNVERIFIED' };
  return { executionStatus: 'FAILED', verificationStatus: 'FAILED' };
}

/** Built-in windowsExecutor adapter: reuses windowsJobs' own risk gate and idempotency (by taskId=requestId). */
function createWindowsExecutorAdapter(jobState = windowsJobs.defaultState) {
  return (record, input) => {
    const result = windowsJobs.submitWindowsJob(jobState, {
      taskId: record.requestId,
      action: record.requestType,
      workspace: asTrimmedString(input.workspace) || '.',
      riskLevel: record.riskLevel
    }, 'cnai_router');
    if (result.status === 'WAITING_FOR_APPROVAL') {
      return { success: false, errorCode: 'HUMAN_APPROVAL_REQUIRED', errorSummary: 'HIGH/CRITICALは人間承認待ちです（Windows Executorへは渡されません）', ...result };
    }
    // The job is only QUEUED here; actual completion is reported later via /job/result.
    // Reporting COMPLETED/VERIFIED now would be an unconfirmed-result false positive.
    return { success: true, verified: false, ...result };
  };
}

/** Built-in localCode adapter: deterministic, safe, no external call — used for local E2E gates. */
function localCodeAdapter(record, input) {
  return { success: true, verified: true, echoed: maskDeep(input.payload ?? null) };
}

function defaultAdapters(options = {}) {
  return {
    windowsExecutor: createWindowsExecutorAdapter(options.jobState),
    localCode: localCodeAdapter,
    ...options.adapters
  };
}

function find(state, requestId) {
  const record = state.requests.get(requestId);
  if (!record) throw notFoundError('CNAI Router依頼が見つかりません');
  return record;
}

function snapshot(record) {
  return {
    requestId: record.requestId,
    correlationId: record.correlationId,
    idempotencyKey: record.idempotencyKey,
    requestType: record.requestType,
    riskLevel: record.riskLevel,
    costClass: record.costClass,
    selectedRoute: record.selectedRoute,
    fallbackRoute: record.fallbackRoute,
    executionStatus: record.executionStatus,
    verificationStatus: record.verificationStatus,
    checkpointId: record.checkpointId,
    auditId: record.auditId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    errorCode: record.errorCode,
    errorSummary: record.errorSummary,
    lastDispatchOutput: record.lastDispatchOutput ?? null
  };
}

async function dispatchAndVerify(record, input, adapters) {
  record.executionStatus = 'RUNNING';
  audit(record, 'RUNNING', { selectedRoute: record.selectedRoute });
  checkpoint(record, 'RUNNING');

  const dispatchResult = await dispatch(record, input, adapters);

  record.executionStatus = 'VERIFYING';
  audit(record, 'VERIFYING', { dispatchSuccess: dispatchResult.success, errorCode: dispatchResult.errorCode });
  checkpoint(record, 'VERIFYING');

  const derived = deriveStatus(dispatchResult);
  record.executionStatus = derived.executionStatus;
  record.verificationStatus = derived.verificationStatus;
  record.errorCode = dispatchResult.errorCode || null;
  record.errorSummary = dispatchResult.errorSummary ? maskSecrets(dispatchResult.errorSummary) : null;
  record.completedAt = now();
  record.lastDispatchOutput = maskDeep(dispatchResult.output ?? null);

  audit(record, record.executionStatus, { verificationStatus: record.verificationStatus, errorCode: record.errorCode });
  checkpoint(record, record.executionStatus);

  return snapshot(record);
}

/** Main entry point: classify -> route -> dispatch -> verify -> audit -> checkpoint -> response. */
async function routeRequest(state, input = {}, adapters = defaultAdapters()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw requestError('inputはJSONオブジェクトである必要があります');

  const idempotencyKey = asTrimmedString(input.idempotencyKey);
  if (idempotencyKey && state.byIdempotencyKey.has(idempotencyKey)) {
    const existing = state.requests.get(state.byIdempotencyKey.get(idempotencyKey));
    return { ...snapshot(existing), duplicate: true };
  }

  const requestId = crypto.randomUUID();
  const record = {
    requestId,
    correlationId: asTrimmedString(input.correlationId) || crypto.randomUUID(),
    idempotencyKey: idempotencyKey || null,
    platformHint: null,
    requestType: null,
    riskLevel: null,
    costClass: null,
    selectedRoute: null,
    fallbackRoute: null,
    executionStatus: 'RECEIVED',
    verificationStatus: 'UNVERIFIED',
    checkpointId: null,
    auditId: crypto.randomUUID(),
    startedAt: now(),
    completedAt: null,
    errorCode: null,
    errorSummary: null,
    lastDispatchOutput: null,
    checkpointHistory: [],
    auditTrail: []
  };
  state.requests.set(requestId, record);
  if (idempotencyKey) state.byIdempotencyKey.set(idempotencyKey, requestId);

  audit(record, 'RECEIVED', { requestType: input.requestType, platformHint: input.platformHint, route: input.route });
  checkpoint(record, 'RECEIVED');

  let classification;
  try {
    classification = classify(input);
  } catch (err) {
    record.executionStatus = 'FAILED';
    record.verificationStatus = 'FAILED';
    record.errorCode = 'INVALID_REQUEST';
    record.errorSummary = maskSecrets(err.message);
    record.completedAt = now();
    audit(record, 'FAILED', { errorCode: record.errorCode, errorSummary: record.errorSummary });
    checkpoint(record, 'FAILED');
    return snapshot(record);
  }

  record.platformHint = classification.platformHint;
  record.requestType = classification.requestType;
  record.riskLevel = classification.riskLevel;
  record.executionStatus = 'CLASSIFIED';
  audit(record, 'CLASSIFIED', classification);
  checkpoint(record, 'CLASSIFIED');

  const selection = selectRoute(classification, input);
  record.selectedRoute = selection.selectedRoute;
  record.fallbackRoute = selection.fallbackRoute;
  record.costClass = selection.costClass;
  record.executionStatus = 'ROUTED';
  audit(record, 'ROUTED', selection);
  checkpoint(record, 'ROUTED');

  record.executionStatus = 'QUEUED';
  audit(record, 'QUEUED', { selectedRoute: record.selectedRoute });
  checkpoint(record, 'QUEUED');

  return dispatchAndVerify(record, input, adapters);
}

/** Resume a FAILED/BLOCKED request from its last checkpoint. Not allowed for terminal success/rollback states. */
async function resumeRequest(state, requestId, input = {}, adapters = defaultAdapters()) {
  const record = find(state, requestId);
  if (!RESUMABLE_STATUSES.includes(record.executionStatus)) {
    throw requestError(`再開できるのはFAILED/BLOCKEDの依頼のみです（現在: ${record.executionStatus}）`);
  }
  audit(record, 'RESUMED', { fromStatus: record.executionStatus });
  record.executionStatus = 'QUEUED';
  checkpoint(record, 'RESUMED');
  return dispatchAndVerify(record, input, adapters);
}

/** State-level rollback only. Most routes here are read-only, fail-closed, or already gated elsewhere,
 *  so there is no external side effect this module can itself undo — that limitation is reported, not hidden. */
function rollbackRequest(state, requestId, reason) {
  const record = find(state, requestId);
  if (record.executionStatus === 'ROLLED_BACK') return { ...snapshot(record), rollbackScope: 'state_only' };
  record.executionStatus = 'ROLLED_BACK';
  // A prior VERIFIED verdict no longer describes the current (rolled back) state.
  record.verificationStatus = 'UNVERIFIED';
  record.errorSummary = maskSecrets(asTrimmedString(reason) || 'manual_rollback');
  record.completedAt = now();
  audit(record, 'ROLLED_BACK', { reason: record.errorSummary, rollbackScope: 'state_only' });
  checkpoint(record, 'ROLLED_BACK');
  return { ...snapshot(record), rollbackScope: 'state_only' };
}

function getStatus(state, requestId) {
  return snapshot(find(state, requestId));
}

function getCheckpoint(state, requestId) {
  const record = find(state, requestId);
  return { requestId: record.requestId, checkpointId: record.checkpointId, history: [...record.checkpointHistory] };
}

function getAuditTrail(state, requestId) {
  const record = find(state, requestId);
  return { requestId: record.requestId, auditId: record.auditId, trail: [...record.auditTrail] };
}

module.exports = {
  ROUTES,
  EXECUTION_STATUSES,
  RESUMABLE_STATUSES,
  createRouterState,
  defaultState,
  defaultAdapters,
  classify,
  selectRoute,
  routeRequest,
  resumeRequest,
  rollbackRequest,
  getStatus,
  getCheckpoint,
  getAuditTrail
};
