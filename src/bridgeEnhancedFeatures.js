/**
 * Bridge Enhanced Features Service
 * 
 * Phase 3 優先B機能の実装
 * - SharePoint List スキーマ取得
 * - 登録済み Power Automate フロー一覧
 * - Power Automate 実行結果取得
 * - Power Apps 構造解析
 */

const { createCommonResponse } = require('./bridgeCapabilities');
const executivePolicy = require('../config/executive-policy.json');
const { maskDeep } = require('./secretMasking');

// Existing enhanced-feature service; these tools never write business records.
function getExecutivePolicy({ query = '' } = {}) {
  if (typeof query !== 'string' || query.length > 4000) throw new Error('queryは4000文字以内の文字列です');
  const matched = executivePolicy.roles.filter(role => role.keywords.some(word => query.toLowerCase().includes(word.toLowerCase())));
  return createCommonResponse({ status: 'ok', verified: true,
    data: { policy: JSON.parse(JSON.stringify(executivePolicy)), routing: {
      roles: (matched.length ? matched : executivePolicy.roles.slice(0, 1)).map(role => role.name),
      method: 'keyword-advisory', executionState: '未実行', userEntryPoint: 'CNAI'
    } }, summary: 'CNAI Executive vNext方針を取得（業務操作は未実行）' });
}

async function getExecutiveBrief({ sharePointReader, sources = [] } = {}) {
  if (!Array.isArray(sources) || sources.length > 8) throw new Error('sourcesは8件以内の配列です');
  // Validate the entire request before reading any external resource.
  for (const source of sources) {
    if (!source || !executivePolicy.managementData.includes(source.metric)) throw new Error('metricはmanagementDataに存在する項目を指定してください');
    if (!(typeof source.listId === 'string' && source.listId.trim()) && !(typeof source.listName === 'string' && source.listName.trim())) throw new Error('listIdまたはlistNameが必要です');
    if (typeof source.field !== 'string' || !source.field.trim()) throw new Error('実在する列の内部名fieldが必要です');
    if (source.top !== undefined && (!Number.isInteger(source.top) || source.top < 1 || source.top > 200)) throw new Error('topは1～200の整数です');
  }
  const originalValues = [];
  const errors = [];
  const confirmed = new Set();
  for (const source of sources) {
    try {
      if (typeof sharePointReader?.listItems !== 'function') throw new Error('SharePoint取得機能が未構成です');
      const result = await sharePointReader.listItems({ siteId: source.siteId, listId: source.listId, listName: source.listName, top: source.top || 50 });
      if (result.status !== 'ok' || !Array.isArray(result.columns) || !Array.isArray(result.items)) throw new Error('取得結果または列定義を確認できません');
      if (!result.columns.some(column => column.name === source.field || column.internalName === source.field)) throw new Error('指定列の実在性を確認できません');
      const records = result.items.map(item => ({ itemId: item.itemId, value: item.fields?.[source.field] ?? null }));
      originalValues.push({ metric: source.metric, siteId: result.siteId, listId: result.listId, field: source.field,
        records, scope: '取得した項目のみ。期間・全件・通貨・単位は未検証。全社集計に使用不可。',
        complete: result.hasMore === false, retrievedAt: new Date().toISOString() });
      if (records.some(record => record.value !== null)) confirmed.add(source.metric);
    } catch {
      // Do not reflect raw upstream errors, which can contain credentials.
      errors.push({ metric: source.metric, status: '失敗', reason: '取得または列検証に失敗。対象リスト・列・接続を確認してください。' });
    }
  }
  const missingData = executivePolicy.managementData.filter(metric => !confirmed.has(metric))
    .map(metric => ({ metric, sourceCandidates: ['既存SharePoint Lists', '既存SharePoint文書ライブラリの原資料'], verified: false }));
  return createCommonResponse({ status: errors.length ? 'partial' : 'ok', verified: missingData.length === 0 && errors.length === 0,
    data: { executionState: errors.length ? '失敗' : sources.length ? '成功' : '未実行', priorities: [...executivePolicy.priorities],
      originalValues: maskDeep(originalValues, [sharePointReader?.clientSecret]), calculatedValues: [], missingData, retrievalErrors: errors },
    unconfirmed: ['全社・全期間集計', '通貨・単位', '原資料との照合'],
    summary: `${originalValues.length}取得元を確認。不足${missingData.length}項目。未確認値の推測・正本更新はしていません。` });
}

/**
 * SharePoint List のスキーマ情報を取得
 * @param {Object} options - { sharePointReader, siteId, listId }
 * @returns {Object} 共通レスポンス形式
 */
async function getSharePointListSchema(options = {}) {
  const { sharePointReader, siteId, listId } = options;
  const errors = [];
  const warnings = [];

  try {
    if (!sharePointReader) {
      return createCommonResponse({
        status: 'error',
        data: { schema: null },
        verified: false,
        errors: ['SharePoint Reader未構成'],
        summary: 'SharePoint Reader not configured'
      });
    }

    if (!siteId || !listId) {
      return createCommonResponse({
        status: 'error',
        data: { schema: null },
        verified: false,
        errors: ['siteId と listId は必須'],
        summary: 'Missing required parameters'
      });
    }

    // SharePoint List スキーマ取得（カスタムメソッド）
    let columns = [];
    try {
      if (typeof sharePointReader.listColumns !== 'function') throw new Error('列取得機能が未構成です');
      const result = await sharePointReader.listColumns({ siteId, listId });
      columns = Array.isArray(result) ? result : result?.columns;
      if (!Array.isArray(columns)) throw new Error('列取得結果を確認できません');
    } catch (error) {
      if (error.message?.includes('404')) {
        errors.push(`List not found: ${listId}`);
      } else {
        errors.push(error.message);
      }
    }

    // スキーマ構造へ変換
    const schema = {
      siteId,
      listId,
      columnCount: columns.length,
      columns: columns.map(col => ({
        displayName: col.displayName || col.name,
        internalName: col.internalName || col.name,
        type: col.type,
        required: col.required || false,
        readOnly: col.readOnly || false,
        description: col.description || '',
        // Choice型の場合は選択肢を含める
        ...(col.type === 'Choice' && col.choices ? { choices: col.choices } : {}),
        // Lookup型の場合は参照先情報を含める
        ...(col.type === 'Lookup' && col.lookupListId ? { 
          lookupListId: col.lookupListId,
          lookupFieldName: col.lookupFieldName 
        } : {}),
        // 一意制約の有無
        unique: col.unique || false
      }))
    };

    return createCommonResponse({
      status: errors.length > 0 ? 'error' : 'ok',
      data: { schema },
      verified: errors.length === 0,
      warnings,
      errors,
      summary: errors.length === 0 
        ? `List schema: ${columns.length} columns`
        : `Schema retrieval failed: ${errors[0]}`
    });
  } catch (error) {
    return createCommonResponse({
      status: 'error',
      data: { schema: null },
      verified: false,
      errors: [error.message],
      summary: `Unexpected error: ${error.message}`
    });
  }
}

/**
 * 登録済み Power Automate フロー一覧を取得
 * @param {Object} options - { powerAutomateRunner }
 * @returns {Object} 共通レスポンス形式
 */
async function listRegisteredPowerAutomateFlows(options = {}) {
  const { powerAutomateRunner } = options;
  const errors = [];
  const warnings = [];

  try {
    if (!powerAutomateRunner) {
      return createCommonResponse({
        status: 'error',
        data: { flows: [] },
        verified: false,
        errors: ['Power Automate Runner未構成'],
        summary: 'Power Automate Runner not configured'
      });
    }

    // 登録済みフロー情報を取得（カスタムメソッド）
    let flows = [];
    try {
      if (typeof powerAutomateRunner.listRegisteredFlows !== 'function') throw new Error('登録フロー一覧機能が未構成です');
      flows = await powerAutomateRunner.listRegisteredFlows();
      if (!Array.isArray(flows)) throw new Error('登録フロー一覧を確認できません');
    } catch (error) {
      errors.push(`Failed to list flows: ${error.message}`);
    }

    // フロー情報を構造化
    const flowList = flows.map(flow => ({
      flowKey: flow.flowKey,
      displayName: flow.displayName || flow.name,
      description: flow.description || '',
      purpose: flow.purpose || '',
      status: flow.enabled ? 'enabled' : 'disabled',
      triggerType: flow.triggerType || 'unknown',
      requiresApproval: flow.requiresApproval || false,
      inputDefinition: flow.inputDefinition ? {
        count: Object.keys(flow.inputDefinition).length,
        parameters: Object.keys(flow.inputDefinition)
      } : null,
      outputDefinition: flow.outputDefinition ? {
        count: Object.keys(flow.outputDefinition).length,
        parameters: Object.keys(flow.outputDefinition)
      } : null,
      lastModified: flow.lastModified,
      note: 'Trigger URL and SAS values are not returned for security'
    }));

    // 無効なフローについて警告
    const disabledFlows = flowList.filter(f => f.status !== 'enabled');
    if (disabledFlows.length > 0) {
      warnings.push(`${disabledFlows.length} disabled flow(s) found`);
    }

    return createCommonResponse({
      status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok',
      data: { 
        flowCount: flowList.length,
        scope: 'Bridge登録済みフローのみ。Power Platform環境全体の一覧ではありません。',
        flows: flowList
      },
      verified: errors.length === 0,
      warnings,
      errors,
      summary: `${flowList.length} registered flows`
    });
  } catch (error) {
    return createCommonResponse({
      status: 'error',
      data: { flows: [] },
      verified: false,
      errors: [error.message],
      summary: `Unexpected error: ${error.message}`
    });
  }
}

/**
 * Power Automate フロー実行結果を取得
 * @param {Object} options - { powerAutomateRunner, runId }
 * @returns {Object} 共通レスポンス形式
 */
async function getPowerAutomateRunResult(options = {}) {
  const { powerAutomateRunner, runId } = options;
  const errors = [];
  const warnings = [];

  try {
    if (!powerAutomateRunner) {
      return createCommonResponse({
        status: 'error',
        data: { result: null },
        verified: false,
        errors: ['Power Automate Runner未構成'],
        summary: 'Power Automate Runner not configured'
      });
    }

    if (!runId) {
      return createCommonResponse({
        status: 'error',
        data: { result: null },
        verified: false,
        errors: ['runId は必須'],
        summary: 'Missing runId'
      });
    }

    // フロー実行結果を取得
    let runResult = null;
    try {
      runResult = await powerAutomateRunner.getRunResult?.(runId);
    } catch (error) {
      if (error.message?.includes('404')) {
        errors.push(`Run not found: ${runId}`);
      } else {
        errors.push(error.message);
      }
    }

    if (!runResult) {
      return createCommonResponse({
        status: 'error',
        data: { result: null },
        verified: false,
        errors: errors.length > 0 ? errors : ['Run result not available'],
        summary: 'Failed to retrieve run result'
      });
    }

    // 実行結果を構造化
    const result = {
      runId,
      status: runResult.status, // Succeeded, Failed, Running等
      startTime: runResult.startTime,
      endTime: runResult.endTime,
      duration: runResult.endTime && runResult.startTime
        ? new Date(runResult.endTime) - new Date(runResult.startTime)
        : null,
      flowName: runResult.flowName,
      triggerName: runResult.triggerName,
      actions: (runResult.actions || []).map(action => ({
        name: action.name,
        status: action.status,
        startTime: action.startTime,
        endTime: action.endTime,
        error: action.error ? {
          code: action.error.code,
          message: action.error.message
        } : null
      })),
      outputs: runResult.outputs ? Object.keys(runResult.outputs) : [],
      errors: runResult.errors ? runResult.errors.map(err => ({
        code: err.code,
        message: err.message
      })) : []
    };

    // ステータス判定
    const isFailed = result.status === 'Failed';
    const hasErrors = result.errors.length > 0;

    return createCommonResponse({
      status: isFailed ? 'error' : hasErrors ? 'warning' : 'ok',
      data: { result },
      verified: !isFailed && !hasErrors,
      warnings: hasErrors ? result.errors.map(e => `${e.code}: ${e.message}`) : [],
      errors: isFailed ? [`Flow execution failed: ${result.status}`] : [],
      summary: `Run ${runId}: ${result.status}`
    });
  } catch (error) {
    return createCommonResponse({
      status: 'error',
      data: { result: null },
      verified: false,
      errors: [error.message],
      summary: `Unexpected error: ${error.message}`
    });
  }
}

/**
 * Power Apps 構造を解析
 * 画面一覧、コントロール一覧、コンポーネント、データソース等を取得
 * @param {Object} options - { powerAppsStore, appId }
 * @returns {Object} 共通レスポンス形式
 */
async function inspectPowerAppsStructure(options = {}) {
  const { powerAppsStore, appId } = options;
  const errors = [];
  const warnings = [];
  const unconfirmed = [];

  try {
    if (!powerAppsStore) {
      return createCommonResponse({
        status: 'error',
        data: { structure: null },
        verified: false,
        errors: ['Power Apps Store未構成'],
        summary: 'Power Apps Store not configured'
      });
    }

    // App情報を取得
    let appInfo = null;
    try {
      appInfo = await powerAppsStore.getAppInfo?.();
    } catch (error) {
      errors.push(`Failed to get app info: ${error.message}`);
    }

    if (!appInfo) {
      return createCommonResponse({
        status: 'error',
        data: { structure: null },
        verified: false,
        errors: errors.length > 0 ? errors : ['App info not available'],
        summary: 'Failed to retrieve app structure'
      });
    }

    // Power Fx参照の抽出（簡易）
    const extractPowerFxReferences = (content) => {
      const patterns = {
        SharePointReferences: (content.match(/SharePoint\./g) || []).length,
        FilterUsage: (content.match(/Filter\(/gi) || []).length,
        LookupUsage: (content.match(/LookUp\(/gi) || []).length,
        PatchUsage: (content.match(/Patch\(/gi) || []).length,
        SubmitFormUsage: (content.match(/SubmitForm\(/gi) || []).length
      };
      return patterns;
    };

    // 構造情報を構築
    const structure = {
      appId: appInfo.id,
      appName: appInfo.name,
      environmentId: appInfo.environmentId,
      screens: {
        count: appInfo.screenCount || 0,
        list: (appInfo.screens || []).map(screen => ({
          name: screen.name,
          displayName: screen.displayName,
          controlCount: screen.controlCount || 0
        }))
      },
      components: {
        count: appInfo.componentCount || 0,
        list: (appInfo.components || []).map(comp => ({
          name: comp.name,
          description: comp.description
        }))
      },
      dataSources: {
        count: appInfo.dataSourceCount || 0,
        list: (appInfo.dataSources || []).map(ds => ({
          name: ds.name,
          type: ds.type, // SharePoint, Excel, Dataverse等
          tableName: ds.tableName,
          readOnly: ds.readOnly || false
        }))
      },
      connectors: {
        count: appInfo.connectorCount || 0,
        list: (appInfo.connectors || []).map(conn => ({
          name: conn.name,
          type: conn.type,
          status: conn.status // Connected, NeedsAuthentication等
        }))
      },
      powerFxMetrics: appInfo.sourceContent 
        ? extractPowerFxReferences(appInfo.sourceContent)
        : null,
      lastModified: appInfo.lastModifiedTime,
      publishedVersion: appInfo.publishedVersion,
      unpublishedChanges: appInfo.unpublishedChanges || false
    };

    // 警告を抽出
    if (structure.unpublishedChanges) {
      warnings.push('Unpublished changes exist');
    }
    if (structure.dataSources.list.some(ds => ds.status === 'NeedsAuthentication')) {
      warnings.push('Some data sources require authentication');
    }
    if (structure.screenCount === 0) {
      warnings.push('No screens found');
    }

    // 未確認事項
    if (!appInfo.sourceContent) {
      unconfirmed.push('Source content not available - detailed Power Fx analysis skipped');
    }

    return createCommonResponse({
      status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'ok',
      data: { structure },
      verified: errors.length === 0 && structure.screenCount > 0,
      warnings,
      errors,
      unconfirmed: unconfirmed.length > 0 ? unconfirmed : undefined,
      summary: `App structure: ${structure.screens.count} screens, ${structure.components.count} components`
    });
  } catch (error) {
    return createCommonResponse({
      status: 'error',
      data: { structure: null },
      verified: false,
      errors: [error.message],
      summary: `Unexpected error: ${error.message}`
    });
  }
}

module.exports = {
  getExecutivePolicy,
  getExecutiveBrief,
  getSharePointListSchema,
  listRegisteredPowerAutomateFlows,
  getPowerAutomateRunResult,
  inspectPowerAppsStructure
};
