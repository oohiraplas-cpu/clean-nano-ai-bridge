'use strict';
// Copilot-facing READ-only entry for the CNAI Router (cnai_status / cnai_route_request).
//
// Surface: served only through /connector/mcp (CONNECTOR_API_KEY, read-only window).
// Reuses cnaiRouter (routing, idempotency, audit, checkpoint, secret masking); it adds
//  - a request shape Copilot can fill (requestId / correlationId / operation / target / payload),
//  - a hard READ-only gate (operation + target allowlist, riskLevel fixed to LOW),
//  - read adapters for the `sharepoint` and `operationsMcp` routes, which the router has none for.
// An unconfirmed result is never reported as COMPLETED/VERIFIED (the router derives that from `verified`).

const crypto = require('node:crypto');
const cnaiRouter = require('./cnaiRouter');
const { maskDeep, maskSecrets } = require('./secretMasking');

const READ_OPERATIONS = Object.freeze(['read', 'list', 'status']);
const READ_TARGETS = Object.freeze(['sharepoint', 'operationsMcp', 'localCode']);
const OPERATIONS_MCP_READ_TOOLS = Object.freeze(['health_check', 'list_sharepoint_lists', 'get_sharepoint_list_schema']);
const COPILOT_TOOL_NAMES = Object.freeze(['cnai_status', 'cnai_route_request']);

const ID_PATTERN = '^[A-Za-z0-9._:-]{1,128}$';
const ID_RE = new RegExp(ID_PATTERN);

const RESPONSE_PROPERTIES = {
  status: { type: 'string', enum: ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED', 'REJECTED'] },
  verificationStatus: { type: 'string', enum: ['VERIFIED', 'UNVERIFIED', 'FAILED'] },
  selectedRoute: { type: ['string', 'null'] },
  requestId: { type: ['string', 'null'] },
  correlationId: { type: ['string', 'null'] },
  auditId: { type: ['string', 'null'] },
  executionStatus: { type: ['string', 'null'] },
  result: {},
  readBackResult: {},
  errorCode: { type: ['string', 'null'] },
  errorSummary: { type: ['string', 'null'] }
};

const COPILOT_TOOLS = Object.freeze([
  {
    name: 'cnai_status',
    description: 'CNAI Router / Bridge MAXの到達状態・version・deployment SHA・verification statusを返します（読み取り専用・秘密値なし）。',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'cnai_route_request',
    description: 'CNAI Routerへ読み取り専用の依頼を1件渡します。operationはread/list/status、targetはsharepoint/operationsMcp/localCodeのみ。未確認の結果はVERIFIEDとして返しません。',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', pattern: ID_PATTERN, description: '依頼ID。同じ値の再送は二重実行されません（冪等）' },
        correlationId: { type: 'string', pattern: ID_PATTERN, description: '追跡ID。省略時はRouterが採番' },
        operation: { type: 'string', enum: READ_OPERATIONS },
        target: { type: 'string', enum: READ_TARGETS },
        payload: {
          type: 'object',
          description: 'target=sharepoint: {siteId?, listId|listName, top?}。target=operationsMcp: {tool, arguments?}',
          additionalProperties: true
        }
      },
      required: ['requestId', 'operation', 'target'],
      additionalProperties: false
    },
    outputSchema: { type: 'object', properties: RESPONSE_PROPERTIES }
  }
]);

function rejected(errorCode, errorSummary, input = {}) {
  return {
    status: 'REJECTED',
    verificationStatus: 'UNVERIFIED',
    selectedRoute: null,
    requestId: typeof input.requestId === 'string' ? input.requestId : null,
    correlationId: typeof input.correlationId === 'string' ? input.correlationId : null,
    auditId: null,
    executionStatus: null,
    result: null,
    readBackResult: null,
    errorCode,
    errorSummary
  };
}

/** Fail-closed READ-only validation. Returns an error response, or null when the request may proceed. */
function validateReadOnlyRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return rejected('INVALID_REQUEST', '引数はJSONオブジェクトである必要があります');
  const known = ['requestId', 'correlationId', 'operation', 'target', 'payload'];
  const unknown = Object.keys(input).filter((key) => !known.includes(key));
  if (unknown.length) return rejected('INVALID_REQUEST', `未対応のプロパティです: ${unknown.join(', ')}`, input);
  if (typeof input.requestId !== 'string' || !ID_RE.test(input.requestId)) return rejected('INVALID_REQUEST', 'requestIdは1〜128文字の英数字と . _ : - のみです', input);
  if (input.correlationId !== undefined && (typeof input.correlationId !== 'string' || !ID_RE.test(input.correlationId))) return rejected('INVALID_REQUEST', 'correlationIdは1〜128文字の英数字と . _ : - のみです', input);
  if (!READ_OPERATIONS.includes(input.operation)) return rejected('READ_ONLY_VIOLATION', `この入口は読み取り専用です（operation: ${READ_OPERATIONS.join(' / ')}）`, input);
  if (!READ_TARGETS.includes(input.target)) return rejected('READ_ONLY_VIOLATION', `この入口で使えるtargetは ${READ_TARGETS.join(' / ')} のみです`, input);
  if (input.payload !== undefined && (input.payload === null || typeof input.payload !== 'object' || Array.isArray(input.payload))) return rejected('INVALID_REQUEST', 'payloadはJSONオブジェクトである必要があります', input);
  return null;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function stable(items) {
  return (items || []).map((item) => ({ itemId: item.itemId, fields: item.fields }));
}

/**
 * sharepoint route (READ only). Columns/types come from the live list (never assumed); the items
 * are read twice and verified only if both reads agree (read-back). A mismatch is PARTIAL/UNVERIFIED.
 */
function createSharePointReadAdapter(reader) {
  return async (record, input) => {
    const payload = input.payload || {};
    if (input.operation !== 'list' && !payload.listId && !payload.listName) {
      return { success: false, errorCode: 'INVALID_REQUEST', errorSummary: 'payloadにlistIdまたはlistNameが必要です' };
    }
    const params = { siteId: payload.siteId, listId: payload.listId, listName: payload.listName, top: payload.top };
    if (input.operation === 'list') {
      const lists = await reader.listLists({ siteId: payload.siteId, searchTerm: payload.searchTerm, top: payload.top });
      return { success: true, verified: false, operation: 'list', count: lists.lists ? lists.lists.length : 0, lists: lists.lists };
    }
    const first = await reader.listItems(params);
    const second = await reader.listItems({ ...params, siteId: first.siteId, listId: first.listId });
    const firstHash = hashOf(stable(first.items));
    const secondHash = hashOf(stable(second.items));
    const agreed = firstHash === secondHash && first.count === second.count;
    return {
      success: true,
      verified: agreed,
      operation: input.operation,
      siteId: first.siteId,
      listId: first.listId,
      count: first.count,
      hasMore: first.hasMore,
      columns: first.columns.map((c) => ({ name: c.name, displayName: c.displayName, type: c.type })),
      items: first.items,
      readBack: { performed: true, matched: agreed, firstReadSha256: firstHash, secondReadSha256: secondHash, count: second.count },
      ...(agreed ? {} : { errorCode: 'READ_BACK_MISMATCH', errorSummary: '再読込の結果が一致しませんでした（未確認として返します）' })
    };
  };
}

/** operationsMcp route: only an allowlist of read tools, executed through the Bridge's own handler. */
function createOperationsMcpReadAdapter(executeReadTool) {
  return async (record, input) => {
    const payload = input.payload || {};
    if (!OPERATIONS_MCP_READ_TOOLS.includes(payload.tool)) {
      return { success: false, errorCode: 'READ_ONLY_VIOLATION', errorSummary: `operationsMcpで使えるtoolは ${OPERATIONS_MCP_READ_TOOLS.join(' / ')} のみです` };
    }
    const result = await executeReadTool(payload.tool, payload.arguments || {});
    return { success: true, verified: true, tool: payload.tool, output: result };
  };
}

function normalizeError(error) {
  const status = error && (error.status || error.statusCode);
  if (status === 401) return { errorCode: 'UNAUTHORIZED', errorSummary: '認証に失敗しました' };
  if (status === 403) return { errorCode: 'FORBIDDEN', errorSummary: 'アクセスポリシーにより拒否されました' };
  if (status === 404) return { errorCode: 'NOT_FOUND', errorSummary: '対象のroute/リストが見つかりません' };
  if (error && /timeout|timed out|ETIMEDOUT/i.test(error.message || '')) return { errorCode: 'UPSTREAM_TIMEOUT', errorSummary: '上流の応答がタイムアウトしました' };
  return { errorCode: 'UPSTREAM_ERROR', errorSummary: maskSecrets(String((error && error.message) || 'upstream error')).slice(0, 300) };
}

/** Wraps an adapter so upstream HTTP errors become normalized, secret-free error codes. */
function guardAdapter(adapter) {
  return async (record, input) => {
    try { return await adapter(record, input); } catch (error) {
      return { success: false, verified: false, ...normalizeError(error) };
    }
  };
}

function toCopilotResponse(snapshot) {
  const output = snapshot.lastDispatchOutput || null;
  const status = ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(snapshot.executionStatus) ? snapshot.executionStatus : 'FAILED';
  const readBackResult = output && output.readBack ? output.readBack : null;
  return maskDeep({
    status,
    verificationStatus: snapshot.verificationStatus,
    selectedRoute: snapshot.selectedRoute,
    requestId: snapshot.idempotencyKey ? snapshot.idempotencyKey.replace(/^copilot:/, '') : snapshot.requestId,
    correlationId: snapshot.correlationId,
    auditId: snapshot.auditId,
    executionStatus: snapshot.executionStatus,
    result: output,
    readBackResult,
    errorCode: snapshot.errorCode,
    errorSummary: snapshot.errorSummary,
    ...(snapshot.duplicate ? { duplicate: true } : {})
  });
}

function createCopilotEntry({ state = cnaiRouter.defaultState, reader, executeReadTool, config = {}, version = '1.0.0' } = {}) {
  const adapters = cnaiRouter.defaultAdapters({
    adapters: {
      sharepoint: guardAdapter(createSharePointReadAdapter(reader)),
      operationsMcp: guardAdapter(createOperationsMcpReadAdapter(executeReadTool))
    }
  });
  // Copilot never reaches the windowsExecutor route from this entry.
  delete adapters.windowsExecutor;

  function status() {
    const deploymentSha = config.deploymentSha || null;
    return {
      status: 'ok',
      router: { reachable: true, routes: cnaiRouter.ROUTES, copilotReadOnlyTargets: READ_TARGETS },
      bridgeMax: { reachable: true },
      version,
      deploymentSha,
      verificationStatus: deploymentSha ? 'VERIFIED' : 'UNVERIFIED',
      ...(deploymentSha ? {} : { note: 'DEPLOYMENT_SHA未設定のため稼働SHAは未確認です' })
    };
  }

  async function route(input) {
    const invalid = validateReadOnlyRequest(input);
    if (invalid) return invalid;
    const snapshot = await cnaiRouter.routeRequest(state, {
      requestType: `copilot:${input.operation}`,
      route: input.target,
      riskLevel: 'LOW',
      idempotencyKey: `copilot:${input.requestId}`,
      correlationId: input.correlationId,
      operation: input.operation,
      payload: input.payload || {}
    }, adapters);
    return toCopilotResponse(snapshot);
  }

  async function call(name, args) {
    if (name === 'cnai_status') return status();
    if (name === 'cnai_route_request') return route(args);
    throw Object.assign(new Error('未対応のツールです'), { status: 404 });
  }

  return { call, status, route };
}

module.exports = {
  COPILOT_TOOLS,
  COPILOT_TOOL_NAMES,
  READ_OPERATIONS,
  READ_TARGETS,
  OPERATIONS_MCP_READ_TOOLS,
  validateReadOnlyRequest,
  createSharePointReadAdapter,
  createOperationsMcpReadAdapter,
  createCopilotEntry
};
