'use strict';

// Clean Nano Operations MCP の共通ツール層。
// 方針: 外部サービスへ書き込まない。検証できる項目だけを実装し、外部接続や承認台帳が必要な項目は
// PASS にせず BLOCKED と理由コードで返す（未検証をPASSにしない）。
// 秘密値（APIキー等）は値を返さず、設定の有無のみ返す。

const crypto = require('node:crypto');
const pkg = require('../package.json');
const environmentProfile = require('../config/operations-environment.json');

const SERVER_NAME = 'Clean Nano Operations MCP';
const INTERNAL_NAME = 'clean-nano-operations';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_OPERATIONS = 500;
const MAX_CHANGES_JSON_LENGTH = 20000;

const OPERATION_TYPES = Object.freeze([
  'read', 'write_external', 'publish_internal', 'permission_change', 'production_release',
  'external_publish', 'delete', 'billing', 'admin_role'
]);
// 承認が必要（承認を得るまで実行しない）
const APPROVAL_REQUIRED_TYPES = Object.freeze(['write_external', 'publish_internal', 'permission_change', 'production_release']);
// 常に禁止（計画の登録も拒否する）
const FORBIDDEN_OPERATION_TYPES = Object.freeze(['external_publish', 'delete', 'billing', 'admin_role']);

const IMPLEMENTED_STATUS = 'implemented';
const BLOCKED_STATUS = 'blocked';

// ツール契約（references/tool-contract.md）に従うメタデータ。
const TOOL_DEFS = Object.freeze([
  def('health_check', 'READ', 'low', 'Clean Nano Operations MCPの稼働状態を返します。', {}, IMPLEMENTED_STATUS),
  def('version_get', 'READ', 'low', 'Bridgeのバージョンと配備SHAを返します。', {}, IMPLEMENTED_STATUS),
  def('tools_list', 'READ', 'low', 'このサーバーのツール一覧とメタデータを返します。', {}, IMPLEMENTED_STATUS),
  def('tool_schema_get', 'READ', 'low', '指定したツールの入力スキーマを返します。', {
    name: { type: 'string', description: 'ツール名' }
  }, IMPLEMENTED_STATUS, ['name']),
  def('capability_check', 'READ', 'low', '各ツールの実装状況（実装済み・BLOCKED）を返します。', {}, IMPLEMENTED_STATUS),
  def('authentication_check', 'READ', 'low', '認証設定の有無と目標認証方式の状態を返します（秘密値は返しません）。', {}, IMPLEMENTED_STATUS),
  def('permission_check', 'READ', 'low', '権限を確認します。外部接続の確認は未実装です。', {}, BLOCKED_STATUS),
  def('license_check', 'READ', 'low', 'ライセンスを確認します。外部接続の確認は未実装です。', {}, BLOCKED_STATUS),
  def('connection_test', 'READ', 'low', '接続先への疎通を確認します。外部接続の確認は未実装です。', {}, BLOCKED_STATUS),
  def('environment_get', 'READ', 'low', '環境プロファイル（秘密値を除く確定値）を返します。', {}, IMPLEMENTED_STATUS),
  def('operation_plan', 'READ', 'medium', '操作の計画を登録します。実行はしません。承認が必要な操作は awaiting_approval になります。', {
    operationType: { type: 'string', enum: OPERATION_TYPES, description: '操作種別' },
    targetEnvironmentId: { type: 'string', description: '対象の環境ID' },
    targetObjectId: { type: 'string', description: '対象オブジェクトID' },
    action: { type: 'string', description: '操作内容の短い説明' },
    changes: { type: 'object', description: '変更内容（任意）' }
  }, IMPLEMENTED_STATUS, ['operationType', 'targetEnvironmentId', 'targetObjectId', 'action']),
  def('operation_status', 'READ', 'low', '登録済みの操作計画の状態を返します。', {
    operationId: { type: 'string', description: '操作ID' }
  }, IMPLEMENTED_STATUS, ['operationId']),
  def('operation_cancel', 'READ', 'low', '実行前の操作計画を取り消します。', {
    operationId: { type: 'string', description: '操作ID' }
  }, IMPLEMENTED_STATUS, ['operationId']),
  def('dry_run', 'READ', 'low', '操作計画の変更内容を確認します。何も変更しません。', {
    operationId: { type: 'string', description: '操作ID' }
  }, IMPLEMENTED_STATUS, ['operationId']),
  def('snapshot_create', 'WRITE', 'medium', '変更前のスナップショットを作成します。保存先が未構成のため未実装です。', {}, BLOCKED_STATUS),
  def('operation_verify', 'VERIFY', 'medium', '操作後の状態を再取得して照合します。未実装です。', {}, BLOCKED_STATUS),
  def('audit_write', 'WRITE', 'low', '監査記録を書き込みます。監査の保存先が未構成のため未実装です。', {}, BLOCKED_STATUS),
  def('rollback_execute', 'ROLLBACK', 'high', 'ロールバックを実行します。承認と復元経路の試験が前提のため未実装です。', {}, BLOCKED_STATUS)
]);

const TOOL_BY_NAME = new Map(TOOL_DEFS.map((tool) => [tool.name, tool]));

const BLOCKED_REASONS = Object.freeze({
  permission_check: { reasonCode: 'LIVE_CHECK_NOT_IMPLEMENTED', nextStep: '実環境への権限確認を実装する。' },
  license_check: { reasonCode: 'LIVE_CHECK_NOT_IMPLEMENTED', nextStep: 'ライセンス確認の実装と実環境での試験を行う。' },
  connection_test: { reasonCode: 'LIVE_CHECK_NOT_IMPLEMENTED', nextStep: '接続先ごとの疎通確認を実装する。' },
  snapshot_create: { reasonCode: 'STORE_NOT_CONFIGURED', nextStep: 'スナップショットの保存先（永続ストレージ）を決めて構成する。' },
  operation_verify: { reasonCode: 'NOT_IMPLEMENTED', nextStep: '操作後の再取得と照合を実装する。' },
  audit_write: { reasonCode: 'AUDIT_STORE_NOT_CONFIGURED', nextStep: '監査記録の保存先を決めて構成する。' },
  rollback_execute: { reasonCode: 'NOT_IMPLEMENTED', nextStep: '復元経路の試験後に実装する。承認ゲートを必須にする。' }
});

function def(name, category, riskLevel, description, properties, implementation, required = []) {
  const isWrite = category === 'WRITE' || category === 'ROLLBACK';
  return {
    name,
    description,
    category,
    riskLevel,
    requiresApproval: riskLevel === 'high' || (isWrite && riskLevel !== 'low'),
    supportsDryRun: name !== 'version_get',
    supportsRollback: category === 'WRITE',
    auditRequired: category !== 'READ',
    additionalCost: false,
    requiredPermissions: [],
    requiredConnections: [],
    implementation,
    inputSchema: {
      type: 'object',
      properties,
      required,
      additionalProperties: false
    }
  };
}

function publicToolMeta(tool) {
  const { inputSchema, implementation, ...meta } = tool;
  return { ...meta, implementationStatus: implementation };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isNonEmptyString(value, max = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validateSchema(tool, args) {
  const problems = [];
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return ['引数はオブジェクトで指定してください'];
  }
  const { properties, required, additionalProperties } = tool.inputSchema;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') problems.push(`${key} は必須です`);
  }
  if (additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!properties[key]) problems.push(`${key} は指定できません`);
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] === undefined) continue;
    if (spec.enum && !spec.enum.includes(args[key])) problems.push(`${key} の値が不正です`);
    if (spec.type === 'string' && typeof args[key] !== 'string') problems.push(`${key} は文字列で指定してください`);
    if (spec.type === 'object' && (args[key] === null || typeof args[key] !== 'object' || Array.isArray(args[key]))) {
      problems.push(`${key} はオブジェクトで指定してください`);
    }
  }
  return problems;
}

function createOperationsMcp(config = {}) {
  const operations = new Map();

  function blockedResult(name, extra = {}) {
    const reason = BLOCKED_REASONS[name] || { reasonCode: 'NOT_IMPLEMENTED', nextStep: '未実装です。' };
    return {
      status: 'BLOCKED',
      tool: name,
      reasonCode: reason.reasonCode,
      message: `${name} は未実装または外部確認が未構成のため BLOCKED です。`,
      nextStep: reason.nextStep,
      executed: false,
      ...extra
    };
  }

  function getOperation(operationId) {
    const record = operations.get(operationId);
    if (!record) {
      return { error: { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', message: '指定された操作IDが見つかりません。' } };
    }
    return { record };
  }

  const handlers = {
    health_check: () => ({
      status: 'PASS',
      ok: true,
      server: INTERNAL_NAME,
      uptimeSeconds: Math.round(process.uptime())
    }),

    version_get: () => ({
      status: 'PASS',
      name: SERVER_NAME,
      internalName: INTERNAL_NAME,
      version: pkg.version,
      deploymentSha: config.deploymentSha || null,
      runtime: process.version
    }),

    tools_list: () => ({
      status: 'PASS',
      count: TOOL_DEFS.length,
      tools: TOOL_DEFS.map(publicToolMeta)
    }),

    tool_schema_get: ({ name }) => {
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', message: '指定されたツールが見つかりません。' };
      return { status: 'PASS', name, inputSchema: tool.inputSchema };
    },

    capability_check: () => {
      const tools = TOOL_DEFS.map((tool) => ({
        name: tool.name,
        implementationStatus: tool.implementation,
        ...(tool.implementation === BLOCKED_STATUS ? { reasonCode: (BLOCKED_REASONS[tool.name] || {}).reasonCode } : {})
      }));
      const implemented = tools.filter((t) => t.implementationStatus === IMPLEMENTED_STATUS).length;
      return {
        status: implemented === tools.length ? 'PASS' : 'PARTIAL',
        implemented,
        blocked: tools.length - implemented,
        tools
      };
    },

    authentication_check: () => {
      const mcpConfigured = Boolean(config.mcpApiKey);
      const connectorConfigured = Boolean(config.connectorApiKey);
      return {
        status: mcpConfigured ? 'PARTIAL' : 'FAIL',
        currentMethod: 'Bearer（移行期間のみ）',
        mcpApiKeyConfigured: mcpConfigured,
        connectorApiKeyConfigured: connectorConfigured,
        targetMethods: environmentProfile.targetAuthOrder,
        targetMethodStatus: 'NOT_IMPLEMENTED',
        message: mcpConfigured
          ? '現行の共有キー認証は構成されています。Entra ID 認証は未実装です。'
          : 'MCP_API_KEY が未構成のため、このエンドポイントは利用できません。'
      };
    },

    permission_check: () => blockedResult('permission_check'),
    license_check: () => blockedResult('license_check'),
    connection_test: () => blockedResult('connection_test'),

    environment_get: () => ({ status: 'PASS', profile: environmentProfile }),

    operation_plan: (args) => {
      const problems = validateSchema(TOOL_BY_NAME.get('operation_plan'), args);
      if (problems.length) {
        return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: problems.join('、') };
      }
      if (!isNonEmptyString(args.targetEnvironmentId, 100) || !isNonEmptyString(args.targetObjectId, 200)
        || !isNonEmptyString(args.action, 500)) {
        return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: '対象IDと操作内容は空でない文字列で指定してください。' };
      }
      const changes = args.changes || {};
      if (canonicalJson(changes).length > MAX_CHANGES_JSON_LENGTH) {
        return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: '変更内容が大きすぎます。' };
      }
      if (FORBIDDEN_OPERATION_TYPES.includes(args.operationType)) {
        return {
          status: 'BLOCKED',
          reasonCode: 'FORBIDDEN_OPERATION',
          message: `${args.operationType} は常に禁止された操作のため、計画を登録しません。`,
          nextStep: '対象操作を見直すか、人間が直接実施する。',
          executed: false
        };
      }
      if (operations.size >= MAX_OPERATIONS) {
        return { status: 'BLOCKED', reasonCode: 'STORE_FULL', message: '操作計画の保持数が上限に達しています。', executed: false };
      }
      const approvalRequired = APPROVAL_REQUIRED_TYPES.includes(args.operationType);
      const planBody = {
        operationType: args.operationType,
        targetEnvironmentId: args.targetEnvironmentId,
        targetObjectId: args.targetObjectId,
        action: args.action,
        changes
      };
      const record = {
        operationId: crypto.randomUUID(),
        ...planBody,
        planHash: sha256(canonicalJson(planBody)),
        approvalRequired,
        status: approvalRequired ? 'awaiting_approval' : 'planned',
        createdAt: new Date().toISOString()
      };
      operations.set(record.operationId, record);
      return {
        status: 'PASS',
        operationId: record.operationId,
        planHash: record.planHash,
        operationStatus: record.status,
        approvalRequired,
        executed: false,
        message: approvalRequired
          ? '承認が必要な操作です。承認を得るまで実行されません。'
          : '計画を登録しました。実行はまだ行われていません。'
      };
    },

    operation_status: ({ operationId }) => {
      const { record, error } = getOperation(operationId);
      if (error) return error;
      return {
        status: 'PASS',
        operationId,
        operationStatus: record.status,
        operationType: record.operationType,
        approvalRequired: record.approvalRequired,
        planHash: record.planHash,
        createdAt: record.createdAt,
        executed: false
      };
    },

    operation_cancel: ({ operationId }) => {
      const { record, error } = getOperation(operationId);
      if (error) return error;
      if (record.status !== 'planned' && record.status !== 'awaiting_approval') {
        return { status: 'FAIL', reasonCode: 'INVALID_STATE', message: `現在の状態（${record.status}）では取り消せません。` };
      }
      record.status = 'cancelled';
      return { status: 'PASS', operationId, operationStatus: record.status, executed: false };
    },

    dry_run: ({ operationId }) => {
      const { record, error } = getOperation(operationId);
      if (error) return error;
      if (record.status === 'cancelled') {
        return { status: 'FAIL', reasonCode: 'INVALID_STATE', message: '取り消し済みの操作です。' };
      }
      return {
        status: 'PASS',
        dryRun: true,
        executed: false,
        operationId,
        planHash: record.planHash,
        wouldChange: {
          operationType: record.operationType,
          targetEnvironmentId: record.targetEnvironmentId,
          targetObjectId: record.targetObjectId,
          action: record.action,
          changes: record.changes
        },
        approvalRequired: record.approvalRequired
      };
    },

    snapshot_create: () => blockedResult('snapshot_create'),
    operation_verify: () => blockedResult('operation_verify'),
    audit_write: () => blockedResult('audit_write'),
    rollback_execute: () => blockedResult('rollback_execute')
  };

  function callTool(name, args = {}) {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) return null;
    const problems = validateSchema(tool, args);
    if (problems.length) {
      return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: problems.join('、') };
    }
    return handlers[name](args);
  }

  function toolResult(payload) {
    const isError = payload.status === 'FAIL' || payload.status === 'BLOCKED';
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError
    };
  }

  function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
  }

  // 1リクエストを処理する。通知（id無し）は null を返す（HTTPでは202）。
  function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(null, -32600, '不正なリクエストです');
    }
    const { id, method, params = {} } = message;
    const isNotification = id === undefined;
    try {
      if (method.startsWith('notifications/')) return null;
      if (isNotification) return null;
      if (method === 'initialize') {
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: pkg.version }
        });
      }
      if (method === 'ping') return rpcResult(id, {});
      if (method === 'tools/list') {
        return rpcResult(id, { tools: TOOL_DEFS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      }
      if (method === 'tools/call') {
        const name = params && params.name;
        if (typeof name !== 'string' || !TOOL_BY_NAME.has(name)) {
          return rpcError(id, -32602, '不明なツール名です');
        }
        const payload = callTool(name, (params && params.arguments) || {});
        return rpcResult(id, toolResult(payload));
      }
      return rpcError(id, -32601, '未対応のメソッドです');
    } catch (error) {
      void error;
      return rpcError(id, -32603, '内部エラーが発生しました');
    }
  }

  return { handle, callTool, TOOL_DEFS: TOOL_DEFS.map(publicToolMeta) };
}

module.exports = {
  createOperationsMcp,
  TOOL_DEFS,
  OPERATION_TYPES,
  APPROVAL_REQUIRED_TYPES,
  FORBIDDEN_OPERATION_TYPES
};
