'use strict';

// Power Automate（クラウドフロー）の参照アダプター（POWER_AUTOMATE_READ）。
// - フローのメタデータは Dataverse の workflows テーブル（category 5 = クラウドフロー）から読む。
// - 環境の Dataverse クライアントは注入する（対象環境の固定は PowerPlatform 側の責務）。
// - フロー定義（clientdata）は生のまま返さない。SAS 付きURL・接続情報を含みうるため、
//   操作名・コネクタ種別・変数名だけを返す。秘密らしき値を検出したら検証結果に出す（値は出さない）。
// - 書込みは含まない（POWER_AUTOMATE_WRITE で、snapshot と rollback 境界の内側にのみ実装する）。
// - エンドポイントは Dataverse Web API（v9.2）。実環境での応答形式は未確認（BLOCKED: 実環境接続）。

const { containsLikelySecret } = require('../secretMasking');

const CLOUD_FLOW_CATEGORY = 5;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const LIST_TOP = 200;
// 例: ?sig=..., &sv=..., api_key=..., access_token=...（値の部分は出力しない）。
const EMBEDDED_CREDENTIAL_RE = /(?:sig|sv|api[_-]?key|access[_-]?token|x-api-key)\s*=\s*[^&"\s\\]{6,}/i;

const READ_ACTION_SCHEMAS = Object.freeze({
  flows_list: { required: [], optional: ['stateFilter'] },
  flow_get: { required: ['flowId'], optional: [] },
  flow_definition_get: { required: ['flowId'], optional: [] },
  flow_connection_references_get: { required: ['flowId'], optional: [] },
  flow_environment_variables_get: { required: ['flowId'], optional: [] },
  flow_validate: { required: ['flowId'], optional: [] }
});

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function checkFlowId(flowId) {
  if (typeof flowId !== 'string' || !GUID_RE.test(flowId)) throw fail('VALIDATION_FAILED', 'flowId は GUID で指定してください');
  return flowId;
}

// 定義のうち、外へ返してよい情報だけを取り出す。
function summarizeDefinition(clientdata) {
  let def = clientdata;
  if (typeof def === 'string') {
    try { def = JSON.parse(def); } catch { return { parseable: false, triggers: [], actions: [], connectors: [], variables: [] }; }
  }
  const definition = def?.properties?.definition || def?.definition || def || {};
  const triggers = Object.entries(definition.triggers || {}).map(([name, t]) => ({ name, type: t?.type || null }));
  const actions = [];
  const connectors = new Set();
  const variables = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [name, a] of Object.entries(node.actions || {})) {
      actions.push({ name, type: a?.type || null });
      walk(a);
    }
    if (node.else) walk(node.else);
  };
  walk(definition);
  // 接続参照（コネクタ種別と論理名のみ）。接続ID・トークンは返さない。
  for (const [logical, ref] of Object.entries(def?.properties?.connectionReferences || def?.connectionReferences || {})) {
    connectors.add(JSON.stringify({ logicalName: logical, connectorId: ref?.id || null }));
  }
  // 環境変数の参照名（@parameters('...') / @{parameters('...')} のみ。値は読まない）。
  const text = JSON.stringify(definition);
  for (const m of text.matchAll(/parameters\(\\?'([A-Za-z0-9_]+)\\?'\)/g)) variables.add(m[1]);
  return {
    parseable: true,
    triggers,
    actions,
    connectors: [...connectors].map((c) => JSON.parse(c)),
    variables: [...variables],
    containsSecretLikeText: containsLikelySecret(text),
    // SAS 署名・API キー等を URL やヘッダに埋め込んだ形（共通検出器では拾えないため個別に見る）。
    containsEmbeddedCredential: EMBEDDED_CREDENTIAL_RE.test(text)
  };
}

function createPowerAutomateAdapter({ dataverse } = {}) {
  if (typeof dataverse !== 'function') throw new Error('dataverse resolver is required');

  async function client() {
    const dv = await dataverse();
    if (!dv || dv.error) throw fail(dv?.error || 'DATAVERSE_NOT_AVAILABLE', 'Dataverse に接続できません（未プロビジョニングまたは未構成）');
    return dv.client;
  }

  async function flowsList({ stateFilter } = {}) {
    const dv = await client();
    const filters = [`category eq ${CLOUD_FLOW_CATEGORY}`];
    if (stateFilter === 'on') filters.push('statecode eq 1');
    if (stateFilter === 'off') filters.push('statecode eq 0');
    const data = await dv.request({
      pathAndQuery: `/api/data/v9.2/workflows?$select=workflowid,name,statecode,statuscode,modifiedon&$filter=${filters.join(' and ')}&$top=${LIST_TOP}`
    });
    const items = (data?.value || []).map((w) => ({
      flowId: w.workflowid, displayName: w.name, state: w.statecode === 1 ? 'on' : 'off', modifiedOn: w.modifiedon || null
    }));
    return { items, truncated: items.length >= LIST_TOP };
  }

  async function flowGet({ flowId }) {
    const id = checkFlowId(flowId);
    const dv = await client();
    const w = await dv.request({ pathAndQuery: `/api/data/v9.2/workflows(${id})?$select=workflowid,name,statecode,statuscode,modifiedon,category` });
    return { flowId: w.workflowid, displayName: w.name, state: w.statecode === 1 ? 'on' : 'off', statusCode: w.statuscode ?? null, modifiedOn: w.modifiedon || null, category: w.category ?? null };
  }

  async function fetchDefinition(flowId) {
    const id = checkFlowId(flowId);
    const dv = await client();
    const w = await dv.request({ pathAndQuery: `/api/data/v9.2/workflows(${id})?$select=clientdata` });
    return summarizeDefinition(w?.clientdata);
  }

  async function flowDefinitionGet({ flowId }) {
    const s = await fetchDefinition(flowId);
    return { flowId: checkFlowId(flowId), parseable: s.parseable, triggers: s.triggers, actions: s.actions };
  }

  async function flowConnectionReferencesGet({ flowId }) {
    const s = await fetchDefinition(flowId);
    return { flowId: checkFlowId(flowId), connectors: s.connectors };
  }

  async function flowEnvironmentVariablesGet({ flowId }) {
    const s = await fetchDefinition(flowId);
    return { flowId: checkFlowId(flowId), variables: s.variables, valuesIncluded: false };
  }

  async function flowValidate({ flowId }) {
    const id = checkFlowId(flowId);
    const s = await fetchDefinition(id);
    const checks = [];
    checks.push({ name: 'definition_parseable', result: s.parseable ? 'PASS' : 'FAIL' });
    checks.push({ name: 'has_trigger', result: s.triggers.length > 0 ? 'PASS' : 'FAIL' });
    checks.push({ name: 'has_action', result: s.actions.length > 0 ? 'PASS' : 'FAIL' });
    checks.push({ name: 'no_secret_like_text', result: s.containsSecretLikeText ? 'FAIL' : 'PASS' });
    checks.push({ name: 'no_embedded_credential', result: s.containsEmbeddedCredential ? 'FAIL' : 'PASS' });
    const verdict = checks.some((c) => c.result === 'FAIL') ? 'FAIL' : 'PASS';
    // 値は出さない。失敗理由のコードだけを返す。
    return { flowId: id, verdict, checks };
  }

  const handlers = {
    flows_list: flowsList,
    flow_get: flowGet,
    flow_definition_get: flowDefinitionGet,
    flow_connection_references_get: flowConnectionReferencesGet,
    flow_environment_variables_get: flowEnvironmentVariablesGet,
    flow_validate: flowValidate
  };

  async function call(name, args = {}) {
    const handler = handlers[name];
    if (!handler) throw fail('UNSUPPORTED_OPERATION', 'unsupported Power Automate operation');
    return handler(args);
  }

  return { operations: Object.freeze(Object.keys(handlers)), schemas: READ_ACTION_SCHEMAS, call };
}

module.exports = { createPowerAutomateAdapter, READ_ACTION_SCHEMAS, CLOUD_FLOW_CATEGORY, summarizeDefinition };
