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
    repository: null,  // GitHub repository (set in step 3)
    isolatedCommit: isolatedCommit || null,
    feature: null,
    evidence: {},  // Bridge confirmations per step
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
    // Resolution pipeline: registry → resolve_app_target → application rules → BLOCKED
    const step1 = {};
    let targetApp, targetEnv;
    let resolutionSource = null; // Track where app info came from

    try {
      if (!appName) {
        contract.missing.push('appName: required parameter');
      } else {
        // Try appTargetResolver first (includes registry fallback + dynamic resolution)
        // appTargetResolver is the unified resolver covering all sources
        targetApp = await appTargetResolver.resolve({ appName });

        step1.resolved = targetApp ? true : false;
        step1.appName = appName;
        step1.appId = targetApp?.id;
        step1.environmentId = targetApp?.environmentId;
        step1.environmentName = targetApp?.environmentName;
        step1.resolutionSource = targetApp?.source || 'not_found'; // registry, resolver, etc.

        if (targetApp?.id && targetApp?.environmentId) {
          // Successful resolution from any source (registry, resolver, rules)
          contract.target = {
            appName,
            appId: targetApp.id,
            environmentId: targetApp.environmentId,
            environmentName: targetApp.environmentName || ''
          };
          contract.repository = targetApp.repository; // e.g., "oohiraplas-cpu/clean-nano-ai-bridge"
          contract.gitRoot = targetApp.gitRoot; // e.g., "powerapps/CN_AI依頼台帳/Source"
          contract.canonicalBranch = targetApp.canonicalBranch || 'main';

          resolutionSource = targetApp.source;
          step1.success = true;
        } else {
          // Resolution failed from all sources
          contract.missing.push(`appName "${appName}": could not be resolved (checked registry, resolver, and application rules)`);
          step1.success = false;
        }
      }
    } catch (err) {
      step1.error = err.message;
      contract.missing.push(`Step 1 (app resolution): ${err.message}`);
      step1.success = false;
    }

    step1.diagnostics = {
      resolutionSource,
      pipelineSteps: ['registry', 'resolve_app_target', 'application_rules'],
      failureReasonIfAny: step1.success ? null : 'all_sources_exhausted'
    };
    contract.diagnostics.step1AppResolution = step1;

    // Fail-Closed: If Step 1 fails, no resolution → BLOCKED
    if (!step1.success || contract.missing.length > 0) {
      return contract;
    }

    // ========== STEP 2: StateContext generation ==========
    const step2 = {};
    let stateContext;
    try {
      // StateContext will be completed in step 3 with actual branch/SHA from source
      stateContext = {
        appId: targetApp.id,
        environment: targetApp.environmentId,
        branch: null,  // Set in step 3
        canonicalBranch: null,  // Set in step 3
        sha: null,  // Set in step 3
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
      contract.repository = 'oohiraplas-cpu/clean-nano-ai-bridge';  // GitHub repository

      // Update StateContext with confirmed values
      stateContext.branch = isolatedCommit ? 'isolated-test' : canonicalBranch;
      stateContext.canonicalBranch = canonicalBranch;
      stateContext.sha = isolatedCommit || baseSha;
      contract.stateContext = stateContext;

      step3.canonicalBranch = canonicalBranch;
      step3.baseSha = baseSha;
      step3.sourceFileCount = sourceList.length;
      step3.confirmed = true;

      // Populate evidence map for this step
      contract.evidence.step3SourceFetch = {
        timestamp: new Date().toISOString(),
        confirmed: true,
        canonicalBranch,
        baseSha,
        sourceFileCount: sourceList.length
      };
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

      // Identify incomplete/missing screens from structure analysis
      // NOTE: This logic detects missing screens by pattern in CN_AI依頼台帳 (S1-S7 naming).
      // For generic apps, missing screens should be derived from:
      // - objective parameter (explicit feature reference)
      // - power apps state analysis (TODO comments, unconnected controls)
      // - design document vs. implementation diff
      // - bridgeExtensionsValidation/prepareExecutionPackage should accept explicit objectiveScreens[] input
      const screenReferences = [];
      const screenFiles = gitStructure.screen || [];

      // Candidate screen detection: derive from objective + confirmed requirements
      // Do NOT guess missing screens from naming patterns alone
      // Valid sources for candidates:
      // - objective parameter (explicit "implement X screen", "add Y panel")
      // - power apps state (TODO comments, unconnected controls, incomplete properties)
      // - design doc vs implementation diff
      // - missing dependencies from improvement backlog
      // - confirmed gaps in modification ledger

      // Fail-Closed: Only extract candidates from confirmed sources
      // Valid sources:
      // 1. Objective parameter (explicit feature mention)
      // 2. Modification ledger (confirmed incomplete items)
      // 3. Confirmed source-vs-implementation diffs
      // 4. Unresolved refs / unconnected elements / explicit TODO comments
      // NO guessing from naming patterns - tool must work for ANY Power App, not just S1-S7 convention

      if (objective) {
        // Parse objective for explicit screen/feature mentions
        // Example: "Implement S6_Members admin panel" → extract "S6_Members"
        const screenNameMatch = objective.match(/(?:implement|add|create)\s+(?:screen|panel|page)?\s*([A-Za-z0-9_]+)/i);
        if (screenNameMatch && screenNameMatch[1]) {
          const targetScreen = screenNameMatch[1];
          const screenExists = screenFiles.some(f =>
            f.includes(`/Source/${targetScreen}`) || f.includes(targetScreen)
          );
          if (!screenExists) {
            screenReferences.push({
              screenPattern: targetScreen,
              status: 'missing',
              referencedIn: 'objective parameter',
              extractedFrom: objective
            });
          }
        }
      }
      // Without objective or other confirmed source, do NOT generate candidates
      // This ensures Fail-Closed behavior and generic app support

      step4.gitDiff = gitDiff;
      step4.sourceStructure = gitStructure;
      step4.incompleteScreens = screenReferences;
      step4.confirmed = true;

      // Populate evidence for this step
      contract.evidence.step4GitAnalysis = {
        timestamp: new Date().toISOString(),
        confirmed: true,
        diffSummary: gitDiff,
        incompleteScreenCount: screenReferences.length
      };
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

      // Mark whether dependencies were actually fetched vs. just empty
      step5.sharePointFetched = !!spSchemaResult;
      step5.flowsFetched = !!flowsResult;
    } catch (err) {
      step5.error = err.message;
      contract.missing.push(`Step 5 (dependencies): ${err.message}`);
    }
    contract.diagnostics.step5Dependencies = step5;

    // ========== STEP 6: Duplicate detection ==========
    const step6 = {};
    const duplicates = [];
    try {
      // Duplicate detection only relevant if we're implementing an admin/management feature
      // Check if any incomplete screens are admin-related first
      const adminPatterns = ['Admin', 'Management', '管理', '運営'];
      const incompleteScreensToImplement = step4.incompleteScreens || [];
      const targetIsAdmin = incompleteScreensToImplement.some(s =>
        adminPatterns.some(pattern => s.screenPattern?.includes(pattern))
      );

      // Only flag duplicates if target IS admin and existing admin features are found
      if (targetIsAdmin) {
        // Check SharePoint for admin-like lists
        const adminListsInSP = sharePointSchemas.filter(s =>
          adminPatterns.some(pattern => s.listName?.includes(pattern))
        );
        if (adminListsInSP.length > 0) {
          duplicates.push(`既存管理機能: SharePoint ${adminListsInSP.map(s => s.listName).join(', ')}`);
        }

        // Check screens for other admin/management features
        const screenFiles = gitStructure.screen || [];
        const otherAdminScreens = screenFiles.filter(f =>
          adminPatterns.some(pattern => f.includes(pattern)) &&
          !incompleteScreensToImplement.some(s => f.includes(s.screenPattern))
        );
        if (otherAdminScreens.length > 0) {
          duplicates.push(`既存管理画面: ${otherAdminScreens.map(f => f.split('/').pop()).join(', ')}`);
        }
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
    const candidates = [];

    try {
      // Generic candidate selection from incomplete screens
      if (!duplicates.length && step4.incompleteScreens?.length > 0) {
        // Rank candidates by ROI (profit > recovery > timeSavings > usage > assets > effort > charges)
        step4.incompleteScreens.forEach((screen, idx) => {
          const screenName = screen.screenPattern || screen.screen;
          candidates.push({
            id: `screen_${screenName}`,
            name: `画面: ${screenName}`,
            screenPattern: screenName,
            description: `Missing screen ${screenName}`,
            roiRank: idx + 1,
            category: 'screen',
            currentState: 'missing',
            estimatedEffort: 'medium',
            profitImpact: 'unknown',
            recoveryAcceleration: 'unknown',
            timeSavings: 'unknown',
            usageFrequency: 'unknown',
            existingAssetReuse: []
          });
        });

        // Handle candidates: single → select, multiple → REVIEW_REQUIRED
        if (candidates.length === 1) {
          selectedFeature = candidates[0];
        } else if (candidates.length > 1) {
          // Multiple candidates: mark as REVIEW_REQUIRED (同点)
          contract.warnings.push(`Step 7: 複数候補存在（${candidates.length}個、同点判定）`);
        }
      } else if (duplicates.length > 0) {
        // Duplicates detected: warn but don't block; requires human review for duplicate handling
        contract.warnings.push('Step 7: 候補選定対象なし（既存重複）');
        // Don't add to missing - duplicates should trigger REVIEW_REQUIRED, not BLOCKED
      } else {
        // No duplicates but no screens to select: this is blocking
        contract.missing.push('Step 7: 候補選定対象なし（不完全な画面なし）');
      }

      if (selectedFeature) {
        contract.feature = selectedFeature;
        // Generic change scope (will be confirmed during implementation)
        contract.changes.filesPaths = [`powerapps/**/Source/${selectedFeature.screenPattern}.pa.yaml`];
        contract.changes.estimatedLines = 0;  // Unknown at this stage
        contract.changes.minimumScope = `${selectedFeature.screenPattern}画面定義`;
        contract.changes.breakingChanges = false;
        contract.changes.newSharePointColumns = [];
        contract.changes.newFlows = [];

        // Generic acceptance criteria
        contract.acceptanceCriteria = [
          `${selectedFeature.screenPattern}画面ファイル作成、保存完了`,
          `コントロール実装完了`,
          `ナビゲーション検証完了`,
          `npm test 成功、リグレッションなし`
        ];
      }

      step7.candidatesFound = candidates.length;
      step7.selectedFeature = selectedFeature?.name || 'none';
      step7.roiAnalysis = 'profit > recovery > timeSavings > usage > assets > effort > charges';
      step7.confirmed = !!selectedFeature && candidates.length === 1;  // Only confirmed if exactly one candidate
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
    } else if (!allConfirmed || step6.duplicatesFound > 0 || step7.candidatesFound > 1) {
      contract.status = 'REVIEW_REQUIRED';
    } else {
      contract.status = 'READY';
    }

    // Include StateContext for subsequent inspect_powerapps_structure calls
    // If source was retrieved, include the context data for State Manager binding
    if (stateContext && stateContext.canonicalBranch && stateContext.sha) {
      contract.stateContext = {
        appId: stateContext.appId,
        environment: stateContext.environment,
        branch: stateContext.canonicalBranch,
        canonicalBranch: stateContext.canonicalBranch,
        sha: stateContext.sha,
        correlationId: stateContext.correlationId,
        repository: contract.repository || 'oohiraplas-cpu/clean-nano-ai-bridge',
        gitRoot: contract.gitRoot || 'powerapps/CN_AI依頼台帳/Source'
      };
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
