const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonical, sha256, assertNoSecrets, stop } = require('./powerAppsStructureService');
const { notConfiguredError } = require('./errors');
const run = promisify(execFile);
const comparePath = (a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;

function verifyManifest(payload) {
  if (!payload || payload.formatVersion !== 2 || payload.scope !== 'source_files_only' || !/^[0-9a-f]{40}$/i.test(payload.commitSha || '') || typeof payload.branch !== 'string') stop('snapshot_tampered');
  for (const side of ['before', 'after']) {
    const files = payload[side]; const receipt = payload.analysis?.[side];
    if (!Array.isArray(files) || !files.length || files.length > 100 || !receipt || receipt.recovery?.allowed !== true || receipt.recovery?.scope !== 'source_files_only' || receipt.issues.length) stop('snapshot_tampered');
    const paths = new Set(); let bytes = 0;
    for (const f of files) {
      if (!f || Object.keys(f).sort().join(',') !== 'bytes,content,relativePath,sha256' || typeof f.content !== 'string' || typeof f.relativePath !== 'string'
        || !/^[^\\:\x00-\x1f]+\.(?:yaml|yml|json)$/.test(f.relativePath) || f.relativePath.startsWith('/') || f.relativePath.split('/').some(p => !p || p === '.' || p === '..') || paths.has(f.relativePath)
        || f.bytes !== Buffer.byteLength(f.content) || f.sha256 !== sha256(f.content) || f.bytes > 1000000) stop('snapshot_tampered');
      paths.add(f.relativePath); bytes += f.bytes;
    }
    if (bytes > 4000000 || receipt.summary.files !== files.length || receipt.summary.bytes !== bytes || canonical([...files].sort(comparePath)) !== canonical(files)) stop('snapshot_tampered');
  }
}

class ChangeSnapshotService {
  constructor({ structureService, impactService, directory, repositoryRoot = process.cwd() }) {
    Object.assign(this, { structureService, impactService, directory, repositoryRoot: path.resolve(repositoryRoot) });
  }
  async safeDirectory() {
    if (!this.directory) throw notConfiguredError('snapshot_directory', ['POWERAPPS_SNAPSHOT_DIR']);
    const directory = path.resolve(this.directory);
    // Walk each existing component: following a symlink would escape the configured boundary.
    const parts = directory.split(path.sep).filter(Boolean);
    let current = path.parse(directory).root;
    for (const part of parts) {
      current = path.join(current, part);
      try { const st = await fs.lstat(current); if (!st.isDirectory() || st.isSymbolicLink()) stop('snapshot_path_unsafe'); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if (error.code !== 'EEXIST') stop('snapshot_path_unavailable', 500); }
        const st = await fs.lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink()) stop('snapshot_path_unsafe');
      }
    }
    if ((await fs.stat(directory)).mode & 0o077) stop('snapshot_directory_permissions');
    let gitRoot;
    try { gitRoot = (await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.trim(); }
    catch (error) { if (error.code !== 128 || !String(error.stderr).includes('not a git repository')) stop('snapshot_git_check_failed'); }
    if (gitRoot) {
      // Exclude paths must be ignored and contain no tracked files. Never modify gitignore here.
      try {
        const tracked = await run('git', ['-C', gitRoot, 'ls-files', '--', directory]);
        if (tracked.stdout.trim()) stop('snapshot_is_tracked');
        await run('git', ['-C', gitRoot, 'check-ignore', '-q', '--', path.join(directory, 'probe.json')]);
      } catch { stop('snapshot_not_git_ignored'); }
    }
    return directory;
  }
  async readVerified(file, id) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 12000000 || stat.mode & 0o077) stop('snapshot_tampered');
      const text = await handle.readFile('utf8');
      const envelope = JSON.parse(text);
      if (Object.keys(envelope).sort().join(',') !== 'algorithm,payload,snapshotId' || envelope.algorithm !== 'SHA-256'
        || envelope.snapshotId !== id || sha256(canonical(envelope.payload)) !== id
        || canonical(envelope) !== text) stop('snapshot_tampered');
      assertNoSecrets(envelope.payload, this.structureService.secrets);
      verifyManifest(envelope.payload);
      return envelope;
    } catch (e) { if (e.code === 'ENOENT') throw e; stop('snapshot_tampered'); }
    finally { if (handle) await handle.close(); }
  }
  async create(params) {
    if (params.recoveryScope !== undefined && params.recoveryScope !== 'source_files_only') stop('snapshot_recovery_scope_unsupported', 400);
    const loaded = await this.structureService.load(params.branch);
    const { bundle, structure } = loaded;
    // Runtime/schema/history dependencies do not prevent byte-for-byte source-file restoration.
    // They are retained as explicit exclusions; required source definitions still block recovery.
    if (!structure.recovery.allowed) stop('snapshot_analysis_incomplete', 422, { recovery: structure.recovery });
    let candidate = bundle.files;
    let after = structure;
    if (params.changes) {
      const evaluated = this.impactService.evaluate(loaded, params.changes);
      if (!evaluated.report.recovery.allowed) stop('snapshot_analysis_incomplete', 422, { recovery: evaluated.report.recovery });
      candidate = evaluated.files;
      after = evaluated.afterStructure;
    }
    const sorted = files => [...files].sort(comparePath).map(f => ({ relativePath: f.relativePath, content: f.content, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content) }));
    const receipt = s => ({ summary: s.summary, status: s.status, classification: s.classification, recovery: s.recovery, issues: s.issues, dependencies: s.dependencies.filter(d => d.resolution !== 'confirmed'), limitations: s.limitations });
    const payload = { formatVersion: 2, scope: 'source_files_only', branch: bundle.branch, commitSha: bundle.commitSha, source: bundle.source || null, before: sorted(bundle.files), after: sorted(candidate), analysis: { before: receipt(structure), after: receipt(after) } };
    verifyManifest(payload);
    assertNoSecrets(payload, this.structureService.secrets);
    const snapshotId = sha256(canonical(payload));
    const directory = await this.safeDirectory();
    const finalPath = path.join(directory, `${snapshotId}.json`);
    const envelope = { snapshotId, algorithm: 'SHA-256', payload };
    const text = canonical(envelope);
    if (Buffer.byteLength(text) > 12000000) stop('snapshot_size_limit', 413);
    try { await this.readVerified(finalPath, snapshotId); return this.result(snapshotId, true, structure, after); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
      // Atomic no-replace publication. A concurrent identical writer verifies the existing file.
      try { await fs.link(temporary, finalPath); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      await this.readVerified(finalPath, snapshotId);
      const dirHandle = await fs.open(directory, constants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch (e) {
      if (e.payload) throw e;
      stop('snapshot_save_failed', 500);
    } finally {
      if (handle) await handle.close();
      await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
    return this.result(snapshotId, false, structure, after);
  }
  result(snapshotId, reused, before, after) {
    return { status: 'saved', snapshotId, algorithm: 'SHA-256', reused, scope: 'source_files_only', runtimeVerified: false,
      sourceFileRecovery: 'verified', applicationRecovery: 'not_verified', analysisStatus: { before: before.status, after: after.status },
      excludedRuntimeDependencyCount: { before: before.recovery.excludedRuntimeDependencyCount, after: after.recovery.excludedRuntimeDependencyCount },
      exclusions: [...new Set([...before.recovery.exclusions, ...after.recovery.exclusions])].sort() };
  }
}
module.exports = { ChangeSnapshotService, verifyManifest };
