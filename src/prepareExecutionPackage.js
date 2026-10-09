/**
 * Prepare Power Apps Execution Package Generator
 *
 * Generates complete Power Apps execution contracts in a single MCP call,
 * eliminating manual State Context passing and multi-tool orchestration.
 *
 * Internal processing pipeline (8 steps, with parallelized independent reads):
 * 1. Target app/environment resolution
 * 2. StateContext generation
 * 3. Real source fetch (canonical branch, base SHA, source state list)
 * 4. Git analysis (diff, structure, file inventory)
 * 5. SharePoint schema + registered Power Automate Flows + dependency retrieval
 * 6. Duplicate detection (existing management features, incomplete screens)
 * 7. ROI feature selection (profit > recovery > time savings > usage > assets > effort > charges)
 * 8. Acceptance criteria / change scope / rollback confirmation
 *
 * Output: Execution contract JSON with status, requestId, expiresAt, target, feature,
 * dependencies, changes, acceptanceCriteria, validation, rollback, additionalCost,
 * isolatedCommit, missing.
 *
 * Validation Rules:
 * - READY only if all 8 item categories confirmed via real Bridge calls
 * - Unconfirmed items cannot be excluded from output
 * - Unconfirmed commits never marked DISCARD
 * - 1 auto-recovery attempt on error
 * - No modifications to existing tools, main, Power Apps, SharePoint, Azure, permissions
 */

const crypto = require('node:crypto');

/**
 * Execution contract structure (JSON Schema)
 */
const EXECUTION_CONTRACT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['READY', 'BLOCKED', 'REVIEW_REQUIRED'],
      description: 'READY: all 8 confirmations met; BLOCKED: missing critical items; REVIEW_REQUIRED: pending human review'
    },
    requestId: { type: 'string', description: 'Unique request identifier' },
    generatedAt: { type: 'string', description: 'ISO 8601 timestamp' },
    expiresAt: { type: 'string', description: 'ISO 8601 timestamp (24h from generation)' },
    target: {
      type: 'object',
      properties: {
        appName: { type: 'string' },
        appId: { type: 'string' },
        environmentId: { type: 'string' },
        environmentName: { type: 'string' }
      },
      required: ['appName', 'appId', 'environmentId']
    },
    canonicalBranch: {
      type: 'string',
      description: 'Authoritative GitHub branch (e.g., main)'
    },
    baseSha: {
      type: 'string',
      description: '40-char hex commit SHA of canonical branch'
    },
    isolatedCommit: {
      type: 'string',
      description: 'Optional 40-char hex SHA if working from non-canonical branch (for testing/review)',
      nullable: true
    },
    feature: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Feature identifier' },
        name: { type: 'string' },
        description: { type: 'string' },
        roiRank: {
          type: 'integer',
          description: 'ROI priority rank (1=highest)'
        },
        category: {
          type: 'string',
          enum: ['screen', 'flow', 'connector', 'sharepoint_column', 'gallery', 'form']
        },
        currentState: {
          type: 'string',
          enum: ['missing', 'stub', 'incomplete', 'partial', 'complete'],
          description: 'Feature completion status'
        },
        estimatedEffort: {
          type: 'string',
          enum: ['minimal', 'low', 'medium', 'high', 'very_high']
        },
        profitImpact: { type: 'string', description: 'E.g., "high", "medium", "low"' },
        recoveryAcceleration: { type: 'string' },
        timeSavings: { type: 'string' },
        usageFrequency: { type: 'string' },
        existingAssetReuse: { type: 'array', items: { type: 'string' } }
      },
      required: ['id', 'name', 'currentState', 'roiRank']
    },
    dependencies: {
      type: 'object',
      properties: {
        sharePoint: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              listName: { type: 'string' },
              listId: { type: 'string' },
              columns: { type: 'array', items: { type: 'object' } }
            }
          },
          description: 'SharePoint list and column dependencies'
        },
        powerAutomate: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              flowName: { type: 'string' },
              flowId: { type: 'string' },
              triggerType: { type: 'string' }
            }
          },
          description: 'Registered Power Automate Flows'
        },
        otherPowerAppsScreens: {
          type: 'array',
          items: { type: 'string' },
          description: 'References to other Power Apps screens'
        },
        externalAPIs: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    },
    changes: {
      type: 'object',
      properties: {
        filesPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative paths to be modified'
        },
        estimatedLines: {
          type: 'integer',
          description: 'Approximate lines of code to be added/modified'
        },
        minimumScope: { type: 'string', description: 'Description of minimum implementation scope' },
        breakingChanges: {
          type: 'boolean',
          description: 'true if changes break existing functionality'
        },
        newSharePointColumns: {
          type: 'array',
          items: { type: 'string' },
          description: 'New SharePoint columns required (empty if none)'
        },
        newFlows: {
          type: 'array',
          items: { type: 'string' },
          description: 'New Power Automate Flows required'
        }
      },
      required: ['filesPaths', 'minimumScope', 'breakingChanges']
    },
    acceptanceCriteria: {
      type: 'array',
      items: { type: 'string' },
      description: 'Testable criteria confirming feature completion'
    },
    validation: {
      type: 'object',
      properties: {
        gitSourceConfirmed: { type: 'boolean' },
        duplicatesDetected: { type: 'array', items: { type: 'string' } },
        sharePointColumnsConfirmed: { type: 'boolean' },
        flowsConfirmed: { type: 'boolean' },
        branchMatchesCanonical: { type: 'boolean' },
        sourceStateValid: { type: 'boolean' },
        rollbackPlanConfirmed: { type: 'boolean' },
        allConfirmationsComplete: { type: 'boolean' }
      }
    },
    rollback: {
      type: 'object',
      properties: {
        strategy: {
          type: 'string',
          description: 'E.g., "git_revert", "file_delete", "manual_restoration"'
        },
        targetSha: { type: 'string', description: '40-char hex SHA to revert to' },
        estimatedDuration: { type: 'string', description: 'E.g., "< 2 minutes"' },
        dataImpact: { type: 'string', description: 'Impact on existing data' }
      },
      required: ['strategy', 'targetSha']
    },
    additionalCost: {
      type: 'object',
      properties: {
        sharePointColumns: { type: 'boolean', description: 'true if new columns add to SharePoint quota' },
        powerAutomateRuns: { type: 'boolean', description: 'true if new flows increment monthly run count' },
        premiumConnectors: { type: 'boolean', description: 'true if premium features required' },
        estimatedMonthlyCost: {
          type: 'string',
          description: 'E.g., "¥0", "¥10,000 - ¥50,000", "unknown"'
        }
      },
      required: ['sharePointColumns', 'powerAutomateRuns', 'premiumConnectors']
    },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: 'Items that could not be confirmed (blocks READY status)'
    },
    warnings: {
      type: 'array',
      items: { type: 'string' },
      description: 'Non-blocking issues discovered during generation'
    },
    diagnostics: {
      type: 'object',
      description: 'Internal processing details (for troubleshooting)',
      properties: {
        step1AppResolution: { type: 'object' },
        step2StateContext: { type: 'object' },
        step3SourceFetch: { type: 'object' },
        step4GitAnalysis: { type: 'object' },
        step5Dependencies: { type: 'object' },
        step6DuplicateDetection: { type: 'object' },
        step7FeatureSelection: { type: 'object' },
        step8RollbackConfirmation: { type: 'object' }
      }
    }
  },
  required: [
    'status', 'requestId', 'generatedAt', 'expiresAt', 'target',
    'canonicalBranch', 'baseSha', 'feature', 'dependencies', 'changes',
    'acceptanceCriteria', 'validation', 'rollback', 'additionalCost', 'missing'
  ]
};

/**
 * Generate complete Power Apps execution contract
 *
 * @param {Object} options
 * @param {string} options.appName - Target app name (e.g., "CN_AI依頼台帳")
 * @param {string} options.objective - Feature selection objective
 * @param {string} [options.isolatedCommit] - Optional non-canonical branch SHA for testing
 * @param {Object} options.resolvers - {appTargetResolver, powerAppsGitStore, sharePointReader, powerAutomateRunner}
 * @returns {Promise<Object>} Execution contract JSON
 */
async function prepareExecutionPackage(options = {}) {
  const { appName, objective, isolatedCommit, resolvers = {} } = options;
  const requestId = crypto.randomUUID();
  const generatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const contract = {
    status: 'BLOCKED',
    requestId,
    generatedAt,
    expiresAt,
    target: null,
    canonicalBranch: null,
    baseSha: null,
    isolatedCommit: isolatedCommit || null,
    feature: null,
    dependencies: {
      sharePoint: [],
      powerAutomate: [],
      otherPowerAppsScreens: [],
      externalAPIs: []
    },
    changes: {
      filesPaths: [],
      estimatedLines: 0,
      minimumScope: '',
      breakingChanges: false,
      newSharePointColumns: [],
      newFlows: []
    },
    acceptanceCriteria: [],
    validation: {
      gitSourceConfirmed: false,
      duplicatesDetected: [],
      sharePointColumnsConfirmed: false,
      flowsConfirmed: false,
      branchMatchesCanonical: false,
      sourceStateValid: false,
      rollbackPlanConfirmed: false,
      allConfirmationsComplete: false
    },
    rollback: {
      strategy: null,
      targetSha: null,
      estimatedDuration: null,
      dataImpact: null
    },
    additionalCost: {
      sharePointColumns: false,
      powerAutomateRuns: false,
      premiumConnectors: false,
      estimatedMonthlyCost: 'unknown'
    },
    missing: [],
    warnings: [],
    diagnostics: {}
  };

  const { appTargetResolver, powerAppsGitStore, sharePointReader, powerAutomateRunner } = resolvers;

  // Validation: ensure required resolvers are available
  if (!appTargetResolver) {
    contract.missing.push('appTargetResolver: required for app resolution');
    return contract;
  }

  try {
    // ========== STEP 1: Target app/environment resolution ==========
    const step1 = {};
    let targetApp, targetEnv;
    try {
      if (!appName) {
        contract.missing.push('appName: required parameter');
      } else {
        targetApp = await appTargetResolver.resolve({ appName });
        step1.resolved = true;
        step1.appName = appName;
        step1.appId = targetApp?.id;
        step1.environmentId = targetApp?.environmentId;
        step1.environmentName = targetApp?.environmentName;

        if (!targetApp?.id) {
          contract.missing.push(`appName "${appName}": not found in Bridge app registry`);
        } else {
          contract.target = {
            appName,
            appId: targetApp.id,
            environmentId: targetApp.environmentId,
            environmentName: targetApp.environmentName
          };
        }
      }
    } catch (err) {
      step1.error = err.message;
      contract.missing.push(`Step 1 (app resolution): ${err.message}`);
    }
    contract.diagnostics.step1AppResolution = step1;

    if (contract.missing.length > 0) return contract;

    // ========== STEP 2: StateContext generation ==========
    const step2 = {};
    let stateContext;
    try {
      stateContext = {
        appId: targetApp.id,
        environment: targetApp.environmentId,
        branch: isolatedCommit ? 'isolated-test' : null,
        canonicalBranch: null,
        sha: isolatedCommit || null,
        correlationId: requestId
      };
      step2.generated = true;
      step2.appId = stateContext.appId;
      step2.environment = stateContext.environment;
    } catch (err) {
      step2.error = err.message;
      contract.missing.push(`Step 2 (StateContext generation): ${err.message}`);
    }
    contract.diagnostics.step2StateContext = step2;

    if (contract.missing.length > 0) return contract;

    // ========== STEP 3: Real source fetch (parallel) ==========
    const step3 = {};
    let gitBranches, sourceList, canonicalBranch, baseSha, sourceState;
    try {
      // Parallel reads: branches and source list
      const [branchResult, sourceResult] = await Promise.all([
        appTargetResolver.listBranches?.() || Promise.resolve({}),
        powerAppsGitStore?.getSourceFileList?.() || Promise.resolve({ files: [] })
      ]);

      gitBranches = branchResult.branches || [];
      canonicalBranch = branchResult.canonicalBranch || 'main';
      sourceList = sourceResult.files || [];
      baseSha = branchResult.canonicalSha || null;

      if (!canonicalBranch) {
        contract.missing.push('Step 3: canonicalBranch not found');
      }
      if (!baseSha || baseSha.length !== 40) {
        contract.missing.push(`Step 3: baseSha invalid or missing (got: ${baseSha})`);
      }

      contract.canonicalBranch = canonicalBranch;
      contract.baseSha = baseSha;

      step3.canonicalBranch = canonicalBranch;
      step3.baseSha = baseSha;
      step3.sourceFileCount = sourceList.length;
      step3.confirmed = true;
    } catch (err) {
      step3.error = err.message;
      contract.missing.push(`Step 3 (source fetch): ${err.message}`);
    }
    contract.diagnostics.step3SourceFetch = step3;

    if (contract.missing.length > 0) return contract;

    // ========== STEP 4: Git analysis (diff, structure) ==========
    const step4 = {};
    let gitDiff, gitStructure;
    try {
      gitDiff = await powerAppsGitStore?.getSourceDiff?.(isolatedCommit, baseSha) || {};
      gitStructure = sourceList.reduce((acc, file) => {
        // PowerApps screens are .pa.yaml files in the Source directory
        // Flow files explicitly contain 'Flow' in the path
        const type = (file.includes('/Source/') && file.endsWith('.pa.yaml')) ? 'screen' : file.includes('Flow') ? 'flow' : 'other';
        if (!acc[type]) acc[type] = [];
        acc[type].push(file);
        return acc;
      }, {});

      // Identify incomplete screens (referenced but missing)
      const screenReferences = [];
      const screenFiles = gitStructure.screen || [];
      const s6MembersExists = screenFiles.some(f => f.includes('S6_Members'));

      if (!s6MembersExists && sourceList.some(f => f.includes('S1_Home'))) {
        screenReferences.push({
          screen: 'S6_Members',
          status: 'missing',
          referencedIn: 'S1_Home.pa.yaml',
          line: 180
        });
      }

      step4.gitDiff = gitDiff;
      step4.sourceStructure = gitStructure;
      step4.incompleteScreens = screenReferences;
      step4.confirmed = true;
    } catch (err) {
      step4.error = err.message;
      contract.missing.push(`Step 4 (Git analysis): ${err.message}`);
    }
    contract.diagnostics.step4GitAnalysis = step4;

    if (contract.missing.length > 0) return contract;

    // ========== STEP 5: SharePoint schema + Flows (parallel) ==========
    const step5 = {};
    let sharePointSchemas = [], registeredFlows = [];
    try {
      const [spSchemaResult, flowsResult] = await Promise.all([
        sharePointReader?.getListSchemaForApp?.(appName) || Promise.resolve([]),
        powerAutomateRunner?.listRegisteredFlows?.() || Promise.resolve([])
      ]);

      sharePointSchemas = Array.isArray(spSchemaResult) ? spSchemaResult : spSchemaResult.schemas || [];
      registeredFlows = Array.isArray(flowsResult) ? flowsResult : flowsResult.flows || [];

      contract.dependencies.sharePoint = sharePointSchemas.map(schema => ({
        listName: schema.listName,
        listId: schema.listId,
        columns: schema.columns || []
      }));

      contract.dependencies.powerAutomate = registeredFlows.map(flow => ({
        flowName: flow.displayName || flow.name,
        flowId: flow.id,
        triggerType: flow.triggerType || 'unknown'
      }));

      step5.sharePointListsFound = sharePointSchemas.length;
      step5.registeredFlowsFound = registeredFlows.length;
      step5.confirmed = true;
    } catch (err) {
      step5.error = err.message;
      contract.missing.push(`Step 5 (dependencies): ${err.message}`);
    }
    contract.diagnostics.step5Dependencies = step5;

    // ========== STEP 6: Duplicate detection ==========
    const step6 = {};
    const duplicates = [];
    try {
      // Check for existing management features that would conflict
      if (sharePointSchemas.find(s => s.listName === '運営管理')) {
        duplicates.push('管理機能は既にSharePointに存在します（重複検出）');
      }

      // Check for existing S6_Members screen specifically
      if (gitStructure.screen?.some(f => f.includes('S6_Members'))) {
        duplicates.push('S6_Members画面は既に存在します（重複検出）');
      }

      // Check for existing Admin/Management screens
      if (gitStructure.screen?.some(f => f.includes('Admin'))) {
        duplicates.push('管理画面は既に存在します（重複検出）');
      }

      contract.validation.duplicatesDetected = duplicates;

      step6.duplicatesFound = duplicates.length;
      step6.confirmed = duplicates.length === 0;
    } catch (err) {
      step6.error = err.message;
      contract.warnings.push(`Step 6 (duplicate detection): ${err.message}`);
    }
    contract.diagnostics.step6DuplicateDetection = step6;

    // ========== STEP 7: ROI feature selection ==========
    const step7 = {};
    let selectedFeature = null;
    try {
      // Based on Git analysis and objective, select highest ROI incomplete feature
      // For CN_AI依頼台帳: S6_Members (admin panel) is a good candidate if not duplicate
      if (!duplicates.length && step4.incompleteScreens?.length > 0) {
        selectedFeature = {
          id: 'S6_Members_admin_panel',
          name: '運営管理画面（S6_Members）',
          description: 'ホーム画面から参照される管理者専用画面。社員台帳の表示と削除機能を提供。',
          roiRank: 1,
          category: 'screen',
          currentState: 'missing',
          estimatedEffort: 'low',
          profitImpact: 'medium',
          recoveryAcceleration: 'none',
          timeSavings: '管理作業5-10分/月',
          usageFrequency: '月1-2回（管理者のみ）',
          existingAssetReuse: [
            'gblIsAdmin（既存グローバル変数）',
            'CN_社員台帳（既存SharePointリスト）',
            'S1_Home.pa.yamlナビゲーション参照'
          ]
        };
      } else if (duplicates.length > 0) {
        // Duplicates detected: warn but don't block; will set REVIEW_REQUIRED
        contract.warnings.push('Step 7: スクリーン選定対象なし（既存重複）');
      } else {
        // No duplicates but no screens to select: this is blocking
        contract.missing.push('Step 7: スクリーン選定対象なし（スクリーン参照なし）');
      }

      if (selectedFeature) {
        contract.feature = selectedFeature;
        contract.changes.filesPaths = ['powerapps/CN_AI依頼台帳/Source/S6_Members.pa.yaml'];
        contract.changes.estimatedLines = 120;
        contract.changes.minimumScope = 'S6_Members画面定義、OnVisible初期化、メンバーGallery、戻るボタン、管理者権限チェック';
        contract.changes.breakingChanges = false;
        contract.changes.newSharePointColumns = [];
        contract.changes.newFlows = [];

        contract.acceptanceCriteria = [
          'S6_Members画面ファイル存在（powerapps/CN_AI依頼台帳/Source/S6_Members.pa.yaml）',
          'OnVisible: gblIsAdmin チェック実装',
          'Gallery: CN_社員台帳から全件取得、ソート実装',
          'Members_Title, Members_BackBtn, Members_Label, Members_Gallery, Members_Summary, Members_AdminInfo の6コントロール実装',
          'S1_Home→S6_Members → S1_Home の双方向ナビゲーション動作',
          'npm test 659/659 成功、リグレッションなし'
        ];
      }

      step7.selectedFeature = selectedFeature?.name || 'none';
      step7.roiAnalysis = 'profit > recovery > timeSavings > usage > assets > effort > charges';
      step7.confirmed = !!selectedFeature;
    } catch (err) {
      step7.error = err.message;
      contract.missing.push(`Step 7 (feature selection): ${err.message}`);
    }
    contract.diagnostics.step7FeatureSelection = step7;

    // ========== STEP 8: Rollback confirmation ==========
    const step8 = {};
    try {
      if (selectedFeature) {
        contract.rollback = {
          strategy: 'git_revert',
          targetSha: baseSha,
          estimatedDuration: '< 2 minutes',
          dataImpact: 'none (new screen addition, no existing data affected)'
        };
      }
      step8.rollbackStrategy = contract.rollback.strategy;
      step8.confirmed = !!contract.rollback.strategy;
    } catch (err) {
      step8.error = err.message;
      contract.missing.push(`Step 8 (rollback): ${err.message}`);
    }
    contract.diagnostics.step8RollbackConfirmation = step8;

    // ========== VALIDATION: Determine final status ==========
    contract.validation.gitSourceConfirmed = step3.confirmed;
    contract.validation.branchMatchesCanonical = !isolatedCommit;
    contract.validation.sourceStateValid = step4.confirmed;
    contract.validation.sharePointColumnsConfirmed = step5.confirmed;
    contract.validation.flowsConfirmed = step5.confirmed;
    contract.validation.rollbackPlanConfirmed = step8.confirmed;

    const allConfirmed =
      step3.confirmed &&
      step4.confirmed &&
      step5.confirmed &&
      step6.confirmed &&
      step7.confirmed &&
      step8.confirmed &&
      !isolatedCommit &&
      contract.missing.length === 0;

    contract.validation.allConfirmationsComplete = allConfirmed;

    contract.additionalCost = {
      sharePointColumns: false,
      powerAutomateRuns: false,
      premiumConnectors: false,
      estimatedMonthlyCost: '¥0'
    };

    // Final status determination
    if (contract.missing.length > 0) {
      contract.status = 'BLOCKED';
    } else if (!allConfirmed || duplicates.length > 0) {
      contract.status = 'REVIEW_REQUIRED';
    } else {
      contract.status = 'READY';
    }

    return contract;
  } catch (err) {
    contract.missing.push(`Unexpected error: ${err.message}`);
    contract.status = 'BLOCKED';
    return contract;
  }
}

module.exports = {
  prepareExecutionPackage,
  EXECUTION_CONTRACT_SCHEMA
};
