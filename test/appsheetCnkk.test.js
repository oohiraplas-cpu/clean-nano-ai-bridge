'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const a = require('../src/appsheetCnkk');
const g = require('../src/googleCapability');
const cnaiRouter = require('../src/cnaiRouter');
const { createEditorDriver, createMobileRunner } = require('../src/appsheetEditorDriver');
const { createAppSheetApi } = require('../src/appsheetOfficialApi');

const APP = 'app-1234-5678';
const SCRIPT = 'script_id_1234567890';
const CFG = { workspaceDomain: 'cleannano.co.jp', appsheet: { appId: APP }, cnkk: { gasScriptId: SCRIPT } };
const GOOD_SCREEN = { rendered: true, horizontalOverflow: false, tapTargetsOk: true, expectedTextFound: true, errors: [], screenshotSha256: 'abc' };

function world(over = {}) {
  const w = { def: { views: { Orders: { type: 'table' } }, actions: {}, columns: {}, security: { slices: {} }, automations: {}, images: {} }, staged: [], deployed: false, sharing: 'internal', calls: [], rows: { Orders: [{ ID: 'CNAI_TEST_1', Status: 'new' }] }, mobile: [GOOD_SCREEN] };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const rec = (n, f) => async (...args) => { w.calls.push(n); return f(...args); };
  w.editor = {
    channel: 'editor_browser',
    readDefinition: rec('readDefinition', async () => clone(w.def)),
    apply: rec('apply', async (_a, _op, step) => { w.staged.push(step); }),
    save: rec('save', async () => { for (const s of w.staged) { w.def[s.section] = w.def[s.section] || {}; w.def[s.section][s.target] = { ...(w.def[s.section][s.target] || {}), ...clone(s.set) }; } w.staged = []; return { saved: true, version: 7 }; }),
    deploy: rec('deploy', async () => { w.deployed = true; return { deployed: true, version: 8 }; }),
    readSharing: rec('readSharing', async () => ({ audience: w.sharing })),
    restore: rec('restore', async (_a, def) => { w.def = clone(def); })
  };
  w.api = {
    find: rec('find', async (table, { runAs } = {}) => (runAs === 'low@cleannano.co.jp' ? [{ ID: 'CNAI_TEST_1' }] : w.rows[table] || [])),
    invokeAction: rec('invokeAction', async (table, _act, rows) => { for (const r of rows) { const row = w.rows[table].find((x) => x.ID === r.ID); if (row) row.Status = 'done'; } return []; })
  };
  w.verifier = {
    id: 'v1',
    editor: { readDefinition: async () => clone(w.def), readSharing: async () => ({ audience: w.sharing }) },
    mobile: { run: rec('mobile', async (_a, { screens }) => screens.map((s) => ({ ...w.mobile[0], screen: s.name }))) },
    api: { find: w.api.find, invokeAction: w.api.invokeAction }
  };
  w.deps = { config: CFG, state: a.createAppSheetState(), editor: w.editor, verifier: w.verifier, api: { find: w.api.find, invokeAction: w.api.invokeAction }, ...over };
  return w;
}
const run = (w, capability, params, approvedByHuman, extra = {}) => a.executeAppSheet(w.deps, { capability, params, approvedByHuman, ...extra });

const TESTS = { mobileScreens: [{ name: 'Orders', expectText: ['Orders'] }], actionTests: [{ table: 'Orders', action: 'Complete', keyColumn: 'ID', key: 'CNAI_TEST_1', expect: { Status: 'done' } }] };
const VIEW_STEP = { capability: 'appsheet.view.update', target: 'Orders', set: { type: 'deck', mobile: { orientation: 'portrait', columns: 1 } } };
const ACTION_STEP = { capability: 'appsheet.action.update', target: 'Complete', set: { table: 'Orders', kind: 'data_set_values', prominence: 'display_prominently', assignments: { Status: '"done"' } } };

test('all 11 required capabilities exist; security is gated, reads are not', () => {
  for (const c of ['inspect', 'edit', 'view.update', 'action.update', 'image.update', 'security.update', 'automation.update', 'save', 'deploy', 'verify', 'rollback']) assert.ok(a.APPSHEET_CAPABILITIES[`appsheet.${c}`], c);
  assert.equal(a.APPSHEET_CAPABILITIES['appsheet.security.update'].humanGate, true);
  assert.equal(a.APPSHEET_CAPABILITIES['appsheet.inspect'].readOnly, true);
  assert.equal(g.describeCapabilities().capabilities.some((c) => c.capability === 'appsheet.deploy'), true);
});

test('no editor configured: official API cannot edit app definitions -> fail-closed', async () => {
  const w = world({ editor: null });
  const r = await run(w, 'appsheet.view.update', VIEW_STEP);
  assert.equal(r.errorCode, 'ADAPTER_NOT_CONFIGURED');
  assert.match(r.errorSummary, /公式API/);
  assert.equal((await run(w, 'appsheet.inspect', { appId: 'other-app-9999' })).errorCode, 'APP_NOT_ALLOWED');
});

test('inspect: auto, takes a snapshot, can read data through the official API', async () => {
  const w = world();
  const r = await run(w, 'appsheet.inspect', { table: 'Orders' });
  assert.equal(r.verified, true);
  assert.ok(r.snapshotId);
  assert.equal(r.evidence.after.data.rowCount, 1);
});

test('edit takes the Snapshot first; edit and save alone are never complete', async () => {
  const w = world();
  const e = await run(w, 'appsheet.view.update', VIEW_STEP);
  assert.equal(e.success, true);
  assert.equal(e.verified, false);
  assert.equal(e.phase, 'edited_not_saved');
  assert.equal(w.calls[0], 'readDefinition');
  assert.equal(w.calls.indexOf('readDefinition') < w.calls.indexOf('apply'), true);
  const s = await run(w, 'appsheet.save', { changeSetId: e.changeSetId });
  assert.equal(s.success, true);
  assert.equal(s.verified, false);
  assert.equal(s.phase, 'saved_not_complete');
  assert.equal(s.evidence.checks.find((c) => c.name === 'saved_refetch_matches').passed, true);
});

test('save with a refetch that does not match is VERIFICATION_FAILED', async () => {
  const w = world();
  w.editor.save = async () => ({ saved: true });
  const e = await run(w, 'appsheet.view.update', VIEW_STEP);
  const s = await run(w, 'appsheet.save', { changeSetId: e.changeSetId });
  assert.equal(s.errorCode, 'VERIFICATION_FAILED');
});

async function saved(w, steps, tests = TESTS) {
  let csId; let first = true;
  for (const st of steps) { const r = await run(w, st.capability, { changeSetId: csId, target: st.target, set: st.set, ...(first ? { tests } : {}) }, true); csId = r.changeSetId; first = false; }
  await run(w, 'appsheet.save', { changeSetId: csId }, true);
  return csId;
}

test('independent verifier: PASS needs refetch, no unexpected changes, mobile, action tests, security, audience', async () => {
  const w = world();
  const cs = await saved(w, [VIEW_STEP, ACTION_STEP]);
  const v = await run(w, 'appsheet.verify', { changeSetId: cs });
  assert.equal(v.verified, true);
  assert.equal(v.verifierId, 'v1');
  for (const n of a.REQUIRED_CHECKS.pre_deploy) assert.ok(v.checks.some((c) => c.name === n && c.passed), n);
  assert.equal(w.rows.Orders[0].Status, 'done');
});

test('verifier FAILs: no mobile screens / action change without actionTests / mobile defects / bad action result / not internal', async () => {
  let w = world(); let cs = await saved(w, [VIEW_STEP], { actionTests: [] });
  assert.equal((await run(w, 'appsheet.verify', { changeSetId: cs })).errorCode, 'VERIFICATION_FAILED');
  w = world(); cs = await saved(w, [ACTION_STEP], { mobileScreens: TESTS.mobileScreens });
  assert.match((await run(w, 'appsheet.verify', { changeSetId: cs })).errorSummary, /action_tests/);
  w = world(); cs = await saved(w, [VIEW_STEP]); w.mobile = [{ ...GOOD_SCREEN, horizontalOverflow: true }];
  assert.match((await run(w, 'appsheet.verify', { changeSetId: cs })).errorSummary, /mobile_layout/);
  w = world(); cs = await saved(w, [ACTION_STEP]); w.api.invokeAction = async () => []; w.verifier.api = { find: w.api.find, invokeAction: async () => [] };
  assert.match((await run(w, 'appsheet.verify', { changeSetId: cs })).errorSummary, /action_tests/);
  w = world(); cs = await saved(w, [VIEW_STEP]); w.sharing = 'external';
  assert.match((await run(w, 'appsheet.verify', { changeSetId: cs })).errorSummary, /audience/);
});

test('verifier is independent of the executor and catches collateral changes', async () => {
  let w = world(); const cs = await saved(w, [VIEW_STEP]);
  w.deps.verifier = { ...w.verifier, editor: w.editor };
  assert.equal((await run(w, 'appsheet.verify', { changeSetId: cs })).errorCode, 'INDEPENDENCE_VIOLATION');
  w = world(); const cs2 = await saved(w, [VIEW_STEP]);
  w.def.views.Other = { type: 'table' };
  const v = await run(w, 'appsheet.verify', { changeSetId: cs2 });
  assert.equal(v.errorCode, 'VERIFICATION_FAILED');
  assert.match(v.errorSummary, /no_unexpected_changes/);
  w = world(); w.deps.verifier = null;
  const cs3 = await saved(w, [VIEW_STEP]);
  assert.equal((await run(w, 'appsheet.verify', { changeSetId: cs3 })).errorCode, 'VERIFIER_NOT_CONFIGURED');
});

test('deploy: Evidence Gate (needs verifier PASS), drift check, then post-deploy refetch + mobile E2E', async () => {
  let w = world(); let cs = await saved(w, [VIEW_STEP]);
  const noEv = await run(w, 'appsheet.deploy', { changeSetId: cs });
  assert.equal(noEv.errorCode, 'EVIDENCE_INCOMPLETE');
  assert.equal(w.deployed, false);
  await run(w, 'appsheet.verify', { changeSetId: cs });
  w.def.views.Orders.type = 'gallery';
  assert.equal((await run(w, 'appsheet.deploy', { changeSetId: cs })).errorCode, 'DRIFT_DETECTED');
  w = world(); cs = await saved(w, [VIEW_STEP]);
  await run(w, 'appsheet.verify', { changeSetId: cs });
  const mobileCallsBefore = w.calls.filter((c) => c === 'mobile').length;
  const d = await run(w, 'appsheet.deploy', { changeSetId: cs });
  assert.equal(d.verified, true);
  assert.equal(d.phase, 'deployed_verified');
  assert.equal(w.deployed, true);
  assert.equal(w.calls.filter((c) => c === 'mobile').length, mobileCallsBefore + 1);
  assert.ok(d.evidence.checks.some((c) => c.name === 'post_deploy:mobile_layout' && c.passed));
});

test('post-deploy failure never reports success and rolls back to the tested snapshot', async () => {
  const w = world(); const cs = await saved(w, [VIEW_STEP]);
  await run(w, 'appsheet.verify', { changeSetId: cs });
  const orig = w.verifier.mobile.run;
  w.verifier.mobile.run = async (...args) => (w.deployed ? [{ ...GOOD_SCREEN, rendered: false }] : orig(...args));
  const d = await run(w, 'appsheet.deploy', { changeSetId: cs });
  assert.equal(d.verified, false);
  assert.equal(d.errorCode, 'VERIFICATION_FAILED');
  assert.equal(d.rolledBack.restored, true);
  assert.equal(w.def.views.Orders.type, 'table');
});

test('Human Gate: security.update always, external audience / billing / external notification recipient; none touch Editor before approval', async () => {
  const w = world();
  const sec = { target: 'OrdersByOwner', set: { securityFilter: { expr: '[Owner]=USEREMAIL()' } } };
  const g1 = await run(w, 'appsheet.security.update', sec);
  assert.equal(g1.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.ok(g1.approvalSummary.gateReasons.includes('permission_change'));
  const notif = (to) => ({ target: 'Notify', set: { event: { type: 'Adds', table: 'Orders' }, tasks: [{ type: 'notification', to: [to] }], enabled: true } });
  assert.equal((await run(w, 'appsheet.automation.update', notif('x@gmail.com'))).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(w.calls.length, 0);
  assert.equal((await run(w, 'appsheet.automation.update', notif('a@cleannano.co.jp'))).success, true);
  const ok = await run(w, 'appsheet.security.update', sec, true);
  assert.equal(ok.success, true);
  const cs = (await run(w, 'appsheet.view.update', { ...VIEW_STEP, tests: TESTS })).changeSetId;
  assert.equal((await run(w, 'appsheet.deploy', { changeSetId: cs, audience: 'external' })).errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal((await run(w, 'appsheet.deploy', { changeSetId: cs, billingImpact: true })).errorCode, 'HUMAN_APPROVAL_REQUIRED');
});

test('security filter verification runs as the target user through the official API', async () => {
  const w = world();
  const sec = { target: 'OrdersByOwner', set: { securityFilter: { expr: '[Owner]=USEREMAIL()' } } };
  const tests = { ...TESTS, securityChecks: [{ table: 'Orders', runAs: 'low@cleannano.co.jp', keyColumn: 'ID', mustSeeKeys: ['CNAI_TEST_1'], mustNotSeeKeys: ['SECRET_ROW'], expectMaxRows: 1 }] };
  const s1 = await run(w, 'appsheet.security.update', { ...sec, tests }, true);
  await run(w, 'appsheet.save', { changeSetId: s1.changeSetId }, true);
  assert.equal((await run(w, 'appsheet.verify', { changeSetId: s1.changeSetId })).verified, true);
  const w2 = world();
  const s2 = await run(w2, 'appsheet.security.update', { ...sec, tests: { ...tests, securityChecks: [{ ...tests.securityChecks[0], mustNotSeeKeys: ['CNAI_TEST_1'] }] } }, true);
  await run(w2, 'appsheet.save', { changeSetId: s2.changeSetId }, true);
  assert.match((await run(w2, 'appsheet.verify', { changeSetId: s2.changeSetId })).errorSummary, /security_filter/);
  const w3 = world();
  const s3 = await run(w3, 'appsheet.security.update', { ...sec, tests: { mobileScreens: TESTS.mobileScreens } }, true);
  await run(w3, 'appsheet.save', { changeSetId: s3.changeSetId }, true);
  assert.match((await run(w3, 'appsheet.verify', { changeSetId: s3.changeSetId })).errorSummary, /security_filter/);
});

test('spec validation: allowlisted keys, no delete/external-URL actions, no secrets in expressions, GAS only from allowlist, asset confinement', async () => {
  const w = world();
  assert.equal((await run(w, 'appsheet.action.update', { target: 'X', set: { kind: 'data_delete_row' } })).errorCode, 'FORBIDDEN_ACTION_KIND');
  assert.equal((await run(w, 'appsheet.action.update', { target: 'X', set: { kind: 'external_url' } })).errorCode, 'FORBIDDEN_ACTION_KIND');
  assert.equal((await run(w, 'appsheet.edit', { target: 'Orders.Status', set: { showIf: '[Token]="ghp_abcdefghijklmnopqrstuvwxyz0123456789"' } })).errorCode, 'INVALID_INPUT');
  assert.equal((await run(w, 'appsheet.edit', { target: 'Orders.Status', set: { notAKey: 1 } })).errorCode, 'INVALID_INPUT');
  assert.equal((await run(w, 'appsheet.edit', { target: 'Orders', set: { showIf: 'TRUE' } })).errorCode, 'INVALID_INPUT');
  assert.equal((await run(w, 'appsheet.automation.update', { target: 'B', set: { tasks: [{ type: 'call_script', scriptId: 'evil_script_id_000' }] } })).errorCode, 'SCRIPT_NOT_ALLOWED');
  assert.equal((await run(w, 'appsheet.automation.update', { target: 'B', set: { tasks: [{ type: 'call_script', scriptId: SCRIPT }] } })).success, true);
  assert.equal((await run(w, 'appsheet.view.update', { target: 'V', set: { mobile: { orientation: 'landscape' } } })).errorCode, 'INVALID_INPUT');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-assets-'));
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(os.tmpdir(), 'outside.png'), 'x');
  const w2 = world({ config: { ...CFG, appsheet: { ...CFG.appsheet, assetDir: dir } } });
  const img = await run(w2, 'appsheet.image.update', { target: 'Orders', set: { asset: { path: 'logo.png' }, placement: 'view_icon' } });
  assert.equal(img.success, true);
  assert.equal((await run(w2, 'appsheet.image.update', { target: 'Orders', set: { asset: { path: '../outside.png' } } })).errorCode, 'INVALID_INPUT');
  assert.equal((await run(w2, 'appsheet.image.update', { target: 'Orders', set: { asset: { path: 'logo.png', sha256: 'bad' } } })).errorCode, 'INVALID_INPUT');
});

test('change (one instruction): plan -> edit -> save -> verify -> deploy -> post-deploy verify = COMPLETED', async () => {
  const w = world();
  const r = await run(w, 'appsheet.change', { plan: { author: 'gemini', steps: [VIEW_STEP, ACTION_STEP], tests: TESTS } });
  assert.equal(r.success, true);
  assert.equal(r.verified, true);
  assert.equal(r.phase, 'deployed_verified');
  assert.equal(r.evidence.plan.author, 'gemini');
  assert.deepEqual(r.stages.map((s) => s.stage), ['appsheet.view.update', 'appsheet.action.update', 'save', 'verify(pre_deploy)', 'deploy+post_deploy_verify']);
  assert.equal(w.deployed, true);
  assert.equal(w.def.actions.Complete.prominence, 'display_prominently');
});

test('change: gated plan makes no Editor call; proposalOnly entry never executes; deploy:false is not complete', async () => {
  let w = world();
  const gated = await run(w, 'appsheet.change', { plan: { steps: [{ capability: 'appsheet.security.update', target: 'S', set: { slice: { table: 'Orders', rowFilter: '[Owner]=USEREMAIL()' } } }], tests: TESTS } });
  assert.equal(gated.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(w.calls.length, 0);
  w = world();
  const prop = await run(w, 'appsheet.change', { plan: { steps: [VIEW_STEP], tests: TESTS } }, false, { proposalOnly: true });
  assert.equal(prop.errorCode, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(w.calls.length, 0);
  w = world();
  const nd = await run(w, 'appsheet.change', { plan: { steps: [VIEW_STEP], tests: TESTS, deploy: false } });
  assert.equal(nd.verified, false);
  assert.equal(nd.phase, 'verified_not_deployed');
  assert.equal(w.deployed, false);
  w = world();
  const ext = await run(w, 'appsheet.change', { plan: { steps: [VIEW_STEP], tests: TESTS, audience: 'external' } });
  assert.ok(ext.approvalSummary.gateReasons.includes('external_publish'));
});

test('change: failure during save/verify restores the Snapshot and reports not complete', async () => {
  const w = world(); w.mobile = [{ ...GOOD_SCREEN, tapTargetsOk: false }];
  const r = await run(w, 'appsheet.change', { plan: { steps: [VIEW_STEP], tests: TESTS } });
  assert.equal(r.verified, false);
  assert.equal(r.rolledBack.restored, true);
  assert.equal(w.def.views.Orders.type, 'table');
  assert.equal(w.deployed, false);
});

test('rollback: own change set is automatic and verified; foreign snapshot needs Human Gate', async () => {
  const w = world(); const cs = await saved(w, [VIEW_STEP]);
  assert.equal(w.def.views.Orders.type, 'deck');
  const r = await run(w, 'appsheet.rollback', { changeSetId: cs });
  assert.equal(r.verified, true);
  assert.equal(w.def.views.Orders.type, 'table');
  const foreign = await run(w, 'appsheet.rollback', { snapshotId: 'whatever' });
  assert.equal(foreign.errorCode, 'HUMAN_APPROVAL_REQUIRED');
});

test('Gemini planner output is untrusted: re-validated; disabled by default', async () => {
  const planner = a.createGeminiPlanner({ client: null, config: {} });
  await assert.rejects(() => planner({ goal: 'x', appId: APP }), /未有効/);
  const client = { forScopes: () => ({ geminiGenerate: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ steps: [{ capability: 'appsheet.action.update', target: 'X', set: { kind: 'data_delete_row' } }], tests: TESTS }) }] } }] }) }) };
  const w = world({ planner: a.createGeminiPlanner({ client, config: { gemini: { enabled: true, model: 'm' } } }) });
  const r = await run(w, 'appsheet.change', { goal: 'delete rows' });
  assert.equal(r.errorCode, 'FORBIDDEN_ACTION_KIND');
  assert.equal(w.calls.length, 0);
});

test('Router: appsheet.* auto-selects googleWorkspace; approval is bound to the proposed plan', async () => {
  assert.equal(cnaiRouter.classify({ requestType: 'appsheet.view.update' }).route, 'googleWorkspace');
  const w = world();
  const ext = a.createAppSheetExtension(w.deps);
  const adapters = cnaiRouter.defaultAdapters({ adapters: { googleWorkspace: g.createGoogleWorkspaceAdapter({ client: null, config: CFG, extensions: [ext] }) } });
  const rs = cnaiRouter.createRouterState();
  const plan = { steps: [{ capability: 'appsheet.security.update', target: 'S', set: { slice: { table: 'Orders', rowFilter: 'TRUE' } } }], tests: { mobileScreens: TESTS.mobileScreens, securityChecks: [{ table: 'Orders', runAs: 'low@cleannano.co.jp', keyColumn: 'ID', mustSeeKeys: ['CNAI_TEST_1'] }] } };
  const blocked = await cnaiRouter.routeRequest(rs, { requestType: 'appsheet.change', payload: { capability: 'appsheet.change', params: { plan } } }, adapters);
  assert.equal(blocked.executionStatus, 'BLOCKED');
  const swapped = await cnaiRouter.resumeRequest(rs, blocked.requestId, { approvedByHuman: true, payload: { capability: 'appsheet.change', params: { plan: { ...plan, deploy: false } } } }, adapters);
  assert.equal(swapped.errorCode, 'APPROVAL_PAYLOAD_MISMATCH');
  assert.equal(w.calls.length, 0);
  const done = await cnaiRouter.resumeRequest(rs, blocked.requestId, { approvedByHuman: true }, adapters);
  assert.equal(done.executionStatus, 'COMPLETED');
  assert.equal(done.lastDispatchOutput.verifier.status, 'PASS');
});

test('Copilot window: inspect runs; edits are not offered; change/deploy are proposals only', async () => {
  const entry = require('../src/googleCopilotEntry');
  const w = world();
  const adapter = g.createGoogleWorkspaceAdapter({ client: null, config: CFG, extensions: [a.createAppSheetExtension(w.deps)] });
  const rs = cnaiRouter.createRouterState();
  const call = (input) => entry.handle(input, { adapter, state: rs });
  assert.equal((await call({ requestId: 'p1', capability: 'appsheet.inspect', params: {} })).status, 'COMPLETED');
  assert.equal((await call({ requestId: 'p2', capability: 'appsheet.view.update', params: VIEW_STEP })).errorCode, 'READ_ONLY_VIOLATION');
  const calls = w.calls.length;
  const prop = await call({ requestId: 'p3', capability: 'appsheet.change', params: { plan: { steps: [VIEW_STEP], tests: TESTS } } });
  assert.equal(prop.status, 'BLOCKED');
  assert.equal(prop.approval.required, true);
  assert.equal(w.calls.length, calls);
});

test('official API client: key only in header, errors are secret-free, run-as and action payloads', async () => {
  const seen = [];
  const api = createAppSheetApi({ appId: APP, accessKey: 'KEY_SECRET_9999', fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: init.body.includes('Boom'), status: 500, text: async () => '[]' }; } });
  await assert.rejects(() => api.find('Orders', { runAs: 'u@cleannano.co.jp' }), (e) => !e.message.includes('KEY_SECRET'));
  assert.equal(seen[0].init.headers.ApplicationAccessKey, 'KEY_SECRET_9999');
  assert.equal(JSON.parse(seen[0].init.body).Properties.RunAsUserEmailAddress, 'u@cleannano.co.jp');
  await api.invokeAction('Orders', 'Boom', [{ ID: 'x' }]);
  assert.equal(JSON.parse(seen[1].init.body).Action, 'Boom');
  await assert.rejects(() => createAppSheetApi({}).find('T'), /未設定/);
});

test('editor driver: no guessed selectors (missing recipe fails closed); login screen => AUTH_REQUIRED; storageState required', async () => {
  const state = path.join(os.tmpdir(), 'as-state.json'); fs.writeFileSync(state, '{"cookies":[],"origins":[]}');
  let url = 'https://www.appsheet.com/x';
  const fakePw = () => ({ chromium: { launch: async () => ({ close: async () => {}, newContext: async () => ({ route: async () => {}, close: async () => {}, newPage: async () => ({ goto: async () => {}, url: () => url }) }) }) } });
  const noRecipe = createEditorDriver({ storageStatePath: state, loadPlaywright: fakePw });
  await assert.rejects(() => noRecipe.readDefinition(APP), { code: 'EDITOR_RECIPE_MISSING' });
  const withRecipe = createEditorDriver({ storageStatePath: state, loadPlaywright: fakePw, recipes: { readDefinition: async () => ({ views: {} }) } });
  assert.deepEqual(await withRecipe.readDefinition(APP), { views: {} });
  url = 'https://accounts.google.com/signin';
  await assert.rejects(() => withRecipe.readDefinition(APP), { code: 'AUTH_REQUIRED' });
  await assert.rejects(() => createEditorDriver({ loadPlaywright: fakePw, recipes: { readDefinition: async () => ({}) } }).readDefinition(APP), { code: 'NOT_CONFIGURED' });
});

test('mobile runner (real Chromium, 390x844 portrait): detects overflow and small tap targets', async (t) => {
  let pw; try { pw = require('playwright'); } catch (_) { return t.skip('playwright unavailable'); }
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/good') return res.end('<meta name=viewport content="width=device-width,initial-scale=1"><body><h1>Orders</h1><button style="width:100%;height:48px">Complete</button></body>');
    if (req.url === '/wide') return res.end('<meta name=viewport content="width=device-width,initial-scale=1"><body><h1>Orders</h1><div style="width:900px;height:20px;background:#ccc">wide</div></body>');
    return res.end('<meta name=viewport content="width=device-width,initial-scale=1"><body><h1>Orders</h1><button style="width:12px;height:12px">x</button></body>');
  }).listen(0);
  const state = path.join(os.tmpdir(), 'as-state2.json'); fs.writeFileSync(state, '{"cookies":[],"origins":[]}');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const mk = (p) => createMobileRunner({ storageStatePath: state, allowedHosts: ['127.0.0.1'], appUrl: () => `${base}${p}`, loadPlaywright: () => pw });
    const good = (await mk('/good').run('x', { screens: [{ name: 'Orders', expectText: ['Orders'] }] }))[0];
    assert.equal(good.rendered, true); assert.equal(good.horizontalOverflow, false); assert.equal(good.tapTargetsOk, true); assert.equal(good.expectedTextFound, true);
    assert.equal(good.viewport.width, 390);
    assert.match(good.screenshotSha256, /^[0-9a-f]{64}$/);
    assert.equal((await mk('/wide').run('x', { screens: [{ name: 'w' }] }))[0].horizontalOverflow, true);
    assert.equal((await mk('/small').run('x', { screens: [{ name: 's' }] }))[0].tapTargetsOk, false);
    assert.equal((await mk('/good').run('x', { screens: [{ name: 'm', expectText: ['MissingText'] }] }))[0].expectedTextFound, false);
  } finally { server.close(); }
});
