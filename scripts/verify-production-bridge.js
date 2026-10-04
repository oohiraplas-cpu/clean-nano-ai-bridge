// Read-only Azure metadata and Bridge smoke tests. Never emit setting values or response bodies.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { MCP_PUBLIC_TOOLS } = require('../src/server');
const azure = (args, timeout = 30000) => JSON.parse(execFileSync('az', [...args, '--only-show-errors', '-o', 'json'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8000000 }));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function main() {
  const apps = azure(['webapp', 'list']);
  const app = apps.find(a => a.name === 'clean-nano-ai-bridge');
  if (!app) throw new Error('configured_app_not_found');
  const args = ['--name', app.name, '--resource-group', app.resourceGroup];
  const settings = Object.fromEntries(azure(['webapp', 'config', 'appsettings', 'list', ...args]).map(s => [s.name, s.value]));
  const sourceBranch = settings.POWERAPPS_GITHUB_BRANCH || 'main';
  const sourceRoot = settings.POWERAPPS_GITHUB_ROOT || 'powerapps/CN_AI依頼台帳/Source';
  const report = { verificationCommit: process.env.GITHUB_SHA, mode: process.env.VERIFICATION_MODE || 'smoke', azure: { name: app.name, state: app.state, host: app.defaultHostName }, settingsPresent: Object.keys(settings).filter(k => /^(POWERAPPS_|DEPLOY_|PERMISSIONS_|MCP_API_KEY|TASK_STORE_BACKEND|SHAREPOINT_|AZURE_)/.test(k)).sort(), sourceBranch, sourceRoot, health: null, initialize: null, tools: null, smoke: {}, availability: {}, mutations: [] };
  try { report.azure.deployments = azure(['webapp', 'log', 'deployment', 'list', ...args], 20000).slice(0, 3).map(d => ({ id: d.id, status: d.status, active: d.active, endTime: d.end_time })); } catch { report.azure.deploymentMetadata = 'access_denied_or_unavailable'; }
  const baseUrl = 'https://' + app.defaultHostName;
  const request = async (route, body) => {
    try {
      const response = await fetch(baseUrl + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(settings.MCP_API_KEY ? { 'X-API-Key': settings.MCP_API_KEY } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
      let data; try { data = await response.json(); } catch { data = null; }
      return { httpStatus: response.status, data };
    } catch { return { httpStatus: null, data: null }; }
  };
  const safe = r => {
    const s = r.data?.result?.structuredContent || r.data?.result || r.data;
    return { httpStatus: r.httpStatus, isError: r.data?.result?.isError === true || !!r.data?.error, status: typeof s?.status === 'string' && /^[a-z_]+$/.test(s.status) ? s.status : null, reason: typeof s?.reason === 'string' && /^[a-zA-Z0-9_ :.-]{1,150}$/.test(s.reason) ? s.reason : null, missingConfiguration: Array.isArray(s?.missingConfiguration) ? s.missingConfiguration.filter(k => /^[A-Z0-9_]+$/.test(k)) : [], ...(s?.summary ? { summary: s.summary } : {}), ...(s?.classification ? { classification: s.classification } : {}), ...(s?.recovery ? { recovery: { scope: s.recovery.scope, allowed: s.recovery.allowed, blockerCount: s.recovery.blockers?.length, applicationRecovery: s.recovery.applicationRecovery, excludedRuntimeDependencyCount: s.recovery.excludedRuntimeDependencyCount } } : {}) };
  };
  const call = async (name, params = {}) => {
    const r = await request('/mcp', { jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: params } });
    report.smoke[name] = safe(r);
    return r.data?.result?.structuredContent || null;
  };
  report.health = safe(await request('/health'));
  const init = await request('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'production-readonly-verifier', version: '1' } } });
  report.initialize = { httpStatus: init.httpStatus, protocolVersion: init.data?.result?.protocolVersion || null, success: !!init.data?.result?.capabilities };
  const listing = await request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const actual = listing.data?.result?.tools;
  report.tools = { httpStatus: listing.httpStatus, count: actual?.length || 0, names: actual?.map(t => t.name) || [], contractSha256: actual ? hash(actual) : null, first28MatchesCheckout: actual?.length >= 28 && hash(actual.slice(0, 28)) === hash(MCP_PUBLIC_TOOLS.slice(0, 28)), matchesCheckout: actual && hash(actual) === hash(MCP_PUBLIC_TOOLS) };
  console.log('::notice title=Production Bridge publication evidence::' + JSON.stringify({ azure: report.azure, health: report.health, initialize: report.initialize, tools: report.tools }));
  if (report.mode !== 'baseline' && actual) {
    await call('health_check');
    const appInfo = await call('get_powerapps_app');
    report.appMetadata = appInfo ? { appId: appInfo.appId, displayName: appInfo.displayName, hasWarning: !!appInfo.warning } : null;
    await call('get_powerapps_state');
    const source = await call('get_powerapps_source', { relativePath: 'App.pa.yaml' });
    report.sourceMetadata = source ? { branch: source.branch, canonicalBranch: source.canonicalBranch, isCanonicalBranch: source.isCanonicalBranch, path: source.path, sha: source.sha, bytes: typeof source.content === 'string' ? Buffer.byteLength(source.content) : null } : null;
    if (actual.some(t => t.name === 'inspect_powerapps_structure')) await call('inspect_powerapps_structure', { branch: sourceBranch });
    if (actual.some(t => t.name === 'analyze_change_impact')) {
      if (source?.content && source.branch === sourceBranch) await call('analyze_change_impact', { branch: sourceBranch, changes: [{ relativePath: 'App.pa.yaml', content: source.content }] });
      else report.smoke.analyze_change_impact = { status: 'blocked', reason: 'canonical_source_unavailable' };
    }
    if (source?.content) await call('run_powerapps_tests', { files: [{ relativePath: 'App.pa.yaml', content: source.content }] });
    else report.smoke.run_powerapps_tests = { status: 'blocked', reason: 'source_unavailable' };
    await call('get_permissions', { targetType: 'powerapps_app' });
    if (actual.some(t => t.name === 'create_change_snapshot')) {
      if (settings.POWERAPPS_SNAPSHOT_DIR && report.smoke.inspect_powerapps_structure?.recovery?.allowed) {
        await call('create_change_snapshot', { branch: sourceBranch, recoveryScope: 'source_files_only' });
      } else report.smoke.create_change_snapshot = { status: 'blocked', reason: 'explicit_safe_snapshot_directory_or_source_recovery_not_available' };
    }
    await call('get_tasks');
    await call('get_next_task');
    // Every unexercised tool stays unverified; names being published never establishes readiness.
    for (const t of actual) {
      const smoke = report.smoke[t.name];
      report.availability[t.name] = smoke?.status === 'not_configured' ? 'not_configured' : smoke?.status === 'blocked' || (smoke && (smoke.httpStatus !== 200 || (smoke.isError && smoke.status !== 'incomplete'))) ? 'blocked' : smoke ? 'ready' : 'mock_verified_only';
    }
  }
  const gate = report.health?.httpStatus === 200 && report.health.status === 'ok' && report.initialize.success && (report.mode === 'baseline' || report.tools.matchesCheckout === true);
  report.publicationGatePassed = gate;
  console.log('::notice title=Production Bridge evidence::' + JSON.stringify(report));
  if (!gate) process.exitCode = 1;
}
main().catch(() => { console.error('::error::Production verification could not read Azure metadata or complete safe requests; no setting values or response bodies emitted.'); process.exitCode = 1; });
