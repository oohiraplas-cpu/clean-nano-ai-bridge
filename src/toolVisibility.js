'use strict';
// External (CNAI / MCP tools/list) tool surface.
//
// Consolidates fine-grained Bridge operations into purpose-based tools that take an
// `operation` and dispatch internally. Every underlying tool keeps its implementation,
// validation, state-context gate and approval gate; only the published tools/list changes.
// Internal names remain callable through tools/call for existing clients (backward compatibility).

const FACADE_ERROR = 'UNSUPPORTED_OPERATION';

/** Each facade maps `operation` -> { tool, fixed }. `fixed` is merged last (wins). */
const FACADES = Object.freeze([
  {
    name: 'system_health',
    description: 'Bridgeの稼働確認と能力確認。operation: health | capabilities',
    ops: {
      health: { tool: 'health_check' },
      capabilities: { tool: 'get_bridge_capabilities' },
    },
  },
  {
    name: 'canvas_resolve',
    description: 'Power Appsの環境・アプリを一意に特定する（読み取りのみ）。operation: targets | list_apps | environments。targetsはappName・environmentIdで対象を確定し、一意でなければMULTIPLE_APPS_FOUNDを返す。',
    ops: {
      targets: { tool: 'resolve_app_target' },
      list_apps: { tool: 'list_power_apps' },
      environments: { tool: 'list_environments' },
    },
  },
  {
    name: 'canvas_read',
    description: 'Canvas Appの読み取り（変更なし）。operation: app | state | source | structure（画面・コントロール・データソースを含む） | discover | screens | controls | powerfx | datasources | dependencies（接続参照・依存関係） | app_read | compare_git | operation_result。controls/screens/powerfxはscreen・control・controlTypeで絞り込み可。',
    ops: {
      app: { tool: 'get_powerapps_app' },
      state: { tool: 'get_powerapps_state' },
      source: { tool: 'get_powerapps_source' },
      structure: { tool: 'inspect_powerapps_structure' },
      discover: { tool: 'discover_powerapps_structure' },
      screens: { tool: 'powerapps_manage', fixed: { operation: 'screen_get' } },
      controls: { tool: 'powerapps_manage', fixed: { operation: 'control_get' } },
      powerfx: { tool: 'powerapps_manage', fixed: { operation: 'powerfx_get' } },
      datasources: { tool: 'inspect_powerapps_structure' },
      dependencies: { tool: 'check_dependencies' },
      app_read: { tool: 'powerapps_app_read' },
      compare_git: { tool: 'compare_powerapps_with_git' },
      operation_result: { tool: 'get_powerapps_operation_result' },
    },
  },
  {
    name: 'canvas_media',
    description: 'Canvasのメディア（画像）。読み取り: list | get | export。書込み: upload（新規追加）| replace（差替え）| assign（Imageプロパティ割当）。書込みはstateContextが必要で、保存はcanvas_saveで行う。',
    ops: {
      list: { tool: 'get_powerapps_media_asset', fixed: { operation: 'list' } },
      get: { tool: 'get_powerapps_media_asset', fixed: { operation: 'get' } },
      export: { tool: 'get_powerapps_media_asset', fixed: { operation: 'export' } },
      upload: { tool: 'update_powerapps_image', fixed: { operation: 'add' } },
      edit_image: { tool: 'update_powerapps_image', fixed: { operation: 'edit' } },
      replace: { tool: 'powerapps_manage', fixed: { operation: 'image_replace' } },
      assign: { tool: 'powerapps_manage', fixed: { operation: 'image_assign' } },
    },
  },
  {
    name: 'canvas_edit',
    description: 'Canvasの編集（変更は保存されるまで確定しない）。operation: screen_add | screen_edit | control_add | control_edit | powerfx_edit | datasource_add | datasource_edit | source_update。編集後はcanvas_saveで保存する。',
    ops: {
      screen_add: { tool: 'powerapps_manage', fixed: { operation: 'screen_add' } },
      screen_edit: { tool: 'powerapps_manage', fixed: { operation: 'screen_edit' } },
      control_add: { tool: 'powerapps_manage', fixed: { operation: 'control_add' } },
      control_edit: { tool: 'powerapps_manage', fixed: { operation: 'control_edit' } },
      powerfx_edit: { tool: 'powerapps_manage', fixed: { operation: 'powerfx_edit' } },
      datasource_add: { tool: 'powerapps_manage', fixed: { operation: 'datasource_add' } },
      datasource_edit: { tool: 'powerapps_manage', fixed: { operation: 'datasource_edit' } },
      source_update: { tool: 'update_powerapps_app' },
    },
  },
  {
    name: 'canvas_save',
    description: 'Canvasの変更を保存する。operation: save（保存後の再取得はcanvas_verifyのreread/save_resultで確認する）。',
    ops: {
      save: { tool: 'save_powerapps_app' },
      manage_save: { tool: 'powerapps_manage', fixed: { operation: 'save' } },
    },
  },
  {
    name: 'canvas_verify',
    description: '保存後・公開後の検証（読み取りのみ）。operation: save_result | change（変更前後の差分） | tests | source_validate | reread | publish_verify | app_checker。',
    ops: {
      save_result: { tool: 'verify_save_result' },
      change: { tool: 'validate_powerapps_change' },
      tests: { tool: 'run_powerapps_tests' },
      source_validate: { tool: 'validate_powerapps_source' },
      reread: { tool: 'powerapps_manage', fixed: { operation: 'reread' } },
      publish_verify: { tool: 'powerapps_manage', fixed: { operation: 'publish_verify' } },
      app_checker: { tool: 'powerapps_manage', fixed: { operation: 'app_checker' } },
    },
  },
  {
    name: 'canvas_publish',
    description: 'Canvasの社内公開。保存と検証が成功した後にのみ実行する。operation: publish。外部公開は行わない。',
    ops: {
      publish: { tool: 'publish_powerapps_app' },
      manage_publish: { tool: 'powerapps_manage', fixed: { operation: 'publish' } },
    },
  },
  {
    name: 'canvas_rollback',
    description: '変更の復旧。operation: snapshots（復旧可能版一覧） | rollback（snapshotIdの版へ戻す） | restore（変更前状態へ戻す）。',
    ops: {
      snapshots: { tool: 'powerapps_snapshots_list' },
      rollback: { tool: 'powerapps_app_rollback' },
      restore: { tool: 'powerapps_manage', fixed: { operation: 'restore' } },
    },
  },
  {
    name: 'audit_get',
    description: '監査・実行証跡の参照（読み取りのみ）。operation: execution_status | execution_queue | checkpoint | evidence | runtime_report。',
    ops: {
      execution_status: { tool: 'get_execution_status' },
      execution_queue: { tool: 'get_execution_queue' },
      checkpoint: { tool: 'get_checkpoint' },
      evidence: { tool: 'export_evidence' },
      runtime_report: { tool: 'generate_runtime_report' },
    },
  },

  {
    name: 'sharepoint',
    description: 'SharePointリストの操作（Canvas以外の既存機能）。operation: lists | list_get | list_schema | columns | ensure_columns | create_list | create_item | update_item。書込みは承認ゲートと検証に従う。',
    ops: {
      lists: { tool: 'list_sharepoint_lists' },
      list_get: { tool: 'get_sharepoint_list' },
      list_schema: { tool: 'get_sharepoint_list_schema' },
      columns: { tool: 'get_sharepoint_columns' },
      ensure_columns: { tool: 'ensure_sharepoint_columns' },
      create_list: { tool: 'create_sharepoint_list' },
      create_item: { tool: 'create_sharepoint_list_item' },
      update_item: { tool: 'update_sharepoint_list_item' },
    },
  },
  {
    name: 'power_automate',
    description: 'Power Automateフローの操作（Canvas以外の既存機能）。operation: registered | flows | flow_read | flow_update | flow_set_state | flow_rollback | run | run_result。run・更新は承認ゲートに従う。',
    ops: {
      registered: { tool: 'list_registered_power_automate_flows' },
      flows: { tool: 'powerautomate_flow_list' },
      flow_read: { tool: 'powerautomate_flow_read' },
      flow_update: { tool: 'powerautomate_flow_update' },
      flow_set_state: { tool: 'powerautomate_flow_set_state' },
      flow_rollback: { tool: 'powerautomate_flow_rollback' },
      run: { tool: 'run_power_automate_flow' },
      run_result: { tool: 'get_power_automate_run_result' },
    },
  },
  {
    name: 'tasks',
    description: 'タスク状態の管理（既存機能）。operation: list | next | create | status | result。',
    ops: {
      list: { tool: 'get_tasks' },
      next: { tool: 'get_next_task' },
      create: { tool: 'create_task' },
      status: { tool: 'update_task_status' },
      result: { tool: 'get_task_result' },
    },
  },
  {
    name: 'github_azure',
    description: 'GitHub・Azureの読み取り（既存機能）。operation: github_commits | github_file | github_pulls | github_runs | git_branches | ci_artifact | azure_subscription | azure_app | azure_slots | azure_deployment。すべて読み取り専用。',
    ops: {
      github_commits: { tool: 'list_github_commits' },
      github_file: { tool: 'get_github_file' },
      github_pulls: { tool: 'list_github_pull_requests' },
      github_runs: { tool: 'list_github_workflow_runs' },
      git_branches: { tool: 'list_git_branches' },
      ci_artifact: { tool: 'verify_github_ci_artifact' },
      azure_subscription: { tool: 'get_azure_subscription' },
      azure_app: { tool: 'get_azure_app_service' },
      azure_slots: { tool: 'list_azure_app_service_slots' },
      azure_deployment: { tool: 'get_azure_deployment_metadata' },
    },
  },
  {
    name: 'governance',
    description: '運用ルール・ナレッジ・実行方針の参照（読み取り専用）。operation: rules | knowledge | executive_policy | executive_brief | payment | ai4_resources | assess_done | prohibited | reuse | playbook | agents。',
    ops: {
      rules: { tool: 'get_application_rules' },
      knowledge: { tool: 'export_knowledge_snapshot' },
      executive_policy: { tool: 'get_executive_policy' },
      executive_brief: { tool: 'get_executive_brief' },
      payment: { tool: 'check_payment_status' },
      ai4_resources: { tool: 'discover_sharepoint_ai4_resources' },
      assess_done: { tool: 'assess_done' },
      prohibited: { tool: 'check_prohibited_operations' },
      reuse: { tool: 'suggest_reuse_pattern' },
      playbook: { tool: 'get_playbook' },
      agents: { tool: 'get_agent_registry' },
    },
  },
  {
    name: 'runtime_capture',
    description: '実行中の状態・挙動の記録（診断用、読み取り中心）。operation: app_startup | user_interaction | data_binding | formula_execution | connection | error_event | state_transition | performance | behavior_verification | integration | report | ui_control_state。',
    ops: {
      app_startup: { tool: 'capture_app_startup' },
      user_interaction: { tool: 'capture_user_interaction' },
      data_binding: { tool: 'capture_data_binding' },
      formula_execution: { tool: 'capture_formula_execution' },
      connection: { tool: 'capture_connection' },
      error_event: { tool: 'capture_error_event' },
      state_transition: { tool: 'capture_state_transition' },
      performance: { tool: 'capture_performance' },
      behavior_verification: { tool: 'capture_behavior_verification' },
      integration: { tool: 'capture_integration' },
      report: { tool: 'generate_runtime_report' },
      ui_control_state: { tool: 'generate_ui_control_state' },
    },
  },
  {
    name: 'deployment',
    description: 'デプロイの検証・ログ・復旧（既存機能）。operation: verify | logs | rollback | test_deploy。本番への直接デプロイは拒否される。',
    ops: {
      verify: { tool: 'verify_deployment' },
      logs: { tool: 'get_deployment_logs' },
      rollback: { tool: 'rollback_deployment' },
      test_deploy: { tool: 'deploy_to_test' },
    },
  },
  {
    name: 'user_access',
    description: 'ユーザーの権限・ロック・パスキー（既存機能）。operation: permissions_get | permissions_update | lock_user | lock_status | validate_passkey | can_view | can_edit | can_delete。権限変更は承認が必要。',
    ops: {
      permissions_get: { tool: 'get_permissions' },
      permissions_update: { tool: 'update_permissions' },
      lock_user: { tool: 'lock_user_info' },
      lock_status: { tool: 'get_user_lock_status' },
      validate_passkey: { tool: 'validate_passkey' },
      can_view: { tool: 'can_view_user_info' },
      can_edit: { tool: 'can_edit_user_info' },
      can_delete: { tool: 'can_delete_user_info' },
    },
  },
  {
    name: 'employee_ledger',
    description: '社員台帳の登録・更新（既存機能）。operation: create | update。',
    ops: {
      create: { tool: 'create_employee_ledger_entry' },
      update: { tool: 'update_employee_ledger_entry' },
    },
  },
  {
    name: 'file_op',
    errorCode: 'VALIDATION_FAILED',
    description: '作業ルート（OPERATIONS_WORK_ROOT）内のファイル操作。operation: directory_list（一覧）| folder_tree（階層）| file_search（名前検索）| file_metadata_get（メタ情報）| file_read（読取・秘密値は伏せ字）| file_write（作成・上書きはoverwrite=trueのみ、既定dryRun）| file_copy（複写、既定dryRun）| file_diff（比較）| hash_sha256（SHA-256）。絶対パス・..・シンボリックリンクは拒否。',
    ops: {
      directory_list: { tool: 'files_manage', fixed: { operation: 'directory_list' } },
      folder_tree: { tool: 'files_manage', fixed: { operation: 'folder_tree' } },
      file_search: { tool: 'files_manage', fixed: { operation: 'file_search' } },
      file_metadata_get: { tool: 'files_manage', fixed: { operation: 'file_metadata_get' } },
      file_read: { tool: 'files_manage', fixed: { operation: 'file_read' } },
      file_write: { tool: 'files_manage', fixed: { operation: 'file_write' } },
      file_copy: { tool: 'files_manage', fixed: { operation: 'file_copy' } },
      file_diff: { tool: 'files_manage', fixed: { operation: 'file_diff' } },
      hash_sha256: { tool: 'files_manage', fixed: { operation: 'hash_sha256' } }
    },
  },
  {
    name: 'zip_op',
    errorCode: 'VALIDATION_FAILED',
    description: 'ZIPの操作（作業ルート内）。operation: zip_inspect（中身の一覧）| zip_validate（ZIP Slip・ZIP bomb・symlink・暗号化・ZIP64・CRC・重複名の検証）| zip_extract（全件検証OKの時のみ新規先へ展開、既定dryRun）| zip_create（既存ファイルからZIP作成、既定dryRun）。自動実行はしません。元ZIPは変更しません。',
    ops: {
      zip_inspect: { tool: 'zip_manage', fixed: { operation: 'zip_inspect' } },
      zip_extract: { tool: 'zip_manage', fixed: { operation: 'zip_extract' } },
      zip_create: { tool: 'zip_manage', fixed: { operation: 'zip_create' } },
      zip_validate: { tool: 'zip_manage', fixed: { operation: 'zip_validate' } }
    },
  },
  {
    name: 'structured_data_op',
    errorCode: 'VALIDATION_FAILED',
    description: 'JSON / YAML / XML の整形式検証。operation: json_validate | yaml_validate | xml_validate。path（作業ルート内）かcontent（1MB以下）のどちらか一方を指定。XMLのDTD・ENTITY宣言は拒否。',
    ops: {
      json_validate: { tool: 'structured_data_manage', fixed: { operation: 'json_validate' } },
      yaml_validate: { tool: 'structured_data_manage', fixed: { operation: 'yaml_validate' } },
      xml_validate: { tool: 'structured_data_manage', fixed: { operation: 'xml_validate' } }
    },
  },
  {
    name: 'entra_read',
    errorCode: 'VALIDATION_FAILED',
    description: 'Entra ID（Graph）の読み取り。operation: entra_tenant_get（テナント）| entra_user_search（ユーザー検索・上限あり）| entra_user_get | entra_groups_list | entra_group_get | entra_licenses_list（空き数付き）| entra_role_assignments_get | entra_apps_list | entra_service_principals_list | entra_audit_logs_get。資格情報・秘密値は返しません。',
    ops: {
      entra_tenant_get: { tool: 'entra_read_manage', fixed: { operation: 'entra_tenant_get' } },
      entra_user_search: { tool: 'entra_read_manage', fixed: { operation: 'entra_user_search' } },
      entra_user_get: { tool: 'entra_read_manage', fixed: { operation: 'entra_user_get' } },
      entra_groups_list: { tool: 'entra_read_manage', fixed: { operation: 'entra_groups_list' } },
      entra_group_get: { tool: 'entra_read_manage', fixed: { operation: 'entra_group_get' } },
      entra_licenses_list: { tool: 'entra_read_manage', fixed: { operation: 'entra_licenses_list' } },
      entra_role_assignments_get: { tool: 'entra_read_manage', fixed: { operation: 'entra_role_assignments_get' } },
      entra_apps_list: { tool: 'entra_read_manage', fixed: { operation: 'entra_apps_list' } },
      entra_service_principals_list: { tool: 'entra_read_manage', fixed: { operation: 'entra_service_principals_list' } },
      entra_audit_logs_get: { tool: 'entra_read_manage', fixed: { operation: 'entra_audit_logs_get' } }
    },
  },
  {
    name: 'entra_write',
    errorCode: 'VALIDATION_FAILED',
    description: 'Entra ID の書込み（既定 dryRun）。operation: entra_user_create（無効状態で作成、初期パスワードは返さない）| entra_user_update | entra_user_disable（accountEnabled で有効/無効）| entra_group_member_add | entra_group_member_remove | entra_license_assign（空き数が無ければ停止・購入しない）| entra_license_remove。実行には approvedByHuman=true が必要。物理削除・管理者ロール付与はありません。',
    ops: {
      entra_user_create: { tool: 'entra_write_manage', fixed: { operation: 'entra_user_create' } },
      entra_user_update: { tool: 'entra_write_manage', fixed: { operation: 'entra_user_update' } },
      entra_user_disable: { tool: 'entra_write_manage', fixed: { operation: 'entra_user_disable' } },
      entra_group_member_add: { tool: 'entra_write_manage', fixed: { operation: 'entra_group_member_add' } },
      entra_group_member_remove: { tool: 'entra_write_manage', fixed: { operation: 'entra_group_member_remove' } },
      entra_license_assign: { tool: 'entra_write_manage', fixed: { operation: 'entra_license_assign' } },
      entra_license_remove: { tool: 'entra_write_manage', fixed: { operation: 'entra_license_remove' } }
    },
  },
  {
    name: 'power_platform_read',
    errorCode: 'VALIDATION_FAILED',
    description: 'Power Platform の読み取り（対象環境 4d0aab59-43ec-ecf1-a9d1-869f2517adbb に固定）。operation: pp_environments_list | pp_environment_get | pp_connectors_list | pp_connections_list | pp_connection_test | solutions_list | connection_references_get | environment_variables_get（名前と設定の有無のみ、値は返さない）| pp_dlp_policies_list。書込みはありません。',
    ops: {
      pp_environments_list: { tool: 'power_platform_manage', fixed: { operation: 'pp_environments_list' } },
      pp_environment_get: { tool: 'power_platform_manage', fixed: { operation: 'pp_environment_get' } },
      pp_connectors_list: { tool: 'power_platform_manage', fixed: { operation: 'pp_connectors_list' } },
      pp_connections_list: { tool: 'power_platform_manage', fixed: { operation: 'pp_connections_list' } },
      pp_connection_test: { tool: 'power_platform_manage', fixed: { operation: 'pp_connection_test' } },
      solutions_list: { tool: 'power_platform_manage', fixed: { operation: 'solutions_list' } },
      connection_references_get: { tool: 'power_platform_manage', fixed: { operation: 'connection_references_get' } },
      environment_variables_get: { tool: 'power_platform_manage', fixed: { operation: 'environment_variables_get' } },
      pp_dlp_policies_list: { tool: 'power_platform_manage', fixed: { operation: 'pp_dlp_policies_list' } }
    },
  },
  {
    name: 'operations_control',
    description: 'Clean Nano Operations の確認系。operation: version_get（版・SHA）| tools_list | tool_schema_get（入力スキーマ）| capability_check（実装・構成状態）| authentication_check（認証の有無のみ）| environment_get（環境プロファイル）。読取のみ。',
    ops: {
      version_get: { tool: 'version_get' },
      tools_list: { tool: 'tools_list' },
      tool_schema_get: { tool: 'tool_schema_get' },
      capability_check: { tool: 'capability_check' },
      authentication_check: { tool: 'authentication_check' },
      environment_get: { tool: 'environment_get' }
    },
  },
  {
    name: 'operations_permission',
    description: 'Clean Nano Operations の権限・ライセンス・接続確認（読取のみ）。operation: permission_check | license_check | connection_test。未構成の接続先は BLOCKED で返します。',
    ops: {
      permission_check: { tool: 'permission_check' },
      license_check: { tool: 'license_check' },
      connection_test: { tool: 'connection_test' }
    },
  },
  {
    name: 'operations_lifecycle',
    description: '変更操作の共通ライフサイクル。operation: operation_plan（計画登録）| operation_status | operation_cancel | dry_run | snapshot_create（変更前スナップショット）| operation_verify（変更後の検証）| audit_write | rollback_execute（承認必須）。',
    ops: {
      operation_plan: { tool: 'operation_plan' },
      operation_status: { tool: 'operation_status' },
      operation_cancel: { tool: 'operation_cancel' },
      dry_run: { tool: 'dry_run' },
      snapshot_create: { tool: 'snapshot_create' },
      operation_verify: { tool: 'operation_verify' },
      audit_write: { tool: 'audit_write' },
      rollback_execute: { tool: 'rollback_execute' }
    },
  },
  {
    name: 'sharepoint_graph',
    description: 'SharePoint（Microsoft Graph）の操作。読取: sp_site_get | sp_lists_list | sp_list_get | sp_list_schema_get | sp_item_get | sp_item_query | sp_permissions_get。書込み（承認と再取得検証付き）: sp_column_create | sp_column_update | sp_item_create | sp_item_update | sp_attachment_add（経路未検証のため BLOCKED）| sp_permissions_plan | sp_permissions_grant | sp_permissions_revoke。',
    ops: {
      sp_site_get: { tool: 'sp_site_get' },
      sp_lists_list: { tool: 'sp_lists_list' },
      sp_list_get: { tool: 'sp_list_get' },
      sp_list_schema_get: { tool: 'sp_list_schema_get' },
      sp_item_get: { tool: 'sp_item_get' },
      sp_item_query: { tool: 'sp_item_query' },
      sp_permissions_get: { tool: 'sp_permissions_get' },
      sp_column_create: { tool: 'sp_column_create' },
      sp_column_update: { tool: 'sp_column_update' },
      sp_item_create: { tool: 'sp_item_create' },
      sp_item_update: { tool: 'sp_item_update' },
      sp_attachment_add: { tool: 'sp_attachment_add' },
      sp_permissions_plan: { tool: 'sp_permissions_plan' },
      sp_permissions_grant: { tool: 'sp_permissions_grant' },
      sp_permissions_revoke: { tool: 'sp_permissions_revoke' }
    },
  },
]);

const FACADE_BY_NAME = new Map(FACADES.map((f) => [f.name, f]));

/** Published tools/list entries for CNAI and other external clients. */
function buildPublishedTools(byName = new Map()) {
  return FACADES.map((f) => ({
    name: f.name,
    description: f.description,
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: Object.keys(f.ops) },
        ...targetProperties(f, byName),
      },
      required: ['operation'],
      additionalProperties: true,
    },
  }));
}

/**
 * Optional parameters accepted by the facade's target tools, so clients can see which
 * arguments (appId, relativePath, stateSessionId, ...) to send. Never required: which ones
 * apply depends on `operation`, and each target still validates its own input.
 */
function targetProperties(facade, byName) {
  const merged = {};
  for (const op of Object.values(facade.ops)) {
    const properties = byName.get(op.tool)?.inputSchema?.properties || {};
    for (const [key, schema] of Object.entries(properties)) {
      if (key === 'operation' || (op.fixed && key in op.fixed) || key in merged) continue;
      merged[key] = schema;
    }
  }
  return merged;
}

/** Canvas core tools also published under their own names (same internal definition). */
const DIRECT_TOOL_NAMES = Object.freeze([
  'health_check',
  'resolve_app_target',
  'get_powerapps_app',
  'get_powerapps_state',
  'get_powerapps_source',
]);

/** tools/list for external clients: consolidated tools + direct Canvas core tools. */
function publishedToolsFor(catalog) {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  const direct = DIRECT_TOOL_NAMES.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`direct tool missing from catalog: ${name}`);
    return tool;
  });
  return Object.freeze([...buildPublishedTools(byName), ...direct]);
}

/**
 * Resolves a published facade call to the internal tool and arguments.
 * Non-facade names pass through unchanged, so internal and legacy callers are unaffected.
 * Unknown operations are refused before any Bridge handler runs.
 */
function resolveVisibleCall(name, args) {
  const facade = FACADE_BY_NAME.get(name);
  if (!facade) return { name, args };
  const { operation, ...rest } = args && typeof args === 'object' ? args : {};
  const target = typeof operation === 'string' && Object.prototype.hasOwnProperty.call(facade.ops, operation)
    ? facade.ops[operation]
    : undefined;
  if (!target) {
    const error = new Error(`${name} の operation が不正です（対応: ${Object.keys(facade.ops).join(', ')}）`);
    error.status = 400;
    error.payload = { reasonCode: facade.errorCode || FACADE_ERROR, operation: typeof operation === 'string' ? operation : null };
    throw error;
  }
  return { name: target.tool, args: { ...rest, ...(target.fixed || {}) } };
}

module.exports = { FACADES, DIRECT_TOOL_NAMES, publishedToolsFor, resolveVisibleCall };
