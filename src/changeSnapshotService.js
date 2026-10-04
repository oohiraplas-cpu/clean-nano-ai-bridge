const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { canonical, sha256, assertNoSecrets, stop } = require('./powerAppsStructureService');
const { notConfiguredError } = require('./errors');
const run = promisify(execFile);

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
      return envelope;
    } catch (e) { if (e.code === 'ENOENT') throw e; stop('snapshot_tampered'); }
    finally { if (handle) await handle.close(); }
  }
  async create(params) {
    const loaded = await this.structureService.load(params.branch);
    const { bundle, structure } = loaded;
    // Fail before even making a snapshot directory if references cannot be safely resolved.
    if (structure.issues.length || structure.possible.length) stop('snapshot_analysis_incomplete', 422);
    let candidate = bundle.files;
    if (params.changes) {
      const evaluated = this.impactService.evaluate(loaded, params.changes);
      if (evaluated.report.issues.length || evaluated.report.possible.length) stop('snapshot_analysis_incomplete', 422);
      candidate = evaluated.files;
    }
    const sorted = files => [...files].sort((a, b) => a.relativePath.localeCompare(b.relativePath)).map(f => ({ relativePath: f.relativePath, content: f.content, sha256: sha256(f.content) }));
    const payload = { formatVersion: 1, scope: 'static_source_snapshot', branch: bundle.branch, commitSha: bundle.commitSha, before: sorted(bundle.files), after: sorted(candidate) };
    assertNoSecrets(payload, this.structureService.secrets);
    const snapshotId = sha256(canonical(payload));
    const directory = await this.safeDirectory();
    const finalPath = path.join(directory, `${snapshotId}.json`);
    const envelope = { snapshotId, algorithm: 'SHA-256', payload };
    try { await this.readVerified(finalPath, snapshotId); return this.result(snapshotId, true); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(canonical(envelope)); await handle.sync(); await handle.close(); handle = null;
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
    return this.result(snapshotId, false);
  }
  result(snapshotId, reused) {
    return { status: 'saved', snapshotId, algorithm: 'SHA-256', reused, scope: 'static_source_snapshot', runtimeVerified: false };
  }
}
module.exports = { ChangeSnapshotService };
