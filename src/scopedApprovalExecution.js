const crypto = require('node:crypto');
const { bridgeError, notConfiguredError } = require('./errors');

const FIELDS = Object.freeze(['requestId', 'tool', 'targetId', 'environmentId', 'commitSha',
  'diffHash', 'approverId', 'approvedAt', 'expiresAt', 'revoked', 'status',
  'executionId', 'executionStatus', 'executionResult', 'backup']);
function deny(reason, status = 403) { return bridgeError(reason, status, { status: 'blocked', reason }); }
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  throw deny('invalid_json', 400);
}
function changeHash(operation) {
  return crypto.createHash('sha256').update(canonical({ requestId: operation.requestId,
    tool: operation.tool, targetId: operation.targetId, environmentId: operation.environmentId,
    commitSha: operation.commitSha, params: operation.params })).digest('hex');
}

// Reuse the existing SharePoint authentication. URLs are constructed from explicit IDs;
// neither arbitrary URLs nor client-provided column names are accepted for the ledger.
class SharePointApprovalStore {
  constructor(reader, config = {}) { this.reader = reader; this.config = config; }
  assertConfigured() {
    const c = this.config;
    const names = FIELDS.map(k => c.fieldMap?.[k]);
    if (!c.siteId || !c.listId || names.some(n => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))
      || new Set(names).size !== FIELDS.length || !c.allowedApproverIds?.length) {
      throw notConfiguredError('scoped_approval_ledger', ['verifiedApprovalList', 'fieldMap', 'allowedApproverIds']);
    }
  }
  path(id) {
    if (!/^[1-9][0-9]*$/.test(String(id))) throw deny('invalid_approval_id', 400);
    return `/sites/${encodeURIComponent(this.config.siteId)}/lists/${encodeURIComponent(this.config.listId)}/items/${id}`;
  }
  async request(path, options = {}) {
    this.reader._assertConfig();
    const token = await this.reader._getAccessToken();
    const response = await this.reader._fetch(`${this.reader.graphBaseUrl}${path}`, {
      ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers },
      redirect: 'error'
    });
    if (!response.ok) throw deny(response.status === 412 ? 'etag_conflict' : 'sharepoint_request_failed', response.status === 412 ? 409 : 502);
    return response.status === 204 ? {} : response.json();
  }
  async read(id) {
    this.assertConfigured();
    const item = await this.request(this.path(id) + '?$expand=fields');
    if (!item.eTag || item.id !== String(id)) throw deny('approval_metadata_missing');
    const record = Object.fromEntries(FIELDS.map(k => [k, item.fields?.[this.config.fieldMap[k]]]));
    return { record, etag: item.eTag, actor: item.lastModifiedBy };
  }
  async verifyHuman(snapshot) {
    const id = snapshot.record.approverId;
    // Trust Graph identity metadata, never the request's approvedByHuman flag.
    if (typeof id !== 'string' || !this.config.allowedApproverIds.includes(id)
      || snapshot.actor?.application || snapshot.actor?.user?.id !== id) return false;
    const user = await this.request(`/users/${encodeURIComponent(id)}?$select=id,accountEnabled`);
    return user.id === id && user.accountEnabled === true;
  }
  async patch(id, etag, values) {
    if (!etag || etag === '*') throw deny('etag_required');
    const allowed = new Set(['executionId', 'executionStatus', 'executionResult', 'backup']);
    if (Object.keys(values).some(k => !allowed.has(k))) throw deny('approval_fields_read_only');
    return this.request(this.path(id) + '/fields', { method: 'PATCH', headers: { 'If-Match': etag },
      body: JSON.stringify(Object.fromEntries(Object.entries(values).map(([k,v]) => [this.config.fieldMap[k],v]))) });
  }
}

class ScopedApprovalExecutor {
  constructor({ store, operations = {}, commitSha, now = () => Date.now() }) {
    this.store = store; this.operations = operations; this.commitSha = commitSha; this.now = now;
  }
  validate(record, input, reserved = false) {
    for (const key of ['requestId','tool','targetId','environmentId','commitSha','diffHash']) {
      if (typeof input[key] !== 'string' || !input[key] || record[key] !== input[key]) throw deny(`${key}_mismatch`);
    }
    if (!/^[a-f0-9]{40}$/.test(input.commitSha) || input.commitSha !== this.commitSha) throw deny('runtime_commit_mismatch');
    if (input.diffHash !== changeHash(input)) throw deny('payload_hash_mismatch');
    const start = Date.parse(record.approvedAt), end = Date.parse(record.expiresAt), now = this.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now || end <= start || end-start > 86400000) throw deny('approval_expired_or_invalid');
    if (record.status !== '承認' || record.revoked !== false) throw deny('approval_not_active');
    if (!reserved && (record.executionId || record.executionStatus)) throw deny('approval_already_used', 409);
  }
  async execute(input) {
    // Clone once: callers cannot mutate the payload between validation and dispatch.
    input = JSON.parse(canonical(input));
    const adapter = Object.hasOwn(this.operations, input.tool) && this.operations[input.tool];
    if (!adapter) throw deny('operation_not_supported', 400);
    adapter.assertTarget(input);
    const snapshot = await this.store.read(input.approvalId);
    this.validate(snapshot.record, input);
    if (!await this.store.verifyHuman(snapshot)) throw deny('approver_identity_unverified');
    const backup = await adapter.preflight(input);
    const backupJson = canonical(backup);
    if (Buffer.byteLength(backupJson) > 60000) throw deny('backup_too_large', 400);
    const executionId = crypto.randomUUID();
    // Atomic compare-and-set BEFORE any target mutation. A crash consumes approval.
    // Never clear the reservation or auto-retry a possibly applied operation.
    await this.store.patch(input.approvalId, snapshot.etag, {
      executionId, executionStatus: 'reserved', backup: backupJson,
      executionResult: JSON.stringify({ executionId, diffHash: input.diffHash, reservedAt: new Date(this.now()).toISOString() })
    });
    let current = await this.store.read(input.approvalId);
    this.validate(current.record, input, true);
    if (current.record.executionId !== executionId || current.record.executionStatus !== 'reserved') throw deny('reservation_lost');
    let outcome = 'outcome_unknown';
    try {
      await adapter.invoke(input, backup);
      outcome = await adapter.verify(input, backup) ? 'verified' : 'verification_failed';
    } catch { /* Do not leak payloads, credentials, or retry ambiguous writes. */ }
    try {
      await this.store.patch(input.approvalId, current.etag, { executionStatus: outcome,
        executionResult: JSON.stringify({ executionId, outcome, diffHash: input.diffHash, finishedAt: new Date(this.now()).toISOString() }) });
    } catch {
      return { status: 'audit_write_failed', executionId, operationOutcome: outcome, retryAllowed: false, verified: false };
    }
    return { status: outcome, executionId, retryAllowed: false, verified: outcome === 'verified' };
  }
}

// Initial real adapter: existing SharePoint item edits only. No list/item creation,
// approval-list editing, connection changes, arbitrary endpoints or hidden overwrite.
function sharePointItemOperation(store, config = {}) {
  function target(input) {
    const p = input.params;
    if (!p || typeof p.targetKey !== 'string' || !Object.hasOwn(config.targets || {}, p.targetKey)) throw deny('target_not_registered');
    const t = config.targets[p.targetKey];
    if (!t.siteId || !t.listId || !t.environmentId || !Array.isArray(t.allowedFields) || !t.allowedFields.length
      || !/^[1-9][0-9]*$/.test(String(p.itemId)) || !p.expectedETag || p.expectedETag === '*') throw deny('target_configuration_invalid');
    if (String(t.siteId).toLowerCase() === String(config.siteId).toLowerCase() && String(t.listId).toLowerCase() === String(config.listId).toLowerCase()) throw deny('approval_list_is_protected');
    if (input.environmentId !== t.environmentId || input.targetId !== `${t.siteId}/${t.listId}/${p.itemId}`) throw deny('target_mismatch');
    const fields = p.fields;
    if (!fields || Object.getPrototypeOf(fields) !== Object.prototype || !Object.keys(fields).length
      || Object.keys(fields).some(k => !t.allowedFields.includes(k) || ['__proto__','constructor','prototype'].includes(k))) throw deny('field_not_allowed');
    if (Object.values(fields).some(v => v !== null && !['string','number','boolean'].includes(typeof v))) throw deny('unsupported_field_value');
    return { t, p, path: `/sites/${encodeURIComponent(t.siteId)}/lists/${encodeURIComponent(t.listId)}/items/${p.itemId}` };
  }
  return {
    assertTarget: target,
    async preflight(input) {
      const { path, p } = target(input);
      const item = await store.request(path + '?$expand=fields');
      if (item.eTag !== p.expectedETag) throw deny('target_etag_mismatch',409);
      return { id: item.id, etag: item.eTag, fields: item.fields, capturedAt: new Date().toISOString() };
    },
    async invoke(input, backup) {
      const { path, p } = target(input);
      return store.request(path + '/fields', { method:'PATCH', headers: { 'If-Match': backup.etag }, body: JSON.stringify(p.fields) });
    },
    async verify(input) {
      const { path, p } = target(input);
      const item = await store.request(path + '?$expand=fields');
      return Object.entries(p.fields).every(([k,v]) => Object.hasOwn(item.fields || {}, k) && item.fields[k] === v);
    }
  };
}
module.exports = { FIELDS, changeHash, SharePointApprovalStore, ScopedApprovalExecutor, sharePointItemOperation };
