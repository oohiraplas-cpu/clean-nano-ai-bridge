require('dotenv').config();

const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const { getConfig } = require('./config');
const { TaskStore } = require('./taskStore');
const { SharePointTaskStore } = require('./sharePointTaskStore');
const { PowerAppsStore } = require('./powerAppsStore');
const { PowerAppsGitStore } = require('./powerAppsGitStore');
const { SharePointReader } = require('./sharePointReader');
const { SharePointListWriter, CN_EMPLOYEE_LEDGER_FIELD_MAP } = require('./sharePointListWriter');
const { PowerAutomateRunner } = require('./powerAutomateRunner');
const { DeploymentService } = require('./deploymentService');
const { PermissionsService } = require('./permissionsService');
const { validateChange, verifySaveResult } = require('./powerAppsChangeValidation');
const { runStaticTests } = require('./powerAppsStaticTests');
const { INSPECTION_TOOLS, validateInspectionParams } = require('./powerAppsInspectionValidation');
const { PowerAppsStructureService } = require('./powerAppsStructureService');
const { PowerAppsImpactService } = require('./powerAppsImpactService');
const { ChangeSnapshotService } = require('./changeSnapshotService');
const {
  validateMcpInput,
  validateStatusInput,
  validateTaskInput,
  validateCreateTaskParams,
  validateUpdateTaskStatusParams,
  validateGetTaskResultParams
} = require('./validation');
const {
  validatePowerAppsMcpInput,
  validateGetPowerAppsAppParams,
  validateGetPowerAppsStateParams,
  validateUpdatePowerAppsAppParams,
  validateSavePowerAppsAppParams,
  validatePublishPowerAppsAppParams,
  validateGetPowerAppsOperationResultParams,
  validateGetPowerAppsSourceParams,
  validateValidatePowerAppsChangeParams,
  validateRunPowerAppsTestsParams,
  validateVerifySaveResultParams
} = require('./powerAppsValidation');
const {
  validateGetSharePointListParams,
  validateGetSharePointColumnsParams,
  validateEnsureSharePointColumnsParams,
  validateRunPowerAutomateFlowParams,
  validateCreateEmployeeLedgerEntryParams,
  validateUpdateEmployeeLedgerEntryParams,
  validateDeployToTestParams,
  validateVerifyDeploymentParams,
  validateGetDeploymentLogsParams,
  validateRollbackDeploymentParams,
  validateGetPermissionsParams,
  validateUpdatePermissionsParams
} = require('./bridgeExtensionsValidation');

function createDefaultStore(config) {
  if (config.taskStoreBackend === 'sharepoint') return new SharePointTaskStore(config.sharepoint);
  return new TaskStore(config.tasksFile);
}

function apiKeyMiddleware(getKey) {
  return (req, res, next) => {
    const expected = getKey();
    if (!expected) return next();

    // Copilot Studio MCP connections can send API keys either in a header or
    // in the query string. Some MCP clients also use Authorization: Bearer.
    // Accept the same configured secret through these transports without
    // changing the secret itself or weakening the comparison.
    const authorization = req.get('authorization') || '';
    const bearer = authorization.match(/^Bearer\s+(.+)$/i);
    const candidates = [
      req.get('x-api-key'),
      bearer ? bearer[1] : '',
      typeof req.query?.['x-api-key'] === 'string' ? req.query['x-api-key'] : '',
      typeof req.query?.api_key === 'string' ? req.query.api_key : ''
    ].filter((value) => typeof value === 'string' && value.length > 0);

    const valid = candidates.some((actual) => actual.length === expected.length
      && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected)));
    if (!valid) return res.status(401).json({ error: '認証に失敗しました' });
    return next();
  };
}

const MCP_METHODS = Object.freeze([
  'health_check', 'get_tasks', 'get_next_task',
  'create_task', 'update_task_status', 'get_task_result',
  'get_powerapps_app', 'get_powerapps_state', 'update_powerapps_app',
  'save_powerapps_app', 'publish_powerapps_app', 'get_powerapps_operation_result',
  'get_powerapps_source',
  'get_sharepoint_list', 'get_sharepoint_columns', 'ensure_sharepoint_columns', 'run_power_automate_flow',
  'create_employee_ledger_entry', 'update_employee_ledger_entry',
  'validate_powerapps_change', 'run_powerapps_tests', 'verify_save_result',
  'deploy_to_test', 'verify_deployment', 'get_deployment_logs', 'rollback_deployment',
  'get_permissions', 'update_permissions',
  ...INSPECTION_TOOLS.map(tool => tool.name)
]);

const EMPLOYEE_LEDGER_RECORD_PROPERTIES = Object.freeze({
  name: { type: 'string', description: '氏名' },
  employeeId: { type: 'string', description: '社員ID' },
  department: { type: 'string', description: '所属' },
  employmentStatus: { type: 'string', description: '状態' },
  progressStatus: { type: 'string', description: '進捗状況' },
  hireDate: { type: 'string', description: '入社日（YYYY-MM-DD）' },
  remarks: { type: 'string', description: '備考' }
});

const MCP_PUBLIC_TOOLS = Object.freeze([
  {
    name: 'health_check',
    description: 'Bridgeの稼働状態を確認します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_tasks',
    description: 'タスク一覧を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_next_task',
    description: '次に実行可能なタスクを取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'create_task',
    description: 'ChatGPTからPower Appsへ渡す編集タスクを新規作成します。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '編集タスクのタイトル' },
        description: { type: 'string', description: 'Power Appsへ渡す具体的な編集内容' },
        priority: { type: 'string', description: '優先度（省略時normal）' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'update_task_status',
    description: '編集タスクの状態と実行結果を更新します。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '対象タスクID' },
        status: { type: 'string', description: '更新後の状態' },
        result: { description: '実行結果' }
      },
      required: ['task_id', 'status'],
      additionalProperties: false
    }
  },
  {
    name: 'get_task_result',
    description: '編集タスクの状態と実行結果を取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '対象タスクID' }
      },
      required: ['task_id'],
      additionalProperties: false
    }
  },
  {
    name: 'get_powerapps_app',
    description: '既存Power Appsアプリの情報を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_powerapps_state',
    description: '既存Power Appsアプリの現在状態を取得します。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_powerapps_source',
    description: '既存Power Appsソースの指定ファイルを取得します。',
    inputSchema: {
      type: 'object',
      properties: { relativePath: { type: 'string', description: '取得するソースファイルの相対パス' } },
      required: ['relativePath'],
      additionalProperties: false
    }
  },
  {
    name: 'update_powerapps_app',
    description: '既存Power Appsアプリを更新します。ソース更新時はGitHubへ保存後、Power Platformへ同期します。',
    inputSchema: {
      type: 'object',
      properties: {
        updateData: { type: 'object', description: 'Power Apps管理APIへ送る更新内容' },
        relativePath: { type: 'string', description: '更新するソースファイルの相対パス' },
        content: { type: 'string', description: '更新後のファイル内容' },
        message: { type: 'string', description: '更新のコミットメッセージ' },
        branch: { type: 'string', description: 'get_powerapps_sourceが返したbranch。正本branchと一致しない場合は拒否します（任意）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'save_powerapps_app',
    description: 'GitHubの既存Power AppsソースをPower Platformへ同期し、保存状態を確認します。',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'get_powerapps_sourceが返したbranch。正本branchと一致しない場合は拒否します（任意）' } },
      additionalProperties: false
    }
  },
  {
    name: 'publish_powerapps_app',
    description: '既存Power Appsアプリを公開します。',
    inputSchema: {
      type: 'object',
      properties: { branch: { type: 'string', description: 'get_powerapps_sourceが返したbranch。正本branchと一致しない場合は拒否します（任意）' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_sharepoint_list',
    description: 'SharePointリストの項目を読み取り専用で取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: '取得するSharePointリストのID' },
        listName: { type: 'string', description: 'listId未指定時に表示名で検索するためのリスト名' },
        siteId: { type: 'string', description: '対象サイトID（省略時は既定のサイトを使用）' },
        top: { type: 'number', description: '取得件数の上限（既定50、最大200）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_sharepoint_columns',
    description: 'SharePointリストの列定義（内部名・表示名・型・必須・Choice候補等）を読み取り専用で取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: '取得するSharePointリストのID' },
        listName: { type: 'string', description: 'listId未指定時に表示名で検索するためのリスト名' },
        siteId: { type: 'string', description: '対象サイトID（省略時は既定のサイトを使用）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'ensure_sharepoint_columns',
    description: 'SharePointリストに不足列だけを追加します。既存列は変更・削除せずスキップします。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string' },
        listName: { type: 'string' },
        siteId: { type: 'string' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              displayName: { type: 'string' },
              type: { type: 'string', enum: ['text','number','dateTime','boolean','choice'] },
              required: { type: 'boolean' },
              multiline: { type: 'boolean' },
              choices: { type: 'array', items: { type: 'string' } },
              description: { type: 'string' }
            },
            required: ['name','displayName','type'],
            additionalProperties: false
          }
        },
        approvedByHuman: { type: 'boolean' }
      },
      required: ['columns','approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'run_power_automate_flow',
    description: '登録済みのPower AutomateフローをHTTPトリガー経由で実行します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        flowKey: { type: 'string', description: '実行するフローの登録キー' },
        payload: { type: 'object', description: 'フローに渡す入力データ' },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['flowKey', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'create_employee_ledger_entry',
    description: 'CN_社員台帳へ新しい社員情報を1件登録します。列内部名は実環境で確認済みの固定マッピングを使用します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        record: {
          type: 'object',
          description: '登録する項目',
          properties: EMPLOYEE_LEDGER_RECORD_PROPERTIES,
          additionalProperties: false
        },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['record', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'update_employee_ledger_entry',
    description: 'CN_社員台帳の既存社員情報を部分更新します。人間承認（approvedByHuman:true）が必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: '更新対象のSharePointアイテムID' },
        record: {
          type: 'object',
          description: '更新する項目（部分更新、指定したキーのみ上書き）',
          properties: EMPLOYEE_LEDGER_RECORD_PROPERTIES,
          additionalProperties: false
        },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['itemId', 'record', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  {
    name: 'get_powerapps_operation_result',
    description: 'Power Apps操作（更新・保存・公開）のoperationIdから、記録された結果を取得します。',
    inputSchema: {
      type: 'object',
      properties: { operationId: { type: 'string', description: '操作ID（更新・保存・公開の応答に含まれるoperationId）' } },
      required: ['operationId'],
      additionalProperties: false
    }
  },
  {
    name: 'validate_powerapps_change',
    description: 'Power Appsソース変更を適用前に検査します（branch・relativePath・対象ファイル・削除・大規模差分・構文）。valid・errors・warnings・summaryを返します。',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: '変更対象のbranch（正本branchと一致する必要があります）' },
        relativePath: { type: 'string', description: '対象ソースファイルの相対パス' },
        content: { type: 'string', description: '更新後のファイル内容（削除の場合は指定しません）' },
        currentContent: { type: 'string', description: '現在のファイル内容（省略時は正本branchから取得します）' },
        currentExists: { type: 'boolean', description: '対象ファイルが現在存在するか（currentContent未指定時の補足）' },
        delete: { type: 'boolean', description: 'ファイル削除を検査する場合はtrue' },
        create: { type: 'boolean', description: '新規ファイル作成を許可する場合はtrue' },
        allowLargeDiff: { type: 'boolean', description: '大規模差分（変更率80%以上）を意図したものとして許可する場合はtrue' }
      },
      required: ['branch', 'relativePath'],
      additionalProperties: false
    }
  },
  {
    name: 'run_powerapps_tests',
    description: 'Power Appsソース変更の静的検査（構文・括弧・引用符・重複定義・画面遷移・データソース参照・危険な削除）を実行します。実行不能の項目は成功扱いにせずskippedとreasonを返します。',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: '検査する変更ファイル（1〜50件）',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string' },
              content: { type: 'string', description: '更新後の内容（削除の場合は指定しません）' },
              delete: { type: 'boolean', description: '削除するファイルの場合はtrue' }
            },
            required: ['relativePath'],
            additionalProperties: false
          }
        },
        knownScreens: { type: 'array', items: { type: 'string' }, description: '既存の画面名一覧（指定すると画面遷移先を厳密に検証します）' },
        knownDataSources: { type: 'array', items: { type: 'string' }, description: '既存のデータソース/コネクタ名一覧（指定するとデータソース参照を検証します）' }
      },
      required: ['files'],
      additionalProperties: false
    }
  },
  {
    name: 'verify_save_result',
    description: '保存後にアプリ状態と正本ソースを再取得し、branch・relativePath・期待SHAまたは期待内容・エラー状態を検証します。expectedShaまたはexpectedContentのいずれかが必須です。',
    inputSchema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string', description: '検証するソースファイルの相対パス' },
        branch: { type: 'string', description: '想定しているbranch（正本branchと一致する必要があります）' },
        expectedSha: { type: 'string', description: '期待するファイルのSHA（40桁の16進）' },
        expectedContent: { type: 'string', description: '期待するファイル内容' }
      },
      required: ['relativePath'],
      additionalProperties: false
    }
  },
  {
    name: 'deploy_to_test',
    description: '構成済みの非本番テスト環境へだけデプロイを要求します。本番・環境不明・設定不足・branch不一致は拒否します。',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'デプロイ元branch（許可branchと一致する必要があります）' },
        environment: { type: 'string', description: '対象環境名（省略時は構成済みのテスト環境）。本番は指定できません' },
        ref: { type: 'string', description: 'デプロイするコミットSHA（省略時はbranch先頭）' }
      },
      required: ['branch'],
      additionalProperties: false
    }
  },
  {
    name: 'verify_deployment',
    description: '対象環境・バージョン・デプロイ結果・healthのHTTP状態と応答内容を検証します。確認できない項目は成功扱いにしません。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '検証する環境名（省略時は構成済みのテスト環境）' },
        deploymentId: { type: 'string', description: 'deploy_to_testが返したdeploymentId（デプロイ結果の検証に使用）' },
        expectedVersion: { type: 'string', description: '期待するバージョン（healthの応答のversionと比較）' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_deployment_logs',
    description: '構成済みのデプロイ基盤から診断ログ（workflow run・job・step）を取得します。トークン・APIキー・接続文字列などはマスクされます。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '対象環境名（省略時は構成済みのテスト環境）' },
        deploymentId: { type: 'string', description: '対象のdeploymentId' },
        runId: { type: 'integer', description: '対象のworkflow run ID（deploymentIdとは同時に指定できません）' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '取得件数（既定5、最大20）' },
        includeJobLogs: { type: 'boolean', description: 'jobログ本文の末尾100行を含める場合はtrue' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'rollback_deployment',
    description: '確認済み（verify_deploymentでverified）の復旧元へだけ戻します。本番はapprovedByHuman:trueが必須です。復旧後にhealthを再確認します。',
    inputSchema: {
      type: 'object',
      properties: {
        environment: { type: 'string', description: '対象環境名（省略時は構成済みのテスト環境）' },
        targetDeploymentId: { type: 'string', description: '復旧元のdeploymentId（確認済みのもののみ）' },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（本番ではtrue必須）' }
      },
      required: ['targetDeploymentId'],
      additionalProperties: false
    }
  },
  {
    name: 'get_permissions',
    description: '構成済み対象の権限を読み取り専用で取得します。対象種別・取得範囲・現在の権限を返し、秘密情報は返しません。',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: { type: 'string', enum: ['powerapps_app', 'dataverse_user_roles'], description: '対象種別' },
        principalId: { type: 'string', description: 'dataverse_user_rolesで対象とするsystemuserのGUID' }
      },
      required: ['targetType'],
      additionalProperties: false
    }
  },
  {
    name: 'update_permissions',
    description: '必要最小権限のみを付与・取消します。人間承認（approvedByHuman:true）が必須です。System Administrator等の強い権限・テナント全体共有・外部共有は拒否し、変更前後を検証します。',
    inputSchema: {
      type: 'object',
      properties: {
        targetType: { type: 'string', enum: ['powerapps_app', 'dataverse_user_roles'], description: '対象種別' },
        action: { type: 'string', enum: ['grant', 'revoke'], description: '付与または取消' },
        principalId: { type: 'string', description: '対象のEntraオブジェクトID（GUID）またはメールアドレス（dataverse_user_rolesではsystemuserのGUID）' },
        principalType: { type: 'string', enum: ['User', 'Group', 'Tenant'], description: '対象の種別（Tenantは常に拒否されます）' },
        roleName: { type: 'string', description: 'ロール名（powerapps_app: CanView/CanEdit。dataverse_user_roles: 許可リストのロール）' },
        approvedByHuman: { type: 'boolean', description: '人間による承認済みであることを示すフラグ（true必須）' }
      },
      required: ['targetType', 'action', 'principalId', 'principalType', 'roleName', 'approvedByHuman'],
      additionalProperties: false
    }
  },
  ...INSPECTION_TOOLS
]);

async function tasksPayload(store) {
  const tasks = await store.list();
  return { status: tasks.length ? 'ok' : 'タスクなし', count: tasks.length, tasks };
}

async function nextPayload(store) {
  const task = await store.next();
  return task ? { status: 'ok', task } : { status: 'タスクなし', task: null };
}

async function createTaskPayload(store, params) {
  const task = await store.upsert({
    id: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    priority: params.priority || 'normal',
    status: '未着手'
  });
  return { task_id: task.id, task };
}

async function updateTaskStatusPayload(store, params) {
  const patch = { status: params.status };
  if (params.result !== undefined) patch.result = params.result;
  return store.update(params.task_id, patch);
}

async function getTaskResultPayload(store, taskId) {
  const tasks = await store.list();
  return tasks.find((task) => task.id === taskId) || null;
}

function requestError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// powerAppsGitStore (GitHub Contents API経由)の呼び出しは、設定不足やGitHub側のエラーを
// プレーンなErrorとして投げる。error.statusが未設定のまま/mcpのtools/callハンドラに届くと
// 中央エラーハンドラの汎用500応答に丸められ、実際の原因（設定不足、404など）が失われるうえ、
// 一部のMCPリレー/プロキシは200以外のHTTPステータスを「オリジン異常」とみなして
// 502に置き換えてしまうことがある。ここでerror.statusを必ず設定し、
// tools/callが常にHTTP 200 + isError:trueで詳細メッセージを返せるようにする。
async function withUpstreamErrorStatus(promise, status = 502) {
  try {
    return await promise;
  } catch (error) {
    if (!error.status) error.status = status;
    throw error;
  }
}

// CN_社員台帳のsiteId/employeeLedgerListIdをSharePointListWriterに束縛し、未設定時は
// SharePointReader/SharePointTaskStoreと同じ文言でエラーにする（呼び出し元にconfigを
// 露出させない）。
function createEmployeeLedgerEntries(writer, sharepointConfig) {
  function assertConfigured() {
    const missingEnvNames = [];
    if (!sharepointConfig.siteId) missingEnvNames.push('SHAREPOINT_SITE_ID');
    if (!sharepointConfig.employeeLedgerListId) missingEnvNames.push('SHAREPOINT_EMPLOYEE_LEDGER_LIST_ID');
    if (missingEnvNames.length) {
      throw new Error(`SharePoint設定が不足しています: ${missingEnvNames.join(', ')}`);
    }
  }
  return {
    // assertConfigured()の同期throwがwithUpstreamErrorStatus()の外で発生しない
    // よう（=error.statusが設定されないまま素通りしないよう）async関数にしている。
    async createEntry(record) {
      assertConfigured();
      return writer.createItem(sharepointConfig.siteId, sharepointConfig.employeeLedgerListId, record);
    },
    async updateEntry(itemId, record) {
      assertConfigured();
      return writer.updateItem(sharepointConfig.siteId, sharepointConfig.employeeLedgerListId, itemId, record);
    }
  };
}

async function executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries, bridgeServices) {
  if (INSPECTION_TOOLS.some(tool => tool.name === method)) {
    const error = validateInspectionParams(method, params);
    if (error) throw requestError(error);
    if (method === 'inspect_powerapps_structure') return bridgeServices.structure.inspect(params);
    if (method === 'analyze_change_impact') return bridgeServices.impact.analyze(params);
    return bridgeServices.snapshots.create(params);
  }
  if (!MCP_METHODS.includes(method)) {
    throw requestError(`不明なmethodです（対応: ${MCP_METHODS.join(', ')}）`);
  }

  if (method === 'health_check') return { status: 'ok' };
  if (method === 'get_tasks') return tasksPayload(store);
  if (method === 'get_next_task') return nextPayload(store);
  if (method === 'create_task') {
    const paramError = validateCreateTaskParams(params);
    if (paramError) throw requestError(paramError);
    return createTaskPayload(store, params);
  }
  if (method === 'update_task_status') {
    const paramError = validateUpdateTaskStatusParams(params);
    if (paramError) throw requestError(paramError);
    const task = await updateTaskStatusPayload(store, params);
    if (!task) throw requestError('タスクが見つかりません', 404);
    return { task };
  }
  if (method === 'get_task_result') {
    const paramError = validateGetTaskResultParams(params);
    if (paramError) throw requestError(paramError);
    const task = await getTaskResultPayload(store, params.task_id);
    if (!task) throw requestError('タスクが見つかりません', 404);
    return { task_id: task.id, status: task.status, result: task.result ?? null };
  }
  if (method === 'get_powerapps_source') {
    const paramError = validateGetPowerAppsSourceParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAppsGitStore.getSourceFile(params.relativePath));
  }
  if (method === 'get_powerapps_app') {
    const paramError = validateGetPowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAppsStore.getAppInfo());
  }
  if (method === 'get_powerapps_state') {
    const paramError = validateGetPowerAppsStateParams(params);
    if (paramError) throw requestError(paramError);
    return powerAppsStore.getAppState();
  }
  if (method === 'update_powerapps_app') {
    const paramError = validateUpdatePowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    return params.updateData
      ? powerAppsStore.updateApp(params.updateData)
      : withUpstreamErrorStatus(powerAppsGitStore.applySourceFileChange(params.relativePath, params.content, params.message, params.branch));
  }
  if (method === 'save_powerapps_app') {
    const paramError = validateSavePowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    // get_powerapps_sourceが返したbranchが渡された場合、正本branchと一致しなければ保存を拒否する。
    await withUpstreamErrorStatus(Promise.resolve().then(() => powerAppsGitStore.assertCanonicalBranch(params.branch, '保存')));
    const refresh = await withUpstreamErrorStatus(powerAppsGitStore.refreshFromGit());
    const pull = await withUpstreamErrorStatus(powerAppsGitStore.pullFromGit());
    const saved = await powerAppsStore.saveApp();
    return { ...saved, sync: { refresh, pull } };
  }
  if (method === 'publish_powerapps_app') {
    const paramError = validatePublishPowerAppsAppParams(params);
    if (paramError) throw requestError(paramError);
    await withUpstreamErrorStatus(Promise.resolve().then(() => powerAppsGitStore.assertCanonicalBranch(params.branch, '公開')));
    return powerAppsStore.publishApp();
  }
  if (method === 'get_powerapps_operation_result') {
    const paramError = validateGetPowerAppsOperationResultParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAppsStore.getOperationResult(params.operationId));
  }
  if (method === 'get_sharepoint_list') {
    const paramError = validateGetSharePointListParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(sharePointReader.listItems(params));
  }
  if (method === 'get_sharepoint_columns') {
    const paramError = validateGetSharePointColumnsParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(sharePointReader.listColumns(params));
  }
  if (method === 'ensure_sharepoint_columns') {
    const paramError = validateEnsureSharePointColumnsParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(sharePointReader.ensureColumns(params));
  }
  if (method === 'run_power_automate_flow') {
    // approvedByHuman:trueはvalidateRunPowerAutomateFlowParamsで必須チェック済み。
    // Bridge全体の方針（更新・実行系は人間承認必須）に合わせ、ここでも他の
    // パラメータ検証と同様400として扱う（フラグが無い＝入力不備という位置づけ）。
    const paramError = validateRunPowerAutomateFlowParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(powerAutomateRunner.runFlow(params.flowKey, params.payload));
  }
  if (method === 'create_employee_ledger_entry') {
    // approvedByHuman:trueはvalidateCreateEmployeeLedgerEntryParamsで必須チェック済み。
    // run_power_automate_flowと同じ方針（AI単独承認禁止）。
    const paramError = validateCreateEmployeeLedgerEntryParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(employeeLedgerEntries.createEntry(params.record));
  }
  if (method === 'update_employee_ledger_entry') {
    const paramError = validateUpdateEmployeeLedgerEntryParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(employeeLedgerEntries.updateEntry(params.itemId, params.record));
  }
  if (method === 'validate_powerapps_change') {
    const paramError = validateValidatePowerAppsChangeParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.validatePowerAppsChange(params));
  }
  if (method === 'run_powerapps_tests') {
    const paramError = validateRunPowerAppsTestsParams(params);
    if (paramError) throw requestError(paramError);
    return runStaticTests(params);
  }
  if (method === 'verify_save_result') {
    const paramError = validateVerifySaveResultParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.verifySaveResult(params));
  }
  if (method === 'deploy_to_test') {
    const paramError = validateDeployToTestParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.deployment.deployToTest(params));
  }
  if (method === 'verify_deployment') {
    const paramError = validateVerifyDeploymentParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.deployment.verifyDeployment(params));
  }
  if (method === 'get_deployment_logs') {
    const paramError = validateGetDeploymentLogsParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.deployment.getDeploymentLogs(params));
  }
  if (method === 'rollback_deployment') {
    const paramError = validateRollbackDeploymentParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.deployment.rollbackDeployment(params));
  }
  if (method === 'get_permissions') {
    const paramError = validateGetPermissionsParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.permissions.getPermissions(params));
  }
  if (method === 'update_permissions') {
    // approvedByHuman:trueはvalidateUpdatePermissionsParamsで必須チェック済み（AI単独承認禁止）。
    const paramError = validateUpdatePermissionsParams(params);
    if (paramError) throw requestError(paramError);
    return withUpstreamErrorStatus(bridgeServices.permissions.updatePermissions(params));
  }
}

// 新ツール（検証・デプロイ・権限）が使うServiceを束ねる。テストでは各Serviceを差し替えられる。
function createBridgeServices(config, powerAppsStore, powerAppsGitStore, injected = {}) {
  const structure = injected.structure || new PowerAppsStructureService({
    sourceProvider: branch => powerAppsGitStore.getSourceBundle(branch),
    canonicalBranch: powerAppsGitStore.canonicalBranch,
    secrets: [config.webhookApiKey, config.mcpApiKey, config.powerApps?.clientSecret, config.powerApps?.githubToken, config.sharepoint?.clientSecret, config.deployment?.githubToken, ...Object.values(config.powerAutomate?.flows || {})].filter(Boolean)
  });
  const impact = injected.impact || new PowerAppsImpactService(structure);
  const snapshots = injected.snapshots || new ChangeSnapshotService({ structureService: structure, impactService: impact, directory: config.powerApps?.snapshotDirectory });
  const deployment = injected.deployment || new DeploymentService(config.deployment || {});
  const permissions = injected.permissions || new PermissionsService({ powerAppsStore, config: config.permissions || {} });

  async function validatePowerAppsChange(params) {
    const canonicalBranch = powerAppsGitStore.canonicalBranch;
    let currentContent = params.currentContent;
    let currentExists = params.currentExists;
    let sourceBranch = null;
    const extraWarnings = [];
    const pathLooksUnsafe = /\.\.|\\/.test(params.relativePath);
    if (currentContent === undefined && currentExists === undefined && !pathLooksUnsafe) {
      try {
        const current = await powerAppsGitStore.getSourceFile(params.relativePath);
        currentContent = current.content;
        currentExists = true;
        sourceBranch = current.branch;
      } catch (error) {
        if (/\(404\)/.test(String(error.message))) currentExists = false;
        else if (/設定が不足/.test(String(error.message))) extraWarnings.push('GitHub設定が不足しているため、現在内容の取得と差分検査を実行していません（未検証）');
        else throw error;
      }
    }
    const result = validateChange({ ...params, currentContent, currentExists }, { canonicalBranch });
    if (sourceBranch && sourceBranch !== canonicalBranch) {
      result.errors.push(`対象ソースは正本branch以外(${sourceBranch})で見つかりました。正本branch(${canonicalBranch})へは存在しないため更新できません`);
      result.valid = false;
      result.summary.sourceBranch = sourceBranch;
      result.summary.errorCount = result.errors.length;
    }
    result.warnings.push(...extraWarnings);
    result.summary.warningCount = result.warnings.length;
    return result;
  }

  function verifySave(params) {
    return verifySaveResult(params, {
      canonicalBranch: powerAppsGitStore.canonicalBranch,
      getSourceFile: (relativePath) => powerAppsGitStore.getSourceFile(relativePath),
      getAppState: () => powerAppsStore.getAppState()
    });
  }

  return {
    structure,
    impact,
    snapshots,
    deployment,
    permissions,
    validatePowerAppsChange: injected.validatePowerAppsChange || validatePowerAppsChange,
    verifySaveResult: injected.verifySaveResult || verifySave
  };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function createApp(config = getConfig(), injectedStore, injectedPowerAppsStore, injectedPowerAppsGitStore, injectedSharePointReader, injectedPowerAutomateRunner, injectedEmployeeLedgerWriter, injectedBridgeServices = {}) {
  const store = injectedStore || createDefaultStore(config);
  const powerAppsStore = injectedPowerAppsStore || new PowerAppsStore(config.powerApps);
  const powerAppsGitStore = injectedPowerAppsGitStore || new PowerAppsGitStore(config.powerApps);
  const sharePointReader = injectedSharePointReader || new SharePointReader(config.sharepoint);
  const powerAutomateRunner = injectedPowerAutomateRunner || new PowerAutomateRunner(config.powerAutomate);
  const employeeLedgerWriter = injectedEmployeeLedgerWriter
    || new SharePointListWriter({ ...config.sharepoint, fieldMap: CN_EMPLOYEE_LEDGER_FIELD_MAP });
  const employeeLedgerEntries = createEmployeeLedgerEntries(employeeLedgerWriter, config.sharepoint);
  const bridgeServices = createBridgeServices(config, powerAppsStore, powerAppsGitStore, injectedBridgeServices);
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

  app.get('/api/tasks', async (req, res, next) => {
    try { return res.status(200).json(await tasksPayload(store)); } catch (error) { return next(error); }
  });

  app.get('/api/next', async (req, res, next) => {
    try { return res.status(200).json(await nextPayload(store)); } catch (error) { return next(error); }
  });

  const webhookAuth = apiKeyMiddleware(() => config.webhookApiKey);
  for (const path of ['/webhooks/claude-code', '/webhooks/copilot']) {
    app.post(path, webhookAuth, async (req, res, next) => {
      const errorMessage = validateTaskInput(req.body, { requireTitle: true });
      if (errorMessage) return res.status(400).json({ error: errorMessage });
      try {
        const task = await store.upsert({ ...req.body, source: path.slice('/webhooks/'.length) });
        return res.status(202).json({ accepted: true, task });
      } catch (error) { return next(error); }
    });
  }

  app.post('/api/tasks/:id/status', async (req, res, next) => {
    const body = { ...req.body, id: req.params.id };
    const errorMessage = validateStatusInput(body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    try {
      const task = await store.update(req.params.id, req.body);
      return task ? res.status(200).json({ task }) : res.status(404).json({ error: 'タスクが見つかりません' });
    } catch (error) { return next(error); }
  });

  const mcpAuth = apiKeyMiddleware(() => config.mcpApiKey);

  // Streamable HTTP MCP endpoint. GET is intentionally not used for SSE;
  // Copilot Studio (and current MCP clients) negotiate over POST /mcp.
  app.get('/mcp/tools/list', mcpAuth, (req, res) => {
    res.status(200).json({ tools: MCP_PUBLIC_TOOLS });
  });
  app.get('/mcp', mcpAuth, (req, res) => res.status(405).set('Allow', 'POST').end());
  app.delete('/mcp', mcpAuth, (req, res) => res.status(405).set('Allow', 'POST').end());
  app.post('/mcp', mcpAuth, (req, res, next) => handleMcpRequest(req, res, next));

  async function handleMcpRequest(req, res, next) {
    const body = req.body || {};

    // ChatGPT Apps use MCP Streamable HTTP with JSON-RPC 2.0.
    // Keep the existing legacy { method, params } contract below for current clients.
    if (body.jsonrpc === '2.0') {
      const id = body.id;
      const params = body.params || {};

      if (body.method === 'notifications/initialized') return res.status(202).end();
      if (body.method === 'ping') return res.status(200).json(jsonRpcResult(id, {}));
      if (body.method === 'initialize') {
        return res.status(200).json(jsonRpcResult(id, {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'clean-nano-ai-bridge', version: '1.0.0' }
        }));
      }
      if (body.method === 'tools/list') {
        return res.status(200).json(jsonRpcResult(id, { tools: MCP_PUBLIC_TOOLS }));
      }
      if (body.method === 'tools/call') {
        const name = params.name;
        const toolParams = params.arguments || {};
        if (typeof name !== 'string') {
          return res.status(200).json(jsonRpcError(id, -32602, 'tools/callにはparams.nameが必要です'));
        }
        try {
          const result = await executeMcpMethod(name, toolParams, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries, bridgeServices);
          return res.status(200).json(jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
            isError: INSPECTION_TOOLS.some(tool => tool.name === name) && ['blocked', 'incomplete'].includes(result.status)
          }));
        } catch (error) {
          if (!error.status) return next(error);
          return res.status(200).json(jsonRpcResult(id, {
            content: [{ type: 'text', text: error.message }],
            structuredContent: { error: error.message, ...(error.upstream ? { details: error.upstream } : {}), ...(error.payload || {}) },
            isError: true
          }));
        }
      }
      return res.status(200).json(jsonRpcError(id, -32601, `Method not found: ${body.method || ''}`));
    }

    const errorMessage = validateMcpInput(body);
    if (errorMessage) return res.status(400).json({ error: errorMessage });
    const { method } = body;
    const params = body.params || {};
    try {
      const result = await executeMcpMethod(method, params, store, powerAppsStore, powerAppsGitStore, sharePointReader, powerAutomateRunner, employeeLedgerEntries, bridgeServices);
      return res.status(200).json({ accepted: true, method, result });
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, ...(error.upstream ? { details: error.upstream } : {}), ...(error.payload || {}) });
      return next(error);
    }
  }

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('request_failed', { method: req.method, path: req.path, message: error.message });
    return res.status(500).json({ error: '内部エラーが発生しました' });
  });
  return app;
}

if (require.main === module) {
  const config = getConfig();
  createApp(config).listen(config.port, config.host, () => console.log(`Bridge API listening on ${config.host}:${config.port}`));
}

module.exports = { apiKeyMiddleware, createApp, MCP_METHODS, MCP_PUBLIC_TOOLS };
