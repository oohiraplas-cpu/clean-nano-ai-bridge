'use strict';
// AppSheet (CNKK) Editor pipeline, run under the CNAI Router (Gemini = implementation owner; OZ Router = Human Gate / Evidence Gate / Verifier).
//
// Channel policy
//  1. AppSheet official API is used wherever it can do the job (data Find/Add/Edit, action invocation, run-as-user reads for tests).
//  2. The official API CANNOT edit the app definition (views, actions, slices, security, automations, columns, images). Those go through
//     the `editor` port (safe browser automation, see appsheetEditorDriver.js). No Enterprise/extra-contract API is used or assumed.
//  3. Gemini authors the plan (change spec). The plan is untrusted input: it is re-validated here, risk is classified here, and the
//     author is never allowed to verify its own work (independent verifier port, separate object from the editor port).
//
// Completion is NEVER "saved". COMPLETED/verified requires:
//   Snapshot(before) -> edit -> save -> refetch -> mobile display test -> action test -> security filter check -> Evidence bundle
//   -> independent verifier PASS -> internal deploy -> post-deploy refetch + mobile E2E PASS.
// Human Gate: external publish, billing impact, permission expansion (any security.update), external notification recipients,
// and rollback to a snapshot that is not the change set's own. Everything else (tested, internal) is automatic.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { maskDeep, containsLikelySecret } = require('./secretMasking');

const sha256 = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const now = () => new Date().toISOString();

// gate: true | false | 'conditional'. editOp: section the capability edits.
const d = (readOnly, risk, gate, section = null) => Object.freeze({ service: 'appsheet', readOnly, risk, humanGate: gate, scopes: Object.freeze([]), section });
const APPSHEET_CAPABILITIES = Object.freeze({
  'appsheet.inspect': d(true, 'LOW', false),
  'appsheet.edit': d(false, 'MEDIUM', false, 'columns'),
  'appsheet.view.update': d(false, 'MEDIUM', false, 'views'),
  'appsheet.action.update': d(false, 'MEDIUM', false, 'actions'),
  'appsheet.image.update': d(false, 'MEDIUM', false, 'images'),
  'appsheet.security.update': d(false, 'HIGH', true, 'security'),
  'appsheet.automation.update': d(false, 'HIGH', 'conditional', 'automations'),
  'appsheet.save': d(false, 'MEDIUM', false),
  'appsheet.deploy': d(false, 'HIGH', 'conditional'),
  'appsheet.verify': d(true, 'LOW', false),
  'appsheet.rollback': d(false, 'HIGH', 'conditional'),
  'appsheet.change': d(false, 'HIGH', 'conditional')
});
const EDIT_OPS = Object.freeze(['appsheet.edit', 'appsheet.view.update', 'appsheet.action.update', 'appsheet.image.update', 'appsheet.security.update', 'appsheet.automation.update']);

class AppSheetError extends Error {
  constructor(message, code, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}
const need = (cond, message, code = 'INVALID_INPUT') => { if (!cond) throw new AppSheetError(message, code); };

// ---- spec validation (allowlisted keys per capability; expressions screened) ----

const NAME = /^[A-Za-z0-9 _.\-぀-ヿ㐀-鿿]{1,100}$/;
const COLUMN_TARGET = /^[A-Za-z0-9 _\-぀-ヿ㐀-鿿]{1,100}\.[A-Za-z0-9 _\-぀-ヿ㐀-鿿]{1,100}$/;
const EXPR_KEYS = new Set(['showIf', 'validIf', 'editableIf', 'condition', 'rowFilter', 'expr', 'initialValue']);
const COLUMN_TYPES = ['Text', 'Number', 'Decimal', 'Price', 'Date', 'DateTime', 'Time', 'Yes/No', 'Enum', 'EnumList', 'Ref', 'Image', 'Thumbnail', 'Email', 'Phone', 'Address', 'LongText', 'Percent', 'Name', 'Url', 'File'];
const VIEW_TYPES = ['table', 'deck', 'gallery', 'detail', 'form', 'card', 'map', 'dashboard', 'calendar', 'chart', 'onboarding'];
const PROMINENCE = ['display_overlay', 'display_prominently', 'display_inline', 'do_not_display'];
const ACTION_KINDS = ['data_set_values', 'data_add_row', 'navigate_app', 'call_script'];
const DESTRUCTIVE_KINDS = ['data_delete_row', 'external_url'];
const MAX_EXPR = 2000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const ALLOWED_KEYS = Object.freeze({
  'appsheet.edit': ['type', 'key', 'ref', 'required', 'label', 'showIf', 'validIf', 'editableIf', 'initialValue', 'enumValues'],
  'appsheet.view.update': ['type', 'table', 'position', 'sortBy', 'groupBy', 'columnOrder', 'icon', 'showIf', 'actions', 'mobile'],
  'appsheet.action.update': ['table', 'kind', 'prominence', 'icon', 'condition', 'assignments', 'confirm', 'scriptId', 'functionName'],
  'appsheet.image.update': ['icon', 'asset', 'placement'],
  'appsheet.security.update': ['slice', 'securityFilter'],
  'appsheet.automation.update': ['event', 'condition', 'tasks', 'enabled']
});

function checkExpression(key, value) {
  need(typeof value === 'string' && value.length <= MAX_EXPR, `${key}は${MAX_EXPR}文字以内の式です`);
  need(!containsLikelySecret(value) && !/(api[_-]?key|secret|password|token)\s*[=:]\s*["']?[A-Za-z0-9._-]{8,}/i.test(value), `${key}に秘密値が含まれている可能性があります`);
}

function checkSetShape(capability, set, config) {
  need(set && typeof set === 'object' && !Array.isArray(set) && Object.keys(set).length > 0, 'setは1つ以上のプロパティを持つオブジェクトです');
  for (const [k, v] of Object.entries(set)) {
    need(ALLOWED_KEYS[capability].includes(k), `${capability}で変更できない項目です: ${k}`);
    if (EXPR_KEYS.has(k)) checkExpression(k, v);
  }
  if (set.type !== undefined) need(capability === 'appsheet.edit' ? COLUMN_TYPES.includes(set.type) : VIEW_TYPES.includes(set.type), `typeが不正です: ${set.type}`);
  if (set.kind !== undefined) { need(!DESTRUCTIVE_KINDS.includes(set.kind), `${set.kind}のActionはこの経路では作成できません（削除・外部URL）`, 'FORBIDDEN_ACTION_KIND'); need(ACTION_KINDS.includes(set.kind), `kindが不正です: ${set.kind}`); }
  if (set.prominence !== undefined) need(PROMINENCE.includes(set.prominence), 'prominenceが不正です');
  if (set.columnOrder !== undefined) need(Array.isArray(set.columnOrder) && set.columnOrder.every((c) => typeof c === 'string' && NAME.test(c)), 'columnOrderは列名の配列です');
  if (set.assignments !== undefined) { need(set.assignments && typeof set.assignments === 'object' && !Array.isArray(set.assignments), 'assignmentsはオブジェクトです'); for (const v of Object.values(set.assignments)) checkExpression('assignments', String(v)); }
  if (set.mobile !== undefined) need(set.mobile && typeof set.mobile === 'object' && !Array.isArray(set.mobile) && Object.keys(set.mobile).every((k) => ['orientation', 'columns', 'density'].includes(k)) && (set.mobile.orientation === undefined || set.mobile.orientation === 'portrait') && (set.mobile.columns === undefined || [1, 2].includes(set.mobile.columns)), 'mobileはorientation=portrait / columns=1|2 / densityのみです');
  if (set.slice !== undefined) { need(set.slice && typeof set.slice === 'object', 'sliceはオブジェクトです'); if (set.slice.rowFilter !== undefined) checkExpression('rowFilter', set.slice.rowFilter); }
  if (set.securityFilter !== undefined) { need(set.securityFilter && typeof set.securityFilter === 'object', 'securityFilterはオブジェクトです'); checkExpression('expr', set.securityFilter.expr); }
  if (set.tasks !== undefined) need(Array.isArray(set.tasks) && set.tasks.length <= 10 && set.tasks.every((t) => t && typeof t === 'object' && ['notification', 'call_script', 'run_data_action'].includes(t.type)), 'tasksは種別(notification|call_script|run_data_action)付きの配列(10件まで)です');
  if (set.event !== undefined) need(set.event && typeof set.event === 'object' && ['Adds', 'Updates', 'Schedule'].includes(set.event.type), 'event.typeはAdds|Updates|Scheduleです');
  if (set.scriptId !== undefined) checkScript(set.scriptId, config);
  for (const t of set.tasks || []) if (t.type === 'call_script') checkScript(t.scriptId, config);
}

function checkScript(scriptId, config) {
  const allowed = [config.cnkk?.gasScriptId, ...(config.appsheet?.allowedScriptIds || [])].filter(Boolean);
  need(allowed.includes(scriptId), 'GAS呼出は設定済みの社内scriptId(GOOGLE_CNKK_GAS_SCRIPT_ID / GOOGLE_APPSHEET_ALLOWED_SCRIPT_IDS)のみです', 'SCRIPT_NOT_ALLOWED');
}

/** Resolves an image asset under the configured asset dir (no traversal), returns {file, sha256, bytes, mime}. */
function resolveAsset(asset, config) {
  need(asset && typeof asset.path === 'string' && config.appsheet?.assetDir, 'assetにはpathが必要で、GOOGLE_APPSHEET_ASSET_DIRの設定が必要です', 'NOT_CONFIGURED');
  const root = fs.realpathSync(config.appsheet.assetDir);
  let file;
  try { file = fs.realpathSync(path.resolve(root, asset.path)); } catch (_) { throw new AppSheetError('画像ファイルが見つかりません', 'INVALID_INPUT'); }
  need(file.startsWith(root + path.sep), '画像はGOOGLE_APPSHEET_ASSET_DIR配下のみ使用できます');
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
  need(mime, '画像はpng/jpg/webpのみです');
  const buf = fs.readFileSync(file);
  need(buf.length <= MAX_IMAGE_BYTES, '画像は2MB以内です');
  const digest = sha256(buf.toString('base64'));
  need(!asset.sha256 || asset.sha256 === digest, '画像のsha256が一致しません');
  return { file, sha256: digest, bytes: buf.length, mime };
}

function domainOf(addr) { const m = /^[^@\s]+@([^@\s]+)$/.exec(String(addr)); return m ? m[1].toLowerCase() : null; }

/** Validates one step and classifies risk flags. Returns the normalized step. Throws AppSheetError. */
function validateStep(capability, step, config) {
  need(EDIT_OPS.includes(capability), `編集系capabilityではありません: ${capability}`);
  need(step && typeof step.target === 'string', 'targetが必要です');
  const section = APPSHEET_CAPABILITIES[capability].section;
  need(section === 'columns' ? COLUMN_TARGET.test(step.target) : NAME.test(step.target), 'targetが不正です（columnsは Table.Column 形式）');
  checkSetShape(capability, step.set, config);
  const flags = { permissionExpansion: capability === 'appsheet.security.update', externalRecipient: false, billingImpact: step.billingImpact === true };
  const set = { ...step.set };
  if (set.asset) { const a = resolveAsset(set.asset, config); set.asset = { path: set.asset.path, sha256: a.sha256, bytes: a.bytes, mime: a.mime }; }
  for (const t of set.tasks || []) {
    if (t.type === 'notification') {
      const rcpts = [].concat(t.to || []);
      need(rcpts.length > 0, '通知taskにはtoが必要です');
      for (const r of rcpts) if (/@/.test(String(r)) && domainOf(r) !== String(config.googleWorkspaceDomain || config.workspaceDomain || '').toLowerCase()) flags.externalRecipient = true;
      need(config.googleWorkspaceDomain || config.workspaceDomain, 'GOOGLE_WORKSPACE_DOMAIN未設定のため通知宛先を判定できません', 'NOT_CONFIGURED');
    }
  }
  return { capability, section, target: step.target, set, flags };
}

const needsGate = (flags) => flags.permissionExpansion || flags.externalRecipient || flags.billingImpact;
function planGate(plan, steps) {
  const reasons = [];
  if (plan.audience === 'external') reasons.push('external_publish');
  if (plan.billingImpact === true || steps.some((s) => s.flags.billingImpact)) reasons.push('billing_impact');
  if (plan.permissionExpansion === true || steps.some((s) => s.flags.permissionExpansion)) reasons.push('permission_change');
  if (steps.some((s) => s.flags.externalRecipient)) reasons.push('external_notification_recipient');
  return reasons;
}

// ---- state ----

function createAppSheetState() { return { changeSets: new Map(), bundles: new Map(), snapshots: new Map() }; }

// ---- definition helpers ----

const get = (obj, pathArr) => pathArr.reduce((o, k) => (o == null ? undefined : o[k]), obj);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const defHash = (def) => sha256(def);

function expectationsFor(step) {
  return Object.entries(step.set).map(([key, value]) => ({ path: [step.section, step.target, key], equals: key === 'asset' ? { sha256: value.sha256 } : value, key }));
}
function matchExpectation(def, e) {
  const actual = get(def, e.path);
  if (e.key === 'asset') return actual && typeof actual === 'object' && actual.sha256 === e.equals.sha256;
  return eq(actual, e.equals);
}
function checkExpectations(def, changeSet) {
  const failures = [];
  for (const step of changeSet.steps) for (const e of expectationsFor(step)) if (!matchExpectation(def, e)) failures.push(e.path.join('.'));
  return failures;
}
/** Anything outside the touched (section,target) pairs must equal the snapshot. */
function unexpectedChanges(before, after, changeSet) {
  const touched = new Set(changeSet.steps.map((s) => `${s.section}/${s.target}`));
  const out = [];
  for (const section of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    for (const name of new Set([...Object.keys(before?.[section] || {}), ...Object.keys(after?.[section] || {})])) {
      if (!touched.has(`${section}/${name}`) && !eq(before?.[section]?.[name], after?.[section]?.[name])) out.push(`${section}.${name}`);
    }
  }
  return out;
}

// ---- executor ----

/**
 * deps: { state, config, editor, verifier:{editor, mobile, api}, api, planner?, snapshots? }
 *  - editor: { readDefinition(appId), apply(appId, op, step), save(appId), deploy(appId, {audience}), readSharing(appId), restore(appId, definition) }
 *  - verifier.editor: separate session/object with readDefinition + readSharing. verifier.mobile.run(appId, {viewport, screens}).
 *  - verifier.api / api: { find(table, {selector, runAs}), invokeAction(table, action, rows) }  (official API)
 */
async function executeAppSheet(deps, request) {
  const { capability, params = {} } = request;
  const def = APPSHEET_CAPABILITIES[capability];
  if (!def) return { success: false, verified: false, errorCode: 'UNKNOWN_CAPABILITY', errorSummary: String(capability) };
  const config = deps.config || {};
  const evidence = { capability, owner: 'gemini', startedAt: now(), channel: null, humanGate: { required: false, approved: false, reasons: [] }, checks: [] };
  const finish = (r) => {
    const verdict = r.verified === true ? 'PASS' : (r.errorCode === 'VERIFICATION_FAILED' || r.errorCode === 'EVIDENCE_INCOMPLETE' ? 'FAIL' : 'NOT_VERIFIED');
    return { capability, owner: 'gemini', ...maskDeep(r), verifier: { status: verdict, checks: maskDeep(evidence.checks) }, evidence: maskDeep({ ...evidence, finishedAt: now() }) };
  };
  try {
    const appId = params.appId || config.appsheet?.appId;
    need(appId && /^[A-Za-z0-9-]{8,64}$/.test(appId), 'appIdが未設定または不正です', 'NOT_CONFIGURED');
    need([config.appsheet?.appId, ...(config.appsheet?.allowedAppIds || [])].filter(Boolean).includes(appId), 'このappIdはCNKK許可リストにありません', 'APP_NOT_ALLOWED');
    if (!deps.editor) return finish({ success: false, verified: false, errorCode: 'ADAPTER_NOT_CONFIGURED', errorSummary: 'AppSheet Editor(ブラウザ自動操作)が未構成です。公式APIはアプリ定義を編集できません' });
    const ctx = { deps, config, evidence, finish, appId, request, state: deps.state };

    // plan-level gate for the orchestrator is decided inside change(); single ops decide here.
    if (capability === 'appsheet.change') return await change(ctx, params);

    let gateReasons = [];
    if (EDIT_OPS.includes(capability)) { const step = validateStep(capability, params, config); gateReasons = planGate({}, [step]); ctx.step = step; }
    if (capability === 'appsheet.deploy') gateReasons = deployGateReasons(ctx, params);
    if (capability === 'appsheet.rollback') gateReasons = rollbackGateReasons(ctx, params);
    if (request.proposalOnly && !def.readOnly) gateReasons = gateReasons.length ? gateReasons : ['proposal_only_entry'];
    if (def.humanGate === true && !gateReasons.length) gateReasons = ['permission_change'];
    const blocked = gate(ctx, gateReasons, () => summarize(capability, params, ctx.step));
    if (blocked) return blocked;

    switch (capability) {
      case 'appsheet.inspect': return await inspect(ctx, params);
      case 'appsheet.save': return await save(ctx, params);
      case 'appsheet.verify': return await verify(ctx, params);
      case 'appsheet.deploy': return await deploy(ctx, params);
      case 'appsheet.rollback': return await rollback(ctx, params);
      default: return await edit(ctx, params);
    }
  } catch (err) {
    const code = err instanceof AppSheetError ? err.code : 'APPSHEET_ERROR';
    return finish({ success: false, verified: false, errorCode: code === 'NOT_CONFIGURED' ? 'ADAPTER_NOT_CONFIGURED' : code, errorSummary: err.message });
  }
}

function gate(ctx, reasons, summaryFn) {
  ctx.evidence.humanGate.reasons = reasons;
  ctx.evidence.humanGate.required = reasons.length > 0;
  if (!reasons.length) return null;
  if (ctx.request.approvedByHuman === true && !ctx.request.proposalOnly) { ctx.evidence.humanGate.approved = true; ctx.approved = true; return null; }
  return ctx.finish({ success: false, verified: false, errorCode: 'HUMAN_APPROVAL_REQUIRED', errorSummary: `${ctx.request.capability}は人間承認待ちです（${reasons.join(', ')}）。Editor/APIは何も実行していません`, approvalSummary: { ...summaryFn(), gateReasons: reasons }, proposalHash: require('./googleCapability').proposalHash(ctx.request.capability, ctx.request.params) });
}

function summarize(capability, p, step) {
  if (capability === 'appsheet.change') return { goal: p.goal, audience: p.plan?.audience || 'internal', steps: (p.plan?.steps || []).map((s) => ({ capability: s.capability, target: s.target, keys: Object.keys(s.set || {}) })), planSha256: sha256(p.plan ?? null), deploy: p.plan?.deploy !== false };
  if (step) return { capability, section: step.section, target: step.target, keys: Object.keys(step.set), setSha256: sha256(step.set) };
  return { capability, changeSetId: p.changeSetId, snapshotId: p.snapshotId, audience: p.audience || 'internal' };
}

function csOf(ctx, id) {
  const cs = ctx.state.changeSets.get(id);
  need(cs, 'changeSetが見つかりません', 'NOT_FOUND');
  need(cs.appId === ctx.appId, 'changeSetのappIdが一致しません');
  return cs;
}

async function takeSnapshot(ctx, appId) {
  const definition = await ctx.deps.editor.readDefinition(appId);
  need(definition && typeof definition === 'object', 'Editorから定義を取得できません', 'EDITOR_READ_FAILED');
  const snapshotId = crypto.randomUUID();
  ctx.state.snapshots.set(snapshotId, { appId, definition, definitionHash: defHash(definition), takenAt: now() });
  return { snapshotId, definitionHash: defHash(definition), definition };
}

async function inspect(ctx, p) {
  const snap = await takeSnapshot(ctx, ctx.appId);
  ctx.evidence.channel = ctx.deps.editor.channel || 'editor_browser';
  ctx.evidence.after = { snapshotId: snap.snapshotId, definitionHash: snap.definitionHash, sections: Object.fromEntries(Object.entries(snap.definition).map(([k, v]) => [k, Object.keys(v || {}).length])) };
  let data = null;
  if (p.table && ctx.deps.api) { const rows = await ctx.deps.api.find(p.table, { selector: p.selector }); data = { table: p.table, rowCount: Array.isArray(rows) ? rows.length : 0 }; ctx.evidence.after.data = data; }
  ctx.evidence.checks.push({ name: 'definition_read', passed: true });
  return ctx.finish({ success: true, verified: true, snapshotId: snap.snapshotId, definitionHash: snap.definitionHash, definition: p.includeDefinition === true ? snap.definition : undefined, sections: ctx.evidence.after.sections, data });
}

async function ensureChangeSet(ctx, params) {
  if (params.changeSetId) return csOf(ctx, params.changeSetId);
  const snap = await takeSnapshot(ctx, ctx.appId);
  const cs = { id: crypto.randomUUID(), appId: ctx.appId, snapshotId: snap.snapshotId, snapshotHash: snap.definitionHash, steps: [], status: 'open', flags: {}, tests: {}, audience: 'internal', createdAt: now() };
  ctx.state.changeSets.set(cs.id, cs);
  ctx.evidence.before = { snapshotId: snap.snapshotId, definitionHash: snap.definitionHash };
  return cs;
}

async function edit(ctx, params, step = ctx.step) {
  const cs = await ensureChangeSet(ctx, params);
  need(['open', 'edited'].includes(cs.status), `この状態では編集できません: ${cs.status}`, 'INVALID_STATE');
  ctx.evidence.channel = ctx.deps.editor.channel || 'editor_browser';
  await ctx.deps.editor.apply(ctx.appId, step.capability, { section: step.section, target: step.target, set: step.set });
  cs.steps.push(step);
  cs.status = 'edited';
  if (ctx.approved) cs.approved = true;
  Object.keys(step.flags).forEach((k) => { if (step.flags[k]) cs.flags[k] = true; });
  if (params.tests && typeof params.tests === 'object') cs.tests = mergeTests(cs.tests, params.tests);
  ctx.evidence.checks.push({ name: 'edit_applied', passed: true });
  // An edit alone is never a completed change.
  return ctx.finish({ success: true, verified: false, phase: 'edited_not_saved', changeSetId: cs.id, snapshotId: cs.snapshotId, stepCount: cs.steps.length });
}

const mergeTests = (a, b) => ({ mobileScreens: [...(a.mobileScreens || []), ...(b.mobileScreens || [])], actionTests: [...(a.actionTests || []), ...(b.actionTests || [])], securityChecks: [...(a.securityChecks || []), ...(b.securityChecks || [])] });

async function save(ctx, p) {
  const cs = csOf(ctx, p.changeSetId);
  need(cs.status === 'edited' && cs.steps.length > 0, '保存する編集がありません', 'INVALID_STATE');
  const res = await ctx.deps.editor.save(ctx.appId);
  need(res && res.saved === true, 'Editorが保存成功を返しませんでした', 'SAVE_FAILED');
  const after = await ctx.deps.editor.readDefinition(ctx.appId);
  const failures = checkExpectations(after, cs);
  ctx.evidence.checks.push({ name: 'saved_refetch_matches', passed: failures.length === 0, ...(failures.length ? { failures } : {}) });
  if (failures.length) return ctx.finish({ success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: `保存後の再取得が期待と一致しません: ${failures.join(', ')}`, changeSetId: cs.id });
  cs.status = 'saved'; cs.savedHash = defHash(after);
  ctx.evidence.after = { definitionHash: cs.savedHash };
  // Saved + refetched is NOT complete: verifier + deploy + post-deploy E2E are still required.
  return ctx.finish({ success: true, verified: false, phase: 'saved_not_complete', changeSetId: cs.id, definitionHash: cs.savedHash });
}

// ---- independent verifier + evidence gate ----

const REQUIRED_CHECKS = Object.freeze({
  pre_deploy: ['snapshot_before', 'refetch_matches_expectations', 'no_unexpected_changes', 'mobile_layout', 'action_tests', 'security_filter', 'audience'],
  post_deploy: ['refetch_matches_expectations', 'no_unexpected_changes', 'mobile_layout', 'security_filter', 'audience']
});

async function runVerifier(ctx, cs, phase) {
  const v = ctx.deps.verifier;
  need(v && v.editor && v.mobile, '独立Verifierが未構成です（Editorと別のセッション/オブジェクトが必要）', 'VERIFIER_NOT_CONFIGURED');
  need(v.editor !== ctx.deps.editor && (!v.api || v.api !== ctx.deps.api), 'VerifierがExecutorと同一オブジェクトです（独立性違反）', 'INDEPENDENCE_VIOLATION');
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, ...(detail ? { detail } : {}) });
  const snapshot = ctx.state.snapshots.get(cs.snapshotId);
  add('snapshot_before', Boolean(snapshot) && snapshot.definitionHash === cs.snapshotHash);

  const def = await v.editor.readDefinition(ctx.appId);
  const failures = checkExpectations(def, cs);
  add('refetch_matches_expectations', failures.length === 0, failures.length ? { failures } : undefined);
  const unexpected = snapshot ? unexpectedChanges(snapshot.definition, def, cs) : ['snapshot_missing'];
  add('no_unexpected_changes', unexpected.length === 0, unexpected.length ? { unexpected } : undefined);

  const screens = cs.tests.mobileScreens || [];
  if (!screens.length) add('mobile_layout', false, { reason: 'mobileScreens(スマホ縦画面の検証対象)が未指定です' });
  else {
    const res = await v.mobile.run(ctx.appId, { viewport: { width: 390, height: 844 }, screens });
    const bad = (res || []).filter((r) => !(r.rendered === true && r.horizontalOverflow === false && r.tapTargetsOk === true && r.expectedTextFound !== false && !(r.errors || []).length));
    add('mobile_layout', Array.isArray(res) && res.length === screens.length && bad.length === 0, { screens: (res || []).map((r) => ({ screen: r.screen, rendered: r.rendered, horizontalOverflow: r.horizontalOverflow, tapTargetsOk: r.tapTargetsOk, screenshotSha256: r.screenshotSha256 })) });
  }

  const touchesAction = cs.steps.some((s) => s.section === 'actions' || s.set.actions);
  if (phase === 'pre_deploy') {
    const tests = cs.tests.actionTests || [];
    if (touchesAction && !tests.length) add('action_tests', false, { reason: 'Action変更にactionTestsがありません' });
    else {
      const results = [];
      for (const t of tests) results.push(await runActionTest(ctx, t));
      add('action_tests', results.every((r) => r.passed), results.length ? { results } : { note: 'Action変更なし' });
    }
  }

  const touchesSecurity = cs.steps.some((s) => s.section === 'security');
  const secChecks = cs.tests.securityChecks || [];
  if (touchesSecurity && !secChecks.length) add('security_filter', false, { reason: 'Security変更にsecurityChecksがありません' });
  else {
    const results = [];
    for (const c of secChecks) results.push(await runSecurityCheck(ctx, v, c));
    const secDrift = !touchesSecurity && snapshot ? !eq(snapshot.definition.security, def.security) : false;
    add('security_filter', results.every((r) => r.passed) && !secDrift, { results, ...(secDrift ? { unexpectedSecurityChange: true } : {}) });
  }

  const sharing = await v.editor.readSharing(ctx.appId);
  const wanted = cs.audience === 'external' && cs.approved ? 'external' : 'internal';
  add('audience', sharing?.audience === wanted, { audience: sharing?.audience || 'unknown', wanted });

  const required = REQUIRED_CHECKS[phase];
  const missing = required.filter((n) => !checks.some((c) => c.name === n));
  const verdict = missing.length === 0 && checks.filter((c) => required.includes(c.name)).every((c) => c.passed) ? 'PASS' : 'FAIL';
  const bundle = { id: crypto.randomUUID(), changeSetId: cs.id, appId: ctx.appId, phase, verifierId: v.id || 'router-independent-verifier', definitionHash: defHash(def), checks, missing, verdict, createdAt: now() };
  bundle.sha256 = sha256({ ...bundle });
  ctx.state.bundles.set(bundle.id, bundle);
  return bundle;
}

async function runActionTest(ctx, t) {
  const api = ctx.deps.verifier.api || ctx.deps.api;
  try {
    need(api && t && /^CNAI_TEST_[A-Za-z0-9_-]{1,60}$/.test(String(t.key)), 'Actionテストはキーが CNAI_TEST_ で始まるテスト行のみ対象です');
    need(NAME.test(String(t.action)) && NAME.test(String(t.table)) && /^[A-Za-z0-9_]{1,60}$/.test(String(t.keyColumn)), 'Actionテスト指定が不正です');
    await api.invokeAction(t.table, t.action, [{ [t.keyColumn]: t.key }]);
    const rows = await api.find(t.table, { selector: `Filter(${t.table}, [${t.keyColumn}]="${t.key}")` });
    const row = (rows || []).find((r) => String(r[t.keyColumn]) === t.key);
    const ok = Boolean(row) && Object.entries(t.expect || {}).every(([k, v]) => String(row[k]) === String(v)) && Object.keys(t.expect || {}).length > 0;
    return { action: t.action, passed: ok };
  } catch (e) { return { action: t?.action, passed: false, error: e.message }; }
}

async function runSecurityCheck(ctx, v, c) {
  const api = v.api || ctx.deps.api;
  try {
    need(api && NAME.test(String(c.table)) && /^[^@\s]+@[^@\s]+$/.test(String(c.runAs)), 'securityCheck指定が不正です');
    const rows = await api.find(c.table, { runAs: c.runAs });
    const list = Array.isArray(rows) ? rows : [];
    const keyCol = c.keyColumn;
    const maxOk = c.expectMaxRows === undefined || list.length <= c.expectMaxRows;
    const hiddenOk = !(c.mustNotSeeKeys || []).some((k) => list.some((r) => String(r[keyCol]) === String(k)));
    const seesOk = (c.mustSeeKeys || []).every((k) => list.some((r) => String(r[keyCol]) === String(k)));
    return { table: c.table, runAs: c.runAs, rowCount: list.length, passed: maxOk && hiddenOk && seesOk };
  } catch (e) { return { table: c?.table, passed: false, error: e.message }; }
}

async function verify(ctx, p) {
  const cs = csOf(ctx, p.changeSetId);
  need(['saved', 'verified', 'deployed'].includes(cs.status), '保存済みのchangeSetのみ検証できます', 'INVALID_STATE');
  const phase = p.phase === 'post_deploy' ? 'post_deploy' : 'pre_deploy';
  const bundle = await runVerifier(ctx, cs, phase);
  ctx.evidence.checks.push(...bundle.checks.map((c) => ({ name: c.name, passed: c.passed })));
  ctx.evidence.after = { bundleId: bundle.id, bundleSha256: bundle.sha256, definitionHash: bundle.definitionHash };
  if (bundle.verdict === 'PASS' && phase === 'pre_deploy' && cs.status !== 'deployed') { cs.status = 'verified'; cs.bundleId = bundle.id; }
  const out = { bundleId: bundle.id, changeSetId: cs.id, phase, verifierId: bundle.verifierId, checks: bundle.checks, missing: bundle.missing };
  return bundle.verdict === 'PASS'
    ? ctx.finish({ success: true, verified: true, ...out })
    : ctx.finish({ success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: `独立Verifier FAIL: ${bundle.checks.filter((c) => !c.passed).map((c) => c.name).join(', ') || bundle.missing.join(', ')}`, ...out });
}

// ---- deploy / rollback ----

function deployGateReasons(ctx, p) {
  const cs = ctx.state.changeSets.get(p.changeSetId);
  const reasons = [];
  if (p.audience === 'external' || cs?.audience === 'external') reasons.push('external_publish');
  if (p.billingImpact === true || cs?.flags?.billingImpact) reasons.push('billing_impact');
  if (cs?.flags?.permissionExpansion && !cs.approved) reasons.push('permission_change');
  if (cs?.flags?.externalRecipient && !cs.approved) reasons.push('external_notification_recipient');
  return reasons;
}

async function deploy(ctx, p) {
  const cs = csOf(ctx, p.changeSetId);
  const bundle = ctx.state.bundles.get(cs.bundleId);
  // Evidence Gate
  const complete = bundle && bundle.verdict === 'PASS' && bundle.phase === 'pre_deploy' && REQUIRED_CHECKS.pre_deploy.every((n) => bundle.checks.some((c) => c.name === n && c.passed));
  ctx.evidence.checks.push({ name: 'evidence_gate', passed: Boolean(complete) });
  if (cs.status !== 'verified' || !complete) return ctx.finish({ success: false, verified: false, errorCode: 'EVIDENCE_INCOMPLETE', errorSummary: 'デプロイには独立Verifier PASSの完全なEvidence(保存→再取得→スマホ→Action→Security→公開範囲)が必要です', changeSetId: cs.id });
  const current = await ctx.deps.editor.readDefinition(ctx.appId);
  const drift = defHash(current) !== bundle.definitionHash;
  ctx.evidence.checks.push({ name: 'no_drift_since_verification', passed: !drift });
  if (drift) return ctx.finish({ success: false, verified: false, errorCode: 'DRIFT_DETECTED', errorSummary: '検証後に定義が変化しているためデプロイしません（再検証が必要）', changeSetId: cs.id });

  const audience = cs.audience === 'external' && ctx.approved ? 'external' : 'internal';
  const res = await ctx.deps.editor.deploy(ctx.appId, { audience });
  need(res && res.deployed === true, 'Editorがデプロイ成功を返しませんでした', 'DEPLOY_FAILED');
  cs.status = 'deployed';
  const post = await runVerifier(ctx, cs, 'post_deploy');
  ctx.evidence.checks.push(...post.checks.map((c) => ({ name: `post_deploy:${c.name}`, passed: c.passed })));
  ctx.evidence.after = { postDeployBundleId: post.id, bundleSha256: post.sha256, definitionHash: post.definitionHash };
  if (post.verdict === 'PASS') { cs.postBundleId = post.id; return ctx.finish({ success: true, verified: true, phase: 'deployed_verified', changeSetId: cs.id, preBundleId: bundle.id, postBundleId: post.id, deployedVersion: res.version }); }
  // Post-deploy failure: restore the tested snapshot, redeploy it, and re-verify. Never report success.
  const rb = await restoreSnapshot(ctx, cs, { redeploy: true });
  return ctx.finish({ success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: `デプロイ後の検証に失敗: ${post.checks.filter((c) => !c.passed).map((c) => c.name).join(', ')}（自動ロールバック: ${rb.restored ? '実施' : '失敗'}）`, changeSetId: cs.id, postBundleId: post.id, rolledBack: rb });
}

function rollbackGateReasons(ctx, p) {
  if (p.changeSetId && ctx.state.changeSets.has(p.changeSetId)) return [];
  return ['rollback_to_foreign_snapshot'];
}

async function restoreSnapshot(ctx, cs, { redeploy }) {
  const snap = ctx.state.snapshots.get(cs.snapshotId);
  need(snap, 'Snapshotが見つかりません', 'NOT_FOUND');
  await ctx.deps.editor.restore(ctx.appId, snap.definition);
  if (redeploy) await ctx.deps.editor.deploy(ctx.appId, { audience: 'internal' });
  const after = await ctx.deps.editor.readDefinition(ctx.appId);
  const restored = defHash(after) === snap.definitionHash;
  cs.status = restored ? 'rolled_back' : 'rollback_failed';
  return { restored, definitionHash: defHash(after), snapshotHash: snap.definitionHash };
}

async function rollback(ctx, p) {
  const cs = csOf(ctx, p.changeSetId);
  const wasDeployed = cs.status === 'deployed';
  const rb = await restoreSnapshot(ctx, cs, { redeploy: wasDeployed });
  ctx.evidence.checks.push({ name: 'restored_definition_matches_snapshot', passed: rb.restored });
  ctx.evidence.after = rb;
  return rb.restored ? ctx.finish({ success: true, verified: true, phase: 'rolled_back', changeSetId: cs.id, ...rb }) : ctx.finish({ success: false, verified: false, errorCode: 'VERIFICATION_FAILED', errorSummary: 'ロールバック後の再取得がSnapshotと一致しません', changeSetId: cs.id, ...rb });
}

// ---- orchestrator: one instruction -> plan -> edit -> save -> verify -> deploy -> post-deploy verify ----

async function change(ctx, params) {
  const { config } = ctx;
  let plan = params.plan;
  let planAuthor = plan?.author || 'unspecified';
  if (!plan && params.goal && ctx.deps.planner) { plan = await ctx.deps.planner({ goal: params.goal, appId: ctx.appId }); planAuthor = 'gemini'; }
  need(plan && Array.isArray(plan.steps) && plan.steps.length > 0 && plan.steps.length <= 30, 'plan.stepsが必要です（Geminiが作成した実装案。1〜30件）');
  const steps = plan.steps.map((s) => validateStep(s.capability, s, config));
  const tests = plan.tests && typeof plan.tests === 'object' ? plan.tests : {};
  ctx.evidence.plan = { author: planAuthor, sha256: sha256(plan), stepCount: steps.length };
  const reasons = planGate(plan, steps);
  const blocked = gate(ctx, ctx.request.proposalOnly && !reasons.length ? ['proposal_only_entry'] : reasons, () => summarize('appsheet.change', { ...params, plan }, null));
  if (blocked) return blocked;

  const sub = (capability, p2) => executeAppSheet({ ...ctx.deps }, { capability, params: { appId: ctx.appId, ...p2 }, approvedByHuman: ctx.approved === true });
  let csId;
  const stages = [];
  const rollbackNow = async () => { if (!csId) return null; const cs = ctx.state.changeSets.get(csId); return restoreSnapshot(ctx, cs, { redeploy: cs.status === 'deployed' }).catch((e) => ({ restored: false, error: e.message })); };
  const stop = async (stage, r) => {
    const rb = await rollbackNow();
    ctx.evidence.checks.push({ name: `stage:${stage}`, passed: false });
    return ctx.finish({ success: false, verified: false, errorCode: r.errorCode || 'FAILED', errorSummary: `${stage}で停止: ${r.errorSummary}`, changeSetId: csId, stages, rolledBack: rb });
  };

  for (const step of steps) {
    const r = await sub(step.capability, { changeSetId: csId, target: step.target, set: step.set, ...(csId ? {} : { tests }), ...(step.billingImpact ? { billingImpact: true } : {}) });
    stages.push({ stage: step.capability, target: step.target, status: r.success ? 'OK' : r.errorCode });
    if (!r.success) return stop(`編集(${step.capability})`, r);
    csId = r.changeSetId;
  }
  const cs = ctx.state.changeSets.get(csId);
  cs.audience = plan.audience === 'external' ? 'external' : 'internal';
  cs.tests = mergeTests({}, tests);
  if (ctx.approved) cs.approved = true;

  const saved = await sub('appsheet.save', { changeSetId: csId }); stages.push({ stage: 'save', status: saved.success ? 'OK' : saved.errorCode });
  if (!saved.success) return stop('保存/再取得', saved);
  const ver = await sub('appsheet.verify', { changeSetId: csId, phase: 'pre_deploy' }); stages.push({ stage: 'verify(pre_deploy)', status: ver.verified ? 'PASS' : 'FAIL', bundleId: ver.bundleId });
  if (!ver.verified) return stop('独立Verifier(デプロイ前)', ver);
  ctx.evidence.checks.push({ name: 'pre_deploy_verifier', passed: true });

  if (plan.deploy === false) return ctx.finish({ success: true, verified: false, phase: 'verified_not_deployed', changeSetId: csId, stages, note: 'plan.deploy=false のためデプロイしていません（完了ではありません）' });
  const dep = await sub('appsheet.deploy', { changeSetId: csId, audience: cs.audience, ...(plan.billingImpact ? { billingImpact: true } : {}) });
  stages.push({ stage: 'deploy+post_deploy_verify', status: dep.verified ? 'PASS' : (dep.errorCode || 'FAIL') });
  if (dep.errorCode === 'HUMAN_APPROVAL_REQUIRED') return ctx.finish({ ...dep, changeSetId: csId, stages, success: false, verified: false });
  if (!dep.verified) { ctx.evidence.checks.push({ name: 'stage:deploy', passed: false }); return ctx.finish({ success: false, verified: false, errorCode: dep.errorCode || 'VERIFICATION_FAILED', errorSummary: dep.errorSummary, changeSetId: csId, stages, rolledBack: dep.rolledBack }); }
  ctx.evidence.checks.push({ name: 'post_deploy_verifier', passed: true });
  return ctx.finish({ success: true, verified: true, phase: 'deployed_verified', changeSetId: csId, stages, preBundleId: dep.preBundleId, postBundleId: dep.postBundleId });
}

// ---- Gemini planner (optional; plan is untrusted and re-validated) ----

function createGeminiPlanner({ client, config }) {
  return async ({ goal, appId }) => {
    need(config.gemini?.enabled === true && config.gemini?.model && client?.forScopes, 'Gemini実装案作成が未有効です（GOOGLE_GEMINI_ENABLED=true / GOOGLE_GEMINI_MODEL）。planを直接指定してください', 'NOT_CONFIGURED');
    need(typeof goal === 'string' && goal.length > 0 && goal.length <= 4000, 'goalは1〜4000文字です');
    const prompt = `You design a change plan for the AppSheet app ${appId}. Return ONLY JSON {"steps":[{"capability":"appsheet.view.update|appsheet.edit|appsheet.action.update|appsheet.image.update|appsheet.security.update|appsheet.automation.update","target":"...","set":{...}}],"tests":{"mobileScreens":[],"actionTests":[],"securityChecks":[]},"audience":"internal","deploy":true}. Goal: ${goal}`;
    const r = await client.forScopes(['https://www.googleapis.com/auth/generative-language.retriever']).geminiGenerate(config.gemini.model, prompt);
    const raw = r?.candidates?.[0]?.content?.parts?.map((x) => x.text || '').join('') || '';
    const m = /\{[\s\S]*\}/.exec(raw);
    need(m, 'Geminiの実装案がJSONではありません', 'PLAN_INVALID');
    let plan; try { plan = JSON.parse(m[0]); } catch (_) { throw new AppSheetError('Geminiの実装案を解析できません', 'PLAN_INVALID'); }
    return { ...plan, author: 'gemini' };
  };
}

function createAppSheetExtension(deps) {
  const state = deps.state || createAppSheetState();
  return { handles: (c) => Object.prototype.hasOwnProperty.call(APPSHEET_CAPABILITIES, c), execute: (req) => executeAppSheet({ ...deps, state }, req), state };
}

module.exports = { APPSHEET_CAPABILITIES, EDIT_OPS, REQUIRED_CHECKS, AppSheetError, createAppSheetState, executeAppSheet, createAppSheetExtension, createGeminiPlanner, validateStep, planGate, resolveAsset };
