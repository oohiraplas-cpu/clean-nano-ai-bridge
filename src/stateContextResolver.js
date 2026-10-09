/**
 * StateContextResolver: Complete Missing State Context Fields
 *
 * Resolves missing branch, sha, state, writable fields through multiple sources.
 * Achieves stateContextComplete=true by filling gaps automatically.
 *
 * Resolution priority:
 * 1. Explicit params
 * 2. StateContextStore (TTL-based cache)
 * 3. PowerAppsGitStore (get_powerapps_source)
 * 4. Derived state/writable
 *
 * If any required field remains unresolved, returns incomplete=true for Fail-Closed.
 */

const stateManagerModule = require('./stateManager');

class StateContextResolver {
  constructor(options = {}) {
    this.stateContextStore = options.stateContextStore || null;
    this.powerAppsGitStore = options.powerAppsGitStore || null;
    this.config = options.config || {};
  }

  /**
   * Resolve complete State Context from multiple sources
   *
   * @param {object} params - MCP method parameters
   * @param {string} correlationId - Optional correlation ID for store lookup
   * @returns {Promise<object>} Complete State Context with status flags
   *
   * Returns:
   * {
   *   stateContext: { appId, environmentId, displayName, branch, canonicalBranch, sha, sourceOrigin, state, writable, correlationId, ... },
   *   complete: true|false,
   *   incomplete: false|true,
   *   resolved: { branch, sha, state, writable }, // Which fields were resolved
   *   source: { branch, sha, state, writable }, // Where each came from
   *   errors: [] // Missing fields if incomplete
   * }
   */
  async resolve(params = {}, correlationId = null) {
    const errors = [];
    const resolved = {};
    const sources = {};

    // Step 1: Extract explicitly provided fields - check all possible fields
    let context = {};
    const fieldsToExtract = [
      'appId', 'environmentId', 'displayName', 'branch', 'canonicalBranch',
      'sha', 'sourceOrigin', 'state', 'writable', 'correlationId'
    ];
    for (const field of fieldsToExtract) {
      if (field in params) {
        context[field] = params[field];
      }
    }

    // Step 2: Determine correlationId to use
    const effectiveCorrelationId = correlationId || context.correlationId;
    if (!effectiveCorrelationId) {
      context.correlationId = stateManagerModule.generateCorrelationId();
    } else if (!context.correlationId) {
      // Ensure effectiveCorrelationId is in context
      context.correlationId = effectiveCorrelationId;
    }

    // Step 3: Try StateContextStore if correlationId provided
    if (effectiveCorrelationId && this.stateContextStore) {
      const cached = this.stateContextStore.get(effectiveCorrelationId);
      if (cached) {
        // Merge cached context, but don't override explicit params
        for (const field of ['branch', 'sha', 'state', 'writable', 'canonicalBranch', 'sourceOrigin']) {
          if (!(field in context) && field in cached) {
            context[field] = cached[field];
            sources[field] = 'stateContextStore';
          }
        }
      }
    }

    // Step 4: Get missing fields from PowerAppsGitStore
    const needsGitLookup = ['branch', 'sha', 'state', 'writable', 'sourceOrigin', 'canonicalBranch']
      .some(field => !(field in context));

    if (needsGitLookup && this.powerAppsGitStore && context.appId) {
      try {
        // Construct relative path from appId or use default
        const relativePath = this._constructSourcePath(context);

        const source = await this.powerAppsGitStore.getSourceFile(relativePath);

        if (source) {
          if (!context.branch) {
            context.branch = source.branch;
            sources.branch = 'powerAppsGitStore.getSourceFile';
            resolved.branch = true;
          }

          if (!context.sha) {
            context.sha = source.sha;
            sources.sha = 'powerAppsGitStore.getSourceFile';
            resolved.sha = true;
          }

          if (!context.canonicalBranch) {
            context.canonicalBranch = source.canonicalBranch;
            sources.canonicalBranch = 'powerAppsGitStore.getSourceFile';
          }

          if (!context.sourceOrigin) {
            context.sourceOrigin = `github:${source.branch}`;
            sources.sourceOrigin = 'powerAppsGitStore.getSourceFile';
            resolved.sourceOrigin = true;
          }

          // Step 5: Derive state from source.sourceState
          if (!context.state) {
            context.state = source.sourceState === 'github_canonical' ? 'ready' : 'hold';
            sources.state = 'derived_from_sourceState';
            resolved.state = true;
          }

          // Step 6: Derive writable from source.writable
          if (context.writable === undefined) {
            context.writable = source.writable === true;
            sources.writable = 'derived_from_sourceControl';
            resolved.writable = true;
          }
        }
      } catch (error) {
        errors.push(`PowerAppsGitStore lookup failed: ${error.message}`);
      }
    }

    // Step 7: Validate completeness
    const requiredFields = [
      'appId',
      'environmentId',
      'displayName',
      'branch',
      'canonicalBranch',
      'sha',
      'sourceOrigin',
      'state',
      'writable',
      'correlationId'
    ];

    const missing = [];
    for (const field of requiredFields) {
      if (context[field] === undefined || context[field] === null || context[field] === '') {
        missing.push(field);
      }
    }

    const complete = missing.length === 0;

    // Step 8: Store in StateContextStore if complete
    if (complete && this.stateContextStore) {
      this.stateContextStore.set(context);
    }

    return {
      stateContext: context,
      complete,
      incomplete: !complete,
      resolved,
      source: sources,
      missing: missing.length > 0 ? missing : null,
      errors: errors.length > 0 ? errors : null
    };
  }

  /**
   * Construct source file path from context
   * @private
   * @param {object} context
   * @returns {string}
   */
  _constructSourcePath(context) {
    // Default pattern: CN_<AppName>.msapp.xml
    if (context.displayName) {
      return `CN_${context.displayName}.msapp.xml`;
    }
    // Fallback to appId
    if (context.appId) {
      return `${context.appId}.msapp.xml`;
    }
    return 'Source.xml';
  }

  /**
   * Get statistics on State Context Store
   * @returns {object}
   */
  getStoreStats() {
    if (!this.stateContextStore) {
      return { status: 'not_configured' };
    }
    return this.stateContextStore.stats();
  }

  /**
   * Clear all State Contexts (for testing)
   */
  clearStore() {
    if (this.stateContextStore) {
      this.stateContextStore.clear();
    }
  }
}

module.exports = StateContextResolver;
