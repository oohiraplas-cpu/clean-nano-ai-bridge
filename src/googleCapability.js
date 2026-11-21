'use strict';
// Google Capability (permanent): Sheets / Drive / Apps Script (GAS) / CNKK, selectable from the CNAI Router
// through the `googleWorkspace` route.
//
// Rules implemented here (fail-closed):
//  - Implementation owner is Gemini (metadata + registry status). Execution itself goes through the Google REST APIs with the
//    existing Google OAuth (refresh-token flow); no new paid API, no API key. If Gemini is BLOCKED in the provider registry
//    this is reported (ownerStatus) but does not block REST execution — it is not Gemini CLI execution and is never reported as such.
//  - READ capabilities run automatically. gas.update / gas.deploy always need approvedByHuman === true (Human Gate).
//    gas.execute needs approval unless the function is in the configured read-only allowlist.
//  - Every write: snapshot before -> write -> re-fetch after -> compare -> Evidence. Unverified writes are never COMPLETED.
//  - Tokens / secrets are never returned or logged (maskDeep on every output).
//  - AppSheet API is not used. CNKK = Google Sheets (+ GAS when needed).

const crypto = require('node:crypto');
const { maskDeep } = require('./secretMasking');

const IMPLEMENTATION_OWNER = 'gemini';

// risk: LOW read / MEDIUM data write / HIGH code write, deploy, execute
const CAPABILITIES = Object.freeze({
  'sheets.read':   { service: 'sheets', readOnly: true,  risk: 'LOW',    humanGate: false },
  'sheets.update': { service: 'sheets', readOnly: false, risk: 'MEDIUM', humanGate: false },
  'drive.read':    { service: 'drive',  readOnly: true,  risk: 'LOW',    humanGate: false },
  'gas.read':      { service: 'gas',    readOnly: true,  risk: 'LOW',    humanGate: false },
  'gas.update':    { service: 'gas',    readOnly: false, risk: 'HIGH',   humanGate: true },
  'gas.deploy':    { service: 'gas',    readOnly: false, risk: 'HIGH',   humanGate: true },
  'gas.execute':   { service: 'gas',    readOnly: false, risk: 'HIGH',   humanGate: 'unless_allowlisted' },
  'gas.verify':    { service: 'gas',    readOnly: true,  risk: 'LOW',    humanGate: false },
  'cnkk.read':     { service: 'cnkk',   readOnly: true,  risk: 'LOW',    humanGate: false },
  'cnkk.update':   { service: 'cnkk',   readOnly: false, risk: 'MEDIUM', humanGate: false }
});

const SHEETS_RANGE = /^[^!]{1,100}!?[A-Za-z0-9:$]{0,40}$|^[A-Za-z0-9:$]{1,40}$/;
const ID = /^[A-Za-z0-9_-]{10,200}$/;
const MAX_CELLS = 5000;
const MAX_SOURCE_BYTES = 1024 * 1024;

class GoogleCapabilityError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const sha256 = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const need = (cond, message) => { if (!cond) throw new GoogleCapabilityError(message, 'INVALID_INPUT'); };
const id = (value, name) => { need(typeof value === 'string' && ID.test(value), `${name}が不正です`); return value; };

/** Registry view (read-only). `providerRegistry` is config/ai-provider-registry.json (optional). */
function describeCapabilities(providerRegistry) {
  const ownerStatus = providerRegistry?.providers?.[IMPLEMENTATION_OWNER]?.status || 'UNKNOWN';
  return {
    implementationOwner: IMPLEMENTATION_OWNER,
    ownerStatus,
    executionPath: 'google_rest_api_with_existing_oauth',
    appSheetApiRequired: false,
    capabilities: Object.entries(CAPABILITIES).map(([name, c]) => ({ capability: name, ...c }))
  };
}

// ---- Google REST client (OAuth refresh-token reuse; the token never leaves this closure) ----

function createGoogleClient({ oauth, fetchImpl = fetch } = {}) {
  let cached = null;
  async function accessToken() {
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;
    if (!oauth?.clientId || !oauth?.clientSecret || !oauth?.refreshToken) throw new GoogleCapabilityError('Google OAuth設定が未構成です', 'NOT_CONFIGURED');
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken })
    });
    if (!res.ok) throw new GoogleCapabilityError(`Google OAuthトークン取得に失敗しました (HTTP ${res.status})`, 'AUTH_FAILED');
    const body = await res.json();
    cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3000) * 1000 };
    return cached.token;
  }
  async function api(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON error body */ }
    if (!res.ok) throw new GoogleCapabilityError(`Google API エラー (HTTP ${res.status}): ${json?.error?.message || 'unknown'}`, res.status === 401 || res.status === 403 ? 'AUTH_OR_SCOPE' : 'UPSTREAM_ERROR', { httpStatus: res.status });
    return json;
  }
  const enc = encodeURIComponent;
  return {
    sheetsGet: (sid, range) => api('GET', `https://sheets.googleapis.com/v4/spreadsheets/${enc(sid)}/values/${enc(range)}`),
    sheetsUpdate: (sid, range, values) => api('PUT', `https://sheets.googleapis.com/v4/spreadsheets/${enc(sid)}/values/${enc(range)}?valueInputOption=USER_ENTERED`, { range, majorDimension: 'ROWS', values }),
    driveMeta: (fid) => api('GET', `https://www.googleapis.com/drive/v3/files/${enc(fid)}?fields=id,name,mimeType,modifiedTime,version,size,md5Checksum&supportsAllDrives=true`),
    driveList: (q, pageSize) => api('GET', `https://www.googleapis.com/drive/v3/files?q=${enc(q)}&pageSize=${pageSize}&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`),
    gasGetContent: (sid) => api('GET', `https://script.googleapis.com/v1/projects/${enc(sid)}/content`),
    gasUpdateContent: (sid, files) => api('PUT', `https://script.googleapis.com/v1/projects/${enc(sid)}/content`, { files }),
    gasCreateVersion: (sid, description) => api('POST', `https://script.googleapis.com/v1/projects/${enc(sid)}/versions`, { description }),
    gasDeploy: (sid, versionNumber, description) => api('POST', `https://script.googleapis.com/v1/projects/${enc(sid)}/deployments`, { versionNumber, description }),
    gasListDeployments: (sid) => api('GET', `https://script.googleapis.com/v1/projects/${enc(sid)}/deployments`),
    gasRun: (sid, fn, parameters, devMode) => api('POST', `https://script.googleapis.com/v1/scripts/${enc(sid)}:run`, { function: fn, parameters: parameters || [], devMode: devMode === true })
  };
}

// ---- helpers ----

function manifest(files) {
  return (files || []).map((f) => ({ name: f.name, type: f.type, bytes: Buffer.byteLength(f.source || ''), sha256: sha256(f.source || '') })).sort((a, b) => a.name.localeCompare(b.name));
}
const filesHash = (files) => sha256(manifest(files));

function validateGasFiles(files) {
  need(Array.isArray(files) && files.length > 0, 'filesは1件以上の配列である必要があります');
  let total = 0;
  for (const f of files) {
    need(f && typeof f.name === 'string' && f.name && ['SERVER_JS', 'HTML', 'JSON'].includes(f.type) && typeof f.source === 'string', 'files[]はname/type(SERVER_JS|HTML|JSON)/sourceが必要です');
    total += Buffer.byteLength(f.source);
  }
  need(total <= MAX_SOURCE_BYTES, 'ソースが大きすぎます(1MB上限)');
  need(files.some((f) => f.name === 'appsscript' && f.type === 'JSON'), 'appsscriptマニフェスト(JSON)を含める必要があります（含めないとGoogle側で全置換により破損します）');
}

function validateGrid(values) {
  need(Array.isArray(values) && values.length > 0 && values.every(Array.isArray), 'valuesは2次元配列である必要があります');
  need(values.reduce((n, r) => n + r.length, 0) <= MAX_CELLS, `1回の更新は${MAX_CELLS}セルまでです`);
}

const gridEqual = (a, b) => JSON.stringify((a || []).map((r) => r.map(String))) === JSON.stringify((b || []).map((r) => r.map(String)));

// ---- executor ----

/**
 * @param {object} deps { client, config:{readonlyFunctions:string[], cnkk:{spreadsheetId, gasScriptId}}, snapshots:Map, providerRegistry }
 * @param {{capability:string, params?:object, approvedByHuman?:boolean}} request
 * @returns {Promise<{success:boolean, verified:boolean, errorCode?:string, errorSummary?:string, capability, evidence, ...}>}
 */
async function executeGoogleCapability(deps, request) {
  const { client, config = {}, snapshots = new Map() } = deps;
  const capability = request?.capability;
  const def = CAPABILITIES[capability];
  if (!def) return { success: false, verified: false, errorCode: 'UNKNOWN_CAPABILITY', errorSummary: `未対応のcapabilityです: ${String(capability)}` };

  const params = request.params && typeof request.params === 'object' ? request.params : {};
  const evidence = { capability, owner: IMPLEMENTATION_OWNER, startedAt: now(), humanGate: { required: false, approved: false }, before: null, after: null, checks: [] };
  const finish = (result) => ({ capability, owner: IMPLEMENTATION_OWNER, ...maskDeep(result), evidence: maskDeep({ ...evidence, finishedAt: now() }) });

  try {
    if (!client) return finish({ success: false, verified: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorSummary: 'Google OAuth/クライアントが未構成です' });

    // Human Gate (before any side effect, and before any snapshot call for write operations)
    const gateRequired = def.humanGate === true
      || (def.humanGate === 'unless_allowlisted' && !(config.readonlyFunctions || []).includes(params.function));
    evidence.humanGate.required = gateRequired;
    if (gateRequired) {
      if (request.approvedByHuman !== true) {
        return finish({ success: false, verified: false, errorCode: 'HUMAN_APPROVAL_REQUIRED', errorSummary: `${capability}は人間承認待ちです（approvedByHuman=trueが必要。何も実行していません）` });
      }
      evidence.humanGate.approved = true;
    }

    const resolved = resolveCnkk(capability, params, config);
    const op = resolved.capability;
    const p = resolved.params;

    switch (op) {
      case 'sheets.read': {
        id(p.spreadsheetId, 'spreadsheetId'); need(SHEETS_RANGE.test(p.range || ''), 'rangeが不正です');
        const data = await client.sheetsGet(p.spreadsheetId, p.range);
        evidence.after = { range: data.range, rows: (data.values || []).length, sha256: sha256(data.values || []) };
        return finish({ success: true, verified: true, values: data.values || [] });
      }
      case 'sheets.update': {
        id(p.spreadsheetId, 'spreadsheetId'); need(SHEETS_RANGE.test(p.range || ''), 'rangeが不正です'); validateGrid(p.values);
        const before = await client.sheetsGet(p.spreadsheetId, p.range);
        const snapshotId = crypto.randomUUID();
        snapshots.set(snapshotId, { capability, target: `${p.spreadsheetId}!${p.range}`, values: before.values || [], takenAt: now() });
        evidence.before = { snapshotId, range: before.range, rows: (before.values || []).length, sha256: sha256(before.values || []) };
        await client.sheetsUpdate(p.spreadsheetId, p.range, p.values);
        const after = await client.sheetsGet(p.spreadsheetId, p.range);
        const match = gridEqual(after.values, p.values);
        evidence.after = { range: after.range, rows: (after.values || []).length, sha256: sha256(after.values || []) };
        evidence.checks.push({ name: 'readback_matches_request', passed: match });
        return finish(match
          ? { success: true, verified: true, snapshotId }
          : { success: false, verified: false, snapshotId, errorCode: 'VERIFICATION_FAILED', errorSummary: '保存後の再取得が要求内容と一致しません（snapshotIdで復元可能）' });
      }
      case 'drive.read': {
        if (p.fileId) { id(p.fileId, 'fileId'); const meta = await client.driveMeta(p.fileId); evidence.after = { fileId: meta.id, modifiedTime: meta.modifiedTime, version: meta.version }; return finish({ success: true, verified: true, file: meta }); }
        need(typeof p.query === 'string' && p.query.length > 0 && p.query.length <= 300, 'fileIdまたはqueryが必要です');
        const list = await client.driveList(p.query, Math.min(Number(p.pageSize) || 20, 50));
        evidence.after = { count: (list.files || []).length };
        return finish({ success: true, verified: true, files: list.files || [] });
      }
      case 'gas.read': {
        id(p.scriptId, 'scriptId');
        const content = await client.gasGetContent(p.scriptId);
        evidence.after = { fileCount: (content.files || []).length, manifestHash: filesHash(content.files), files: manifest(content.files) };
        const includeSource = p.includeSource === true;
        return finish({ success: true, verified: true, files: (content.files || []).map((f) => ({ name: f.name, type: f.type, ...(includeSource ? { source: f.source } : {}) })), manifestHash: evidence.after.manifestHash });
      }
      case 'gas.verify': {
        id(p.scriptId, 'scriptId');
        const content = await client.gasGetContent(p.scriptId);
        const actual = manifest(content.files);
        evidence.after = { manifestHash: filesHash(content.files), files: actual };
        if (p.expectedManifestHash !== undefined) evidence.checks.push({ name: 'manifest_hash', passed: p.expectedManifestHash === evidence.after.manifestHash });
        if (Array.isArray(p.expectedFiles)) {
          for (const e of p.expectedFiles) {
            const a = actual.find((f) => f.name === e.name);
            evidence.checks.push({ name: `file:${e.name}`, passed: Boolean(a) && (e.sha256 === undefined || e.sha256 === a.sha256) });
          }
        }
        if (p.checkDeployments === true) {
          const d = await client.gasListDeployments(p.scriptId);
          const list = d.deployments || [];
          evidence.checks.push({ name: 'has_deployment', passed: list.length > 0 });
          evidence.after.deploymentCount = list.length;
        }
        if (evidence.checks.length === 0) return finish({ success: true, verified: false, errorCode: 'NO_EXPECTATION', errorSummary: '比較対象(expectedManifestHash/expectedFiles/checkDeployments)が無いため検証できません（PASSにしません）' });
        const ok = evidence.checks.every((c) => c.passed);
        return finish(ok ? { success: true, verified: true } : { success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: 'GAS実体が期待と一致しません' });
      }
      case 'gas.update': {
        id(p.scriptId, 'scriptId'); validateGasFiles(p.files);
        const before = await client.gasGetContent(p.scriptId);
        const snapshotId = crypto.randomUUID();
        snapshots.set(snapshotId, { capability, target: p.scriptId, files: before.files || [], takenAt: now() });
        evidence.before = { snapshotId, fileCount: (before.files || []).length, manifestHash: filesHash(before.files), files: manifest(before.files) };
        await client.gasUpdateContent(p.scriptId, p.files);
        const after = await client.gasGetContent(p.scriptId);
        evidence.after = { fileCount: (after.files || []).length, manifestHash: filesHash(after.files), files: manifest(after.files) };
        const match = evidence.after.manifestHash === filesHash(p.files);
        evidence.checks.push({ name: 'readback_matches_request', passed: match });
        return finish(match
          ? { success: true, verified: true, snapshotId, manifestHash: evidence.after.manifestHash }
          : { success: false, verified: false, snapshotId, errorCode: 'VERIFICATION_FAILED', errorSummary: '保存後の再取得が要求内容と一致しません（snapshotIdで復元可能）' });
      }
      case 'gas.deploy': {
        id(p.scriptId, 'scriptId');
        const beforeD = await client.gasListDeployments(p.scriptId);
        evidence.before = { deploymentCount: (beforeD.deployments || []).length, deploymentIds: (beforeD.deployments || []).map((d) => d.deploymentId) };
        const version = await client.gasCreateVersion(p.scriptId, String(p.description || 'CNAI Router deploy').slice(0, 200));
        const dep = await client.gasDeploy(p.scriptId, version.versionNumber, String(p.description || 'CNAI Router deploy').slice(0, 200));
        const afterD = await client.gasListDeployments(p.scriptId);
        const found = (afterD.deployments || []).some((d) => d.deploymentId === dep.deploymentId);
        evidence.after = { deploymentCount: (afterD.deployments || []).length, versionNumber: version.versionNumber, deploymentId: dep.deploymentId };
        evidence.checks.push({ name: 'deployment_listed_after', passed: found });
        return finish(found
          ? { success: true, verified: true, versionNumber: version.versionNumber, deploymentId: dep.deploymentId }
          : { success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: 'deploy後の再取得でdeploymentを確認できません' });
      }
      case 'gas.execute': {
        id(p.scriptId, 'scriptId'); need(typeof p.function === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(p.function), 'functionが不正です');
        const run = await client.gasRun(p.scriptId, p.function, Array.isArray(p.parameters) ? p.parameters : [], p.devMode);
        const failed = Boolean(run?.error);
        evidence.after = { done: run?.done === true, hasError: failed, resultSha256: sha256(run?.response?.result ?? null) };
        // Execution outcome is reported, but "done without error" is not an independent verification of side effects.
        return finish(failed
          ? { success: false, verified: false, errorCode: 'GAS_EXECUTION_ERROR', errorSummary: String(run.error.message || 'GAS実行エラー') }
          : { success: true, verified: false, result: run?.response?.result ?? null, note: '副作用の検証は別途gas.verify/sheets.readで行ってください' });
      }
      default:
        return finish({ success: false, verified: false, errorCode: 'UNKNOWN_CAPABILITY', errorSummary: op });
    }
  } catch (err) {
    const code = err instanceof GoogleCapabilityError ? err.code : 'GOOGLE_ERROR';
    return finish({ success: false, verified: false, errorCode: code === 'NOT_CONFIGURED' ? 'ADAPTER_NOT_CONFIGURED' : code, errorSummary: err.message });
  }
}

/** CNKK = Google Sheets (+ GAS when needed). The spreadsheet/script come from config, never guessed. */
function resolveCnkk(capability, params, config) {
  if (!capability.startsWith('cnkk.')) return { capability, params };
  const spreadsheetId = params.spreadsheetId || config.cnkk?.spreadsheetId;
  if (!spreadsheetId) throw new GoogleCapabilityError('CNKKのspreadsheetIdが未設定です（GOOGLE_CNKK_SPREADSHEET_ID）', 'ADAPTER_NOT_CONFIGURED');
  return { capability: capability === 'cnkk.read' ? 'sheets.read' : 'sheets.update', params: { ...params, spreadsheetId } };
}

/** Router adapter factory: (record, input) -> result. input.payload = { capability, params } ; input.approvedByHuman. */
function createGoogleWorkspaceAdapter(deps) {
  const snapshots = deps.snapshots || new Map();
  return (record, input) => {
    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
    return executeGoogleCapability({ ...deps, snapshots }, {
      capability: payload.capability || record.requestType,
      params: payload.params,
      approvedByHuman: input.approvedByHuman === true
    });
  };
}

module.exports = { IMPLEMENTATION_OWNER, CAPABILITIES, GoogleCapabilityError, describeCapabilities, createGoogleClient, executeGoogleCapability, createGoogleWorkspaceAdapter };
