'use strict';
// Read-only Azure control-plane tools for the fixed Bridge App Service target.
// Only `az` read commands are issued. App settings, secrets, tokens, role assignments
// and deployment credentials are never requested. Any failure is fail-closed.
const { execFileSync } = require('node:child_process');

const APP_NAME = 'clean-nano-ai-bridge';

function unavailable(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** Default runner: read-only `az` call, JSON output, bounded time. */
function defaultRun(args) {
  try {
    const out = execFileSync('az', [...args, '--only-show-errors', '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return JSON.parse(out);
  } catch {
    throw unavailable('azure_read_unavailable');
  }
}

/**
 * Resolves the single App Service named APP_NAME in the visible subscription.
 * Fail-closed: zero or several matches are rejected.
 */
function resolveTarget(run) {
  const matches = run(['webapp', 'list', '--query',
    `[?name=='${APP_NAME}'].{name:name,resourceGroup:resourceGroup}`]);
  if (!Array.isArray(matches) || matches.length !== 1) throw unavailable('azure_target_unverified');
  const [app] = matches;
  if (app.name !== APP_NAME || typeof app.resourceGroup !== 'string' || !app.resourceGroup) {
    throw unavailable('azure_target_unverified');
  }
  return { appName: app.name, resourceGroup: app.resourceGroup };
}

/**
 * @param {object} [options]
 * @param {(args: string[]) => any} [options.run]  injectable read-only runner
 */
function createAzureReadTools({ run: rawRun = defaultRun } = {}) {
  // Every runner failure, whatever its message, becomes one value-free code.
  const run = (args) => {
    try {
      return rawRun(args);
    } catch {
      throw unavailable('azure_read_unavailable');
    }
  };
  let cached = null;
  const target = () => {
    if (!cached) cached = resolveTarget(run);
    return cached;
  };
  const args = () => ['--name', target().appName, '--resource-group', target().resourceGroup];

  async function getSubscription() {
    const account = run(['account', 'show', '--query', '{name:name,subscriptionId:id,state:state}']);
    if (!account || typeof account !== 'object') throw unavailable('azure_read_unavailable');
    return {
      name: typeof account.name === 'string' ? account.name : null,
      subscriptionId: typeof account.subscriptionId === 'string' ? account.subscriptionId : null,
      state: typeof account.state === 'string' ? account.state : null,
    };
  }

  async function getAppService() {
    const app = run(['webapp', 'show', ...args(),
      '--query', '{name:name,state:state,location:location,kind:kind,defaultHostName:defaultHostName,resourceGroup:resourceGroup}']);
    if (!app || typeof app !== 'object') throw unavailable('azure_read_unavailable');
    if (app.name !== target().appName || app.resourceGroup !== target().resourceGroup) {
      throw unavailable('azure_target_unverified');
    }
    return {
      name: app.name,
      resourceGroup: app.resourceGroup,
      state: typeof app.state === 'string' ? app.state : null,
      location: typeof app.location === 'string' ? app.location : null,
      kind: typeof app.kind === 'string' ? app.kind : null,
      defaultHostName: typeof app.defaultHostName === 'string' ? app.defaultHostName : null,
    };
  }

  async function listSlots() {
    const slots = run(['webapp', 'deployment', 'slot', 'list', ...args(), '--query', '[].{name:name,state:state}']);
    if (!Array.isArray(slots)) throw unavailable('azure_read_unavailable');
    return {
      slots: slots.slice(0, 20).map((s) => ({
        name: typeof s.name === 'string' ? s.name : null,
        state: typeof s.state === 'string' ? s.state : null,
      })),
    };
  }

  return Object.freeze({ getSubscription, getAppService, listSlots });
}

module.exports = { createAzureReadTools };
