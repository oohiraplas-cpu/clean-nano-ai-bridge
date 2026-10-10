const crypto = require('node:crypto');

/**
 * @typedef {Object} StateContext
 * @property {string} appId
 * @property {string} environment
 * @property {string} branch
 * @property {string} canonicalBranch
 * @property {string} sha Git contents API blob SHA (not the branch commit SHA).
 * @property {string} correlationId Server-generated UUID for one execution chain.
 */
const STATE_CONTEXT_SCHEMA = Object.freeze({
  type: 'object',
  description: '実取得した対象・Git blob SHA・サーバー登録済みcorrelationId。stateSessionIdと併用します。',
  properties: {
    appId: { type: 'string', minLength: 1 },
    environment: { type: 'string', minLength: 1 },
    branch: { type: 'string', minLength: 1 },
    canonicalBranch: { type: 'string', minLength: 1 },
    sha: { type: 'string', pattern: '^[a-f0-9]{40}$', description: '対象ファイルのGit blob SHA' },
    correlationId: { type: 'string', minLength: 8, description: 'get_powerapps_stateが生成したUUID' },
    repository: { type: 'string', minLength: 1, description: 'GitHub repository (owner/repo)' },
    gitRoot: { type: 'string', minLength: 1, description: 'Git root path for Power Apps source' }
  },
  required: ['appId', 'environment', 'branch', 'canonicalBranch', 'sha', 'correlationId'],
  additionalProperties: false
});
const REQUIRED_STATE_FIELDS = STATE_CONTEXT_SCHEMA.required;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (content) => crypto.createHash('sha256').update(content).digest('hex');
const blobSha = (content) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');

function contextError(failures, status = 409) {
  const error = new Error(`State Manager検証エラー: ${failures.join('; ')}`);
  error.status = status;
  error.payload = { status: 'state_context_invalid', failures, required: REQUIRED_STATE_FIELDS };
  return error;
}

// Process-local, bounded registry. Restart/other instance => fail closed, never rebuild
// an unregistered context from client input. A shared store can be added separately.
class StateContextRegistry {
  constructor({ ttlMs = 300000, maxEntries = 1000, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxEntries) || maxEntries <= 0) throw new Error('Invalid State Context registry limits');
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.records = new Map();
  }

  begin(state, scope) {
    const appId = state.appId;
    const environment = state.environmentId;  // Map input environmentId to internal environment field
    const missing = ['appId', 'environment'].filter((field) => typeof ({ appId, environment })[field] !== 'string' || !({ appId, environment })[field].trim());
    if (missing.length) throw contextError(missing.map((f) => `${f}: missing from observed app state`), 400);
    for (const [id, record] of this.records) if (this.now() >= record.expiresAt) this.records.delete(id);
    if (this.records.size >= this.maxEntries) throw contextError(['registry: capacity exceeded'], 503);
    const correlationId = state.correlationId || crypto.randomUUID();
    const stateSessionId = crypto.randomUUID();
    // Store full context including extended AuthorityContext fields
    // Internal schema: appId, environment (for backward compat), plus all AuthorityContext fields
    const context = { ...state, appId, environment, correlationId };
    this.records.set(correlationId, { context, scope, stateSessionId, expiresAt: this.now() + this.ttlMs, source: null });
    return this.response(this.records.get(correlationId));
  }

  response(record) {
    // Return BOTH legacy stateContext (backward compat) and new authorityContext (8-field structure)
    // stateContext: filtered to STATE_CONTEXT_SCHEMA.required for backward compatibility
    const stateContextFields = REQUIRED_STATE_FIELDS.reduce((acc, field) => {
      if (record.context[field] !== undefined) acc[field] = record.context[field];
      return acc;
    }, {});

    // authorityContext: full 8-field structure for executable sessions
    const authorityContextFields = ['appId', 'environmentId', 'repository', 'gitRoot', 'branch', 'canonicalBranch', 'baseSha', 'correlationId'];
    const authorityContext = authorityContextFields.reduce((acc, field) => {
      if (record.context[field] !== undefined) acc[field] = record.context[field];
      return acc;
    }, {});

    // Check completeness of authorityContext (not based on source binding)
    const authorityContextComplete = authorityContextFields.every(f => record.context[f] !== undefined);
    const sourceObservationComplete = Boolean(record.source);

    return {
      correlationId: record.context.correlationId,
      stateSessionId: record.stateSessionId,
      stateContext: stateContextFields,
      authorityContext,
      authorityContextComplete,
      sourceObservationComplete,
      // Backward compatibility: stateContextComplete means source was bound
      stateContextComplete: sourceObservationComplete,
      stateContextExpiresAt: new Date(record.expiresAt).toISOString()
    };
  }

  lookup(correlationId, stateSessionId, scope) {
    if (typeof correlationId !== 'string' || !UUID.test(correlationId)) throw contextError(['correlationId: missing or invalid server UUID'], 400);
    const record = this.records.get(correlationId);
    if (!record) throw contextError(['correlationId: not registered']);
    if (this.now() >= record.expiresAt) { this.records.delete(correlationId); throw contextError(['correlationId: expired']); }
    if (record.scope !== scope || !stateSessionId || stateSessionId !== record.stateSessionId) throw contextError(['stateSessionId: missing or session mismatch']);
    return record;
  }

  bind(correlationId, stateSessionId, scope, source, relativePath) {
    const record = this.lookup(correlationId, stateSessionId, scope);
    const failures = [];
    for (const field of ['branch', 'canonicalBranch', 'sha', 'path']) {
      if (typeof source[field] !== 'string' || !source[field].length) failures.push(`${field}: missing from observed source`);
    }
    if (typeof source.content !== 'string') failures.push('content: missing from observed source');
    if (!/^[a-f0-9]{40}$/.test(source.sha || '')) failures.push('sha: invalid observed blob SHA');
    if (typeof source.content === 'string' && blobSha(source.content) !== source.sha) failures.push('sha: observed content does not match blob SHA');
    if (failures.length) throw contextError(failures);
    const context = { ...record.context, branch: source.branch, canonicalBranch: source.canonicalBranch, sha: source.sha };
    if (record.source && (record.source.path !== source.path || record.context.sha !== source.sha || record.context.branch !== source.branch || record.context.canonicalBranch !== source.canonicalBranch)) {
      throw contextError(['correlationId: already bound to a different file, branch or SHA']);
    }
    record.context = context;
    record.source = { ...source, requestedPath: relativePath, contentHash: hash(source.content) };
    return this.response(record);
  }

  bindSourceObservation(correlationId, stateSessionId, scope, source, relativePath) {
    // Phase 6: targetNames-specific binding for multiple SourceObservations without re-validating AuthorityContext
    // AuthorityContext fields (branch, canonicalBranch) were validated BEFORE stateSessionId was issued
    // SourceObservation binding ONLY validates file-level fields: sha, path, content
    // Do NOT re-validate or require branch/canonicalBranch from source object
    // Support multiple files bound to same session (last one is stored in record.source for backward compat)
    const record = this.lookup(correlationId, stateSessionId, scope);
    const failures = [];

    // Phase 6: Validate path and content first
    if (typeof source.path !== 'string' || !source.path.length) failures.push('path: missing from observed source');
    if (typeof source.content !== 'string') failures.push('content: missing from observed source');
    if (failures.length) throw contextError(failures);

    // Then validate sha against content (after content is confirmed present)
    if (typeof source.sha !== 'string' || !source.sha.length) failures.push('sha: missing from observed source');
    if (!/^[a-f0-9]{40}$/.test(source.sha || '')) failures.push('sha: invalid observed blob SHA');
    if (blobSha(source.content) !== source.sha) failures.push('sha: observed content does not match blob SHA');
    if (failures.length) throw contextError(failures);

    // Allow rebinding to different paths (targetNames scenario with multiple files)
    // Only reject if trying to bind the SAME path with different SHA
    if (record.source && record.source.path === source.path && record.source.sha !== source.sha) {
      throw contextError(['path: already bound with different SHA']);
    }
    record.source = { ...source, requestedPath: relativePath, contentHash: hash(source.content) };
    return this.response(record);
  }

  lookupBySessionId(stateSessionId, scope, appId) {
    // Dedicated API for inspect_powerapps_structure stateSessionId-only lookup
    if (typeof stateSessionId !== 'string' || stateSessionId.length < 8) {
      throw contextError(['stateSessionId: invalid format'], 400);
    }
    // Iterate through records to find matching stateSessionId
    for (const [correlationId, record] of this.records.entries()) {
      if (this.now() >= record.expiresAt) {
        this.records.delete(correlationId);
        continue;
      }
      if (record.stateSessionId === stateSessionId && record.source && record.scope === scope) {
        // Validate appId if specified
        if (appId !== undefined && appId !== record.context.appId) {
          throw contextError([
            `appId mismatch: received ${appId}, expected ${record.context.appId}`,
            `correlationId: ${record.context.correlationId}, stateSessionId: ${stateSessionId}`
          ]);
        }
        return record;
      }
    }
    throw contextError(['stateSessionId: not found or expired'], 404);
  }

  validate(context, stateSessionId, scope, params, method) {
    const failures = [];
    if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
    for (const field of REQUIRED_STATE_FIELDS) {
      if (typeof context[field] !== 'string' || !context[field].trim()) failures.push(`${field}: missing or invalid`);
    }
    if (context.sha && !/^[a-f0-9]{40}$/.test(context.sha)) failures.push('sha: must be 40-character hex string');
    for (const field of Object.keys(context)) if (!REQUIRED_STATE_FIELDS.includes(field)) failures.push(`${field}: unexpected field`);
    if (failures.length) throw contextError(failures, 400);
    const record = this.lookup(context.correlationId, stateSessionId, scope);
    if (!record.source) throw contextError(['stateContext: source not acquired']);
    // Phase 6: sha is in SourceObservation, not AuthorityContext; check it separately
    const fieldsToCompare = REQUIRED_STATE_FIELDS.filter(f => f !== 'sha');
    for (const field of fieldsToCompare) if (context[field] !== record.context[field]) failures.push(`${field}: mismatch with registered context`);
    if (context.sha !== record.source.sha) failures.push('sha: mismatch with registered source');
    if (record.context.branch !== record.context.canonicalBranch) failures.push('branch: non-canonical source');
    const suppliedPath = method === 'compare_powerapps_with_git' ? params.targetFile : params.relativePath;
    if (suppliedPath !== undefined && suppliedPath !== record.source.path && suppliedPath !== record.source.requestedPath) failures.push('relativePath/targetFile: mismatch with registered file');
    if (params.expectedBranch !== undefined && params.expectedBranch !== context.branch) failures.push('expectedBranch: mismatch');
    if (params.targetApp !== undefined && params.targetApp !== context.appId) failures.push('targetApp: mismatch');
    if (params.sourceContent !== undefined && (typeof params.sourceContent !== 'string' || hash(params.sourceContent) !== record.source.contentHash)) failures.push('sourceContent: mismatch with registered source');
    if (failures.length) throw contextError(failures);
    return record;
  }

  invalidateBySessionId(stateSessionId, reason = 'repair') {
    // Idempotent invalidation: remove only the session with given stateSessionId, ignore others
    if (typeof stateSessionId !== 'string' || stateSessionId.length < 8) {
      return { invalidated: false, reason: 'stateSessionId: invalid format' };
    }
    for (const [correlationId, record] of this.records.entries()) {
      if (record.stateSessionId === stateSessionId) {
        this.records.delete(correlationId);
        return { invalidated: true, correlationId, reason };
      }
    }
    // Session not found or already expired: treated as success (idempotent)
    return { invalidated: false, reason: 'stateSessionId: not found or already expired' };
  }

  cleanupExpired() {
    // Remove only expired sessions
    let deleted = 0;
    for (const [correlationId, record] of this.records.entries()) {
      if (this.now() >= record.expiresAt) {
        this.records.delete(correlationId);
        deleted++;
      }
    }
    return { deleted };
  }
}

module.exports = { STATE_CONTEXT_SCHEMA, REQUIRED_STATE_FIELDS, StateContextRegistry, contextError, blobSha };
