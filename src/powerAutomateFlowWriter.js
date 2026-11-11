'use strict';
// Power Automate (cloud flow) editor via Dataverse `workflows` table (category 5 = modern flow).
// snapshot clientdata -> literal edits -> validate JSON -> PATCH -> re-GET verify.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { settings } = require('./powerAppsSolutionWriter');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (s) => String(s).replace(/'/g, "''");
const countOf = (hay, needle) => hay.split(needle).length - 1;
const stateOf = (statecode) => (statecode === 1 ? 'on' : 'off');

function createClient(cfg, fetchImpl = globalThis.fetch) {
  if (!cfg.orgUrl || !cfg.tenantId || !cfg.clientId || !cfg.clientSecret) {
    throw new Error('Dataverse settings missing (POWERAPPS_ORG_URL / tenant / client id / client secret)');
  }
  let cached = null;
  async function token() {
    if (cached && cached.exp > Date.now() + 60000) return cached.value;
    const r = await fetchImpl(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: `${cfg.orgUrl}/.default` }),
    });
    const j = await r.json();
    if (!j.access_token) throw new Error(`Dataverse token failed: ${j.error || r.status}`);
    cached = { value: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 };
    return cached.value;
  }
  async function call(method, p, body) {
    const r = await fetchImpl(`${cfg.orgUrl}/api/data/v9.2/${p}`, {
      method,
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Accept: 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Dataverse ${method} ${p} ${r.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }
  return {
    get: (p) => call('GET', p),
    patch: async (p, body) => { await call('PATCH', p, body); },
    post: (p, body) => call('POST', p, body),
    del: async (p) => { await call('DELETE', p); },
  };
}

const clientOf = (deps) => deps.client || createClient(settings(deps.env), deps.fetch);
const snapDir = (deps) => path.join(deps.snapshotDir || settings(deps.env).snapshotDir, 'flows');
function checkId(flowId) { if (!GUID.test(flowId || '')) throw new Error('valid flowId (GUID) required'); return flowId.toLowerCase(); }
function parseClientdata(raw) {
  const j = JSON.parse(raw || '{}');
  const def = j && j.properties && j.properties.definition;
  if (!def || typeof def.triggers !== 'object' || !def.triggers || typeof def.actions !== 'object' || !def.actions) {
    throw new Error('clientdata missing properties.definition.triggers/actions');
  }
  return j;
}
const getFlow = (dv, id) => dv.get(`workflows(${id})?$select=name,statecode,statuscode,clientdata,modifiedon`);

async function listFlows({ solutionName, nameContains, top = 50 } = {}, deps = {}) {
  const dv = clientOf(deps);
  const n = Math.max(1, Math.min(5000, parseInt(top, 10) || 50));
  let filter = 'category eq 5';
  if (nameContains) filter += ` and contains(name,'${q(nameContains)}')`;
  let allowed = null;
  if (solutionName) {
    const s = await dv.get(`solutions?$select=solutionid&$filter=uniquename eq '${q(solutionName)}'`);
    if (!s.value || !s.value.length) throw new Error(`solution ${solutionName} not found`);
    const c = await dv.get(`solutioncomponents?$select=objectid&$filter=_solutionid_value eq ${s.value[0].solutionid} and componenttype eq 29`);
    allowed = new Set((c.value || []).map((x) => String(x.objectid).toLowerCase()));
  }
  const r = await dv.get(`workflows?$select=workflowid,name,statecode,statuscode,modifiedon,category&$filter=${filter}${allowed ? '' : `&$top=${n}`}`);
  let rows = r.value || [];
  if (allowed) rows = rows.filter((w) => allowed.has(String(w.workflowid).toLowerCase())).slice(0, n);
  return { flows: rows.map((w) => ({ id: w.workflowid, name: w.name, state: stateOf(w.statecode), modifiedOn: w.modifiedon })) };
}

async function readFlow({ flowId, search, raw = false } = {}, deps = {}) {
  const id = checkId(flowId);
  const w = await getFlow(clientOf(deps), id);
  const parsed = parseClientdata(w.clientdata);
  const props = parsed.properties;
  const out = {
    id, name: w.name, state: stateOf(w.statecode), modifiedOn: w.modifiedon,
    triggers: Object.keys(props.definition.triggers), actions: Object.keys(props.definition.actions),
    connectionReferences: Object.keys(props.connectionReferences || {}),
  };
  if (search) {
    const lines = JSON.stringify(parsed, null, 2).split('\n');
    out.matches = [];
    for (let i = 0; i < lines.length && out.matches.length < 50; i++) {
      if (lines[i].includes(search)) out.matches.push({ line: i + 1, text: lines[i].slice(0, 300) });
    }
  } else out.definition = props.definition;
  // Read-only: the raw clientdata string is returned only when explicitly requested (exact-text edits need it).
  if (raw === true) out.clientdata = String(w.clientdata || '');
  return out;
}

async function updateFlow({ flowId, edits, dryRun = false } = {}, deps = {}) {
  const id = checkId(flowId);
  if (!Array.isArray(edits) || !edits.length) throw new Error('edits required');
  const dv = clientOf(deps);
  const w = await getFlow(dv, id);
  const before = String(w.clientdata || '');
  const savedAt = new Date().toISOString();
  const snapshotId = `flow_${id}_${savedAt.replace(/[^0-9A-Za-z]/g, '')}_${crypto.createHash('sha256').update(before).digest('hex').slice(0, 12)}`;
  const dir = snapDir(deps);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${snapshotId}.json`), JSON.stringify({ id, name: w.name, clientdata: before, savedAt }));
  let next = before;
  const report = edits.map((e, index) => {
    if (!e || typeof e.find !== 'string' || !e.find || typeof e.replace !== 'string') throw new Error(`edit #${index}: find (non-empty) and replace strings required`);
    const matches = countOf(next, e.find);
    if (!matches) throw new Error(`edit #${index}: find text not found`);
    if (e.expectCount != null && matches !== e.expectCount) throw new Error(`edit #${index}: expected ${e.expectCount} matches, found ${matches}`);
    next = next.split(e.find).join(e.replace);
    return { index, matches };
  });
  try { parseClientdata(next); } catch (err) { throw new Error(`edited clientdata invalid, not saved: ${err.message}`); }
  if (dryRun) return { status: 'dry_run', snapshotId, edits: report, checks: [] };
  await dv.patch(`workflows(${id})`, { clientdata: next });
  const after = String((await getFlow(dv, id)).clientdata || '');
  const checks = [];
  edits.forEach((e, index) => {
    if (e.replace) checks.push({ index, check: 'replace_present', ok: after.includes(e.replace) });
    if (!e.replace.includes(e.find)) checks.push({ index, check: 'find_absent', ok: !after.includes(e.find) });
  });
  return { status: checks.every((c) => c.ok) ? 'saved_verified' : 'saved_verify_failed', snapshotId, edits: report, checks };
}

async function setFlowState({ flowId, state } = {}, deps = {}) {
  const id = checkId(flowId);
  if (state !== 'on' && state !== 'off') throw new Error("state must be 'on' or 'off'");
  const dv = clientOf(deps);
  const on = state === 'on';
  await dv.patch(`workflows(${id})`, { statecode: on ? 1 : 0, statuscode: on ? 2 : 1 });
  const w = await dv.get(`workflows(${id})?$select=statecode,statuscode`);
  return { status: stateOf(w.statecode) === state ? 'verified' : 'verify_failed', state: stateOf(w.statecode) };
}

async function rollbackFlow({ snapshotId } = {}, deps = {}) {
  if (!/^[A-Za-z0-9_\-]+$/.test(snapshotId || '')) throw new Error('valid snapshotId required');
  const file = path.join(snapDir(deps), `${snapshotId}.json`);
  if (!fs.existsSync(file)) throw new Error(`snapshot ${snapshotId} not found`);
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = checkId(snap.id);
  const dv = clientOf(deps);
  await dv.patch(`workflows(${id})`, { clientdata: snap.clientdata });
  const after = await dv.get(`workflows(${id})?$select=clientdata`);
  return { status: 'rolled_back', snapshotId, flowId: id, verified: after.clientdata === snap.clientdata };
}

async function listFlowSnapshots(params = {}, deps = {}) {
  const dir = snapDir(deps);
  if (!fs.existsSync(dir)) return { snapshots: [] };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  return { snapshots: files.slice(0, 30).map((x) => x.f.replace(/\.json$/, '')) };
}

module.exports = { listFlows, readFlow, updateFlow, setFlowState, rollbackFlow, listFlowSnapshots, _internal: { createClient, parseClientdata } };
