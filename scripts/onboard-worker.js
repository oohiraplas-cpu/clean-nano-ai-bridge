#!/usr/bin/env node
'use strict';
// Runs src/onboardWorker.js against the production /mcp endpoint.
// Env: BASE_URL, KEY (never printed), DISPLAY_NAME, EMAIL, DRY_RUN ("true" by default), ENABLE_NOW ("false" by default), APPROVER.
// The report contains no password and no token.
const { onboardWorker } = require('../src/onboardWorker');

async function call(tool, args) {
  let res;
  try {
    res = await fetch(process.env.BASE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    return { ok: false, inner: null, error: `network: ${e.name}` };
  }
  let body;
  try { body = await res.json(); } catch (_) { return { ok: false, inner: null, error: `HTTP ${res.status}, not JSON` }; }
  const result = body.result || body;
  const sc = (result && result.structuredContent) || result;
  if (res.status !== 200 || (result && result.isError)) {
    const msg = (sc && (sc.error || (sc.data && sc.data.error))) || `HTTP ${res.status}`;
    return { ok: false, inner: null, error: String(msg).slice(0, 300) };
  }
  const inner = (sc && sc.data && sc.data.data) || (sc && sc.data) || null;
  return { ok: true, inner, error: null };
}

(async () => {
  const dryRun = (process.env.DRY_RUN || 'true') !== 'false';
  const enableNow = process.env.ENABLE_NOW === 'true';
  const report = await onboardWorker({ displayName: process.env.DISPLAY_NAME, email: process.env.EMAIL }, call, { dryRun, enableNow, approver: process.env.APPROVER || 'owner' });
  console.log(JSON.stringify(report, null, 2));
  const okStatuses = new Set(['dry_run_ok', 'completed']);
  process.exit(okStatuses.has(report.status) ? 0 : 1);
})();
