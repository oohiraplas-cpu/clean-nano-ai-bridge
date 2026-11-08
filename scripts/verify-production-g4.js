#!/usr/bin/env node
'use strict';
/**
 * Production G4 verification (read-only, zero additional cost).
 *
 * Checks an already-deployed Bridge instance: health, MCP initialize/tools-list,
 * Windows Executor heartbeat, and (if SharePoint is configured on the server) a
 * read-only SharePoint list lookup. It never writes, publishes, deploys, changes
 * permissions, or spends money. It never prints a secret: MCP_API_KEY/CONNECTOR_API_KEY
 * are read from the environment and used only as Authorization headers.
 *
 * Usage (secrets come from your existing deployment environment, never from this file):
 *   BRIDGE_BASE_URL=https://<your-app>.azurewebsites.net MCP_API_KEY=*** node scripts/verify-production-g4.js
 *
 * Exit code: 0 only if every check that could run is PASS. Any FAIL or UNVERIFIED -> exit 1,
 * so this is safe to wire into a CI gate without it ever silently reporting success.
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = (process.env.BRIDGE_BASE_URL || '').replace(/\/+$/, '');
const MCP_API_KEY = process.env.MCP_API_KEY || '';
const EXECUTOR_ID = process.env.VERIFY_EXECUTOR_ID || 'cnai-g4-verify';

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail: detail ?? null, timestamp: new Date().toISOString() });
}

async function callMcp(method, params) {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${MCP_API_KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body is reported via httpStatus */ }
  return { httpStatus: res.status, body };
}

async function run() {
  if (!BASE_URL) {
    record('config', 'FAIL', 'BRIDGE_BASE_URL is not set. Nothing was contacted.');
    return finish();
  }

  // 1. health
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json().catch(() => null);
    record('health', res.status === 200 && body?.status === 'ok' ? 'PASS' : 'FAIL', { httpStatus: res.status, body });
  } catch (err) {
    record('health', 'FAIL', { error: err.message });
  }

  if (!MCP_API_KEY) {
    record('mcp_initialize', 'UNVERIFIED', 'MCP_API_KEY not provided to this script; cannot authenticate.');
    record('mcp_tools_list', 'UNVERIFIED', 'MCP_API_KEY not provided to this script; cannot authenticate.');
  } else {
    // 2. MCP initialize
    try {
      const { httpStatus, body } = await callMcp('initialize', {});
      const ok = httpStatus === 200 && body?.result?.serverInfo?.name;
      record('mcp_initialize', ok ? 'PASS' : 'FAIL', { httpStatus, serverInfo: body?.result?.serverInfo || null, error: body?.error || null });
    } catch (err) {
      record('mcp_initialize', 'FAIL', { error: err.message });
    }

    // 3. MCP tools/list
    try {
      const { httpStatus, body } = await callMcp('tools/list', {});
      const toolCount = body?.result?.tools?.length;
      record('mcp_tools_list', httpStatus === 200 && Number.isInteger(toolCount) && toolCount > 0 ? 'PASS' : 'FAIL', { httpStatus, toolCount: toolCount ?? null });
    } catch (err) {
      record('mcp_tools_list', 'FAIL', { error: err.message });
    }

    // 4. Windows Executor heartbeat (read/registration only — submits no job)
    try {
      const res = await fetch(`${BASE_URL}/executor/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${MCP_API_KEY}` },
        body: JSON.stringify({ executorId: EXECUTOR_ID, status: 'idle' })
      });
      const body = await res.json().catch(() => null);
      record('windows_executor_heartbeat', res.status === 200 && body?.status === 'OK' ? 'PASS' : (res.status === 503 ? 'UNVERIFIED' : 'FAIL'),
        { httpStatus: res.status, body });
    } catch (err) {
      record('windows_executor_heartbeat', 'FAIL', { error: err.message });
    }

    // 5. SharePoint — read-only connectivity check only. This is NOT a write round-trip:
    // per COST_GATE / destructive-action rules this script never writes, so a full
    // save->reread round-trip is out of scope for an unattended verification run.
    try {
      const { httpStatus, body } = await callMcp('tools/call', { name: 'list_sharepoint_lists', arguments: {} });
      const isError = body?.result?.isError;
      if (httpStatus === 200 && isError === false) {
        record('sharepoint_readonly_check', 'PASS', { httpStatus, note: 'list_sharepoint_lists succeeded (read-only; not a write round-trip)' });
      } else {
        record('sharepoint_readonly_check', 'UNVERIFIED', { httpStatus, result: body?.result || body?.error || null });
      }
    } catch (err) {
      record('sharepoint_readonly_check', 'UNVERIFIED', { error: err.message });
    }

    // 6. Audit log reachability (read-only)
    try {
      const { httpStatus, body } = await callMcp('tools/call', { name: 'export_evidence', arguments: {} });
      const isError = body?.result?.isError;
      record('audit_log_reachable', httpStatus === 200 && isError === false ? 'PASS' : 'UNVERIFIED', { httpStatus, isError: isError ?? null });
    } catch (err) {
      record('audit_log_reachable', 'UNVERIFIED', { error: err.message });
    }
  }

  return finish();
}

function finish() {
  const summary = {
    baseUrl: BASE_URL || null,
    generatedAt: new Date().toISOString(),
    additionalBilling: '0円（書込み・公開・デプロイ・課金系操作は一切実行しません）',
    rollback: 'このスクリプトは読み取り専用（Windows Executorへのheartbeatのみ）です。副作用はExecutorレコードの一時更新のみで、Bridge再起動または次回register呼び出しで自然に上書きされます。元に戻す操作は不要です。',
    results,
    overall: results.some((r) => r.status === 'FAIL') ? 'FAIL'
      : results.some((r) => r.status === 'UNVERIFIED') ? 'PARTIAL_UNVERIFIED'
      : 'PASS'
  };

  const outPath = path.join(__dirname, '..', `verification-result-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n結果を保存しました: ${outPath}`);
  process.exitCode = summary.overall === 'PASS' ? 0 : 1;
}

run();
