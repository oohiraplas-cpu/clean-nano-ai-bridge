'use strict';
// Google Workspace Capability (permanent), selectable from the CNAI Router (`googleWorkspace` route).
// Targets: Gemini / Gmail / Chat / Drive / Sheets / Docs / Calendar / Apps Script (GAS) / AppSheet (CNKK).
//
// Rules (fail-closed):
//  - Implementation owner = Gemini (metadata). Execution = Google REST APIs with the existing Google OAuth refresh token of the same
//    Workspace domain. No new paid API, no API key. Gemini CLI is NOT used and is never reported as having executed anything.
//  - Least privilege: each capability asks Google for an access token narrowed to ONLY its own scopes (refresh-token `scope` subset).
//  - READ runs automatically. Mail send, Chat post, GAS update/deploy, Docs/Calendar/Sheets/AppSheet writes need approvedByHuman === true
//    (gas.execute unless the function is allowlisted). A blocked request makes no Google call and returns an approvalSummary +
//    proposalHash; on approval the originally proposed payload is executed (a different payload is refused).
//  - Every write: Snapshot(before) -> execute -> re-fetch -> compare -> Evidence -> Verifier verdict. Unverified is never COMPLETED.
//  - Tokens/secrets are never returned or logged (maskDeep). Irreversible deletes (events, rows, mail) are not offered.

const crypto = require('node:crypto');
const { maskDeep } = require('./secretMasking');

const IMPLEMENTATION_OWNER = 'gemini';
const G = 'https://www.googleapis.com/auth/';
const S = {
  gmailRead: `${G}gmail.readonly`, gmailCompose: `${G}gmail.compose`,
  chatRead: `${G}chat.messages.readonly`, chatCreate: `${G}chat.messages.create`,
  driveMeta: `${G}drive.metadata.readonly`,
  sheetsRead: `${G}spreadsheets.readonly`, sheetsWrite: `${G}spreadsheets`,
  docsRead: `${G}documents.readonly`, docsWrite: `${G}documents`,
  calRead: `${G}calendar.events.readonly`, calWrite: `${G}calendar.events`,
  gasRead: `${G}script.projects.readonly`, gasWrite: `${G}script.projects`, gasDeploy: `${G}script.deployments`,
  gasRun: `${G}script.scriptapp`,
  gemini: `${G}generative-language.retriever`
};

// humanGate: true | false | 'unless_allowlisted'.  backend:'none' => no Google call (metadata only).
const def = (service, readOnly, risk, humanGate, scopes) => Object.freeze({ service, readOnly, risk, humanGate, scopes: Object.freeze(scopes) });
const CAPABILITIES = Object.freeze({
  'google.status': def('google', true, 'LOW', false, []),
  'gemini.status': def('gemini', true, 'LOW', false, []),
  'gemini.generate': def('gemini', true, 'LOW', false, [S.gemini]),
  'gmail.read': def('gmail', true, 'LOW', false, [S.gmailRead]),
  'gmail.draft': def('gmail', false, 'MEDIUM', false, [S.gmailCompose]),
  'gmail.send': def('gmail', false, 'HIGH', true, [S.gmailCompose, S.gmailRead]),
  'chat.read': def('chat', true, 'LOW', false, [S.chatRead]),
  'chat.send': def('chat', false, 'HIGH', true, [S.chatCreate, S.chatRead]),
  'drive.read': def('drive', true, 'LOW', false, [S.driveMeta]),
  'sheets.read': def('sheets', true, 'LOW', false, [S.sheetsRead]),
  'sheets.update': def('sheets', false, 'MEDIUM', true, [S.sheetsWrite]),
  'docs.read': def('docs', true, 'LOW', false, [S.docsRead]),
  'docs.write': def('docs', false, 'MEDIUM', true, [S.docsWrite]),
  'calendar.read': def('calendar', true, 'LOW', false, [S.calRead]),
  'calendar.write': def('calendar', false, 'HIGH', true, [S.calWrite]),
  'gas.read': def('gas', true, 'LOW', false, [S.gasRead]),
  'gas.update': def('gas', false, 'HIGH', true, [S.gasWrite]),
  'gas.deploy': def('gas', false, 'HIGH', true, [S.gasWrite, S.gasDeploy]),
  'gas.execute': def('gas', false, 'HIGH', 'unless_allowlisted', [S.gasRun]),
  'gas.verify': def('gas', true, 'LOW', false, [S.gasRead, S.gasDeploy]),
  'appsheet.read': def('appsheet', true, 'LOW', false, []),
  'appsheet.write': def('appsheet', false, 'MEDIUM', true, []),
  'cnkk.read': def('cnkk', true, 'LOW', false, [S.sheetsRead]),
  'cnkk.update': def('cnkk', false, 'MEDIUM', true, [S.sheetsWrite])
});

const ID = /^[A-Za-z0-9_-]{10,200}$/;
const SIMPLE_ID = /^[A-Za-z0-9_.@-]{1,200}$/;
const SHEETS_RANGE = /^[^!\r\n]{1,100}!?[A-Za-z0-9:$]{0,40}$|^[A-Za-z0-9:$]{1,40}$/;
const EMAIL = /^[A-Za-z0-9._%+'-]{1,64}@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;
const MAX_CELLS = 5000;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_TEXT = 20000;

class GoogleCapabilityError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();
const need = (cond, message, code = 'INVALID_INPUT') => { if (!cond) throw new GoogleCapabilityError(message, code); };
const rid = (v, name) => { need(typeof v === 'string' && ID.test(v), `${name}が不正です`); return v; };
const sid = (v, name) => { need(typeof v === 'string' && SIMPLE_ID.test(v), `${name}が不正です`); return v; };
const text = (v, name, max = MAX_TEXT) => { need(typeof v === 'string' && v.length > 0 && v.length <= max, `${name}は1〜${max}文字の文字列である必要があります`); return v; };
const noCrlf = (v, name) => { text(v, name, 998); need(!/[\r\n]/.test(v), `${name}に改行は使えません`); return v; };

function appSheetCapabilities() { try { return require('./appsheetCnkk').APPSHEET_CAPABILITIES; } catch (_) { return {}; } }

function describeCapabilities(providerRegistry) {
  return {
    implementationOwner: IMPLEMENTATION_OWNER,
    ownerStatus: providerRegistry?.providers?.[IMPLEMENTATION_OWNER]?.status || 'UNKNOWN',
    executionPath: 'google_rest_api_with_existing_workspace_oauth',
    appSheetApiRequired: false,
    capabilities: Object.entries({ ...CAPABILITIES, ...appSheetCapabilities() }).map(([capability, c]) => ({ capability, ...c }))
  };
}

/** Union of scopes for a one-time consent (human does this once). */
function consentScopes(capabilities = Object.keys(CAPABILITIES)) {
  return [...new Set(capabilities.flatMap((c) => CAPABILITIES[c]?.scopes || []))].sort();
}

// ---- REST client: refresh-token reuse, per-capability narrowed access tokens ----

function createGoogleClient({ oauth, fetchImpl = fetch } = {}) {
  const cache = new Map();
  async function accessToken(scopes) {
    const key = [...scopes].sort().join(' ');
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now() + 60000) return hit.token;
    if (!oauth?.clientId || !oauth?.clientSecret || !oauth?.refreshToken) throw new GoogleCapabilityError('Google OAuth設定が未構成です', 'NOT_CONFIGURED');
    const form = { grant_type: 'refresh_token', client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken };
    if (key) form.scope = key;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    if (!res.ok) throw new GoogleCapabilityError(`このGoogle OAuthにはscope同意が不足しています、またはトークン取得に失敗しました (HTTP ${res.status})`, 'CONSENT_REQUIRED', { missingScopes: scopes });
    const body = await res.json();
    cache.set(key, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3000) * 1000 });
    return body.access_token;
  }
  function forScopes(scopes = []) {
    async function api(method, url, body, extraHeaders = {}) {
      const res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${await accessToken(scopes)}`, 'content-type': 'application/json', ...extraHeaders },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const raw = await res.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (_) { /* non-JSON */ }
      if (!res.ok) throw new GoogleCapabilityError(`Google API エラー (HTTP ${res.status}): ${json?.error?.message || 'unknown'}`, res.status === 401 || res.status === 403 ? 'AUTH_OR_SCOPE' : 'UPSTREAM_ERROR', { httpStatus: res.status });
      return json;
    }
    const e = encodeURIComponent;
    const gm = 'https://gmail.googleapis.com/gmail/v1/users/me';
    const cal = (id) => `https://www.googleapis.com/calendar/v3/calendars/${e(id)}/events`;
    return {
      sheetsGet: (s, range) => api('GET', `https://sheets.googleapis.com/v4/spreadsheets/${e(s)}/values/${e(range)}`),
      sheetsUpdate: (s, range, values) => api('PUT', `https://sheets.googleapis.com/v4/spreadsheets/${e(s)}/values/${e(range)}?valueInputOption=USER_ENTERED`, { range, majorDimension: 'ROWS', values }),
      driveMeta: (f) => api('GET', `https://www.googleapis.com/drive/v3/files/${e(f)}?fields=id,name,mimeType,modifiedTime,version,size&supportsAllDrives=true`),
      driveList: (q, n) => api('GET', `https://www.googleapis.com/drive/v3/files?q=${e(q)}&pageSize=${n}&fields=files(id,name,mimeType,modifiedTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`),
      gasGetContent: (s) => api('GET', `https://script.googleapis.com/v1/projects/${e(s)}/content`),
      gasUpdateContent: (s, files) => api('PUT', `https://script.googleapis.com/v1/projects/${e(s)}/content`, { files }),
      gasCreateVersion: (s, d) => api('POST', `https://script.googleapis.com/v1/projects/${e(s)}/versions`, { description: d }),
      gasDeploy: (s, v, d) => api('POST', `https://script.googleapis.com/v1/projects/${e(s)}/deployments`, { versionNumber: v, description: d }),
      gasListDeployments: (s) => api('GET', `https://script.googleapis.com/v1/projects/${e(s)}/deployments`),
      gasRun: (s, fn, parameters, devMode) => api('POST', `https://script.googleapis.com/v1/scripts/${e(s)}:run`, { function: fn, parameters: parameters || [], devMode: devMode === true }),
      gmailSearch: (q, n) => api('GET', `${gm}/messages?q=${e(q)}&maxResults=${n}`),
      gmailGet: (id, format) => api('GET', `${gm}/messages/${e(id)}?format=${format}${format === 'metadata' ? '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date' : ''}`),
      gmailDraftCreate: (raw) => api('POST', `${gm}/drafts`, { message: { raw } }),
      gmailDraftGet: (id) => api('GET', `${gm}/drafts/${e(id)}?format=full`),
      gmailDraftDelete: (id) => api('DELETE', `${gm}/drafts/${e(id)}`),
      gmailDraftSend: (id) => api('POST', `${gm}/drafts/send`, { id }),
      chatList: (space, n) => api('GET', `https://chat.googleapis.com/v1/${space}/messages?pageSize=${n}&orderBy=${e('createTime desc')}`),
      chatGet: (name) => api('GET', `https://chat.googleapis.com/v1/${name}`),
      chatCreate: (space, textBody, requestId) => api('POST', `https://chat.googleapis.com/v1/${space}/messages?requestId=${e(requestId)}`, { text: textBody }),
      docsGet: (d) => api('GET', `https://docs.googleapis.com/v1/documents/${e(d)}`),
      docsBatchUpdate: (d, requests, revisionId) => api('POST', `https://docs.googleapis.com/v1/documents/${e(d)}:batchUpdate`, { requests, writeControl: { requiredRevisionId: revisionId } }),
      calList: (id, q) => api('GET', `${cal(id)}?${new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', ...q })}`),
      calGet: (id, ev) => api('GET', `${cal(id)}/${e(ev)}`),
      calInsert: (id, body) => api('POST', `${cal(id)}?sendUpdates=none`, body),
      calPatch: (id, ev, body) => api('PATCH', `${cal(id)}/${e(ev)}?sendUpdates=none`, body),
      geminiGenerate: (model, prompt) => api('POST', `https://generativelanguage.googleapis.com/v1beta/models/${e(model)}:generateContent`, { contents: [{ parts: [{ text: prompt }] }] }),
      appsheet: (appId, table, accessKey, body) => api('POST', `https://api.appsheet.com/api/v2/apps/${e(appId)}/tables/${e(table)}/Action`, body, { ApplicationAccessKey: accessKey }),
      probe: async () => { await accessToken(scopes); return true; }
    };
  }
  return { forScopes };
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

function recipients(list, name, config, p, { required = true } = {}) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  need(!required || arr.length > 0, `${name}は1件以上必要です`);
  need(arr.length <= 20, `${name}は20件までです`);
  const domain = String(config.workspaceDomain || '').toLowerCase();
  need(domain, 'GOOGLE_WORKSPACE_DOMAIN未設定のため、宛先ドメインの判定ができません（fail-closed）', 'NOT_CONFIGURED');
  return arr.map((a) => {
    need(typeof a === 'string' && !/[\r\n,;<>]/.test(a) && EMAIL.test(a), `${name}のメールアドレスが不正です`);
    const external = EMAIL.exec(a)[1].toLowerCase() !== domain;
    need(!external || p.allowExternal === true, `${name}に同一Workspaceドメイン外の宛先があります（allowExternal:trueが必要）`, 'EXTERNAL_RECIPIENT_BLOCKED');
    return a;
  });
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
function buildRaw({ to, cc, subject, body }) {
  const lines = [`To: ${to.join(', ')}`];
  if (cc.length) lines.push(`Cc: ${cc.join(', ')}`);
  lines.push(`Subject: =?UTF-8?B?${b64(subject)}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', b64(body));
  return b64url(lines.join('\r\n'));
}
const header = (msg, name) => (msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
function decodeSubject(v) {
  const m = /^=\?UTF-8\?B\?(.+)\?=$/i.exec(v);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : v;
}
function plainBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return Buffer.from(payload.body.data, 'base64url').toString('utf8');
  for (const part of payload.parts || []) { const t = plainBody(part); if (t) return t; }
  return '';
}
const docText = (doc) => (doc?.body?.content || []).flatMap((el) => (el.paragraph?.elements || []).map((x) => x.textRun?.content || '')).join('');
const normalizeEol = (s) => String(s).replace(/\r\n/g, '\n');

/** What the human sees when approving. No secrets, bodies are shown as size+hash (+ short preview for mail/chat). */
function summarize(capability, p) {
  const prev = (s) => String(s ?? '').slice(0, 120);
  switch (capability) {
    case 'gmail.send': return { to: p.to, cc: p.cc || [], subject: p.subject, bodyChars: String(p.body || '').length, bodyPreview: prev(p.body), bodySha256: sha256(String(p.body || '')), allowExternal: p.allowExternal === true };
    case 'chat.send': return { space: p.space, textChars: String(p.text || '').length, textPreview: prev(p.text) };
    case 'docs.write': return { documentId: p.documentId, operation: p.operation, find: p.find, textChars: String(p.text || '').length, textPreview: prev(p.text) };
    case 'calendar.write': return { action: p.action, calendarId: p.calendarId || 'primary', eventId: p.eventId, event: p.event ? { summary: p.event.summary, start: p.event.start, end: p.event.end, attendees: (p.event.attendees || []).length } : undefined };
    case 'sheets.update': case 'cnkk.update': return { spreadsheetId: p.spreadsheetId, range: p.range, cells: Array.isArray(p.values) ? p.values.reduce((n, r) => n + (Array.isArray(r) ? r.length : 0), 0) : 0, valuesSha256: sha256(p.values ?? null) };
    case 'gas.update': return { scriptId: p.scriptId, files: Array.isArray(p.files) ? manifest(p.files) : undefined };
    case 'gas.deploy': return { scriptId: p.scriptId, description: p.description };
    case 'gas.execute': return { scriptId: p.scriptId, function: p.function, parameterCount: (p.parameters || []).length };
    case 'appsheet.write': return { table: p.table, action: p.action, rows: (p.rows || []).length, rowsSha256: sha256(p.rows ?? null) };
    default: return {};
  }
}
const proposalHash = (capability, params) => sha256({ capability, params: params ?? {} });

// ---- executor ----

async function executeGoogleCapability(deps, request) {
  const { client, config = {}, snapshots = new Map(), providerRegistry } = deps;
  const requested = request?.capability;
  const top = CAPABILITIES[requested];
  if (!top) return { success: false, verified: false, errorCode: 'UNKNOWN_CAPABILITY', errorSummary: `未対応のcapabilityです: ${String(requested)}` };

  const params = request.params && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {};
  const evidence = { capability: requested, owner: IMPLEMENTATION_OWNER, startedAt: now(), humanGate: { required: false, approved: false }, scopes: top.scopes, before: null, after: null, checks: [] };
  const finish = (result) => {
    const verifier = result.verified === true ? 'PASS' : (result.errorCode === 'VERIFICATION_FAILED' ? 'FAIL' : 'NOT_VERIFIED');
    return { capability: requested, owner: IMPLEMENTATION_OWNER, ...maskDeep(result), verifier: { status: verifier, checks: maskDeep(evidence.checks) }, evidence: maskDeep({ ...evidence, finishedAt: now() }) };
  };

  try {
    let op = requested; let p = params;
    if (requested.startsWith('cnkk.')) {
      const r = resolveCnkk(requested, params, config); op = r.capability; p = r.params;
    }
    const opDef = CAPABILITIES[op];
    evidence.scopes = opDef.scopes;

    // Human Gate: before any Google call (including snapshot).
    const gate = opDef.humanGate === true || top.humanGate === true
      || (opDef.humanGate === 'unless_allowlisted' && !(config.readonlyFunctions || []).includes(p.function));
    evidence.humanGate.required = gate;
    if (gate) {
      if (request.approvedByHuman !== true) {
        return finish({ success: false, verified: false, errorCode: 'HUMAN_APPROVAL_REQUIRED', errorSummary: `${requested}は人間承認待ちです（approvedByHuman=trueが必要。Google側は何も実行していません）`, approvalSummary: summarize(op, p), proposalHash: proposalHash(requested, params) });
      }
      evidence.humanGate.approved = true;
    }

    if (op === 'gemini.status') return finish({ success: true, verified: true, ...describeCapabilities(providerRegistry), note: 'GeminiはGoogle実装担当（Router上の担当表示）。CLI実行ではなくGoogle REST + 既存OAuthで実行します' });
    if (!client) return finish({ success: false, verified: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorSummary: 'Google OAuth/クライアントが未構成です' });
    const c = client.forScopes ? client.forScopes(opDef.scopes) : client;

    return await runOp(op, p, c, { evidence, snapshots, config, finish, client, requested, request });
  } catch (err) {
    const code = err instanceof GoogleCapabilityError ? err.code : 'GOOGLE_ERROR';
    const mapped = code === 'NOT_CONFIGURED' ? 'ADAPTER_NOT_CONFIGURED' : code;
    return finish({ success: false, verified: false, errorCode: mapped, errorSummary: err.message, ...(err.missingScopes ? { missingScopes: err.missingScopes } : {}) });
  }
}

function snapshotStore(ctx, data) {
  const snapshotId = crypto.randomUUID();
  ctx.snapshots.set(snapshotId, { capability: ctx.requested, takenAt: now(), ...data });
  return snapshotId;
}
const verifyFail = (ctx, summary, extra = {}) => ctx.finish({ success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: summary, ...extra });

async function runOp(op, p, c, ctx) {
  const { evidence, finish, config } = ctx;
  switch (op) {
    case 'google.status': {
      const groups = Object.entries(CAPABILITIES).filter(([, d]) => d.scopes.length);
      const out = [];
      for (const [name, d] of groups) {
        if (!ctx.client?.forScopes) { out.push({ capability: name, status: 'UNKNOWN' }); continue; }
        try { await ctx.client.forScopes(d.scopes).probe(); out.push({ capability: name, status: 'GRANTED' }); } catch (e) { out.push({ capability: name, status: e.code === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'CONSENT_REQUIRED' }); }
      }
      const missing = consentScopes(out.filter((o) => o.status !== 'GRANTED').map((o) => o.capability));
      evidence.after = { granted: out.filter((o) => o.status === 'GRANTED').length, total: out.length };
      return finish({ success: true, verified: true, capabilities: out, missingScopes: missing, ...(missing.length ? { humanAction: '不足scopeの同意（初回OAuth同意）を1回で行ってください: node scripts/google-consent-plan.js' } : {}) });
    }
    case 'gemini.generate': {
      need(config.gemini?.enabled === true && config.gemini?.model, 'Gemini生成は未有効です（GOOGLE_GEMINI_ENABLED=true と GOOGLE_GEMINI_MODEL。無料枠内であることを確認した場合のみ）', 'NOT_CONFIGURED');
      const prompt = text(p.prompt, 'prompt', 8000);
      const r = await c.geminiGenerate(config.gemini.model, prompt);
      const out = r?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
      evidence.after = { promptSha256: sha256(prompt), outputChars: out.length };
      return finish({ success: out.length > 0, verified: false, text: out.slice(0, MAX_TEXT), ...(out ? {} : { errorCode: 'EMPTY_RESPONSE', errorSummary: 'Geminiの応答が空です' }), note: '生成結果は事実検証されていません' });
    }

    // ---- Gmail ----
    case 'gmail.read': {
      if (p.messageId) {
        sid(p.messageId, 'messageId');
        const full = p.includeBody === true;
        const m = await c.gmailGet(p.messageId, full ? 'full' : 'metadata');
        const msg = { id: m.id, threadId: m.threadId, from: header(m, 'From'), to: header(m, 'To'), subject: decodeSubject(header(m, 'Subject')), date: header(m, 'Date'), snippet: m.snippet, ...(full ? { body: plainBody(m.payload).slice(0, MAX_TEXT) } : {}) };
        evidence.after = { messageId: m.id, sha256: sha256(msg) };
        return finish({ success: true, verified: true, message: msg });
      }
      text(p.query, 'query', 300);
      const r = await c.gmailSearch(p.query, Math.min(Number(p.maxResults) || 10, 20));
      evidence.after = { count: (r.messages || []).length };
      return finish({ success: true, verified: true, messages: r.messages || [] });
    }
    case 'gmail.draft': {
      const mail = mailParams(p, config);
      const created = await c.gmailDraftCreate(buildRaw(mail));
      const got = await c.gmailDraftGet(created.id);
      const ok = draftMatches(got.message, mail);
      evidence.after = { draftId: created.id, bodySha256: sha256(mail.body) };
      evidence.checks.push({ name: 'draft_readback_matches', passed: ok });
      return ok ? finish({ success: true, verified: true, draftId: created.id }) : verifyFail(ctx, '下書きの再取得が要求内容と一致しません', { draftId: created.id });
    }
    case 'gmail.send': {
      const mail = mailParams(p, config);
      evidence.before = { bodySha256: sha256(mail.body), to: mail.to, subject: mail.subject };
      const draft = await c.gmailDraftCreate(buildRaw(mail));
      const got = await c.gmailDraftGet(draft.id);
      const preOk = draftMatches(got.message, mail);
      evidence.checks.push({ name: 'predraft_matches_approved_content', passed: preOk });
      if (!preOk) { await c.gmailDraftDelete(draft.id).catch(() => {}); return verifyFail(ctx, '送信前の下書きが承認内容と一致しないため送信を中止しました（下書きは削除）'); }
      const sent = await c.gmailDraftSend(draft.id);
      const after = await c.gmailGet(sent.id, 'metadata');
      const inSent = (after.labelIds || []).includes('SENT');
      evidence.after = { messageId: sent.id, labelIds: after.labelIds, subject: decodeSubject(header(after, 'Subject')) };
      evidence.checks.push({ name: 'message_in_SENT', passed: inSent });
      return inSent ? finish({ success: true, verified: true, messageId: sent.id }) : verifyFail(ctx, '送信後の再取得でSENTを確認できません', { messageId: sent.id });
    }

    // ---- Chat ----
    case 'chat.read': {
      const space = chatSpace(p.space);
      const r = await c.chatList(space, Math.min(Number(p.pageSize) || 10, 25));
      const messages = (r.messages || []).map((m) => ({ name: m.name, sender: m.sender?.displayName, createTime: m.createTime, text: String(m.text || '').slice(0, 2000) }));
      evidence.after = { count: messages.length, sha256: sha256(messages) };
      return finish({ success: true, verified: true, messages });
    }
    case 'chat.send': {
      const space = chatSpace(p.space); const body = text(p.text, 'text', 4000);
      const last = await c.chatList(space, 1);
      evidence.before = { latestMessage: last.messages?.[0]?.name || null };
      const created = await c.chatCreate(space, body, `cnai-${crypto.createHash('sha256').update(`${space}${body}${ctx.request.proposalKey || ''}`).digest('hex').slice(0, 40)}`);
      const got = await c.chatGet(created.name);
      const ok = got?.text === body;
      evidence.after = { message: created.name, textSha256: sha256(got?.text || '') };
      evidence.checks.push({ name: 'posted_text_matches', passed: ok });
      return ok ? finish({ success: true, verified: true, message: created.name }) : verifyFail(ctx, '投稿後の再取得が要求内容と一致しません', { message: created.name });
    }

    // ---- Drive ----
    case 'drive.read': {
      if (p.fileId) { rid(p.fileId, 'fileId'); const meta = await c.driveMeta(p.fileId); evidence.after = { fileId: meta.id, modifiedTime: meta.modifiedTime, version: meta.version }; return finish({ success: true, verified: true, file: meta }); }
      text(p.query, 'fileIdまたはquery', 300);
      const list = await c.driveList(p.query, Math.min(Number(p.pageSize) || 20, 50));
      evidence.after = { count: (list.files || []).length };
      return finish({ success: true, verified: true, files: list.files || [] });
    }

    // ---- Sheets ----
    case 'sheets.read': {
      rid(p.spreadsheetId, 'spreadsheetId'); need(SHEETS_RANGE.test(p.range || ''), 'rangeが不正です');
      const data = await c.sheetsGet(p.spreadsheetId, p.range);
      evidence.after = { range: data.range, rows: (data.values || []).length, sha256: sha256(data.values || []) };
      return finish({ success: true, verified: true, values: data.values || [] });
    }
    case 'sheets.update': {
      rid(p.spreadsheetId, 'spreadsheetId'); need(SHEETS_RANGE.test(p.range || ''), 'rangeが不正です'); validateGrid(p.values);
      const before = await c.sheetsGet(p.spreadsheetId, p.range);
      const snapshotId = snapshotStore(ctx, { target: `${p.spreadsheetId}!${p.range}`, values: before.values || [] });
      evidence.before = { snapshotId, range: before.range, rows: (before.values || []).length, sha256: sha256(before.values || []) };
      await c.sheetsUpdate(p.spreadsheetId, p.range, p.values);
      const after = await c.sheetsGet(p.spreadsheetId, p.range);
      const match = gridEqual(after.values, p.values);
      evidence.after = { range: after.range, rows: (after.values || []).length, sha256: sha256(after.values || []) };
      evidence.checks.push({ name: 'readback_matches_request', passed: match });
      return match ? finish({ success: true, verified: true, snapshotId }) : verifyFail(ctx, '保存後の再取得が要求内容と一致しません（snapshotIdで復元可能）', { snapshotId });
    }

    // ---- Docs ----
    case 'docs.read': {
      rid(p.documentId, 'documentId');
      const d = await c.docsGet(p.documentId);
      const t = docText(d);
      evidence.after = { revisionId: d.revisionId, chars: t.length, sha256: sha256(t) };
      return finish({ success: true, verified: true, title: d.title, revisionId: d.revisionId, text: t.slice(0, MAX_TEXT), truncated: t.length > MAX_TEXT });
    }
    case 'docs.write': {
      rid(p.documentId, 'documentId'); need(['append', 'replace'].includes(p.operation), 'operationはappend|replaceです'); const body = text(p.text, 'text', 20000);
      if (p.operation === 'replace') { text(p.find, 'find', 1000); need(!(body.includes(p.find) && body !== p.find), '置換後テキストが検索語を含むと検証できません'); }
      const before = await c.docsGet(p.documentId);
      const beforeText = docText(before);
      const snapshotId = snapshotStore(ctx, { target: p.documentId, text: beforeText, revisionId: before.revisionId });
      evidence.before = { snapshotId, revisionId: before.revisionId, chars: beforeText.length, sha256: sha256(beforeText) };
      const endIndex = before.body.content[before.body.content.length - 1].endIndex;
      const requests = p.operation === 'append'
        ? [{ insertText: { location: { index: endIndex - 1 }, text: body } }]
        : [{ replaceAllText: { containsText: { text: p.find, matchCase: true }, replaceText: body } }];
      await c.docsBatchUpdate(p.documentId, requests, before.revisionId);
      const after = await c.docsGet(p.documentId);
      const afterText = docText(after);
      const ok = p.operation === 'append'
        ? normalizeEol(afterText).endsWith(`${normalizeEol(body)}\n`) || normalizeEol(afterText).includes(normalizeEol(body))
        : !afterText.includes(p.find) && afterText.includes(body);
      evidence.after = { revisionId: after.revisionId, chars: afterText.length, sha256: sha256(afterText) };
      evidence.checks.push({ name: 'readback_contains_change', passed: ok }, { name: 'revision_changed', passed: after.revisionId !== before.revisionId });
      return ok ? finish({ success: true, verified: true, snapshotId }) : verifyFail(ctx, '保存後の再取得が要求内容と一致しません（snapshotIdで復元可能）', { snapshotId });
    }

    // ---- Calendar ----
    case 'calendar.read': {
      const cid = sid(p.calendarId || 'primary', 'calendarId');
      if (p.eventId) { const ev = await c.calGet(cid, sid(p.eventId, 'eventId')); evidence.after = { eventId: ev.id, updated: ev.updated }; return finish({ success: true, verified: true, event: slimEvent(ev) }); }
      const q = { maxResults: String(Math.min(Number(p.maxResults) || 20, 50)) };
      if (p.timeMin) q.timeMin = String(p.timeMin); if (p.timeMax) q.timeMax = String(p.timeMax);
      const r = await c.calList(cid, q);
      const events = (r.items || []).map(slimEvent);
      evidence.after = { count: events.length, sha256: sha256(events) };
      return finish({ success: true, verified: true, events });
    }
    case 'calendar.write': {
      const cid = sid(p.calendarId || 'primary', 'calendarId');
      need(['create', 'update'].includes(p.action), 'actionはcreate|updateです（削除は提供しません）');
      need(p.event && typeof p.event === 'object', 'eventが必要です');
      const ev = calendarEvent(p.event, config, p, p.action === 'create');
      let eventId; let snapshotId = null;
      if (p.action === 'update') {
        eventId = sid(p.eventId, 'eventId');
        const before = await c.calGet(cid, eventId);
        snapshotId = snapshotStore(ctx, { target: `${cid}/${eventId}`, event: before });
        evidence.before = { snapshotId, updated: before.updated, sha256: sha256(slimEvent(before)) };
        await c.calPatch(cid, eventId, ev);
      } else {
        evidence.before = { note: 'new event' };
        eventId = (await c.calInsert(cid, ev)).id;
      }
      const after = await c.calGet(cid, eventId);
      const ok = Object.keys(ev).every((k) => k === 'attendees' ? sameAttendees(after.attendees, ev.attendees) : JSON.stringify(normalizeEventField(after[k])) === JSON.stringify(normalizeEventField(ev[k])));
      evidence.after = { eventId, updated: after.updated, sha256: sha256(slimEvent(after)) };
      evidence.checks.push({ name: 'readback_matches_request', passed: ok });
      return ok ? finish({ success: true, verified: true, eventId, ...(snapshotId ? { snapshotId } : {}) }) : verifyFail(ctx, '保存後の再取得が要求内容と一致しません', { eventId, ...(snapshotId ? { snapshotId } : {}) });
    }

    // ---- GAS ----
    case 'gas.read': {
      rid(p.scriptId, 'scriptId');
      const content = await c.gasGetContent(p.scriptId);
      evidence.after = { fileCount: (content.files || []).length, manifestHash: filesHash(content.files), files: manifest(content.files) };
      return finish({ success: true, verified: true, files: (content.files || []).map((f) => ({ name: f.name, type: f.type, ...(p.includeSource === true ? { source: f.source } : {}) })), manifestHash: evidence.after.manifestHash });
    }
    case 'gas.verify': {
      rid(p.scriptId, 'scriptId');
      const content = await c.gasGetContent(p.scriptId);
      const actual = manifest(content.files);
      evidence.after = { manifestHash: filesHash(content.files), files: actual };
      if (p.expectedManifestHash !== undefined) evidence.checks.push({ name: 'manifest_hash', passed: p.expectedManifestHash === evidence.after.manifestHash });
      if (Array.isArray(p.expectedFiles)) for (const e of p.expectedFiles) { const a = actual.find((f) => f.name === e.name); evidence.checks.push({ name: `file:${e.name}`, passed: Boolean(a) && (e.sha256 === undefined || e.sha256 === a.sha256) }); }
      if (p.checkDeployments === true) { const list = (await c.gasListDeployments(p.scriptId)).deployments || []; evidence.checks.push({ name: 'has_deployment', passed: list.length > 0 }); evidence.after.deploymentCount = list.length; }
      if (evidence.checks.length === 0) return finish({ success: true, verified: false, errorCode: 'NO_EXPECTATION', errorSummary: '比較対象(expectedManifestHash/expectedFiles/checkDeployments)が無いため検証できません（PASSにしません）' });
      return evidence.checks.every((x) => x.passed) ? finish({ success: true, verified: true }) : verifyFail(ctx, 'GAS実体が期待と一致しません');
    }
    case 'gas.update': {
      rid(p.scriptId, 'scriptId'); validateGasFiles(p.files);
      const before = await c.gasGetContent(p.scriptId);
      const snapshotId = snapshotStore(ctx, { target: p.scriptId, files: before.files || [] });
      evidence.before = { snapshotId, fileCount: (before.files || []).length, manifestHash: filesHash(before.files), files: manifest(before.files) };
      await c.gasUpdateContent(p.scriptId, p.files);
      const after = await c.gasGetContent(p.scriptId);
      evidence.after = { fileCount: (after.files || []).length, manifestHash: filesHash(after.files), files: manifest(after.files) };
      const match = evidence.after.manifestHash === filesHash(p.files);
      evidence.checks.push({ name: 'readback_matches_request', passed: match });
      return match ? finish({ success: true, verified: true, snapshotId, manifestHash: evidence.after.manifestHash }) : verifyFail(ctx, '保存後の再取得が要求内容と一致しません（snapshotIdで復元可能）', { snapshotId });
    }
    case 'gas.deploy': {
      rid(p.scriptId, 'scriptId');
      const desc = String(p.description || 'CNAI Router deploy').slice(0, 200);
      const beforeD = await c.gasListDeployments(p.scriptId);
      evidence.before = { deploymentCount: (beforeD.deployments || []).length, deploymentIds: (beforeD.deployments || []).map((d) => d.deploymentId) };
      const version = await c.gasCreateVersion(p.scriptId, desc);
      const dep = await c.gasDeploy(p.scriptId, version.versionNumber, desc);
      const afterD = await c.gasListDeployments(p.scriptId);
      const found = (afterD.deployments || []).some((d) => d.deploymentId === dep.deploymentId);
      evidence.after = { deploymentCount: (afterD.deployments || []).length, versionNumber: version.versionNumber, deploymentId: dep.deploymentId };
      evidence.checks.push({ name: 'deployment_listed_after', passed: found });
      return found ? finish({ success: true, verified: true, versionNumber: version.versionNumber, deploymentId: dep.deploymentId }) : verifyFail(ctx, 'deploy後の再取得でdeploymentを確認できません');
    }
    case 'gas.execute': {
      rid(p.scriptId, 'scriptId'); need(typeof p.function === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(p.function), 'functionが不正です');
      const run = await c.gasRun(p.scriptId, p.function, Array.isArray(p.parameters) ? p.parameters : [], p.devMode);
      const failed = Boolean(run?.error);
      evidence.after = { done: run?.done === true, hasError: failed, resultSha256: sha256(run?.response?.result ?? null) };
      return failed ? finish({ success: false, verified: false, errorCode: 'GAS_EXECUTION_ERROR', errorSummary: String(run.error.message || 'GAS実行エラー') })
        : finish({ success: true, verified: false, result: run?.response?.result ?? null, note: '副作用の検証は別途gas.verify/sheets.readで行ってください' });
    }

    // ---- AppSheet (optional; AppSheet API is not required for CNKK) ----
    case 'appsheet.read': case 'appsheet.write': {
      const a = config.appsheet || {};
      need(a.appId && a.accessKey, 'AppSheet APIは未設定です（任意機能。CNKKはGoogle Sheetsで動作します）', 'NOT_CONFIGURED');
      sid(a.appId, 'appId'); const table = sid(p.table, 'table');
      const call = (body) => c.appsheet(a.appId, table, a.accessKey, { Properties: { Locale: 'ja-JP' }, ...body });
      if (op === 'appsheet.read') {
        const rows = await call({ Action: 'Find', Rows: [] });
        const list = Array.isArray(rows) ? rows.slice(0, 200) : [];
        evidence.after = { rows: list.length, sha256: sha256(list) };
        return finish({ success: true, verified: true, rows: list });
      }
      need(['Add', 'Edit'].includes(p.action), 'actionはAdd|Editです（削除は提供しません）');
      const key = sid(p.keyColumn, 'keyColumn');
      need(Array.isArray(p.rows) && p.rows.length > 0 && p.rows.length <= 50 && p.rows.every((r) => r && typeof r === 'object' && SIMPLE_ID.test(String(r[key] ?? ''))), `rowsは1〜50件で、各行に${key}が必要です`);
      const keys = p.rows.map((r) => String(r[key]));
      const sel = `Filter(${table}, OR(${keys.map((k) => `[${key}]="${k}"`).join(', ')}))`;
      const before = await call({ Action: 'Find', Properties: { Locale: 'ja-JP', Selector: sel }, Rows: [] });
      const snapshotId = snapshotStore(ctx, { target: `${table}`, rows: Array.isArray(before) ? before : [] });
      evidence.before = { snapshotId, rows: Array.isArray(before) ? before.length : 0, sha256: sha256(before ?? []) };
      await call({ Action: p.action, Rows: p.rows });
      const after = await call({ Action: 'Find', Properties: { Locale: 'ja-JP', Selector: sel }, Rows: [] });
      const ok = p.rows.every((r) => { const row = (after || []).find((x) => String(x[key]) === String(r[key])); return row && Object.entries(r).every(([k, v]) => String(row[k]) === String(v)); });
      evidence.after = { rows: Array.isArray(after) ? after.length : 0, sha256: sha256(after ?? []) };
      evidence.checks.push({ name: 'readback_matches_request', passed: ok });
      return ok ? finish({ success: true, verified: true, snapshotId }) : verifyFail(ctx, '再取得が要求内容と一致しません（snapshotIdで復元可能）', { snapshotId });
    }
    default:
      return finish({ success: false, verified: false, errorCode: 'UNKNOWN_CAPABILITY', errorSummary: op });
  }
}

function mailParams(p, config) {
  const to = recipients(p.to, 'to', config, p); const cc = recipients(p.cc, 'cc', config, p, { required: false });
  return { to, cc, subject: noCrlf(p.subject, 'subject'), body: text(p.body, 'body') };
}
function draftMatches(message, mail) {
  const to = header(message, 'To').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).sort();
  return decodeSubject(header(message, 'Subject')) === mail.subject
    && JSON.stringify(to) === JSON.stringify(mail.to.map((s) => s.toLowerCase()).sort())
    && normalizeEol(plainBody(message.payload)).trimEnd() === normalizeEol(mail.body).trimEnd();
}
function chatSpace(v) { need(typeof v === 'string' && /^spaces\/[A-Za-z0-9_-]{1,100}$/.test(v), 'spaceは spaces/XXXX の形式です'); return v; }

const slimEvent = (e) => ({ id: e.id, summary: e.summary, start: e.start, end: e.end, location: e.location, attendees: (e.attendees || []).map((a) => a.email), status: e.status, updated: e.updated });
const normalizeEventField = (v) => (v && typeof v === 'object' ? { dateTime: v.dateTime ? new Date(v.dateTime).toISOString() : undefined, date: v.date } : v);
const sameAttendees = (actual, wanted) => JSON.stringify((actual || []).map((a) => a.email.toLowerCase()).sort()) === JSON.stringify((wanted || []).map((a) => a.email.toLowerCase()).sort());
function calendarEvent(e, config, p, creating) {
  const out = {};
  if (e.summary !== undefined) out.summary = noCrlf(e.summary, 'summary');
  if (e.description !== undefined) out.description = text(e.description, 'description', 8000);
  if (e.location !== undefined) out.location = noCrlf(e.location, 'location');
  for (const k of ['start', 'end']) if (e[k] !== undefined) { need(e[k] && (e[k].dateTime || e[k].date), `${k}はdateTimeまたはdateが必要です`); out[k] = e[k].dateTime ? { dateTime: e[k].dateTime, ...(e[k].timeZone ? { timeZone: e[k].timeZone } : {}) } : { date: e[k].date }; }
  if (e.attendees !== undefined) out.attendees = recipients(e.attendees, 'attendees', config, p, { required: false }).map((email) => ({ email }));
  need(!creating || (out.summary && out.start && out.end), '新規作成にはsummary/start/endが必要です');
  need(Object.keys(out).length > 0, '更新内容がありません');
  return out;
}

/** CNKK = Google Sheets (default, + GAS when needed) or AppSheet when configured (optional). Ids come from config, never guessed. */
function resolveCnkk(capability, params, config) {
  const read = capability === 'cnkk.read';
  if (config.cnkk?.backend === 'appsheet') return { capability: read ? 'appsheet.read' : 'appsheet.write', params: { table: config.cnkk.appsheetTable, ...params } };
  const spreadsheetId = params.spreadsheetId || config.cnkk?.spreadsheetId;
  if (!spreadsheetId) throw new GoogleCapabilityError('CNKKのspreadsheetIdが未設定です（GOOGLE_CNKK_SPREADSHEET_ID）', 'NOT_CONFIGURED');
  return { capability: read ? 'sheets.read' : 'sheets.update', params: { ...params, spreadsheetId } };
}

/**
 * Approval binding. When a request is BLOCKED for approval its payload is remembered (by requestId); a later approved resume executes
 * exactly that payload. A different payload / proposal hash is refused. `execute({capability, params, approvedByHuman, proposalKey,
 * proposalOnly})` must return errorCode HUMAN_APPROVAL_REQUIRED + proposalHash when it needs approval.
 */
function bindApproval(execute) {
  const pending = new Map();
  return async (record, input) => {
    const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
    let capability = payload.capability || record.requestType;
    let params = payload.params;
    const stored = pending.get(record.requestId);
    if (input.approvedByHuman === true && stored) {
      const supplied = payload.capability || payload.params ? proposalHash(capability, params) : stored.hash;
      if (supplied !== stored.hash || (input.approvedProposalHash && input.approvedProposalHash !== stored.hash)) {
        return { success: false, verified: false, errorCode: 'APPROVAL_PAYLOAD_MISMATCH', errorSummary: '承認された提案内容と異なるため実行しません（承認対象はproposalHashで固定されています）', proposalHash: stored.hash };
      }
      ({ capability, params } = stored);
    }
    const result = await execute({ capability, params, approvedByHuman: input.approvedByHuman === true, proposalKey: record.requestId, proposalOnly: input.proposalOnly === true });
    if (result.errorCode === 'HUMAN_APPROVAL_REQUIRED') pending.set(record.requestId, { capability, params, hash: result.proposalHash });
    else if (result.success && stored) pending.delete(record.requestId);
    return result;
  };
}

/** Router adapter. `deps.extensions`: [{ handles(capability), execute(request) }] (e.g. AppSheet Editor pipeline) take precedence. */
function createGoogleWorkspaceAdapter(deps) {
  const snapshots = deps.snapshots || new Map();
  return bindApproval((req) => {
    const ext = (deps.extensions || []).find((e) => e.handles(req.capability));
    return ext ? ext.execute(req) : executeGoogleCapability({ ...deps, snapshots }, req);
  });
}

module.exports = { IMPLEMENTATION_OWNER, CAPABILITIES, GoogleCapabilityError, describeCapabilities, consentScopes, createGoogleClient, executeGoogleCapability, createGoogleWorkspaceAdapter, bindApproval, proposalHash, sha256 };
