'use strict';
// Local-only MCP endpoint diagnostic (task D). Never touches a real deployment.
// Generates a throwaway in-process key, never logs or persists it.
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { getConfig } = require('../src/config');

async function main() {
  const key = crypto.randomBytes(24).toString('hex');
  const config = getConfig({ WEBHOOK_API_KEY: 'diag-hook-key', MCP_API_KEY: key, TASKS_FILE: 'data/tasks.diagnose.json' });
  const server = createApp(config).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];

  async function check(label, fn) {
    try {
      const r = await fn();
      results.push({ label, ...r });
    } catch (err) {
      results.push({ label, error: err.message });
    }
  }

  await check('1. GET /health (no auth)', async () => {
    const res = await fetch(`${base}/health`);
    return { status: res.status, body: await res.json() };
  });

  await check('2. POST /mcp initialize (no auth) -> expect 401, not 404', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    return { status: res.status, body: await res.json() };
  });

  await check('3. POST /mcp initialize (bad auth) -> expect 401', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    return { status: res.status, body: await res.json() };
  });

  await check('4. POST /mcp initialize (valid auth) -> expect 200', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
    return { status: res.status, body: await res.json() };
  });

  await check('5. POST /mcp tools/list (valid auth) -> expect 200 with tools[]', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const body = await res.json();
    return { status: res.status, toolCount: body.result?.tools?.length, firstTools: body.result?.tools?.slice(0, 3).map(t => t.name) };
  });

  await check('6. GET /mcp (wrong method) -> expect 405, not 404', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${key}` } });
    return { status: res.status, allow: res.headers.get('allow') };
  });

  await check('7. POST /mcp with trailing slash /mcp/ -> checking Express route matching', async () => {
    const res = await fetch(`${base}/mcp/`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    return { status: res.status };
  });

  await check('8. POST /MCP (uppercase, case sensitivity) -> expect 404 (Express routes are case-sensitive by default)', async () => {
    const res = await fetch(`${base}/MCP`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    return { status: res.status };
  });

  await check('9. POST /nonexistent-route -> expect a real 404', async () => {
    const res = await fetch(`${base}/nonexistent-route`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return { status: res.status };
  });

  await check('10. POST /mcp with wrong Content-Type (text/plain) -> check body parsing behavior', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
    return { status: res.status, body: await res.text() };
  });

  console.log(JSON.stringify(results, null, 2));
  await new Promise((resolve) => server.close(resolve));
}

main().catch((err) => { console.error(err); process.exit(1); });
