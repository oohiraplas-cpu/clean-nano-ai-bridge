'use strict';
// Power Apps canvas app editor via Dataverse solution round-trip.
// export (snapshot) -> edit .msapp in memory -> ImportSolution -> PublishAllXml -> re-export verify.
// No Dataverse Git integration / Managed Environment required.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip, writeZip } = require('./zipLite');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/bmp': '.bmp' };

function settings(env = process.env) {
  const orgUrl = (env.POWERAPPS_ORG_URL || env.DATAVERSE_URL || '').replace(/\/+$/, '');
  const tenantId = env.POWERAPPS_TENANT_ID || env.AZURE_TENANT_ID;
  const clientId = env.POWERAPPS_CLIENT_ID || env.AZURE_CLIENT_ID;
  const clientSecret = env.POWERAPPS_CLIENT_SECRET || env.AZURE_CLIENT_SECRET;
  const snapshotDir = env.CN_SNAPSHOT_DIR || (env.HOME && fs.existsSync('/home/site') ? '/home/data/cn-snapshots' : path.join(os.tmpdir(), 'cn-snapshots'));
  return { orgUrl, tenantId, clientId, clientSecret, snapshotDir };
}

function createDataverseClient(cfg, fetchImpl = globalThis.fetch) {
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
  async function call(action, body) {
    const r = await fetchImpl(`${cfg.orgUrl}/api/data/v9.2/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`Dataverse ${action} ${r.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }
  return {
    async exportSolution(solutionName) {
      const j = await call('ExportSolution', { SolutionName: solutionName, Managed: false });
      return Buffer.from(j.ExportSolutionFile, 'base64');
    },
    async importSolution(buf) {
      const importJobId = crypto.randomUUID();
      await call('ImportSolution', { CustomizationFile: buf.toString('base64'), OverwriteUnmanagedCustomizations: true, PublishWorkflows: true, ImportJobId: importJobId });
      return importJobId;
    },
    async publishAll() { await call('PublishAllXml', {}); },
  };
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function findMsapps(outer, appFilter) {
  const apps = outer.filter((e) => /\.msapp$/i.test(e.name));
  if (!apps.length) throw new Error('No canvas app (.msapp) found in solution');
  if (!appFilter) {
    if (apps.length > 1) throw new Error(`Solution has ${apps.length} canvas apps; specify appFile (one of: ${apps.map((a) => a.name).join(', ')})`);
    return apps[0];
  }
  const hit = apps.filter((a) => a.name.toLowerCase().includes(String(appFilter).toLowerCase()));
  if (hit.length !== 1) throw new Error(`appFile "${appFilter}" matched ${hit.length} apps (${apps.map((a) => a.name).join(', ')})`);
  return hit[0];
}

function sepOf(entries) { return entries.some((e) => e.name.includes('\\')) ? '\\' : '/'; }
const norm = (n) => n.replace(/\\/g, '/');

function countOf(hay, needle) {
  if (!needle.length) return 0;
  let n = 0; let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function applyTextEdits(inner, edits) {
  const report = [];
  for (const [idx, ed] of edits.entries()) {
    if (typeof ed.find !== 'string' || !ed.find.length || typeof ed.replace !== 'string') throw new Error(`edits[${idx}] needs non-empty "find" and string "replace"`);
    const f = Buffer.from(ed.find, 'utf8');
    const files = {};
    for (const e of inner) {
      if (ed.file && !norm(e.name).toLowerCase().includes(norm(ed.file).toLowerCase())) continue;
      const c = countOf(e.data, f);
      if (!c) continue;
      e.data = Buffer.from(e.data.toString('utf8').split(ed.find).join(ed.replace), 'utf8');
      files[norm(e.name)] = c;
    }
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    if (!total) throw new Error(`edits[${idx}] "find" text not found${ed.file ? ` in ${ed.file}` : ''}; nothing was changed`);
    if (Number.isInteger(ed.expectCount) && ed.expectCount !== total) throw new Error(`edits[${idx}] expected ${ed.expectCount} matches but found ${total}; nothing was changed`);
    report.push({ index: idx, matches: total, files });
  }
  return report;
}

async function loadImage(img, fetchImpl) {
  let data; let type = img.contentType;
  if (img.base64) data = Buffer.from(String(img.base64).replace(/^data:([^;]+);base64,/, (m, t) => { type = type || t; return ''; }), 'base64');
  else if (img.url) {
    if (!/^https:\/\//i.test(img.url)) throw new Error('image url must be https');
    const r = await fetchImpl(img.url);
    if (!r.ok) throw new Error(`image download failed ${r.status}`);
    type = type || (r.headers.get('content-type') || '').split(';')[0];
    data = Buffer.from(await r.arrayBuffer());
  } else throw new Error('image needs base64 or url');
  if (!data.length || data.length > MAX_IMAGE_BYTES) throw new Error(`image size ${data.length} bytes is outside 1..${MAX_IMAGE_BYTES}`);
  if (!type) {
    if (data[0] === 0x89 && data[1] === 0x50) type = 'image/png';
    else if (data[0] === 0xff && data[1] === 0xd8) type = 'image/jpeg';
    else if (data.subarray(0, 3).toString() === 'GIF') type = 'image/gif';
    else if (/<svg/i.test(data.subarray(0, 512).toString())) type = 'image/svg+xml';
  }
  const ext = IMAGE_EXT[(type || '').toLowerCase()];
  if (!ext) throw new Error(`unsupported image type "${type}"`);
  return { data, ext };
}

async function applyImages(inner, images, fetchImpl) {
  if (!images || !images.length) return [];
  const sep = sepOf(inner);
  const resEntry = inner.find((e) => /(^|[\\/])References[\\/]Resources\.json$/i.test(e.name));
  if (!resEntry) throw new Error('References/Resources.json not found in app');
  const resJson = JSON.parse(resEntry.data.toString('utf8').replace(/^\uFEFF/, ''));
  const list = resJson.Resources || [];
  const report = [];
  for (const [idx, img] of images.entries()) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(img.name || '')) throw new Error(`images[${idx}].name must be letters/digits/underscore, starting with a letter`);
    const { data, ext } = await loadImage(img, fetchImpl);
    const existing = list.find((r) => r.Name === img.name);
    if (existing) {
      if (existing.ResourceKind && existing.ResourceKind !== 'LocalFile') throw new Error(`resource "${img.name}" is not a local file and cannot be replaced`);
      const oldPath = norm(existing.Path || '');
      const target = inner.find((e) => norm(e.name) === oldPath);
      const newPath = oldPath.replace(/\.[^.\/]+$/, '') + ext;
      if (target) { target.data = data; target.name = newPath.split('/').join(sep); target.nameBuf = undefined; }
      else inner.push({ name: newPath.split('/').join(sep), data });
      existing.Path = newPath.split('/').join('\\');
      if (existing.FileName) existing.FileName = path.posix.basename(newPath);
      report.push({ name: img.name, action: 'replaced', path: newPath, bytes: data.length, sha256: sha(data) });
    } else {
      const tmpl = list.find((r) => r.Content === 'Image' && (r.ResourceKind || 'LocalFile') === 'LocalFile');
      const rel = `Assets/Images/${crypto.randomUUID()}${ext}`;
      const entry = tmpl ? JSON.parse(JSON.stringify(tmpl)) : { Type: 'ResourceInfo', Schema: 'i', Content: 'Image', IsSampleData: false, IsWritable: false, ResourceKind: 'LocalFile' };
      entry.Name = img.name;
      entry.Path = rel.split('/').join('\\');
      entry.FileName = `${img.name}${ext}`;
      entry.Content = 'Image';
      entry.ResourceKind = 'LocalFile';
      entry.IsSampleData = false;
      list.push(entry);
      inner.push({ name: rel.split('/').join(sep), data });
      report.push({ name: img.name, action: 'added', path: rel, bytes: data.length, sha256: sha(data), templateUsed: !!tmpl });
    }
  }
  resJson.Resources = list;
  resEntry.data = Buffer.from(JSON.stringify(resJson), 'utf8');
  return report;
}

function saveSnapshot(dir, solutionName, buf) {
  fs.mkdirSync(dir, { recursive: true });
  const id = `${solutionName}_${new Date().toISOString().replace(/[:.]/g, '-')}_${sha(buf).slice(0, 12)}`;
  fs.writeFileSync(path.join(dir, `${id}.zip`), buf);
  return id;
}

function innerOf(solutionBuf, appFile) {
  const outer = readZip(solutionBuf);
  const app = findMsapps(outer, appFile);
  return { outer, app, inner: readZip(app.data) };
}

async function readApp({ solutionName, appFile, search, file, maxResults = 20 }, deps = {}) {
  if (!solutionName) throw new Error('solutionName is required');
  const dv = deps.client || createDataverseClient(settings(deps.env), deps.fetch);
  const buf = await dv.exportSolution(solutionName);
  const { app, inner } = innerOf(buf, appFile);
  const files = inner.map((e) => ({ name: norm(e.name), bytes: e.data.length }));
  const matches = [];
  if (search) {
    for (const e of inner) {
      if (file && !norm(e.name).toLowerCase().includes(norm(file).toLowerCase())) continue;
      if (!/\.(json|ya?ml|txt|xml)$/i.test(e.name)) continue;
      const lines = e.data.toString('utf8').split(/\r?\n/);
      lines.forEach((ln, i) => { if (matches.length < maxResults && ln.includes(search)) matches.push({ file: norm(e.name), line: i + 1, text: ln.slice(0, 400) }); });
    }
  } else if (file) {
    const e = inner.find((x) => norm(x.name).toLowerCase() === norm(file).toLowerCase() || norm(x.name).toLowerCase().endsWith('/' + norm(file).toLowerCase()));
    if (!e) throw new Error(`file "${file}" not found in app`);
    return { app: app.name, file: norm(e.name), content: e.data.toString('utf8').slice(0, 60000) };
  }
  return { app: app.name, solutionSha256: sha(buf), fileCount: files.length, files: search ? undefined : files, matches: search ? matches : undefined };
}

async function applyEdit({ solutionName, appFile, edits = [], images = [], dryRun = false }, deps = {}) {
  if (!solutionName) throw new Error('solutionName is required');
  if (!edits.length && !images.length) throw new Error('nothing to change: provide edits and/or images');
  const cfg = settings(deps.env);
  const fetchImpl = deps.fetch || globalThis.fetch;
  const dv = deps.client || createDataverseClient(cfg, fetchImpl);
  const t0 = Date.now();
  const before = await dv.exportSolution(solutionName);
  const snapshotId = saveSnapshot(deps.snapshotDir || cfg.snapshotDir, solutionName, before);
  const { outer, app, inner } = innerOf(before, appFile);
  const editReport = applyTextEdits(inner, edits);
  const imageReport = await applyImages(inner, images, fetchImpl);
  app.data = writeZip(inner);
  const after = writeZip(outer);
  // self-check: package reopens
  innerOf(after, appFile);
  if (dryRun) return { status: 'dry_run', snapshotId, app: app.name, edits: editReport, images: imageReport, elapsedMs: Date.now() - t0 };
  const importJobId = await dv.importSolution(after);
  await dv.publishAll();
  const verifyBuf = await dv.exportSolution(solutionName);
  const v = innerOf(verifyBuf, appFile).inner;
  const checks = [];
  for (const [idx, ed] of edits.entries()) {
    const present = v.reduce((n, e) => n + (ed.replace.length ? countOf(e.data, Buffer.from(ed.replace)) : 0), 0);
    const remaining = ed.replace.includes(ed.find) ? 0 : v.reduce((n, e) => n + countOf(e.data, Buffer.from(ed.find)), 0);
    checks.push({ edit: idx, replacePresent: ed.replace.length ? present > 0 : true, findRemaining: remaining, ok: (ed.replace.length ? present > 0 : true) && remaining === 0 });
  }
  for (const im of imageReport) {
    const e = v.find((x) => norm(x.name) === im.path);
    checks.push({ image: im.name, ok: !!e && sha(e.data) === im.sha256 });
  }
  const verified = checks.every((c) => c.ok);
  return {
    status: verified ? 'published_verified' : 'published_verify_failed',
    verified, snapshotId, importJobId, app: app.name, edits: editReport, images: imageReport, checks,
    note: 'Imported as unmanaged solution and published (PublishAllXml). Rollback with powerapps_solution_rollback {snapshotId}.',
    elapsedMs: Date.now() - t0,
  };
}

async function rollback({ snapshotId }, deps = {}) {
  if (!/^[A-Za-z0-9_\-]+$/.test(snapshotId || '')) throw new Error('valid snapshotId required');
  const cfg = settings(deps.env);
  const file = path.join(deps.snapshotDir || cfg.snapshotDir, `${snapshotId}.zip`);
  if (!fs.existsSync(file)) throw new Error(`snapshot ${snapshotId} not found`);
  const dv = deps.client || createDataverseClient(cfg, deps.fetch);
  const importJobId = await dv.importSolution(fs.readFileSync(file));
  await dv.publishAll();
  return { status: 'rolled_back', snapshotId, importJobId };
}

function listSnapshots(deps = {}) {
  const dir = deps.snapshotDir || settings(deps.env).snapshotDir;
  if (!fs.existsSync(dir)) return { snapshots: [] };
  return { snapshots: fs.readdirSync(dir).filter((f) => f.endsWith('.zip')).sort().reverse().slice(0, 30).map((f) => f.replace(/\.zip$/, '')) };
}

module.exports = { applyEdit, readApp, rollback, listSnapshots, settings, createDataverseClient, _internal: { applyTextEdits, applyImages, findMsapps } };
