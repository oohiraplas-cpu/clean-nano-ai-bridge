'use strict';
// Unified Power Platform tools: sharepoint_manage / powerapps_manage / powerautomate_manage / powerplatform_validate.
// Reuses powerAppsSolutionWriter (solution round-trip) and powerAutomateFlowWriter (Dataverse workflows).
// Every call: auto-repair (classify -> minimal fix -> retry once) -> re-read -> verify -> audit line.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const paw = require('./powerAppsSolutionWriter');
const pfw = require('./powerAutomateFlowWriter');
const { readZip } = require('./zipLite');

const GRAPH = 'https://graph.microsoft.com/v1.0';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const norm = (n) => String(n).replace(/\\/g, '/');

class OpError extends Error {
  constructor(message, kind, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

function classify(err) {
  const m = String(err && err.message || err);
  const st = Number((m.match(/\b(4\d\d|5\d\d)\b/) || [])[1]) || err.status || 0;
  if (err && err.kind) return err.kind;
  if (st === 429 || st >= 500 || /ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(m)) return 'transient';
  if (st === 401 || st === 403 || /Authorization|Forbidden|accessDenied/i.test(m)) return 'permission';
  if (st === 404 || /not found|itemNotFound/i.test(m)) return 'not_found';
  if (st === 409 || /conflict|already exists|nameAlreadyExists/i.test(m)) return 'conflict';
  if (st === 400 || /invalid|required|must/i.test(m)) return 'invalid_input';
  return 'unknown';
}

const FALLBACK = ['microsoft_api', 'cli_or_powershell', 'solution_operation', 'computer_use'];


// ---------- premium guard (fail-closed: unknown connectors are treated as premium) ----------
const STANDARD_CONNECTORS = new Set(['shared_sharepointonline', 'shared_office365', 'shared_office365users', 'shared_office365groups', 'shared_teams', 'shared_onedriveforbusiness', 'shared_onedrive', 'shared_excelonlinebusiness', 'shared_msnweather', 'shared_planner', 'shared_todo', 'shared_outlook', 'shared_flowpush', 'shared_microsoftforms', 'shared_onenote', 'shared_rss', 'shared_approvals', 'shared_wordonlinebusiness', 'shared_sendmail', 'shared_powerappsnotification', 'shared_bingmaps', 'shared_translatorv2', 'shared_yammer', 'shared_microsoftbookings', 'shared_shifts']);
const PREMIUM_ACTION_TYPES = new Set(['http', 'httpwebhook', 'response']);
function premiumScan(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj || {});
  const found = new Map();
  const re = /\/apis\/([A-Za-z0-9_\-.]+)/g; let m;
  while ((m = re.exec(text))) { const raw = m[1].toLowerCase(); const n = raw.startsWith('shared_') ? raw : `shared_${raw}`; if (!STANDARD_CONNECTORS.has(n)) found.set(n, 'connector'); }
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.type === 'string') {
      const t = o.type.toLowerCase();
      if (PREMIUM_ACTION_TYPES.has(t)) found.set(`action:${o.type}`, 'builtin');
      if (t === 'request' && o.kind && String(o.kind).toLowerCase() === 'http') found.set('trigger:Request(Http)', 'builtin');
    }
    for (const v of Object.values(o)) walk(v);
  };
  try { walk(typeof obj === 'string' ? JSON.parse(obj) : obj); } catch (_) { /* text-only scan */ }
  return [...found.entries()].map(([name, kind]) => ({ name, kind }));
}
function assertNoPremium(obj, where) {
  const hits = premiumScan(obj);
  if (hits.length) throw new OpError(`プレミアム該当(またはStandard未確認)のため停止しました: ${hits.map((h) => h.name).join(', ')} [${where}]。利用者課金を防ぐため実行していません。`, 'blocked_premium', { premium: hits });
}

// ---------- chat-friendly input normalisation ----------
const OP_ALIASES = {
  sharepoint_manage: { item_get: 'search', items: 'search', item_list: 'search', list_items: 'search', items_get: 'search', count: 'search', query: 'search', find: 'search', list_get: 'get', columns: 'get', column_get: 'get', lists: 'get', item_add: 'item_create', add: 'item_create', create_item: 'item_create', item_edit: 'item_update', update: 'item_update', edit: 'item_update', update_item: 'item_update', create_list: 'list_create', add_column: 'column_create', column_add: 'column_create', column_edit: 'column_update', choices_update: 'choice_update', bulk_add: 'bulk_create', bulk_edit: 'bulk_update', index: 'index_create', validate: 'schema_validate', remove: 'delete' },
  powerapps_manage: { get: 'app_get', info: 'app_get', app: 'app_get', state: 'state_get', status: 'state_get', source: 'source_get', screens: 'screen_get', screen_list: 'screen_get', controls: 'control_get', powerfx: 'powerfx_get', fx_get: 'powerfx_get', fx_edit: 'powerfx_edit', image_set: 'image_assign', assign_image: 'image_assign', add_image: 'image_add', replace_image: 'image_replace', check: 'app_checker', appchecker: 'app_checker', checker: 'app_checker', verify: 'publish_verify', rollback: 'restore', re_read: 'reread' },
  powerautomate_manage: { flows: 'list', flow_list: 'list', flow_get: 'get', history: 'runs', run_history: 'runs', runs_get: 'runs', run: 'test', execute: 'test', errors: 'failures', failed: 'failures', repair: 'auto_repair', fix: 'auto_repair', connections: 'connection_check', on: 'enable', off: 'disable', rollback: 'restore', remove: 'delete' },
  powerplatform_validate: { env: 'environment', changes: 'unexpected_changes', fx: 'powerfx', columns: 'sp_column_types', image: 'image_assignment', recover: 'recoverability', premium: 'premium_check', license: 'premium_check' },
};
const JSON_KEYS = ['fields', 'items', 'rules', 'edits', 'images', 'definition', 'set', 'columns', 'column', 'patch', 'connectionReferences', 'expected', 'expect', 'choices', 'scripts', 'allowed', 'value'];
function normalizeParams(tool, params) {
  const p = { ...(params || {}) };
  for (const k of JSON_KEYS) {
    if (typeof p[k] === 'string' && /^\s*[[{]/.test(p[k])) { try { p[k] = JSON.parse(p[k]); } catch (_) { /* keep as-is */ } }
  }
  if (p.operation) {
    const o = String(p.operation).trim().toLowerCase().replace(/[\s-]+/g, '_');
    p.operation = (OP_ALIASES[tool] && OP_ALIASES[tool][o]) || o;
  }
  if (!p.list && (p.listName || p.listId)) p.list = p.listName || p.listId;
  if (p.appFile && GUID.test(String(p.appFile))) delete p.appFile;
  if (!p.appFile && p.appName) p.appFile = p.appName;
  if (!p.flowId && p.id && tool === 'powerautomate_manage') p.flowId = p.id;
  return p;
}

// ---------- audit ----------
function auditFile(env) { return path.join(paw.settings(env).snapshotDir, 'audit.jsonl'); }
function audit(env, rec) {
  try {
    const f = auditFile(env);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), ...rec }) + '\n');
  } catch (_) { /* audit must never break the operation */ }
}
function auditTail(env, n = 30) {
  const f = auditFile(env);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').trim().split('\n').slice(-n).map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });
}

// ---------- Graph (SharePoint) ----------
function spSettings(env = process.env) {
  return {
    tenantId: env.SHAREPOINT_TENANT_ID || env.AZURE_TENANT_ID,
    clientId: env.SHAREPOINT_CLIENT_ID || env.AZURE_CLIENT_ID,
    clientSecret: env.SHAREPOINT_CLIENT_SECRET || env.AZURE_CLIENT_SECRET,
    siteId: env.SHAREPOINT_SITE_ID || '',
  };
}
function createGraph(cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) throw new OpError('Graph settings missing (tenant / client id / secret)', 'config');
  let cached = null;
  async function token() {
    if (cached && cached.exp > Date.now() + 60000) return cached.value;
    const r = await fetchImpl(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: 'https://graph.microsoft.com/.default' }),
    });
    const j = await r.json();
    if (!j.access_token) throw new OpError(`Graph token failed: ${j.error || r.status}`, 'permission');
    cached = { value: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
    return cached.value;
  }
  async function call(method, p, body, extraHeaders = {}) {
    const r = await fetchImpl(p.startsWith('http') ? p : `${GRAPH}${p}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Accept: 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) { const e = new Error(`Graph ${method} ${p.split('?')[0]} ${r.status}: ${text.slice(0, 400)}`); e.status = r.status; throw e; }
    return text ? JSON.parse(text) : {};
  }
  return { get: (p, h) => call('GET', p, null, h), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), del: (p) => call('DELETE', p) };
}

async function withRepair(label, fn, repairs = {}) {
  const attempts = [];
  try { const out = await fn(); return { out, attempts }; } catch (e1) {
    const kind = classify(e1);
    attempts.push({ attempt: 1, kind, error: e1.message.slice(0, 300) });
    const fix = repairs[kind] || (kind === 'transient' ? async () => new Promise((r) => setTimeout(r, repairs.delayMs ?? 1500)) : null);
    if (!fix) { e1.attempts = attempts; e1.kind = kind; throw e1; }
    try {
      const note = await fix(e1);
      const out = await fn(note);
      attempts.push({ attempt: 2, repaired: kind, ok: true });
      return { out, attempts };
    } catch (e2) {
      const k2 = classify(e2);
      attempts.push({ attempt: 2, kind: k2, error: e2.message.slice(0, 300) });
      if (k2 === kind) attempts.push({ stop: 'same failure repeated; not retrying again' });
      e2.attempts = attempts; e2.kind = k2; throw e2;
    }
  }
}

const enc = encodeURIComponent;
function requireConfirm(p, target) {
  const want = `DELETE ${target}`;
  if (p.confirm !== want) throw new OpError(`physical delete needs explicit permission: pass confirm="${want}"`, 'approval_required', { approval: want });
}

async function spResolveSite(g, p, env) {
  if (p.siteId) return p.siteId;
  if (p.siteUrl) {
    const u = new URL(p.siteUrl);
    const s = await g.get(`/sites/${u.hostname}:${u.pathname.replace(/\/$/, '') || '/'}`);
    return s.id;
  }
  if (p.site) {
    if (/^https?:\/\//i.test(p.site)) return spResolveSite(g, { siteUrl: p.site }, env);
    const r = await g.get(`/sites?search=${encodeURIComponent(p.site)}&$select=id,name,displayName,webUrl`);
    const want = String(p.site).toLowerCase();
    const hit = (r.value || []).find((x) => [x.name, x.displayName, (x.webUrl || '').split('/').pop()].some((v) => String(v || '').toLowerCase() === want));
    if (!hit) throw new OpError(`site "${p.site}" not found (candidates: ${(r.value || []).slice(0, 5).map((x) => x.webUrl).join(', ')})`, 'not_found');
    return hit.id;
  }
  const d = spSettings(env).siteId;
  if (!d) throw new OpError('siteId or siteUrl required (SHAREPOINT_SITE_ID not set)', 'invalid_input');
  return d;
}

async function spListId(g, site, list) {
  if (!list) throw new OpError('list (id or display name) required', 'invalid_input');
  if (GUID.test(list)) return list;
  const r = await g.get(`/sites/${site}/lists?$select=id,displayName,name&$top=999`);
  const hit = (r.value || []).find((l) => l.displayName === list || l.name === list) || (r.value || []).find((l) => (l.displayName || '').toLowerCase() === String(list).toLowerCase());
  if (!hit) throw new OpError(`list "${list}" not found`, 'not_found');
  return hit.id;
}

async function spColumns(g, site, listId) {
  const r = await g.get(`/sites/${site}/lists/${listId}/columns?$top=999`);
  return r.value || [];
}
function findColumn(cols, ref) {
  return cols.find((c) => c.id === ref || c.name === ref) || cols.find((c) => c.displayName === ref) || cols.find((c) => (c.displayName || '').toLowerCase() === String(ref).toLowerCase());
}
function columnType(c) {
  for (const k of ['text', 'number', 'choice', 'dateTime', 'boolean', 'lookup', 'personOrGroup', 'currency', 'hyperlinkOrPicture', 'calculated', 'note']) if (c[k]) return k;
  return 'unknown';
}

// map display names in fields -> internal names (auto-repair for invalid field names)
async function mapFields(g, site, listId, fields) {
  const cols = await spColumns(g, site, listId);
  const out = {}; const mapped = [];
  for (const [k, v] of Object.entries(fields || {})) {
    const c = findColumn(cols, k);
    if (c && c.name !== k) mapped.push({ from: k, to: c.name });
    out[c ? c.name : k] = v;
  }
  return { fields: out, mapped };
}
function fieldsMatch(expected, actual) {
  const diffs = [];
  for (const [k, v] of Object.entries(expected || {})) {
    const a = actual ? actual[k] : undefined;
    const same = JSON.stringify(a) === JSON.stringify(v) || String(a) === String(v);
    if (!same) diffs.push({ field: k, expected: v, actual: a });
  }
  return diffs;
}

async function sharepointManage(p, deps = {}) {
  const env = deps.env || process.env;
  const g = deps.graph || createGraph(spSettings(env), deps.fetch);
  const site = await spResolveSite(g, p, env);
  const op = p.operation;
  const L = async () => spListId(g, site, p.list);
  switch (op) {
    case 'list_create': {
      const body = { displayName: p.displayName, list: { template: p.template || 'genericList' }, columns: p.columns || [] };
      if (!p.displayName) throw new OpError('displayName required', 'invalid_input');
      const { out, attempts } = await withRepair(op, () => g.post(`/sites/${site}/lists`, body), {
        conflict: async () => null,
      }).catch(async (e) => {
        if (e.kind === 'conflict') { const id = await spListId(g, site, p.displayName); return { out: { id, existed: true }, attempts: e.attempts }; }
        throw e;
      });
      const re = await g.get(`/sites/${site}/lists/${out.id}?$expand=columns`);
      const missing = (p.columns || []).filter((c) => !(re.columns || []).some((x) => x.name === c.name));
      return { verified: missing.length === 0, data: { listId: re.id, displayName: re.displayName, webUrl: re.webUrl, existed: !!out.existed, columns: (re.columns || []).filter((c) => !c.readOnly).map((c) => ({ name: c.name, displayName: c.displayName, type: columnType(c) })), missing }, attempts };
    }
    case 'column_create': {
      const listId = await L();
      if (!p.column || !p.column.name) throw new OpError('column {name, ...type} required', 'invalid_input');
      const { out, attempts } = await withRepair(op, () => g.post(`/sites/${site}/lists/${listId}/columns`, p.column));
      const re = findColumn(await spColumns(g, site, listId), out.name || p.column.name);
      return { verified: !!re, data: { listId, column: re && { id: re.id, name: re.name, displayName: re.displayName, type: columnType(re), required: re.required, indexed: re.indexed } }, attempts };
    }
    case 'column_update':
    case 'choice_update':
    case 'index_create': {
      const listId = await L();
      const cols = await spColumns(g, site, listId);
      const c = findColumn(cols, p.column);
      if (!c) throw new OpError(`column "${p.column}" not found`, 'not_found');
      let patch = p.patch || {};
      if (op === 'index_create') patch = { indexed: true };
      if (op === 'choice_update') {
        if (!c.choice) throw new OpError(`column "${c.name}" is not a Choice column`, 'invalid_input');
        const cur = c.choice.choices || [];
        const next = p.mode === 'replace' ? p.choices : [...cur, ...(p.choices || []).filter((x) => !cur.includes(x))];
        patch = { choice: { ...c.choice, choices: next } };
      }
      const { attempts } = await withRepair(op, () => g.patch(`/sites/${site}/lists/${listId}/columns/${c.id}`, patch));
      const re = findColumn(await spColumns(g, site, listId), c.id);
      const diffs = fieldsMatch(patch, re);
      return { verified: diffs.length === 0, data: { listId, column: { id: re.id, name: re.name, type: columnType(re), indexed: re.indexed, choices: re.choice && re.choice.choices }, diffs }, attempts };
    }
    case 'item_create':
    case 'item_update': {
      const listId = await L();
      let mapped = [];
      const run = async (fixed) => {
        const fields = fixed || p.fields;
        if (op === 'item_create') return g.post(`/sites/${site}/lists/${listId}/items`, { fields });
        await g.patch(`/sites/${site}/lists/${listId}/items/${enc(p.itemId)}/fields`, fields);
        return { id: p.itemId };
      };
      const { out, attempts } = await withRepair(op, run, {
        invalid_input: async () => { const m = await mapFields(g, site, listId, p.fields); mapped = m.mapped; if (!mapped.length) throw new OpError('no field-name repair possible', 'invalid_input'); return m.fields; },
      });
      const { fields: expected } = await mapFields(g, site, listId, p.fields);
      const re = await g.get(`/sites/${site}/lists/${listId}/items/${out.id}?$expand=fields`);
      const diffs = fieldsMatch(expected, re.fields);
      return { verified: diffs.length === 0, data: { listId, itemId: re.id, fields: re.fields, diffs, mappedFields: mapped }, attempts };
    }
    case 'bulk_create':
    case 'bulk_update': {
      const listId = await L();
      const items = p.items || [];
      if (!items.length || items.length > 200) throw new OpError('items: 1..200 required', 'invalid_input');
      const results = [];
      for (const it of items) {
        try {
          const r = await sharepointManage({ ...p, list: listId, siteId: site, operation: op === 'bulk_create' ? 'item_create' : 'item_update', fields: it.fields || it, itemId: it.id || it.itemId }, { ...deps, graph: g });
          results.push({ itemId: r.data.itemId, verified: r.verified, diffs: r.data.diffs });
        } catch (e) { results.push({ itemId: it.id || null, verified: false, error: e.message.slice(0, 200) }); }
      }
      return { verified: results.every((r) => r.verified), data: { listId, count: results.length, ok: results.filter((r) => r.verified).length, results } };
    }
    case 'get': {
      if (!p.list) { const r = await g.get(`/sites/${site}/lists?$select=id,displayName,webUrl&$top=999`); return { verified: true, data: { siteId: site, lists: r.value } }; }
      const listId = await L();
      if (p.itemId) { const re = await g.get(`/sites/${site}/lists/${listId}/items/${enc(p.itemId)}?$expand=fields`); return { verified: true, data: { listId, itemId: re.id, fields: re.fields } }; }
      const re = await g.get(`/sites/${site}/lists/${listId}?$expand=columns`);
      return { verified: true, data: { listId, displayName: re.displayName, webUrl: re.webUrl, columns: (re.columns || []).filter((c) => !c.readOnly || c.name === 'Title').map((c) => ({ name: c.name, displayName: c.displayName, type: columnType(c), required: c.required, indexed: c.indexed, choices: c.choice && c.choice.choices })) } };
    }
    case 'search': {
      const listId = await L();
      const top = Math.min(Number(p.top) || 50, 500);
      const q = [`$expand=fields`, `$top=${top}`];
      if (p.filter) q.push(`$filter=${enc(p.filter)}`);
      const r = await g.get(`/sites/${site}/lists/${listId}/items?${q.join('&')}`, { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' });
      return { verified: true, data: { listId, count: (r.value || []).length, hasMore: !!r['@odata.nextLink'], items: (r.value || []).map((i) => ({ id: i.id, fields: i.fields })) } };
    }
    case 'schema_validate': {
      const listId = await L();
      const cols = await spColumns(g, site, listId);
      const problems = [];
      for (const ex of p.expected || []) {
        const c = findColumn(cols, ex.name);
        if (!c) { problems.push({ column: ex.name, problem: 'missing' }); continue; }
        if (ex.type && columnType(c) !== ex.type) problems.push({ column: ex.name, problem: 'type', expected: ex.type, actual: columnType(c) });
        if (ex.required !== undefined && !!c.required !== !!ex.required) problems.push({ column: ex.name, problem: 'required', expected: ex.required, actual: !!c.required });
        if (ex.choices && c.choice) { const miss = ex.choices.filter((x) => !(c.choice.choices || []).includes(x)); if (miss.length) problems.push({ column: ex.name, problem: 'choices', missing: miss }); }
        if (ex.indexed !== undefined && !!c.indexed !== !!ex.indexed) problems.push({ column: ex.name, problem: 'indexed', expected: ex.indexed, actual: !!c.indexed });
      }
      return { verified: problems.length === 0, data: { listId, problems } };
    }
    case 'delete': {
      const kind = p.target || (p.itemId ? 'item' : p.column ? 'column' : 'list');
      const listId = await L();
      if (kind === 'item') { requireConfirm(p, `item ${p.itemId}`); await g.del(`/sites/${site}/lists/${listId}/items/${enc(p.itemId)}`); }
      else if (kind === 'column') { const c = findColumn(await spColumns(g, site, listId), p.column); if (!c) throw new OpError('column not found', 'not_found'); requireConfirm(p, `column ${c.name}`); await g.del(`/sites/${site}/lists/${listId}/columns/${c.id}`); }
      else { requireConfirm(p, `list ${p.list}`); await g.del(`/sites/${site}/lists/${listId}`); }
      let gone = false;
      try { if (kind === 'item') await g.get(`/sites/${site}/lists/${listId}/items/${enc(p.itemId)}`); else if (kind === 'list') await g.get(`/sites/${site}/lists/${listId}`); else gone = !findColumn(await spColumns(g, site, listId), p.column); } catch (e) { gone = classify(e) === 'not_found'; }
      return { verified: gone, data: { deleted: kind, listId } };
    }
    default: throw new OpError(`unknown sharepoint operation "${op}"`, 'invalid_input');
  }
}

// ---------- Power Apps ----------
function walkControls(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (node.Name && Array.isArray(node.Rules)) fn(node, parent);
  for (const ch of node.Children || []) walkControls(ch, fn, node);
}
function controlFiles(inner) { return inner.filter((e) => /(^|[\\/])Controls[\\/][^\\/]+\.json$/i.test(e.name)); }
function parseJson(e) { return JSON.parse(e.data.toString('utf8').replace(/^\uFEFF/, '')); }

// rules: [{control, property, script}] -> sets InvariantScript (adds rule if missing)
function applyRules(inner, rules) {
  const report = [];
  for (const [idx, r] of (rules || []).entries()) {
    if (!r.control || !r.property || typeof r.script !== 'string') throw new OpError(`rules[${idx}] needs control, property, script`, 'invalid_input');
    let hit = false;
    for (const e of controlFiles(inner)) {
      const j = parseJson(e);
      let changed = false;
      walkControls(j.TopParent || j, (n) => {
        if (n.Name !== r.control) return;
        hit = true;
        const rule = n.Rules.find((x) => x.Property === r.property);
        if (rule) { report.push({ control: r.control, property: r.property, before: rule.InvariantScript, after: r.script }); rule.InvariantScript = r.script; }
        else { n.Rules.push({ Property: r.property, Category: r.category || 'Design', InvariantScript: r.script, RuleProviderType: 'Unknown' }); report.push({ control: r.control, property: r.property, before: null, after: r.script, added: true }); }
        changed = true;
      });
      if (changed) e.data = Buffer.from(JSON.stringify(j), 'utf8');
    }
    if (!hit) throw new OpError(`control "${r.control}" not found in app`, 'not_found');
  }
  return report;
}
function readRules(inner, control) {
  const out = [];
  for (const e of controlFiles(inner)) {
    const top = parseJson(e).TopParent || parseJson(e);
    const scrName = top && top.Name;
    walkControls(top, (n, parent) => {
      if (control && n.Name !== control) return;
      out.push({ file: norm(e.name), screen: scrName, control: n.Name, parent: parent && parent.Name, template: n.Template && n.Template.Name, rules: n.Rules.map((x) => ({ property: x.Property, script: x.InvariantScript })) });
    });
  }
  return out;
}
function screensOf(inner) {
  const out = [];
  for (const e of controlFiles(inner)) { const j = parseJson(e); const t = j.TopParent || j; if (t && t.Name) out.push({ name: t.Name, template: t.Template && t.Template.Name, file: norm(e.name), controls: (function c(n) { return (n.Children || []).reduce((a, x) => a + 1 + c(x), 0); })(t) }); }
  return out;
}
function resourcesOf(inner) {
  const e = inner.find((x) => /(^|[\\/])References[\\/]Resources\.json$/i.test(x.name));
  return e ? (parseJson(e).Resources || []) : [];
}

// balanced (), [], {}, quotes; single-line Power Fx sanity check
function stripFxComments(src) {
  let out = ''; let q = null;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { out += ch; if (ch === q) { if (src[i + 1] === q) { out += q; i++; } else q = null; } continue; }
    if (ch === '"' || ch === "'") { q = ch; out += ch; continue; }
    if (ch === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 1; out += ' '; continue; }
    if (ch === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i + 2); i = e < 0 ? src.length : e - 1; continue; }
    out += ch;
  }
  return out;
}
function powerFxCheck(rawScript) {
  const script = stripFxComments(String(rawScript || ''));
  const issues = [];
  let inStr = null; const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (inStr) { if (ch === inStr) { if (script[i + 1] === inStr) i++; else inStr = null; } continue; }
    if (ch === '"' || ch === "'") { inStr = ch; continue; }
    if ('([{'.includes(ch)) stack.push(ch);
    else if (pairs[ch]) { if (stack.pop() !== pairs[ch]) issues.push(`unbalanced "${ch}" at ${i}`); }
  }
  if (inStr) issues.push('unterminated string');
  if (stack.length) issues.push(`unclosed "${stack.join('')}"`);
  if (/;;|,,|\(\s*,/.test(script)) issues.push('empty argument / separator');
  return issues;
}

function appChecker(inner) {
  const errors = []; const warnings = [];
  const res = resourcesOf(inner);
  const resNames = new Set(res.map((r) => r.Name));
  for (const r of res) if ((r.ResourceKind || 'LocalFile') === 'LocalFile' && r.Path && !inner.some((e) => norm(e.name) === norm(r.Path))) errors.push({ kind: 'missing_asset', resource: r.Name, path: norm(r.Path) });
  for (const e of controlFiles(inner)) {
    let j; try { j = parseJson(e); } catch (x) { errors.push({ kind: 'invalid_json', file: norm(e.name) }); continue; }
    walkControls(j.TopParent || j, (n) => {
      for (const rule of n.Rules) {
        const s = String(rule.InvariantScript || '');
        const fx = powerFxCheck(s);
        if (fx.length) errors.push({ kind: 'power_fx', control: n.Name, property: rule.Property, issues: fx });
        if (rule.Property === 'Image' && /^[A-Za-z][A-Za-z0-9_]*$/.test(s) && !resNames.has(s) && !/^(Blank|Self|Parent|ThisItem)$/.test(s)) warnings.push({ kind: 'image_not_in_resources', control: n.Name, image: s });
      }
    });
  }
  return { ok: errors.length === 0, errors, warnings, screens: screensOf(inner).length, resources: res.length };
}

function solutionDefaults(p, env) {
  return { solutionName: p.solutionName || env.POWERAPPS_SOLUTION_UNIQUE_NAME || 'CN_AIIraiDaicho', appFile: p.appFile };
}
// Tolerant app lookup for chat input: exact filter -> alphanumeric-normalised name -> configured default -> single app.
function pickApp(outer, appFile, defaultAppFile) {
  try { return paw._internal.findMsapps(outer, appFile); } catch (e) {
    if (!appFile) throw e;
    const apps = outer.filter((x) => /\.msapp$/i.test(x.name));
    const key = String(appFile).toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = key ? apps.filter((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(key)) : [];
    if (hit.length === 1) return hit[0];
    if (defaultAppFile && defaultAppFile !== appFile) { try { return paw._internal.findMsapps(outer, defaultAppFile); } catch (_) { /* fall through */ } }
    if (apps.length === 1) return apps[0];
    throw e;
  }
}
async function exportInner(p, deps) {
  const env = deps.env || process.env;
  const dv = deps.client || paw.createDataverseClient(paw.settings(env), deps.fetch);
  const { solutionName, appFile } = solutionDefaults(p, env);
  const buf = await dv.exportSolution(solutionName);
  const outer = readZip(buf);
  const app = pickApp(outer, appFile, solutionDefaults({}, env).appFile);
  return { buf, app, inner: readZip(app.data), solutionName, dv };
}

// Canvas app internal name from a solution entry name, e.g.
// "CanvasApps/cr296_cnai_12e0a_DocumentUri.msapp" → "cr296_cnai_12e0a".
function internalNameOf(entryName) {
  const base = String(entryName).replace(/\\/g, '/').split('/').pop() || '';
  return base.replace(/\.msapp$/i, '').replace(/_DocumentUri$/i, '');
}

// Resolves the canvas app GUID from its internal name. Fail-Closed: 0 or >1 rows → null.
async function canvasAppIdOf(dv, entryName) {
  const internalName = internalNameOf(entryName);
  if (!internalName) return null;
  const filter = encodeURIComponent(`name eq '${internalName.replace(/'/g, "''")}'`);
  const r = await dv.get(`canvasapps?$select=canvasappid,name&$filter=${filter}`);
  const rows = (r && r.value) || [];
  return rows.length === 1 && rows[0].canvasappid ? String(rows[0].canvasappid).toLowerCase() : null;
}

async function powerappsManage(p, deps = {}) {
  const env = deps.env || process.env;
  const op = p.operation;
  const base = solutionDefaults(p, env);
  const writeOp = async (body) => {
    const { out, attempts } = await withRepair(op, () => paw.applyEdit({ ...base, ...body, dryRun: !!p.dryRun }, { ...deps, applyRules, readRules }));
    return { verified: out.verified !== false && out.status !== 'published_verify_failed', data: out, attempts };
  };
  switch (op) {
    case 'app_get':
    case 'state_get': {
      const { app, inner, buf, solutionName, dv } = await exportInner(p, deps);
      const chk = appChecker(inner);
      const appId = await canvasAppIdOf(dv, app.name);
      const data = { solutionName, app: norm(app.name), appId, solutionSha256: sha(buf), screens: screensOf(inner), images: resourcesOf(inner).filter((r) => r.Content === 'Image').map((r) => r.Name), checker: { ok: chk.ok, errors: chk.errors.length, warnings: chk.warnings.length } };
      // Target binding: when the caller names an appId, the solution's app must match it exactly.
      if (p.appId !== undefined) {
        const matches = typeof p.appId === 'string' && appId !== null && p.appId.toLowerCase() === appId;
        return { verified: matches, data: { ...data, appIdMatch: matches } };
      }
      return { verified: true, data };
    }
    case 'source_get': return { verified: true, data: await paw.readApp({ ...base, search: p.search, file: p.file, maxResults: p.maxResults }, deps) };
    case 'screen_get': { const { inner } = await exportInner(p, deps); return { verified: true, data: { screens: screensOf(inner).filter((s) => !p.screen || s.name === p.screen) } }; }
    case 'control_get':
    case 'powerfx_get': {
      const { inner } = await exportInner(p, deps);
      const scr = p.screen ? String(p.screen) : null;
      const typ = p.controlType ? String(p.controlType).toLowerCase() : null;
      let all = readRules(inner, p.control);
      if (scr) all = all.filter((c) => c.screen === scr);
      if (typ) all = all.filter((c) => String(c.template || '').toLowerCase().includes(typ));
      const max = Math.min(Math.max(Number(p.maxResults) || 30, 1), 100);
      const brief = !p.control && !p.property;
      const controls = all.slice(0, max).map((c) => {
        if (brief) return { control: c.control, screen: c.screen, template: c.template, text: (c.rules.find((r) => r.property === 'Text') || {}).script };
        const rules = p.property ? c.rules.filter((r) => r.property === p.property) : c.rules;
        return { ...c, rules: rules.map((r) => ({ property: r.property, script: String(r.script || '').slice(0, 2000) })) };
      });
      return { verified: true, data: { total: all.length, returned: controls.length, truncated: all.length > controls.length, brief, controls } };
    }
    case 'powerfx_edit':
    case 'control_edit': {
      const rules = p.rules || [{ control: p.control, property: p.property, script: p.script }];
      for (const r of rules) { const fx = powerFxCheck(r.script || ''); if (fx.length) throw new OpError(`Power Fx check failed for ${r.control}.${r.property}: ${fx.join('; ')}`, 'invalid_input'); }
      return writeOp({ rules, edits: p.edits || [] });
    }
    case 'screen_add':
    case 'screen_edit':
    case 'control_add':
    case 'datasource_add':
    case 'datasource_edit':
      if (!(p.edits || []).length && !(p.rules || []).length) throw new OpError(`${op} needs edits [{file?, find, replace}] and/or rules`, 'invalid_input');
      assertNoPremium((p.edits || []).map((e) => e.replace || e.content || ''), `powerapps_manage.${op}`);
      return writeOp({ edits: p.edits || [], rules: p.rules || [] });
    case 'image_add':
    case 'image_replace': {
      const images = p.images || [{ name: p.name, base64: p.base64, url: p.url, contentType: p.contentType }];
      const rules = p.assignTo ? [{ control: p.assignTo, property: p.property || 'Image', script: images[0].name }] : [];
      return writeOp({ images, rules });
    }
    case 'image_assign': return writeOp({ rules: [{ control: p.control, property: p.property || 'Image', script: p.imageName }] });
    case 'save':
    case 'publish': assertNoPremium((p.edits || []).map((e) => e.replace || e.content || ''), `powerapps_manage.${op}`); return writeOp({ edits: p.edits || [], images: p.images || [], rules: p.rules || [] });
    case 'reread':
    case 'publish_verify': {
      const { inner, buf } = await exportInner(p, deps);
      const checks = (p.expect || []).map((x) => { const c = readRules(inner, x.control)[0]; const rule = c && c.rules.find((r) => r.property === (x.property || 'Image')); return { ...x, actual: rule ? rule.script : null, ok: !!rule && rule.script === x.script }; });
      const chk = appChecker(inner); return { verified: checks.every((c) => c.ok), data: { solutionSha256: sha(buf), checks, checker: { ok: chk.ok, errors: chk.errors.length, warnings: chk.warnings.length, firstErrors: chk.errors.slice(0, 5) } } };
    }
    case 'app_checker': { const { inner } = await exportInner(p, deps); const c = appChecker(inner); return { verified: c.ok, data: c }; }
    case 'restore': {
      // restore -> re-read -> compare every control rule with the pre-change snapshot
      const r = await paw.rollback({ snapshotId: p.snapshotId }, deps);
      const snapFile = path.join(paw.settings(env).snapshotDir, `${p.snapshotId}.zip`);
      const snapInner = readZip(pickApp(readZip(fs.readFileSync(snapFile)), base.appFile, solutionDefaults({}, env).appFile).data);
      const { inner } = await exportInner(p, deps);
      const key = (rs) => rs.map((c) => `${c.control}|${c.rules.map((x) => `${x.property}=${x.script}`).sort().join(';')}`).sort();
      const want = key(readRules(snapInner)); const got = key(readRules(inner));
      const diff = want.filter((x) => !got.includes(x)).concat(got.filter((x) => !want.includes(x)));
      return { verified: diff.length === 0, data: { ...r, reread: true, matchesSnapshot: diff.length === 0, controlsCompared: want.length, mismatches: diff.slice(0, 20) } };
    }
    case 'snapshots': { const all = paw.listSnapshots(deps); const arr = Array.isArray(all) ? all : (all.snapshots || []); return { verified: true, data: { total: arr.length, snapshots: arr.slice(0, 20) } }; }
    default: throw new OpError(`unknown powerapps operation "${op}"`, 'invalid_input');
  }
}

// ---------- Power Automate ----------
function dvClient(deps) { return deps.flowClient || pfw._internal.createClient(paw.settings(deps.env || process.env), deps.fetch); }
function setPath(obj, dotted, value) {
  const keys = dotted.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  if (value === null) delete o[keys[keys.length - 1]]; else o[keys[keys.length - 1]] = value;
}
async function flowRuns(dv, flowId, top = 10) {
  try {
    const r = await dv.get(`flowruns?$filter=_workflow_value eq ${flowId}&$orderby=starttime desc&$top=${top}&$select=name,status,starttime,endtime,errorcode,errormessage,triggertype,duration`);
    return { source: 'dataverse_flowruns', runs: r.value || [] };
  } catch (e) { return { source: 'unavailable', runs: [], error: e.message.slice(0, 200) }; }
}
async function powerautomateManage(p, deps = {}) {
  const op = p.operation;
  const dv = dvClient(deps);
  const id = p.flowId && String(p.flowId).toLowerCase();
  const getFlow = () => dv.get(`workflows(${id})?$select=name,statecode,statuscode,clientdata,modifiedon`);
  switch (op) {
    case 'list': return { verified: true, data: await pfw.listFlows({ solutionName: p.solutionName, nameContains: p.nameContains, top: p.top }, { ...deps, client: dv }) };
    case 'get': return { verified: true, data: await pfw.readFlow({ flowId: id, search: p.search }, { ...deps, client: dv }) };
    case 'create': {
      if (!p.name || !p.definition) throw new OpError('name and definition {triggers, actions} required', 'invalid_input');
      assertNoPremium({ definition: p.definition, connectionReferences: p.connectionReferences || {} }, 'powerautomate_manage.create');
      const clientdata = { properties: { connectionReferences: p.connectionReferences || {}, definition: { $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#', contentVersion: '1.0.0.0', parameters: { $connections: { defaultValue: {}, type: 'Object' }, $authentication: { defaultValue: {}, type: 'SecureObject' } }, ...p.definition } }, schemaVersion: '1.0.0.0' };
      pfw._internal.parseClientdata(JSON.stringify(clientdata));
      const body = { category: 5, type: 1, primaryentity: 'none', name: p.name, description: p.description || 'created by powerautomate_manage', clientdata: JSON.stringify(clientdata) };
      const { out, attempts } = await withRepair(op, () => dv.post('workflows?$select=workflowid', body));
      let newId = (out && (out.workflowid || ((out['@odata.id'] || out['OData-EntityId'] || '').match(/\(([0-9a-f-]{36})\)/i) || [])[1])) || null;
      if (!newId) {
        const q = await dv.get(`workflows?$filter=name eq '${String(p.name).replace(/'/g, "''")}' and category eq 5&$orderby=createdon desc&$top=1&$select=workflowid`);
        newId = q.value && q.value[0] && q.value[0].workflowid;
      }
      if (!newId) throw new OpError('flow created but id could not be re-read', 'conflict');
      const re = await dv.get(`workflows(${newId})?$select=name,statecode,clientdata`);
      return { verified: !!re.clientdata, data: { flowId: newId, name: re.name, state: re.statecode === 1 ? 'on' : 'off' }, attempts };
    }
    case 'edit':
    case 'trigger_edit':
    case 'action_edit': {
      assertNoPremium({ edits: p.edits, set: p.set, value: p.value, connectionReferences: p.connectionReferences }, `powerautomate_manage.${op}`);
      if (p.edits) return { verified: true, data: await pfw.updateFlow({ flowId: id, edits: p.edits, dryRun: p.dryRun }, { ...deps, client: dv }) };
      const f = await getFlow();
      const cd = pfw._internal.parseClientdata(f.clientdata);
      const scope = op === 'trigger_edit' ? 'triggers' : op === 'action_edit' ? 'actions' : null;
      const sets = p.set || (p.name ? [{ path: `${scope}.${p.name}`, value: p.value }] : []);
      if (!sets.length) throw new OpError('set [{path, value}] or name+value required', 'invalid_input');
      const snap = path.join(paw.settings(deps.env || process.env).snapshotDir, 'flows');
      fs.mkdirSync(snap, { recursive: true });
      const snapshotId = `${id}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.writeFileSync(path.join(snap, `${snapshotId}.json`), JSON.stringify({ id, flowId: id, clientdata: f.clientdata, statecode: f.statecode }));
      for (const s of sets) setPath(cd.properties.definition, scope && !s.path.startsWith(scope) ? `${scope}.${s.path}` : s.path, s.value);
      if (p.connectionReferences) cd.properties.connectionReferences = { ...cd.properties.connectionReferences, ...p.connectionReferences };
      pfw._internal.parseClientdata(JSON.stringify(cd));
      if (p.dryRun) return { verified: true, data: { status: 'dry_run', snapshotId } };
      const wasOn = f.statecode === 1;
      if (wasOn) await dv.patch(`workflows(${id})`, { statecode: 0, statuscode: 1 });
      await dv.patch(`workflows(${id})`, { clientdata: JSON.stringify(cd) });
      if (wasOn) await dv.patch(`workflows(${id})`, { statecode: 1, statuscode: 2 });
      const re = await getFlow();
      const ok = JSON.stringify(pfw._internal.parseClientdata(re.clientdata).properties.definition) === JSON.stringify(cd.properties.definition);
      return { verified: ok, data: { status: ok ? 'saved_verified' : 'saved_verify_failed', snapshotId, state: re.statecode === 1 ? 'on' : 'off' } };
    }
    case 'save': { const f = await getFlow(); return { verified: !!f.clientdata, data: { saved: true, modifiedon: f.modifiedon, state: f.statecode === 1 ? 'on' : 'off' } }; }
    case 'enable':
    case 'disable': {
      const { out, attempts } = await withRepair(op, () => pfw.setFlowState({ flowId: id, state: op === 'enable' ? 'on' : 'off' }, { ...deps, client: dv }));
      return { verified: out.status !== 'verify_failed', data: out, attempts };
    }
    case 'connection_check': {
      const f = await getFlow();
      const refs = (pfw._internal.parseClientdata(f.clientdata).properties.connectionReferences) || {};
      const out = [];
      for (const [k, v] of Object.entries(refs)) {
        const ln = v.connection && v.connection.connectionReferenceLogicalName;
        let status = 'embedded';
        if (ln) { try { const r = await dv.get(`connectionreferences?$filter=connectionreferencelogicalname eq '${ln.replace(/'/g, "''")}'&$select=connectionid,connectorid,statecode`); const c = (r.value || [])[0]; status = !c ? 'missing_reference' : c.connectionid ? 'bound' : 'unbound'; } catch (e) { status = 'unknown'; } }
        out.push({ key: k, api: v.api && v.api.name, logicalName: ln, status });
      }
      return { verified: out.every((c) => c.status === 'bound' || c.status === 'embedded'), data: { connections: out } };
    }
    case 'test':
    case 'rerun': {
      // Recurrence/automated flows are triggered by toggling off->on; manual triggers need a user-context run.
      const f = await getFlow();
      const trig = Object.values(pfw._internal.parseClientdata(f.clientdata).properties.definition.triggers)[0] || {};
      const before = await flowRuns(dv, id, 1);
      if (trig.type === 'Recurrence' || op === 'rerun') {
        await dv.patch(`workflows(${id})`, { statecode: 0, statuscode: 1 });
        await dv.patch(`workflows(${id})`, { statecode: 1, statuscode: 2 });
      } else throw new OpError(`trigger type "${trig.type}" cannot be started by service principal; use fallback cli_or_powershell / computer_use`, 'unsupported', { fallback: FALLBACK.slice(1) });
      const waitMs = Math.min(Number(p.waitMs) || 90000, 240000);
      const t0 = Date.now(); let latest = null;
      while (Date.now() - t0 < waitMs) {
        await new Promise((r) => setTimeout(r, deps.pollMs ?? 10000));
        const r = await flowRuns(dv, id, 1);
        const run = r.runs[0];
        if (run && (!before.runs[0] || run.name !== before.runs[0].name) && run.status && !/Running|Waiting/i.test(run.status)) { latest = run; break; }
      }
      const ok = !!latest && /Succeeded/i.test(latest.status || '');
      // Never report a pre-existing run as the result of this test.
      return { verified: ok, data: { triggered: true, newRun: !!latest, status: latest ? latest.status : 'no_new_run', run: latest, previousRun: before.runs[0] ? before.runs[0].name : null, note: latest ? undefined : 'no new run was observed within waitMs; result NOT verified' } };
    }
    case 'runs': { const r = await flowRuns(dv, id, Number(p.top) || 10); return { verified: r.source !== 'unavailable', data: r }; }
    case 'failures': { const r = await flowRuns(dv, id, Number(p.top) || 20); const failed = r.runs.filter((x) => /Failed/i.test(x.status || '')); return { verified: r.source !== 'unavailable', data: { failed: failed.map((x) => ({ run: x.name, start: x.starttime, code: x.errorcode, message: (x.errormessage || '').slice(0, 500) })) } }; }
    case 'auto_repair': {
      const steps = [];
      const st = await dv.get(`workflows(${id})?$select=statecode`);
      if (st.statecode !== 1) { await pfw.setFlowState({ flowId: id, state: 'on' }, { ...deps, client: dv }); steps.push('enabled flow'); }
      const conn = await powerautomateManage({ operation: 'connection_check', flowId: id }, { ...deps, flowClient: dv });
      if (!conn.verified) steps.push({ unbound_connections: conn.data.connections.filter((c) => c.status !== 'bound' && c.status !== 'embedded'), next: 'bind connection reference (fallback: computer_use)' });
      const fails = await powerautomateManage({ operation: 'failures', flowId: id, top: 5 }, { ...deps, flowClient: dv });
      return { verified: conn.verified, data: { steps, lastFailures: fails.data.failed, fallback: conn.verified ? [] : FALLBACK.slice(1) } };
    }
    case 'restore': { const r = await pfw.rollbackFlow({ snapshotId: p.snapshotId }, { ...deps, client: dv }); return { verified: r.verified === true, data: r }; }
    case 'delete': {
      requireConfirm(p, `flow ${id}`);
      const f = await getFlow();
      if (f.statecode === 1) await dv.patch(`workflows(${id})`, { statecode: 0, statuscode: 1 });
      await (dv.del ? dv.del(`workflows(${id})`) : dv.patch(`workflows(${id})`, { statecode: 0 }));
      let gone = false; try { await getFlow(); } catch (e) { gone = classify(e) === 'not_found'; }
      return { verified: gone, data: { deleted: id } };
    }
    default: throw new OpError(`unknown powerautomate operation "${op}"`, 'invalid_input');
  }
}

// ---------- validate ----------
async function powerplatformValidate(p, deps = {}) {
  const env = deps.env || process.env;
  const op = p.operation;
  switch (op) {
    case 'environment': {
      const s = paw.settings(env);
      const sol = solutionDefaults(p, env).solutionName;
      const dv = dvClient(deps);
      const r = await dv.get(`solutions?$filter=uniquename eq '${sol.replace(/'/g, "''")}'&$select=uniquename,version,ismanaged`);
      return { verified: (r.value || []).length === 1, data: { orgUrl: s.orgUrl, environmentId: env.POWERAPPS_ENVIRONMENT_ID || null, solution: (r.value || [])[0] || null, sharepointSiteId: spSettings(env).siteId || null } };
    }
    case 'diff':
    case 'unexpected_changes': {
      const s = paw.settings(env);
      const file = path.join(deps.snapshotDir || s.snapshotDir, `${p.snapshotId}.zip`);
      if (!/^[A-Za-z0-9_\-]+$/.test(p.snapshotId || '') || !fs.existsSync(file)) throw new OpError('valid existing snapshotId required', 'not_found');
      const before = readZip(paw._internal.findMsapps(readZip(fs.readFileSync(file)), p.appFile).data);
      const { inner: after } = await exportInner(p, deps);
      const m = (arr) => new Map(arr.map((e) => [norm(e.name), sha(e.data)]));
      const a = m(before); const b = m(after);
      const changed = []; for (const [k, v] of b) if (!a.has(k)) changed.push({ file: k, change: 'added' }); else if (a.get(k) !== v) changed.push({ file: k, change: 'modified' });
      for (const k of a.keys()) if (!b.has(k)) changed.push({ file: k, change: 'removed' });
      const allowed = (p.allowed || []).map((x) => x.toLowerCase());
      const ignore = /(^|\/)(Header\.json|Properties\.json|Entropy\/|checksum\.json|AppCheckerResult\.sarif)/i;
      const unexpected = op === 'unexpected_changes' ? changed.filter((c) => !ignore.test(c.file) && !allowed.some((x) => c.file.toLowerCase().includes(x))) : [];
      return { verified: op === 'diff' ? true : unexpected.length === 0, data: { changed, unexpected } };
    }
    case 'reread': return powerappsManage({ ...p, operation: 'reread' }, deps);
    case 'powerfx': { const res = (p.scripts || [p.script]).map((s) => ({ script: s, issues: powerFxCheck(String(s || '')) })); return { verified: res.every((r) => !r.issues.length), data: { results: res } }; }
    case 'sp_column_types': return sharepointManage({ ...p, operation: 'schema_validate' }, deps);
    case 'flow_run': return powerautomateManage({ ...p, operation: 'runs', top: 1 }, deps).then((r) => ({ verified: !!(r.data.runs[0] && /Succeeded/i.test(r.data.runs[0].status)), data: r.data }));
    case 'image_assignment': {
      const { inner } = await exportInner(p, deps);
      const c = readRules(inner, p.control)[0];
      const rule = c && c.rules.find((r) => r.property === (p.property || 'Image'));
      const res = resourcesOf(inner).find((r) => r.Name === p.imageName);
      const asset = res && inner.find((e) => norm(e.name) === norm(res.Path || ''));
      return { verified: !!rule && rule.script === p.imageName && !!asset, data: { control: p.control, script: rule ? rule.script : null, resource: !!res, asset: asset ? { path: norm(asset.name), bytes: asset.data.length } : null } };
    }
    case 'recoverability': {
      const apps = paw.listSnapshots(deps).snapshots;
      const fdir = path.join(paw.settings(env).snapshotDir, 'flows');
      const flows = fs.existsSync(fdir) ? fs.readdirSync(fdir).filter((f) => !p.flowId || f.startsWith(String(p.flowId).toLowerCase())).slice(-10) : [];
      return { verified: apps.length > 0 || flows.length > 0, data: { appSnapshots: apps.slice(0, 10), flowSnapshots: flows } };
    }
    case 'audit': return { verified: true, data: { entries: auditTail(env, Number(p.top) || 30) } };
    case 'premium_check': {
      const out = {};
      if (p.flowId) { const f = await dvClient(deps).get(`workflows(${String(p.flowId).toLowerCase()})?$select=name,clientdata`); out.flow = { name: f.name, premium: premiumScan(f.clientdata || '') }; }
      if (p.flowId === undefined || p.appFile || p.solutionName) {
        const { inner } = await exportInner(p, deps);
        const text = inner.filter((e) => /^(Connections|References|DataSources)/i.test(norm(e.name))).map((e) => e.data.toString('utf8')).join('\n');
        out.app = { premium: premiumScan(text) };
      }
      const all = [...((out.flow && out.flow.premium) || []), ...((out.app && out.app.premium) || [])];
      return { verified: all.length === 0, data: { ...out, premiumFound: all.length, result: all.length ? 'premium_or_unknown_detected' : 'standard_only' } };
    }
    default: throw new OpError(`unknown validate operation "${op}"`, 'invalid_input');
  }
}

const HANDLERS = { sharepoint_manage: sharepointManage, powerapps_manage: powerappsManage, powerautomate_manage: powerautomateManage, powerplatform_validate: powerplatformValidate };

async function run(tool, params = {}, deps = {}) {
  const env = deps.env || process.env;
  const t0 = Date.now();
  const opId = `pm_${crypto.randomUUID()}`;
  try {
    if (!HANDLERS[tool]) throw new OpError(`unknown tool ${tool}`, 'invalid_input');
    params = normalizeParams(tool, params);
    if (!params.operation) throw new OpError(`operation is required. valid: ${validOps(tool).join(', ')}`, 'invalid_input');
    if (!validOps(tool).includes(params.operation)) throw new OpError(`unknown operation "${params.operation}". valid: ${validOps(tool).join(', ')}`, 'invalid_input');
    const r = await HANDLERS[tool](params, deps);
    const res = { status: r.verified ? 'ok' : 'partial', verified: !!r.verified, operationId: opId, tool, operation: params.operation, data: r.data, repair: r.attempts && r.attempts.length ? r.attempts : undefined, elapsedMs: Date.now() - t0 };
    audit(env, { opId, tool, operation: params.operation, status: res.status, verified: res.verified, elapsedMs: res.elapsedMs });
    return res;
  } catch (e) {
    const kind = classify(e);
    const res = { status: kind === 'approval_required' ? 'approval_required' : kind === 'blocked_premium' ? 'blocked_premium' : 'error', premium: e.premium, verified: false, operationId: opId, tool, operation: params.operation, errorKind: kind, error: String(e.message).slice(0, 800), repair: e.attempts, approval: e.approval, fallback: e.fallback || (['transient', 'unknown', 'unsupported'].includes(kind) ? FALLBACK.slice(1) : undefined), elapsedMs: Date.now() - t0 };
    audit(env, { opId, tool, operation: params.operation, status: res.status, errorKind: kind, error: res.error.slice(0, 200) });
    return res;
  }
}

const op = (list) => ({ type: 'string', enum: list });
function validOps(tool) { const d = TOOL_DEFS.find((t) => t.name === tool); return d ? d.inputSchema.properties.operation.enum : []; }
const TOOL_DEFS = [
  { name: 'sharepoint_manage', description: 'SharePointリスト操作を1ツールで実行(operation指定)。アイテム一覧・件数=search(list指定)、リスト一覧=get(list省略)、列定義=get(list指定)。site=サイト名(例 cleannano)可、list=表示名可。書込後は再取得して一致検証、列名は表示名→内部名へ自動補正。物理削除は confirm="DELETE <対象>" が必須。', inputSchema: { type: 'object', properties: { site: { type: 'string', description: 'サイト名(例 cleannano)またはURL' }, operation: op(['list_create', 'column_create', 'column_update', 'choice_update', 'item_create', 'item_update', 'bulk_create', 'bulk_update', 'get', 'search', 'index_create', 'schema_validate', 'delete']), siteId: { type: 'string' }, siteUrl: { type: 'string' }, list: { type: 'string', description: 'リストID or 表示名' }, displayName: { type: 'string' }, template: { type: 'string' }, columns: { type: 'array', items: { type: 'object' } }, column: { description: '列名/ID(更新系) または Graph columnDefinition(作成)' }, patch: { type: 'object' }, choices: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['add', 'replace'] }, itemId: { type: 'string' }, fields: { type: 'object' }, items: { type: 'array', items: { type: 'object' } }, filter: { type: 'string' }, top: { type: 'integer' }, expected: { type: 'array', items: { type: 'object' } }, target: { type: 'string', enum: ['list', 'column', 'item'] }, confirm: { type: 'string' } }, required: ['operation'] } },
  { name: 'powerapps_manage', description: 'Power Appsキャンバスアプリ操作を1ツールで実行(operation指定)。状態=state_get、画面一覧=screen_get、検査=app_checker。プレミアム/未確認コネクタを含む変更は自動停止(blocked_premium)。ソリューション書出→編集→取込→社内公開→再取得検証、変更前スナップショット自動保存(restoreで復元)。画像はimages[{name,base64|url}]、割当はassignTo/control+imageName。', inputSchema: { type: 'object', properties: { appId: { type: 'string' }, operation: op(['app_get', 'state_get', 'source_get', 'screen_get', 'screen_add', 'screen_edit', 'control_get', 'control_add', 'control_edit', 'powerfx_get', 'powerfx_edit', 'datasource_add', 'datasource_edit', 'image_add', 'image_replace', 'image_assign', 'save', 'publish', 'reread', 'publish_verify', 'app_checker', 'restore', 'snapshots']), solutionName: { type: 'string' }, appFile: { type: 'string' }, screen: { type: 'string' }, controlType: { type: 'string' }, control: { type: 'string' }, property: { type: 'string' }, script: { type: 'string' }, rules: { type: 'array', items: { type: 'object' } }, edits: { type: 'array', items: { type: 'object' } }, images: { type: 'array', items: { type: 'object' } }, name: { type: 'string' }, base64: { type: 'string' }, url: { type: 'string' }, contentType: { type: 'string' }, assignTo: { type: 'string' }, imageName: { type: 'string' }, expect: { type: 'array', items: { type: 'object' } }, search: { type: 'string' }, file: { type: 'string' }, maxResults: { type: 'integer' }, snapshotId: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['operation'] } },
  { name: 'powerautomate_manage', description: 'Power Automateクラウドフロー操作を1ツールで実行(operation指定)。一覧=list(nameContains)、履歴=runs、失敗=failures。プレミアム(HTTP/カスタム/Dataverse等)を含む作成・編集は自動停止(blocked_premium)。作成/編集(トリガー・アクション)/接続確認/有効化/テスト/実行履歴/失敗箇所/自動修復/再実行/復元。物理削除は confirm="DELETE flow <id>" が必須。', inputSchema: { type: 'object', properties: { operation: op(['list', 'get', 'create', 'edit', 'trigger_edit', 'action_edit', 'connection_check', 'save', 'enable', 'disable', 'test', 'runs', 'failures', 'auto_repair', 'rerun', 'restore', 'delete']), flowId: { type: 'string' }, solutionName: { type: 'string' }, nameContains: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, definition: { type: 'object' }, connectionReferences: { type: 'object' }, value: {}, set: { type: 'array', items: { type: 'object' } }, edits: { type: 'array', items: { type: 'object' } }, search: { type: 'string' }, top: { type: 'integer' }, waitMs: { type: 'integer' }, snapshotId: { type: 'string' }, dryRun: { type: 'boolean' }, confirm: { type: 'string' } }, required: ['operation'] } },
  { name: 'powerplatform_validate', description: 'Power Platform変更の検証(operation指定): premium_check(アプリ/フローのプレミアム該当検出)/environment/diff/unexpected_changes/reread/powerfx/sp_column_types/flow_run/image_assignment/recoverability/audit。', inputSchema: { type: 'object', properties: { operation: op(['environment', 'diff', 'unexpected_changes', 'reread', 'powerfx', 'sp_column_types', 'flow_run', 'image_assignment', 'recoverability', 'audit', 'premium_check']), snapshotId: { type: 'string' }, allowed: { type: 'array', items: { type: 'string' } }, solutionName: { type: 'string' }, appFile: { type: 'string' }, script: { type: 'string' }, scripts: { type: 'array', items: { type: 'string' } }, list: { type: 'string' }, siteId: { type: 'string' }, expected: { type: 'array', items: { type: 'object' } }, flowId: { type: 'string' }, control: { type: 'string' }, property: { type: 'string' }, imageName: { type: 'string' }, expect: { type: 'array', items: { type: 'object' } }, top: { type: 'integer' } }, required: ['operation'] } },
];

module.exports = { run, TOOL_DEFS, TOOL_NAMES: TOOL_DEFS.map((t) => t.name), _internal: { pickApp, internalNameOf, premiumScan, normalizeParams, classify, withRepair, applyRules, readRules, appChecker, powerFxCheck, fieldsMatch, setPath, sharepointManage, powerappsManage, powerautomateManage, powerplatformValidate } };
