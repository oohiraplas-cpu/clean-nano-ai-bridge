const { execFile } = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const { STATE_CONTEXT_SCHEMA } = require('./stateContext');

function sourceUnavailable(reason) {
  const error = new Error('Power Apps実ソースを取得できません。');
  error.status = 503;
  error.payload = { status: 'source_unavailable', comparisonStatus: 'source_unavailable', reason };
  return error;
}
function validationBlocked(fields) {
  const error = new Error('Power Apps実ソースの対象照合に失敗しました。');
  error.status = 409;
  error.payload = { status: 'validation_blocked', comparisonStatus: 'validation_blocked', failures: fields };
  return error;
}

// PAC must not inherit the Bridge service principal or developer credentials.
// Fail closed until an explicit dedicated Managed Identity is configured.
function pacWorkerEnvironment(config, parent = process.env) {
  if (config.authMode !== 'managedIdentity') throw sourceUnavailable('pac_identity_not_configured');
  const clientId = config.managedIdentityClientId;
  if (clientId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId))
    throw sourceUnavailable('invalid_managed_identity_client_id');
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SYSTEMROOT', 'WINDIR', 'DOTNET_ROOT']) {
    if (typeof parent[key] === 'string') env[key] = parent[key];
  }
  // Require a dedicated PAC profile directory; never reuse Bridge's profile.
  if (typeof config.pacProfileHome !== 'string' || !path.isAbsolute(config.pacProfileHome))
    throw sourceUnavailable('pac_profile_not_configured');
  env.HOME = config.pacProfileHome;
  env.USERPROFILE = config.pacProfileHome;
  env.AZURE_TOKEN_CREDENTIALS = 'ManagedIdentityCredential';
  if (clientId) env.AZURE_CLIENT_ID = clientId;
  return env;
}

function runWorker(config, request) {
  const env = pacWorkerEnvironment(config);\n  return new Promise((resolve, reject) => {
    const child = execFile(config.pythonExecutable || 'python3',
      [path.join(__dirname, '../scripts/read_powerapps_source.py')],
      { timeout: config.timeoutMs || 100000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env },
      (error, stdout) => {
        if (error) return reject(sourceUnavailable('worker_unavailable_or_failed'));
        try { resolve(JSON.parse(stdout)); } catch { reject(sourceUnavailable('invalid_worker_response')); }
      });
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request));
    }
  });
}

class PowerAppsRuntimeSourceAdapter {
  constructor(config = {}, worker = runWorker) {
    this.config = config;
    this.worker = worker;
  }

  async getSourceFile(relativePath, { stateContext, assertStateContext } = {}) {
    // This callback is injected by the trusted dispatcher, never the MCP caller.
    if (typeof assertStateContext !== 'function') throw validationBlocked(['registered State Manager validation required']);
    assertStateContext();
    const config = this.config;
    const failures = [];
    for (const field of STATE_CONTEXT_SCHEMA.required) if (typeof stateContext?.[field] !== 'string' || !stateContext[field].trim()) failures.push(`${field}: missing`);
    if (stateContext?.appId !== config.appId) failures.push('appId: mismatch');
    if (stateContext?.environment !== config.environmentId) failures.push('environment: mismatch');
    if (stateContext?.branch !== config.canonicalBranch || stateContext?.canonicalBranch !== config.canonicalBranch) failures.push('branch: mismatch');
    if (!/^[a-f0-9]{40}$/.test(stateContext?.sha || '')) failures.push('sha: invalid');
    if (failures.length) throw validationBlocked(failures);
    if (config.mode !== 'pac') throw sourceUnavailable('adapter_not_configured');
    const entry = config.sourceMap?.[relativePath];
    if (typeof entry !== 'string' || !/^Src[\\/].+\.pa\.yaml$/.test(entry) ||
        entry.split(/[\\/]/).some(part => !part || part === '.' || part === '..') || entry.includes('\0')) throw sourceUnavailable('source_mapping_not_configured');
    let observed;
    try {
      observed = await this.worker(config, { appId: config.appId, environment: config.environmentId,
        entry, pacExecutable: config.pacExecutable || 'pac', timeoutSeconds: 45 });
    } catch (error) {
      const reason = error.payload?.reason;
      throw sourceUnavailable(['worker_unavailable_or_failed', 'invalid_worker_response'].includes(reason) ? reason : 'source_read_failed');
    }
    assertStateContext();
    if (observed?.status !== 'ok') throw sourceUnavailable(['pac_unavailable', 'pac_timeout', 'app_not_found_in_environment', 'download_missing', 'unsupported_encoding'].includes(observed?.reason) ? observed.reason : 'source_read_failed');
    if (observed.appId !== stateContext.appId || observed.environment !== stateContext.environment || observed.entry !== entry) throw validationBlocked(['observed runtime source target mismatch']);
    if (typeof observed.content !== 'string' || Buffer.byteLength(observed.content) > 2 * 1024 * 1024) throw sourceUnavailable('invalid_source_content');
    return { status: 'ok', content: observed.content, path: relativePath,
      appId: observed.appId, environment: observed.environment, branch: stateContext.branch,
      gitSha: stateContext.sha, correlationId: stateContext.correlationId,
      runtimeHash: crypto.createHash('sha256').update(observed.content).digest('hex'),
      encoding: observed.encoding, source: 'power-apps-saved-msapp', format: 'pa.yaml' };
  }
}

module.exports = { PowerAppsRuntimeSourceAdapter, sourceUnavailable, validationBlocked, pacWorkerEnvironment };
