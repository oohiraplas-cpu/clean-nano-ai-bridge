'use strict';

// Clean Nano Operations MCP の共通運用ツール層。
//
// 方針
// - 外部サービスへの書き込みはこのモジュールでは行わない。
// - 外部接続（権限・ライセンス・疎通・読み取り・承認台帳・復元）はアダプターとして注入する。
//   既定のアダプターは未構成（configured=false）のため、該当ツールは BLOCKED を返す。
// - 監査（開始・完了）は保存に成功してから処理を進める。監査の保存に失敗した場合は処理を開始しない。
// - スナップショットは変更前に作成し、ハッシュで整合性を確認する。保存に失敗した場合は変更を許可しない（canStartWrite）。
// - 秘密値（APIキー・トークン等）は値を返さず、保存前・返却前に伏せ字にする。
// - 物理削除の機能は持たない。

const crypto = require('node:crypto');
const pkg = require('../package.json');
const environmentProfile = require('../config/operations-environment.json');
const { maskDeep } = require('./secretMasking');
const { createOperationsStore, canonicalJson, hashValue } = require('./operations/store');
const { createSharePointGraphAdapter, SharePointAdapterError } = require('./operations/sharePointGraphAdapter');

const SERVER_NAME = 'Clean Nano Operations MCP';
const INTERNAL_NAME = 'clean-nano-operations';
const PROTOCOL_VERSION = '2025-06-18';
const MAX_OPERATIONS = 500;
const MAX_CHANGES_JSON_LENGTH = 20000;
const MAX_SNAPSHOT_JSON_LENGTH = 512000;

const OPERATION_TYPES = Object.freeze([
  'read', 'write_external', 'publish_internal', 'permission_change', 'production_release',
  'external_publish', 'delete', 'billing', 'admin_role'
]);
const APPROVAL_REQUIRED_TYPES = Object.freeze(['write_external', 'publish_internal', 'permission_change', 'production_release']);
const FORBIDDEN_OPERATION_TYPES = Object.freeze(['external_publish', 'delete', 'billing', 'admin_role']);

const TARGET_TYPES = Object.freeze(['powerapps_app', 'sharepoint_list', 'power_automate_flow', 'solution', 'other']);
const CORRELATION_ID_PATTERN = '^[A-Za-z0-9-]{8,64}$';
const SHA256_PATTERN = '^[0-9a-f]{64}$';
const FIELD_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]{0,63}$';
const GUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const ITEM_ID_PATTERN = '^[1-9][0-9]{0,9}$';
const EVENT_PATTERN = '^[a-z_]{3,64}$';
const TOOL_NAME_PATTERN = '^[a-z_]{3,64}$';
const ZERO_HASH = '0'.repeat(64);

// ---------- 定義（メタデータ・入力スキーマ） ----------

const CORRELATION_PROP = { type: 'string', pattern: CORRELATION_ID_PATTERN, description: '追跡用ID（省略時は自動生成）' };

function meta(category, riskLevel, extra = {}) {
  return {
    category,
    riskLevel,
    requiresApproval: false,
    supportsDryRun: false,
    supportsRollback: false,
    auditRequired: false,
    additionalCost: false,
    requiredPermissions: [],
    requiredConnections: [],
    adapter: null,
    ...extra
  };
}

function tool(name, description, metadata, properties = {}, required = []) {
  return {
    name,
    description,
    meta: metadata,
    inputSchema: {
      type: 'object',
      properties: { ...properties, correlationId: CORRELATION_PROP },
      required,
      additionalProperties: false
    }
  };
}

const CATALOG = Object.freeze([
  tool('health_check', 'Clean Nano Operations MCPの稼働状態を返します。', meta('READ', 'low')),
  tool('version_get', 'Bridgeのバージョンと配備SHAを返します。', meta('READ', 'low')),
  tool('tools_list', 'このサーバーのツール一覧とメタデータを返します。', meta('READ', 'low')),
  tool('tool_schema_get', '指定したツールの入力スキーマを返します。', meta('READ', 'low'), {
    name: { type: 'string', pattern: TOOL_NAME_PATTERN, description: 'ツール名' }
  }, ['name']),
  tool('capability_check', '各ツールの実装状況と外部接続の構成状態を返します。', meta('READ', 'low')),
  tool('authentication_check', '認証設定の有無と目標認証方式の状態を返します（秘密値は返しません）。', meta('READ', 'low')),
  tool('environment_get', '環境プロファイル（秘密値を除く確定値）を返します。', meta('READ', 'low')),
  tool('permission_check', '指定したスコープで必要な権限が付与されているかを確認します。', meta('READ', 'low', {
    auditRequired: true, adapter: 'permission', requiredConnections: ['permission-adapter']
  }), {
    scope: { type: 'string', enum: ['sharepoint', 'entra', 'power_platform', 'dataverse', 'azure'], description: '確認するスコープ' },
    targetId: { type: 'string', maxLength: 200, description: '対象ID（任意）' },
    requiredPermissions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 100 }, description: '必要な権限' }
  }, ['scope', 'requiredPermissions']),
  tool('license_check', '対象のライセンスが有効か、課金が発生する上位プランでないかを確認します。', meta('READ', 'low', {
    auditRequired: true, adapter: 'license', requiredConnections: ['license-adapter']
  }), {
    licenseType: { type: 'string', enum: ['microsoft365', 'power_apps', 'power_automate', 'copilot_studio', 'other'], description: 'ライセンス種別' },
    subjectId: { type: 'string', maxLength: 200, description: '対象の利用者ID（任意）' }
  }, ['licenseType']),
  tool('connection_test', '接続先への疎通を確認します（読み取りのみ）。', meta('READ', 'low', {
    auditRequired: true, adapter: 'connection', requiredConnections: ['connection-adapter']
  }), {
    target: { type: 'string', enum: ['sharepoint', 'graph', 'appservice', 'power_platform', 'github'], description: '接続先' }
  }, ['target']),
  tool('operation_plan', '操作の計画を登録します。実行はしません。承認が必要な操作は awaiting_approval になります。', meta('WRITE', 'medium', {
    supportsDryRun: true, supportsRollback: true, auditRequired: true, requiredConnections: ['operations-store']
  }), {
    operationType: { type: 'string', enum: OPERATION_TYPES, description: '操作種別' },
    targetEnvironmentId: { type: 'string', maxLength: 100, description: '対象の環境ID' },
    targetObjectId: { type: 'string', maxLength: 200, description: '対象オブジェクトID' },
    action: { type: 'string', maxLength: 500, description: '操作内容の短い説明' },
    changes: { type: 'object', maxJsonLength: MAX_CHANGES_JSON_LENGTH, description: '変更内容（任意）' }
  }, ['operationType', 'targetEnvironmentId', 'targetObjectId', 'action']),
  tool('operation_status', '登録済みの操作計画の状態を返します。', meta('READ', 'low'), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID' }
  }, ['operationId']),
  tool('operation_cancel', '実行前の操作計画を取り消します。', meta('WRITE', 'low', {
    auditRequired: true, requiredConnections: ['operations-store']
  }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID' }
  }, ['operationId']),
  tool('dry_run', '操作計画の変更内容を確認します。何も変更しません。', meta('READ', 'low', { supportsDryRun: true }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID' }
  }, ['operationId']),
  tool('snapshot_create', '変更前のスナップショットを作成し、ハッシュを記録します。保存に失敗した場合は変更を開始できません。', meta('WRITE', 'medium', {
    supportsDryRun: true, supportsRollback: true, auditRequired: true, requiredConnections: ['operations-store']
  }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID（登録済みであること）' },
    targetType: { type: 'string', enum: TARGET_TYPES, description: '対象種別' },
    targetId: { type: 'string', minLength: 1, maxLength: 200, description: '対象ID' },
    content: { type: 'object', maxJsonLength: MAX_SNAPSHOT_JSON_LENGTH, description: '変更前の内容' },
    dryRun: { type: 'boolean', description: 'trueの場合はハッシュだけ計算し、保存しない' }
  }, ['operationId', 'targetType', 'targetId', 'content']),
  tool('operation_verify', '操作後の対象を再取得し、期待するハッシュと照合します。', meta('VERIFY', 'medium', {
    auditRequired: true, adapter: 'verify', requiredConnections: ['target-reader']
  }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID' },
    targetType: { type: 'string', enum: TARGET_TYPES, description: '対象種別' },
    targetId: { type: 'string', minLength: 1, maxLength: 200, description: '対象ID' },
    expectedAfterHash: { type: 'string', pattern: SHA256_PATTERN, description: '期待する変更後のSHA-256' }
  }, ['operationId', 'targetType', 'targetId', 'expectedAfterHash']),
  tool('audit_write', '監査記録を追記します。直前の記録のハッシュを連結します（改ざん検知用）。', meta('WRITE', 'low', {
    supportsDryRun: true, requiredConnections: ['operations-store']
  }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID（任意）' },
    event: { type: 'string', pattern: EVENT_PATTERN, description: 'イベント名' },
    status: { type: 'string', enum: ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'], description: '結果' },
    details: { type: 'object', maxJsonLength: 4000, description: '補足（秘密値は伏せ字になります）' }
  }, ['event', 'status']),
  tool('rollback_execute', 'スナップショットから変更前の状態へ戻します。承認が必須です。復元の可否をrollbackAvailableで示します。', meta('ROLLBACK', 'high', {
    requiresApproval: true, supportsDryRun: true, auditRequired: true, adapter: 'restore',
    requiredPermissions: ['approval-ledger'], requiredConnections: ['operations-store', 'restore-adapter']
  }), {
    operationId: { type: 'string', maxLength: 64, description: '操作ID' },
    snapshotId: { type: 'string', maxLength: 64, description: '復元元のスナップショットID' },
    approvalToken: { type: 'string', minLength: 1, maxLength: 500, description: '承認トークン（承認台帳で検証）' },
    dryRun: { type: 'boolean', description: 'trueの場合は復元可否の確認のみ行う' }
  }, ['operationId', 'snapshotId']),
  tool('sp_site_get', 'SharePointサイトの基本情報を読み取ります（対象は cleannano サイトに固定）。', meta('READ', 'low', {
    requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  })),
  tool('sp_lists_list', 'サイト内のリスト一覧を読み取ります。', meta('READ', 'low', {
    requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }), {
    top: { type: 'integer', minimum: 1, maximum: 100, description: '取得件数（既定50）' }
  }),
  tool('sp_list_get', 'リストの基本情報を読み取ります。', meta('READ', 'low', {
    requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }), {
    listId: { type: 'string', pattern: GUID_PATTERN, description: 'リストID（GUID）' }
  }, ['listId']),
  tool('sp_list_schema_get', 'リストの列定義（内部名・表示名・必須・読み取り専用）を読み取ります。', meta('READ', 'low', {
    requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }), {
    listId: { type: 'string', pattern: GUID_PATTERN, description: 'リストID（GUID）' }
  }, ['listId']),
  tool('sp_item_get', 'リスト項目を1件読み取ります。', meta('READ', 'low', {
    auditRequired: true, requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }), {
    listId: { type: 'string', pattern: GUID_PATTERN, description: 'リストID（GUID）' },
    itemId: { type: 'string', pattern: ITEM_ID_PATTERN, description: '項目ID' }
  }, ['listId', 'itemId']),
  tool('sp_item_query', 'リスト項目を読み取ります（件数上限あり。フィルタは取得した範囲に対してのみ適用）。', meta('READ', 'low', {
    auditRequired: true, requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }), {
    listId: { type: 'string', pattern: GUID_PATTERN, description: 'リストID（GUID）' },
    top: { type: 'integer', minimum: 1, maximum: 200, description: '取得件数（既定50）' },
    select: { type: 'array', maxItems: 50, items: { type: 'string', pattern: FIELD_NAME_PATTERN }, description: '返す列の内部名' },
    filterField: { type: 'string', pattern: FIELD_NAME_PATTERN, description: 'フィルタする列の内部名' },
    filterValue: { type: 'string', maxLength: 200, description: 'フィルタする値（完全一致）' }
  }, ['listId']),
  tool('sp_permissions_get', 'サイトの権限一覧を読み取ります（付与対象の識別子は返しません）。', meta('READ', 'low', {
    auditRequired: true, requiredPermissions: ['Sites.Selected'], requiredConnections: ['microsoft-graph', 'sharepoint-cleannano'], adapter: 'sharePoint'
  }))
]);

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));
const ALL_TOOL_NAMES = Object.freeze(CATALOG.map((entry) => entry.name));
// /mcp の既存 health_check と名前が重複するため、統合対象からは除外する（既存の health_check を使う）。
const INTEGRATED_TOOL_NAMES = Object.freeze(ALL_TOOL_NAMES.filter((name) => name !== 'health_check'));

function publicMeta(entry) {
  return { name: entry.name, description: entry.description, ...entry.meta };
}

function publicToolFor(entry) {
  return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    annotations: {
      readOnlyHint: entry.meta.category === 'READ',
      destructiveHint: entry.meta.category === 'ROLLBACK'
    }
  };
}

const OPERATIONS_PUBLIC_TOOLS = Object.freeze(INTEGRATED_TOOL_NAMES.map((name) => publicToolFor(BY_NAME.get(name))));

// ---------- 入力検証 ----------

function checkValue(name, spec, value) {
  if (spec.enum && !spec.enum.includes(value)) return [`${name} の値が不正です`];
  const problems = [];
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return [`${name} は文字列で指定してください`];
      if (spec.minLength !== undefined && value.length < spec.minLength) problems.push(`${name} は${spec.minLength}文字以上で指定してください`);
      if (spec.maxLength !== undefined && value.length > spec.maxLength) problems.push(`${name} は${spec.maxLength}文字以内で指定してください`);
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) problems.push(`${name} の形式が不正です`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) return [`${name} は整数で指定してください`];
      if (spec.minimum !== undefined && value < spec.minimum) problems.push(`${name} は${spec.minimum}以上で指定してください`);
      if (spec.maximum !== undefined && value > spec.maximum) problems.push(`${name} は${spec.maximum}以下で指定してください`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return [`${name} は真偽値で指定してください`];
      break;
    case 'object':
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return [`${name} はオブジェクトで指定してください`];
      if (spec.maxJsonLength !== undefined && canonicalJson(value).length > spec.maxJsonLength) problems.push(`${name} が大きすぎます`);
      break;
    case 'array':
      if (!Array.isArray(value)) return [`${name} は配列で指定してください`];
      if (spec.minItems !== undefined && value.length < spec.minItems) problems.push(`${name} は${spec.minItems}件以上で指定してください`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) problems.push(`${name} は${spec.maxItems}件以内で指定してください`);
      if (spec.items) value.forEach((item, index) => problems.push(...checkValue(`${name}[${index}]`, spec.items, item)));
      break;
    default:
      break;
  }
  return problems;
}

function validateArgs(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ['引数はオブジェクトで指定してください'];
  const problems = [];
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') problems.push(`${key} は必須です`);
  }
  for (const key of Object.keys(args)) {
    if (!schema.properties[key]) problems.push(`${key} は指定できません`);
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    if (args[key] !== undefined) problems.push(...checkValue(key, spec, args[key]));
  }
  return problems;
}

// ---------- 本体 ----------

const ADAPTER_NAMES = Object.freeze(['permission', 'license', 'connection', 'verify', 'restore', 'approval', 'sharePoint']);

function isoNow() {
  return new Date().toISOString();
}

function resolveCorrelationId(value) {
  return typeof value === 'string' && new RegExp(CORRELATION_ID_PATTERN).test(value) ? value : crypto.randomUUID();
}

function adapterBlocked(adapterName, nextStep) {
  return {
    status: 'BLOCKED',
    reasonCode: 'ADAPTER_NOT_CONFIGURED',
    adapter: adapterName,
    executed: false,
    message: `${adapterName} アダプターが未構成のため、実環境での確認は行えません（未確認）。`,
    nextStep: nextStep || `${adapterName} アダプターを構成する。`
  };
}

function safeErrorPayload(error) {
  if (error instanceof SharePointAdapterError) {
    if (error.code === 'AUTH_NOT_CONFIGURED') {
      return {
        status: 'BLOCKED',
        reasonCode: 'ADAPTER_NOT_CONFIGURED',
        adapter: 'sharePoint',
        executed: false,
        message: 'SharePoint の認証が未構成のため、実環境での読み取りは行えません（未確認）。',
        nextStep: 'Microsoft Graph の認証（委任または Managed Identity）を構成する。'
      };
    }
    const messages = {
      AUTH_FAILED: 'SharePoint の認証に失敗しました。',
      PERMISSION_DENIED: 'SharePoint の権限が不足しています。',
      TARGET_NOT_FOUND: '対象が見つかりません。',
      RATE_LIMITED: 'SharePoint 側で要求が制限されています。時間をおいて再試行してください。',
      UPSTREAM_ERROR: 'SharePoint 側でエラーが発生しました。',
      UPSTREAM_UNREACHABLE: 'SharePoint に接続できませんでした。',
      UPSTREAM_INVALID_RESPONSE: 'SharePoint の応答を解釈できませんでした。',
      UPSTREAM_REJECTED: 'SharePoint が要求を拒否しました。'
    };
    return { status: 'FAIL', reasonCode: error.code, executed: false, message: messages[error.code] || 'SharePoint の読み取りに失敗しました。' };
  }
  return { status: 'FAIL', reasonCode: 'INTERNAL_ERROR', executed: false, message: '内部エラーが発生しました。' };
}

function createOperationsMcp(config = {}, deps = {}) {
  const store = deps.store || createOperationsStore({ filePath: config.operations?.storeFile || undefined });
  const plans = new Map();
  const adapters = Object.fromEntries(ADAPTER_NAMES.map((name) => [name, null]));
  Object.assign(adapters, deps.adapters || {});
  if (!adapters.sharePoint) {
    adapters.sharePoint = createSharePointGraphAdapter({
      siteUrl: environmentProfile.sharePointSiteUrl,
      tokenProvider: deps.sharePointTokenProvider || null
    });
  }

  function ready(name) {
    const adapter = adapters[name];
    return adapter && adapter.configured === true ? adapter : null;
  }

  // ---- 監査（追記・ハッシュ連結） ----
  function appendAudit(entry) {
    const rows = store.list('audit');
    const prevHash = rows.length ? rows[rows.length - 1].recordHash : ZERO_HASH;
    const body = { auditRecordId: crypto.randomUUID(), createdAt: isoNow(), prevHash, ...entry };
    return store.append('audit', { ...body, recordHash: hashValue(body) });
  }

  function auditTrail(operationId) {
    return store.list('audit').filter((row) => row.operationId === operationId);
  }

  // ---- 書き込み前ゲート ----
  // 変更処理は、対象操作のスナップショットが存在し、ハッシュが一致し、
  // かつ snapshot_create の完了監査が保存されている場合にのみ許可する。
  function canStartWrite(operationId) {
    const snapshots = store.list('snapshots').filter((row) => row.operationId === operationId);
    if (snapshots.length === 0) return { allowed: false, reasonCode: 'SNAPSHOT_MISSING' };
    const snapshot = snapshots[snapshots.length - 1];
    if (hashValue(snapshot.content) !== snapshot.beforeHash) return { allowed: false, reasonCode: 'SNAPSHOT_INTEGRITY_FAILED' };
    const audited = store.list('audit').some((row) => row.operationId === operationId
      && row.tool === 'snapshot_create' && row.event === 'tool_completed' && row.status === 'PASS');
    if (!audited) return { allowed: false, reasonCode: 'AUDIT_MISSING' };
    return { allowed: true, snapshotId: snapshot.snapshotId, beforeHash: snapshot.beforeHash };
  }

  const ctxFor = (correlationId) => ({ correlationId, store, plans, adapters, ready, appendAudit, canStartWrite });

  // ---- ツールの実装 ----
  const handlers = {
    health_check: () => ({ status: 'PASS', ok: true, server: INTERNAL_NAME, uptimeSeconds: Math.round(process.uptime()) }),

    version_get: () => ({
      status: 'PASS',
      name: SERVER_NAME,
      internalName: INTERNAL_NAME,
      version: pkg.version,
      deploymentSha: config.deploymentSha || null,
      runtime: process.version
    }),

    tools_list: () => ({ status: 'PASS', count: CATALOG.length, tools: CATALOG.map(publicMeta) }),

    tool_schema_get: ({ name }) => {
      const entry = BY_NAME.get(name);
      if (!entry) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', executed: false, message: '指定されたツールが見つかりません。' };
      return { status: 'PASS', name, inputSchema: entry.inputSchema };
    },

    capability_check: () => {
      const tools = CATALOG.map((entry) => {
        const adapterName = entry.meta.adapter;
        const liveStatus = adapterName === null ? 'READY' : (ready(adapterName) ? 'CONFIGURED' : 'NOT_CONFIGURED');
        return { name: entry.name, implementationStatus: 'implemented', adapter: adapterName, liveStatus };
      });
      const notConfigured = tools.filter((t) => t.liveStatus === 'NOT_CONFIGURED').length;
      return {
        status: notConfigured === 0 ? 'PASS' : 'PARTIAL',
        implemented: tools.length,
        liveNotConfigured: notConfigured,
        tools
      };
    },

    authentication_check: () => {
      const hasKey = Boolean(config.mcpApiKey);
      const source = hasKey ? (config.mcpApiKeySource || 'unknown') : null;
      if (!hasKey) {
        return {
          status: 'FAIL',
          reasonCode: 'AUTH_CONFIG_MISSING',
          activeVariable: null,
          executed: false,
          message: 'CN_MCP_API_KEY（後方互換: MCP_API_KEY）が未設定です。認証設定を行うまで利用できません。'
        };
      }
      return {
        status: 'PARTIAL',
        activeVariable: source,
        legacyVariableInUse: source === 'MCP_API_KEY',
        currentMethod: '共有キー（移行期間）',
        targetMethods: environmentProfile.targetAuthOrder,
        targetMethodStatus: 'NOT_IMPLEMENTED',
        message: source === 'MCP_API_KEY'
          ? '後方互換の MCP_API_KEY を使用中です。CN_MCP_API_KEY への移行を推奨します。Entra ID 認証は未実装です。'
          : '共有キー認証は構成されています。Entra ID 認証は未実装です。'
      };
    },

    environment_get: () => ({ status: 'PASS', profile: environmentProfile }),

    permission_check: async ({ scope, targetId, requiredPermissions }, ctx) => {
      const adapter = ctx.ready('permission');
      if (!adapter) return adapterBlocked('permission');
      const granted = new Set(((await adapter.check({ scope, targetId })) || {}).granted || []);
      const missing = requiredPermissions.filter((perm) => !granted.has(perm));
      if (missing.length) return { status: 'FAIL', reasonCode: 'PERMISSION_MISSING', missingPermissions: missing, executed: false };
      return { status: 'PASS', scope, checked: requiredPermissions.length, executed: false };
    },

    license_check: async ({ licenseType, subjectId }, ctx) => {
      const adapter = ctx.ready('license');
      if (!adapter) return adapterBlocked('license');
      const result = (await adapter.check({ licenseType, subjectId })) || {};
      if (result.premium === true) {
        return { status: 'FAIL', reasonCode: 'PREMIUM_REQUIRED', licenseType, message: 'プレミアム（追加課金）が必要な構成のため、許可されません。', executed: false };
      }
      if (result.licensed !== true) return { status: 'FAIL', reasonCode: 'LICENSE_REQUIRED', licenseType, executed: false };
      return { status: 'PASS', licenseType, licensed: true, premium: false, executed: false };
    },

    connection_test: async ({ target }, ctx) => {
      const adapter = ctx.ready('connection');
      if (!adapter) return adapterBlocked('connection');
      const result = (await adapter.test({ target })) || {};
      const reachable = result.reachable === true;
      return {
        status: reachable ? 'PASS' : 'FAIL',
        target,
        reachable,
        ...(reachable ? {} : { reasonCode: 'CONNECTION_FAILED' }),
        ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
        executed: false
      };
    },

    operation_plan: ({ operationType, targetEnvironmentId, targetObjectId, action, changes = {} }, ctx) => {
      if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(targetEnvironmentId) || action.trim().length === 0) {
        return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: '対象IDと操作内容を確認してください。', executed: false };
      }
      if (FORBIDDEN_OPERATION_TYPES.includes(operationType)) {
        return {
          status: 'BLOCKED',
          reasonCode: 'FORBIDDEN_OPERATION',
          message: `${operationType} は常に禁止された操作のため、計画を登録しません。`,
          nextStep: '対象操作を見直すか、人間が直接実施する。',
          executed: false
        };
      }
      if (plans.size >= MAX_OPERATIONS) return { status: 'BLOCKED', reasonCode: 'STORE_FULL', executed: false };
      const approvalRequired = APPROVAL_REQUIRED_TYPES.includes(operationType);
      const planBody = { operationType, targetEnvironmentId, targetObjectId, action, changes };
      const record = {
        operationId: crypto.randomUUID(),
        ...planBody,
        planHash: hashValue(planBody),
        approvalRequired,
        status: approvalRequired ? 'awaiting_approval' : 'planned',
        correlationId: ctx.correlationId,
        createdAt: isoNow()
      };
      plans.set(record.operationId, record);
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

    operation_status: ({ operationId }, ctx) => {
      const record = plans.get(operationId);
      if (!record) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', message: '指定された操作IDが見つかりません。', executed: false };
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
      const record = plans.get(operationId);
      if (!record) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', executed: false };
      if (record.status !== 'planned' && record.status !== 'awaiting_approval') {
        return { status: 'FAIL', reasonCode: 'INVALID_STATE', message: `現在の状態（${record.status}）では取り消せません。`, executed: false };
      }
      record.status = 'cancelled';
      return { status: 'PASS', operationId, operationStatus: record.status, executed: false };
    },

    dry_run: ({ operationId }) => {
      const record = plans.get(operationId);
      if (!record) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', executed: false };
      if (record.status === 'cancelled') return { status: 'FAIL', reasonCode: 'INVALID_STATE', message: '取り消し済みの操作です。', executed: false };
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

    snapshot_create: ({ operationId, targetType, targetId, content, dryRun = false }, ctx) => {
      const record = plans.get(operationId);
      if (!record) return { status: 'FAIL', reasonCode: 'TARGET_NOT_FOUND', message: '操作計画が登録されていません。', executed: false };
      if (record.status === 'cancelled') return { status: 'FAIL', reasonCode: 'INVALID_STATE', executed: false };
      const masked = maskDeep(JSON.parse(canonicalJson(content)));
      const beforeHash = hashValue(masked);
      if (dryRun) return { status: 'PASS', dryRun: true, executed: false, beforeHash, snapshotStored: false };
      const snapshot = {
        snapshotId: crypto.randomUUID(),
        operationId,
        correlationId: ctx.correlationId,
        targetType,
        targetId,
        beforeHash,
        content: masked,
        createdAt: isoNow()
      };
      try {
        ctx.store.append('snapshots', snapshot);
      } catch {
        return {
          status: 'FAIL',
          reasonCode: 'SNAPSHOT_STORE_FAILED',
          message: 'スナップショットを保存できなかったため、変更は開始できません。',
          snapshotStored: false,
          executed: false
        };
      }
      return { status: 'PASS', snapshotId: snapshot.snapshotId, beforeHash, snapshotStored: true, executed: false };
    },

    operation_verify: async ({ operationId, targetType, targetId, expectedAfterHash }, ctx) => {
      const adapter = ctx.ready('verify');
      if (!adapter) return adapterBlocked('verify', '対象の再取得アダプターを構成する。');
      const observed = (await adapter.reread({ targetType, targetId })) || {};
      const observedHash = hashValue(maskDeep(JSON.parse(canonicalJson(observed.content ?? null))));
      const verified = observedHash === expectedAfterHash;
      return {
        status: verified ? 'PASS' : 'FAIL',
        operationId,
        verified,
        observedHash,
        expectedAfterHash,
        ...(verified ? {} : { reasonCode: 'VERIFY_FAILED' }),
        executed: false
      };
    },

    audit_write: ({ operationId, event, status, details }, ctx) => {
      try {
        const row = ctx.appendAudit({
          operationId: operationId ?? null,
          correlationId: ctx.correlationId,
          tool: 'audit_write',
          event,
          status,
          details: details ?? {}
        });
        return { status: 'PASS', auditRecordId: row.auditRecordId, recordHash: row.recordHash, executed: false };
      } catch {
        return { status: 'FAIL', reasonCode: 'AUDIT_WRITE_FAILED', message: '監査記録を保存できませんでした。', executed: false };
      }
    },

    rollback_execute: async ({ operationId, snapshotId, approvalToken, dryRun = false }, ctx) => {
      const snapshot = ctx.store.get('snapshots', snapshotId);
      let reason = null;
      if (!snapshot) reason = 'SNAPSHOT_NOT_FOUND';
      else if (snapshot.operationId !== operationId) reason = 'SNAPSHOT_OPERATION_MISMATCH';
      else if (hashValue(snapshot.content) !== snapshot.beforeHash) reason = 'SNAPSHOT_INTEGRITY_FAILED';
      const rollbackAvailable = reason === null;
      if (!rollbackAvailable) {
        return { status: 'FAIL', reasonCode: 'ROLLBACK_NOT_AVAILABLE', rollbackAvailable, rollbackReason: reason, executed: false };
      }
      if (dryRun) return { status: 'PASS', dryRun: true, rollbackAvailable, executed: false, targetType: snapshot.targetType };
      if (!approvalToken) {
        return { status: 'BLOCKED', reasonCode: 'APPROVAL_REQUIRED', rollbackAvailable, executed: false, nextStep: '人間の承認を得て承認トークンを渡す。' };
      }
      const approvalAdapter = ctx.ready('approval');
      if (!approvalAdapter) return { ...adapterBlocked('approval', '承認台帳アダプターを構成する。'), rollbackAvailable };
      const approval = (await approvalAdapter.verify(approvalToken, { operationId, snapshotId })) || {};
      if (approval.approved !== true) {
        return { status: 'FAIL', reasonCode: 'APPROVAL_INVALID', rollbackAvailable, executed: false };
      }
      const restoreAdapter = ctx.ready('restore');
      if (!restoreAdapter) return { ...adapterBlocked('restore', '復元アダプターを構成する（復元経路の試験後）。'), rollbackAvailable };
      const restored = (await restoreAdapter.restore({ targetType: snapshot.targetType, targetId: snapshot.targetId, content: snapshot.content })) || {};
      if (restored.ok !== true) return { status: 'FAIL', reasonCode: 'ROLLBACK_FAILED', rollbackAvailable, executed: true };
      return { status: 'PASS', rollbackAvailable, restored: true, executed: true, nextStep: 'operation_verify で復元後の状態を照合する。' };
    },

    sp_site_get: async (args, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      return { status: 'PASS', site: await adapter.siteGet(), executed: false };
    },

    sp_lists_list: async ({ top = 50 }, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      const lists = await adapter.listsList({ top });
      return { status: 'PASS', count: lists.length, lists, executed: false };
    },

    sp_list_get: async ({ listId }, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      return { status: 'PASS', list: await adapter.listGet({ listId }), executed: false };
    },

    sp_list_schema_get: async ({ listId }, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      const columns = await adapter.listSchemaGet({ listId });
      return { status: 'PASS', listId, count: columns.length, columns, executed: false };
    },

    sp_item_get: async ({ listId, itemId }, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      return { status: 'PASS', listId, item: await adapter.itemGet({ listId, itemId }), executed: false };
    },

    sp_item_query: async ({ listId, top = 50, select, filterField, filterValue }, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      if ((filterField === undefined) !== (filterValue === undefined)) {
        return { status: 'FAIL', reasonCode: 'VALIDATION_FAILED', message: 'filterField と filterValue は組で指定してください。', executed: false };
      }
      let items = await adapter.itemQuery({ listId, top });
      if (filterField !== undefined) {
        items = items.filter((item) => String((item.fields || {})[filterField] ?? '') === filterValue);
      }
      if (select && select.length) {
        items = items.map((item) => ({
          itemId: item.itemId,
          fields: Object.fromEntries(select.filter((key) => key in (item.fields || {})).map((key) => [key, item.fields[key]]))
        }));
      }
      return {
        status: 'PASS',
        listId,
        count: items.length,
        truncated: items.length >= top && filterField === undefined,
        filterScope: filterField === undefined ? null : 'fetched_page_only',
        items,
        executed: false
      };
    },

    sp_permissions_get: async (args, ctx) => {
      const adapter = ctx.ready('sharePoint');
      if (!adapter) return safeErrorPayload(new SharePointAdapterError('AUTH_NOT_CONFIGURED'));
      const permissions = await adapter.permissionsGet();
      return { status: 'PASS', count: permissions.length, permissions, executed: false };
    }
  };

  // 監査が必要なツールは、開始の監査を保存できた場合にのみ実行する。完了の監査が保存できない場合は FAIL とする。
  function finalize(name, correlationId, result) {
    const base = { status: 'FAIL', executed: false, ...result };
    return maskDeep({ tool: name, correlationId, ...base });
  }

  async function callTool(name, rawArgs = {}) {
    const entry = BY_NAME.get(name);
    if (!entry) return null;
    const correlationId = resolveCorrelationId(rawArgs && rawArgs.correlationId);
    const problems = validateArgs(entry.inputSchema, rawArgs);
    if (problems.length) {
      return finalize(name, correlationId, { reasonCode: 'VALIDATION_FAILED', message: problems.join('、') });
    }
    const args = { ...rawArgs };
    delete args.correlationId;
    const audited = entry.meta.auditRequired && name !== 'audit_write';
    const operationId = typeof args.operationId === 'string' ? args.operationId : null;

    if (audited) {
      try {
        appendAudit({ operationId, correlationId, tool: name, event: 'tool_started', status: 'STARTED', argumentKeys: Object.keys(args).sort() });
      } catch {
        return finalize(name, correlationId, {
          reasonCode: 'AUDIT_WRITE_FAILED',
          message: '監査記録を保存できなかったため、実行しませんでした。'
        });
      }
    }

    let result;
    try {
      result = await handlers[name](args, ctxFor(correlationId));
    } catch (error) {
      result = safeErrorPayload(error);
    }

    if (audited) {
      try {
        appendAudit({
          operationId,
          correlationId,
          tool: name,
          event: 'tool_completed',
          status: result.status,
          executed: result.executed === true
        });
      } catch {
        result = { ...result, status: 'FAIL', reasonCode: 'AUDIT_WRITE_FAILED', message: '監査記録の保存に失敗しました。' };
      }
    }
    return finalize(name, correlationId, result);
  }

  // JSON-RPC 2.0 の単一リクエストを処理する。通知（id無し）は null を返す（HTTPでは202）。
  async function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: '不正なリクエストです' } };
    }
    const { id, method, params = {} } = message;
    if (method.startsWith('notifications/') || id === undefined) return null;
    const rpcResult = (result) => ({ jsonrpc: '2.0', id, result });
    const rpcError = (code, text) => ({ jsonrpc: '2.0', id, error: { code, message: text } });
    try {
      if (method === 'initialize') {
        return rpcResult({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: pkg.version }
        });
      }
      if (method === 'ping') return rpcResult({});
      if (method === 'tools/list') {
        return rpcResult({ tools: CATALOG.map((entry) => publicToolFor(entry)) });
      }
      if (method === 'tools/call') {
        const name = params && params.name;
        if (typeof name !== 'string' || !BY_NAME.has(name)) return rpcError(-32602, '不明なツール名です');
        const payload = await callTool(name, (params && params.arguments) || {});
        const isError = payload.status === 'FAIL' || payload.status === 'BLOCKED';
        return rpcResult({
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError
        });
      }
      return rpcError(-32601, '未対応のメソッドです');
    } catch {
      return rpcError(-32603, '内部エラーが発生しました');
    }
  }

  return { handle, callTool, canStartWrite, auditTrail, store, adapters: Object.freeze({ ...adapters }) };
}

module.exports = {
  createOperationsMcp,
  CATALOG,
  TOOL_DEFS: CATALOG.map(publicMeta),
  ALL_TOOL_NAMES,
  INTEGRATED_TOOL_NAMES,
  OPERATIONS_PUBLIC_TOOLS,
  OPERATION_TYPES,
  APPROVAL_REQUIRED_TYPES,
  FORBIDDEN_OPERATION_TYPES,
  TARGET_TYPES
};
