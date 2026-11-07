#!/usr/bin/env node
'use strict';

// Azure（App Service）へのread-only診断。GitHub Actions から実行する想定（Lane F）。
// - 通信は /health・/mcp（initialize, tools/list, tools/call health_check）のみ。書込み・再起動はしない。
// - 認証鍵は環境変数で受け取り、値は出力しない。出力は HTTP ステータスと種別コードのみ。
// - 不正な接続先（https 以外、許可外ホスト）は通信前に拒否する。
// - 使い方: node scripts/azure-readonly-diagnostics.js <出力JSONパス>
//   環境変数: BRIDGE_BASE_URL（必須）, CN_MCP_API_KEY（任意・推奨）, MCP_API_KEY（任意・後方互換）

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_HOST_SUFFIXES = ['.azurewebsites.net'];
const TIMEOUT_MS = 15000;

function validateBaseUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return { ok: false, reasonCode: 'BASE_URL_INVALID' }; }
  if (url.protocol !== 'https:') return { ok: false, reasonCode: 'BASE_URL_NOT_HTTPS' };
  if (url.username || url.password || url.search || url.hash) return { ok: false, reasonCode: 'BASE_URL_HAS_EXTRA_PARTS' };
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) return { ok: false, reasonCode: 'BASE_URL_HOST_NOT_ALLOWED' };
  return { ok: true, origin: url.origin, reasonCode: null };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });

// 鍵の有無だけを返す。値は返さない。
function keyPresence(env) {
  return { CN_MCP_API_KEY: Boolean(env.CN_MCP_API_KEY), MCP_API_KEY: Boolean(env.MCP_API_KEY) };
}

async function callJson(fetchImpl, url, { method = 'GET', headers = {}, body } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { httpStatus: null, reasonCode: 'UNREACHABLE', json: null };
  }
  let json = null;
  try { json = await response.json(); } catch { json = null; }
  return { httpStatus: response.status, reasonCode: null, json };
}

async function runDiagnostics({ baseUrl, env = {}, fetchImpl = globalThis.fetch }) {
  const checked = validateBaseUrl(baseUrl);
  const report = { schema: 'clean-nano-azure-readonly-diagnostics/1', generatedAt: new Date().toISOString(), checks: [], keys: keyPresence(env) };
  if (!checked.ok) {
    report.checks.push({ name: 'base_url', status: 'FAIL', reasonCode: checked.reasonCode });
    report.status = 'FAIL';
    return report;
  }
  const origin = checked.origin;
  const apiKey = env.CN_MCP_API_KEY || env.MCP_API_KEY || '';
  if (!apiKey) {
    report.checks.push({ name: 'mcp_key_available', status: 'BLOCKED', reasonCode: 'KEY_NOT_PROVIDED' });
  }

  const health = await callJson(fetchImpl, `${origin}/health`);
  report.checks.push({ name: 'health_endpoint', status: health.httpStatus === 200 ? 'PASS' : 'FAIL', httpStatus: health.httpStatus, reasonCode: health.reasonCode });

  if (!apiKey) {
    report.status = 'BLOCKED';
    return report;
  }

  const mcpHeaders = { 'content-type': 'application/json', 'x-api-key': apiKey };
  const init = await callJson(fetchImpl, `${origin}/mcp`, { method: 'POST', headers: mcpHeaders, body: rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'readonly-diagnostics', version: '1' } }) });
  report.checks.push({ name: 'mcp_initialize', status: init.httpStatus === 200 && init.json?.result ? 'PASS' : 'FAIL', httpStatus: init.httpStatus, reasonCode: init.reasonCode || (init.httpStatus === 401 ? 'KEY_MISMATCH_OR_MISSING' : (init.httpStatus === 503 ? 'AUTH_NOT_CONFIGURED' : null)) });

  const list = await callJson(fetchImpl, `${origin}/mcp`, { method: 'POST', headers: mcpHeaders, body: rpc(2, 'tools/list') });
  const toolCount = Array.isArray(list.json?.result?.tools) ? list.json.result.tools.length : null;
  report.checks.push({ name: 'mcp_tools_list', status: list.httpStatus === 200 && toolCount !== null ? 'PASS' : 'FAIL', httpStatus: list.httpStatus, toolCount, reasonCode: list.reasonCode });

  const health2 = await callJson(fetchImpl, `${origin}/mcp`, { method: 'POST', headers: mcpHeaders, body: rpc(3, 'tools/call', { name: 'health_check', arguments: {} }) });
  const healthStatus = health2.json?.result?.structuredContent?.status ?? health2.json?.result?.structuredContent?.ok;
  report.checks.push({ name: 'mcp_health_check', status: health2.httpStatus === 200 && healthStatus ? 'PASS' : 'FAIL', httpStatus: health2.httpStatus, reasonCode: health2.reasonCode });

  report.status = report.checks.every((c) => c.status === 'PASS') ? 'PASS' : 'FAIL';
  return report;
}

// 秘密値が出力に含まれていないことを確認する（含まれていれば失敗）。
function assertNoSecretInReport(report, env) {
  const text = JSON.stringify(report);
  for (const value of [env.CN_MCP_API_KEY, env.MCP_API_KEY]) {
    if (value && text.includes(value)) throw new Error('report contains a secret value');
  }
  return true;
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) { process.stderr.write('usage: azure-readonly-diagnostics.js <output.json>\n'); process.exit(2); }
  const env = process.env;
  const report = await runDiagnostics({ baseUrl: env.BRIDGE_BASE_URL, env });
  assertNoSecretInReport(report, env);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`status=${report.status}\n`);
  process.exit(report.status === 'PASS' ? 0 : 1);
}

if (require.main === module) {
  main().catch(() => { process.stderr.write('diagnostics failed\n'); process.exit(1); });
}

module.exports = { runDiagnostics, validateBaseUrl, assertNoSecretInReport, keyPresence };
