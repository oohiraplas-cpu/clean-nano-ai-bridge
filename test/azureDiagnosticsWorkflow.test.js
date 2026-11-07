'use strict';
// Lane F: Azure read-only 診断の静的検証とモック試験（実 Azure・実 Actions は実行しない）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const { runDiagnostics, validateBaseUrl, assertNoSecretInReport, keyPresence } = require('../scripts/azure-readonly-diagnostics');

const WF_PATH = path.join(__dirname, '..', '.github', 'workflows', 'azure-readonly-diagnostics.yml');
const wfText = fs.readFileSync(WF_PATH, 'utf8');
const wf = yaml.load(wfText);
const SECRET = 'secret-lane-f-value-ZZZZ6001';
const BASE = 'https://clean-nano-ai-bridge-c7evcxhtergad9b0.westus3-01.azurewebsites.net';

// ---------- 静的検証（ワークフロー） ----------

test('the workflow runs only on manual dispatch with read and OIDC permissions', () => {
  assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepEqual(wf.permissions, { contents: 'read', 'id-token': 'write' });
});

test('the workflow never restarts, deploys, creates or changes App Service settings', () => {
  const forbidden = [
    /az\s+webapp\s+restart/, /az\s+webapp\s+create/, /az\s+webapp\s+deployment/, /az\s+webapp\s+config\s+appsettings\s+set/,
    /az\s+resource\s+(create|delete|update)/, /az\s+group\s+create/, /webapps-deploy/, /az\s+webapp\s+stop/, /az\s+webapp\s+delete/
  ];
  for (const pattern of forbidden) assert.equal(pattern.test(wfText), false, String(pattern));
});

test('secrets are passed only through environment variables and never echoed', () => {
  const lines = wfText.split('\n');
  for (const line of lines) {
    if (/\$\{\{\s*secrets\./.test(line)) {
      assert.match(line, /^\s+(CN_MCP_API_KEY|MCP_API_KEY):\s+\$\{\{\s*secrets\.(CN_MCP_API_KEY|MCP_API_KEY)\s*\}\}\s*$/, `secret must be an env mapping: ${line}`);
    }
    assert.equal(/echo\s+.*\$\{\{\s*secrets\./.test(line), false, 'no secret echo');
    assert.equal(/echo\s+.*"\$(CN_MCP_API_KEY|MCP_API_KEY)"/.test(line), false, 'no env secret echo');
  }
  assert.equal(/set\s+-x/.test(wfText), false, 'no shell tracing that could print secrets');
});

test('setting values are never read: only setting names are listed', () => {
  assert.match(wfText, /az webapp config appsettings list[^\n]*--query "\[\]\.name"/);
  assert.equal(/az webapp config appsettings list(?![^\n]*--query "\[\]\.name")/.test(wfText), false);
});

test('the bridge check runs the read-only diagnostics script and uses only https', () => {
  assert.match(wfText, /node scripts\/azure-readonly-diagnostics\.js/);
  assert.match(wfText, /BRIDGE_BASE_URL="https:\/\/\$\{HOST\}"/);
});

test('artifacts are uploaded even when earlier steps fail, and retained for a short period', () => {
  const upload = wf.jobs.diagnose.steps.find((s) => s.uses && s.uses.startsWith('actions/upload-artifact'));
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with['retention-days'], 7);
});

test('the Azure login step does not fail the whole job, so the BLOCKED reason is reported', () => {
  const login = wf.jobs.diagnose.steps.find((s) => s.uses && s.uses.startsWith('azure/login'));
  assert.equal(login['continue-on-error'], true);
});

test('the log step discards logs when a configured key value appears in them', () => {
  assert.match(wfText, /grep -q -F -- "\$V"/);
  assert.match(wfText, /logs discarded from artifact/);
});

test('the existing workflows are not modified by this change', () => {
  const others = fs.readdirSync(path.dirname(WF_PATH)).filter((f) => f !== 'azure-readonly-diagnostics.yml');
  assert.ok(others.length >= 5);
});

// ---------- 診断スクリプト（モック） ----------

function jsonRes(status, body) {
  return { status, json: async () => body };
}

function healthyFetch(seen = []) {
  return async (url, opts = {}) => {
    seen.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const u = String(url);
    if (u.endsWith('/health')) return jsonRes(200, { ok: true });
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (body.method === 'initialize') return jsonRes(200, { result: { protocolVersion: '2025-06-18' } });
    if (body.method === 'tools/list') return jsonRes(200, { result: { tools: new Array(56).fill({ name: 'x' }) } });
    if (body.method === 'tools/call') return jsonRes(200, { result: { structuredContent: { status: 'PASS', ok: true } } });
    return jsonRes(400, {});
  };
}

test('URL validation accepts only https App Service hosts with no extra parts', () => {
  assert.equal(validateBaseUrl(BASE).ok, true);
  assert.equal(validateBaseUrl('http://x.azurewebsites.net').reasonCode, 'BASE_URL_NOT_HTTPS');
  assert.equal(validateBaseUrl('https://example.com').reasonCode, 'BASE_URL_HOST_NOT_ALLOWED');
  assert.equal(validateBaseUrl('https://x.azurewebsites.net/mcp').ok, true, 'a path is allowed but ignored');
  assert.equal(validateBaseUrl('https://u:p@x.azurewebsites.net').reasonCode, 'BASE_URL_HAS_EXTRA_PARTS');
  assert.equal(validateBaseUrl('https://x.azurewebsites.net?x=1').reasonCode, 'BASE_URL_HAS_EXTRA_PARTS');
  assert.equal(validateBaseUrl('not a url').reasonCode, 'BASE_URL_INVALID');
});

test('without a key the diagnostics stop after /health and report BLOCKED with no key value', async () => {
  const seen = [];
  const report = await runDiagnostics({ baseUrl: BASE, env: {}, fetchImpl: healthyFetch(seen) });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(seen.length, 1);
  assert.equal(report.checks.find((c) => c.name === 'mcp_key_available').reasonCode, 'KEY_NOT_PROVIDED');
});

test('with a key, initialize, tools/list and health_check run in order and pass', async () => {
  const seen = [];
  const report = await runDiagnostics({ baseUrl: BASE, env: { CN_MCP_API_KEY: SECRET }, fetchImpl: healthyFetch(seen) });
  assert.equal(report.status, 'PASS');
  assert.deepEqual(report.checks.map((c) => c.name), ['health_endpoint', 'mcp_initialize', 'mcp_tools_list', 'mcp_health_check']);
  assert.equal(report.checks.find((c) => c.name === 'mcp_tools_list').toolCount, 56);
  assert.equal(seen.filter((s) => s.method === 'POST').length, 3);
  assert.equal(seen.filter((s) => s.method === 'POST').every((s) => s.headers['x-api-key'] === SECRET), true);
});

test('the report never contains the key value, even when the key is echoed back by the service', async () => {
  const echoing = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (String(url).endsWith('/health')) return jsonRes(200, { ok: true });
    return jsonRes(200, { result: { echo: SECRET, tools: [], structuredContent: { status: 'PASS' } }, error: null, leaked: SECRET, method: body.method });
  };
  const report = await runDiagnostics({ baseUrl: BASE, env: { CN_MCP_API_KEY: SECRET }, fetchImpl: echoing });
  assert.equal(JSON.stringify(report).includes(SECRET), false);
  assert.throws(() => assertNoSecretInReport({ leaked: SECRET }, { CN_MCP_API_KEY: SECRET }), /secret value/);
});

test('a 401 is reported as a key mismatch or missing key, with the status code only', async () => {
  const rejecting = async (url, opts = {}) => {
    if (String(url).endsWith('/health')) return jsonRes(200, {});
    return jsonRes(401, { error: '認証に失敗しました' });
  };
  const report = await runDiagnostics({ baseUrl: BASE, env: { CN_MCP_API_KEY: SECRET }, fetchImpl: rejecting });
  assert.equal(report.status, 'FAIL');
  const init = report.checks.find((c) => c.name === 'mcp_initialize');
  assert.equal(init.httpStatus, 401);
  assert.equal(init.reasonCode, 'KEY_MISMATCH_OR_MISSING');
});

test('a 503 from /mcp is reported as AUTH_NOT_CONFIGURED', async () => {
  const unconfigured = async (url) => (String(url).endsWith('/health') ? jsonRes(200, {}) : jsonRes(503, {}));
  const report = await runDiagnostics({ baseUrl: BASE, env: { CN_MCP_API_KEY: SECRET }, fetchImpl: unconfigured });
  assert.equal(report.checks.find((c) => c.name === 'mcp_initialize').reasonCode, 'AUTH_NOT_CONFIGURED');
});

test('an unreachable host is reported as UNREACHABLE without throwing', async () => {
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const report = await runDiagnostics({ baseUrl: BASE, env: { CN_MCP_API_KEY: SECRET }, fetchImpl: down });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.checks[0].reasonCode, 'UNREACHABLE');
});

test('key presence is reported by name only', () => {
  assert.deepEqual(keyPresence({ CN_MCP_API_KEY: SECRET }), { CN_MCP_API_KEY: true, MCP_API_KEY: false });
  assert.equal(JSON.stringify(keyPresence({ CN_MCP_API_KEY: SECRET })).includes(SECRET), false);
});

test('an invalid base URL stops before any request is sent', async () => {
  const seen = [];
  const report = await runDiagnostics({ baseUrl: 'http://example.com', env: { CN_MCP_API_KEY: SECRET }, fetchImpl: healthyFetch(seen) });
  assert.equal(report.status, 'FAIL');
  assert.equal(seen.length, 0);
});
