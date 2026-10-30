'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { MCP_PUBLIC_TOOLS, MCP_METHODS, PUBLISHED_TOOLS } = require('../src/server');
const { FACADES, resolveVisibleCall } = require('../src/toolVisibility');

const targetsOf = (facade) => Object.values(facade.ops).map((op) => op.tool);

test('published tools/list is under the CNAI limit (70) and within the recommended 50', () => {
  assert.ok(PUBLISHED_TOOLS.length < 70, `published ${PUBLISHED_TOOLS.length}`);
  assert.ok(PUBLISHED_TOOLS.length <= 50, `published ${PUBLISHED_TOOLS.length}`);
});

test('published tool names are unique and each consolidated tool has a strict operation schema', () => {
  const names = PUBLISHED_TOOLS.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  const consolidated = PUBLISHED_TOOLS.filter((tool) => FACADES.some((f) => f.name === tool.name));
  assert.equal(consolidated.length, FACADES.length);
  for (const tool of consolidated) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.required, ['operation']);
    assert.equal(tool.inputSchema.properties.operation.type, 'string');
    assert.ok(tool.inputSchema.properties.operation.enum.length > 0, tool.name);
  }
});

test('every facade target is a real Bridge tool that is dispatchable (no invented names)', () => {
  const catalog = new Set(MCP_PUBLIC_TOOLS.map((tool) => tool.name));
  const methods = new Set(MCP_METHODS);
  for (const facade of FACADES) {
    for (const target of targetsOf(facade)) {
      assert.ok(catalog.has(target), `${facade.name} -> ${target} is not in the catalog`);
      assert.ok(methods.has(target), `${facade.name} -> ${target} is not dispatchable`);
    }
  }
});

test('Canvas required capabilities are all reachable from the published surface', () => {
  const required = {
    canvas_resolve: ['targets'],
    canvas_read: ['app', 'state', 'source', 'screens', 'controls', 'powerfx', 'datasources', 'dependencies'],
    canvas_media: ['list', 'get', 'export', 'upload', 'replace', 'assign'],
    canvas_edit: ['screen_add', 'screen_edit', 'control_add', 'control_edit', 'powerfx_edit', 'datasource_add', 'datasource_edit'],
    canvas_save: ['save'],
    canvas_verify: ['save_result', 'change', 'reread', 'publish_verify'],
    canvas_publish: ['publish'],
    canvas_rollback: ['snapshots', 'rollback', 'restore'],
    audit_get: ['evidence'],
    system_health: ['health'],
  };
  for (const [facadeName, operations] of Object.entries(required)) {
    const facade = FACADES.find((f) => f.name === facadeName);
    assert.ok(facade, facadeName);
    for (const op of operations) assert.ok(facade.ops[op], `${facadeName}.${op}`);
  }
});

test('direct Canvas core tools are published under their own names with their internal schema', () => {
  const names = PUBLISHED_TOOLS.map((tool) => tool.name);
  for (const name of ['health_check', 'resolve_app_target', 'get_powerapps_app', 'get_powerapps_state', 'get_powerapps_source']) {
    assert.ok(names.includes(name), name);
    const internal = MCP_PUBLIC_TOOLS.find((tool) => tool.name === name);
    assert.deepEqual(PUBLISHED_TOOLS.find((tool) => tool.name === name), internal);
  }
});

test('a published call resolves to the internal target before any gate runs', () => {
  const args = { operation: 'assign', stateContext: { branch: 'main' }, stateSessionId: 'session-1', relativePath: 'x' };
  const resolved = resolveVisibleCall('canvas_media', args);
  assert.equal(resolved.name, 'powerapps_manage');
  assert.equal(resolved.args.operation, 'image_assign');
  assert.deepEqual(resolved.args.stateContext, { branch: 'main' });
  assert.equal(resolved.args.stateSessionId, 'session-1');
  assert.equal('assign' in resolved.args, false); // the caller's operation word is not forwarded as a key
});

test('fixed operation wins over caller input and the caller cannot pick a different operation', () => {
  const resolved = resolveVisibleCall('canvas_media', { operation: 'list', relativePaths: ['a.png'] });
  assert.equal(resolved.name, 'get_powerapps_media_asset');
  assert.equal(resolved.args.operation, 'list');
});

test('unknown or missing operations are refused without resolving to any tool', () => {
  for (const args of [{ operation: 'publish_everything' }, {}, { operation: 42 }, { operation: '__proto__' }]) {
    assert.throws(() => resolveVisibleCall('canvas_publish', args), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.payload.reasonCode, 'UNSUPPORTED_OPERATION');
      return true;
    });
  }
});

test('non-facade names pass through unchanged for existing and internal callers', () => {
  const args = { relativePath: 'x', stateContext: {} };
  assert.deepEqual(resolveVisibleCall('update_powerapps_image', args), { name: 'update_powerapps_image', args });
});

test('consolidated tools advertise their targets\' arguments as optional, so clients know what to send', () => {
  const byName = new Map(MCP_PUBLIC_TOOLS.map((tool) => [tool.name, tool]));
  const canvasRead = PUBLISHED_TOOLS.find((tool) => tool.name === 'canvas_read');
  const props = canvasRead.inputSchema.properties;
  for (const key of ['relativePath', 'screenName', 'targetNames', 'stateSessionId', 'appId']) {
    assert.ok(props[key], `canvas_read should advertise ${key}`);
  }
  assert.deepEqual(canvasRead.inputSchema.required, ['operation']);
  assert.equal(props.operation.enum.length, Object.keys(FACADES.find((f) => f.name === 'canvas_read').ops).length);
  assert.deepEqual(props.relativePath, byName.get('get_powerapps_source').inputSchema.properties.relativePath);
});

test('facade schemas never make a target argument required and keep operation as the only required field', () => {
  for (const facade of FACADES) {
    const tool = PUBLISHED_TOOLS.find((t) => t.name === facade.name);
    assert.deepEqual(tool.inputSchema.required, ['operation'], facade.name);
    assert.equal(tool.inputSchema.properties.operation.type, 'string', facade.name);
  }
});
