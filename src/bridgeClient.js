'use strict';
// Minimal client for the Bridge /mcp endpoint, used by the repository scripts that run inside GitHub Actions.
// Env: BASE_URL, KEY (the MCP key; it is sent as a header and never printed or returned).
// Resolves to { ok, inner, error } where `inner` is the tool's own data object (structuredContent.data.data).
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

module.exports = { call };
