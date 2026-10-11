// Generate connector discovery metadata from the server's authoritative tool registry.
// This script writes local contract files only; it never calls a remote service.
const fs = require('node:fs');
const path = require('node:path');
const { MCP_METHODS, MCP_PUBLIC_TOOLS } = require('../src/server');
const root = path.join(__dirname, '..');
const names = MCP_PUBLIC_TOOLS.map(tool => tool.name);
if (new Set(names).size !== names.length || [...MCP_METHODS].sort().join() !== [...names].sort().join()) {
  throw new Error('MCP dispatch and public tools differ');
}
const openapiPath = path.join(root, 'openapi.yaml');
const original = fs.readFileSync(openapiPath, 'utf8');
const marker = /(    McpInput:[\s\S]*?        method:\n          type: string\n          enum: )\[[^\n]*\]/;
if (!marker.test(original)) throw new Error('McpInput.method.enum not found');
fs.writeFileSync(openapiPath, original.replace(marker, (_, prefix) => `${prefix}[${MCP_METHODS.join(', ')}]`));
fs.writeFileSync(path.join(root, 'config/mcp-public-tools.json'), `${JSON.stringify({ tools: MCP_PUBLIC_TOOLS }, null, 2)}\n`);
console.log(`Synchronized ${names.length} MCP tool definitions; no remote changes.`);
