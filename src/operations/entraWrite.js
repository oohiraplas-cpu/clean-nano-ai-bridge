'use strict';

// Entra ID WRITE（Lane 2）。対象は次の7操作のみ。
//   entra_user_create / entra_user_update / entra_user_disable /
//   entra_group_member_add / entra_group_member_remove / entra_license_assign / entra_license_remove
// 禁止（実装しない）: 物理削除、管理者ロール付与、新規ライセンス購入、初期パスワードの応答・保存、秘密値の監査保存。
//
// 実行順: 入力検証 → 事前読取（preflight） → 計画（dryRun） → 変更前スナップショット（ハッシュ付き）
//         → 書込み（許可経路のみ） → 再取得検証（verify） → Rollback 可否の返却。
// 本番相当の書込み（dryRun=false）は approvedByHuman=true を必須とする（外部書込みの明示承認）。

const crypto = require('node:crypto');
const { validateAction } = require('../files/actionSchema');
const { createEntraAdapter, classifyGraphError, odataString } = require('./entraAdapter');
const { GraphClientError } = require('../graph/graphClient');

const WRITE_ALLOWED = Object.freeze({
  POST: /^\/users(\?|$)|^\/groups\/[^/?]+\/members\/\$ref(\?|$)|^\/users\/[^/?]+\/assignLicense(\?|$)/,
  PATCH: /^\/users\/[^/?]+(\?|$)/,
  DELETE: /^\/groups\/[^/?]+\/members\/[^/?]+\/\$ref(\?|$)/
});
const allowWrite = (method, pathAndQuery) => Boolean(WRITE_ALLOWED[method] && WRITE_ALLOWED[method].test(pathAndQuery));

const GUID = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const UPN = '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,63}$';
const USER_REF = '^[A-Za-z0-9@._%+-]{1,256}$';
const common = { dryRun: { type: 'boolean' }, approvedByHuman: { type: 'boolean' } };

const ACTION_SCHEMAS = Object.freeze({
  entra_user_create: { required: ['userPrincipalName', 'displayName', 'mailNickname'], additionalProperties: false, properties: {
    ...common, userPrincipalName: { type: 'string', pattern: UPN, maxLength: 320 },
    displayName: { type: 'string', minLength: 1, maxLength: 256 },
    mailNickname: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,64}$' },
    usageLocation: { type: 'string', pattern: '^[A-Z]{2}$' }
  } },
  entra_user_update: { required: ['userId', 'changes'], additionalProperties: false, properties: {
    ...common, userId: { type: 'string', pattern: USER_REF, maxLength: 256 },
    changes: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 5, properties: {
      displayName: { type: 'string', minLength: 1, maxLength: 256 },
      department: { type: 'string', maxLength: 64 },
      jobTitle: { type: 'string', maxLength: 128 },
      usageLocation: { type: 'string', pattern: '^[A-Z]{2}$' },
      officeLocation: { type: 'string', maxLength: 128 }
    } }
  } },
  entra_user_disable: { required: ['userId'], additionalProperties: false, properties: {
    ...common, userId: { type: 'string', pattern: USER_REF, maxLength: 256 },
    accountEnabled: { type: 'boolean' }
  } },
  entra_group_member_add: { required: ['groupId', 'userId'], additionalProperties: false, properties: {
    ...common, groupId: { type: 'string', pattern: GUID }, userId: { type: 'string', pattern: GUID }
  } },
  entra_group_member_remove: { required: ['groupId', 'userId'], additionalProperties: false, properties: {
    ...common, groupId: { type: 'string', pattern: GUID }, userId: { type: 'string', pattern: GUID }
  } },
  entra_license_assign: { required: ['userId', 'skuId'], additionalProperties: false, properties: {
    ...common, userId: { type: 'string', pattern: USER_REF, maxLength: 256 }, skuId: { type: 'string', pattern: GUID }
  } },
  entra_license_remove: { required: ['userId', 'skuId'], additionalProperties: false, properties: {
    ...common, userId: { type: 'string', pattern: USER_REF, maxLength: 256 }, skuId: { type: 'string', pattern: GUID }
  } }
});
const OPERATIONS = Object.freeze(Object.keys(ACTION_SCHEMAS));

function sha256Json(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fail(reasonCode, message, extra = {}) {
  return { status: 'FAIL', reasonCode, executed: false, message, ...extra };
}

function randomInitialPassword() {
  // 生成したパスワードは書込みにのみ使い、応答・ログ・監査・保存には出さない。
  return crypto.randomBytes(18).toString('base64url') + 'A1!';
}

function createEntraWriter({ adapter, now = () => new Date().toISOString() } = {}) {
  const graphBase = adapter.client.graphBase;
  const userPath = (id) => `/users/${encodeURIComponent(id)}`;

  async function readUser(userId) {
    return adapter.get(`${userPath(userId)}?$select=id,displayName,userPrincipalName,accountEnabled,usageLocation,department,jobTitle,officeLocation,assignedLicenses`);
  }
  function pickUserFields(user, keys) {
    const out = {};
    for (const k of keys) out[k] = user[k] ?? null;
    return out;
  }

  async function memberIds(groupId) {
    const page = await adapter.list(`/groups/${encodeURIComponent(groupId)}/members?$select=id&$top=999`, 5000);
    return { ids: page.items.map((m) => m.id), truncated: page.truncated };
  }

  const licenseIds = async (userId) => (await readUser(userId)).assignedLicenses || [];
  const specs = {
    async entra_user_create(args) {
      const exists = await adapter.get(`/users?$filter=${encodeURIComponent(`userPrincipalName eq '${odataString(args.userPrincipalName)}'`)}&$select=id`);
      if (Array.isArray(exists.value) && exists.value.length > 0) return { conflict: 'USER_ALREADY_EXISTS' };
      const body = { accountEnabled: false, displayName: args.displayName, mailNickname: args.mailNickname, userPrincipalName: args.userPrincipalName, usageLocation: args.usageLocation || 'JP' };
      return {
        plan: { changes: body, target: args.userPrincipalName },
        before: null,
        write: async () => {
          // 初期パスワードは書込みの本文にだけ入れ、以後どこにも出さない。
          const created = await adapter.client.request({ method: 'POST', pathAndQuery: '/users', allowWrite, body: { ...body, passwordProfile: { forceChangePasswordNextSignIn: true, password: randomInitialPassword() } } });
          if (typeof created.id !== 'string') throw new GraphClientError('UPSTREAM_INVALID_RESPONSE');
          return created.id;
        },
        verify: async (id) => {
          const u = await readUser(id);
          return { ok: u.userPrincipalName === args.userPrincipalName && u.accountEnabled === false, after: { userPrincipalName: u.userPrincipalName, accountEnabled: u.accountEnabled } };
        },
        rollback: { available: true, method: 'entra_user_disable', note: '物理削除は行わない。取消しは entra_user_disable（accountEnabled=false）で無効化する。' },
        rollbackArgs: null,
        humanActions: ['新規ユーザーの初期パスワード配布と有効化は人間が承認して行う（応答・保存はしていない）。']
      };
    },

    async entra_user_update(args) {
      const keys = Object.keys(args.changes);
      const user = await readUser(args.userId);
      const before = pickUserFields(user, keys);
      if (keys.every((k) => before[k] === args.changes[k])) return { noChange: true };
      return {
        plan: { changes: args.changes, target: user.id },
        before: { id: user.id, ...before },
        write: async () => { await adapter.client.request({ method: 'PATCH', pathAndQuery: userPath(args.userId), body: args.changes, allowWrite }); return user.id; },
        verify: async () => {
          const u = await readUser(args.userId);
          const after = pickUserFields(u, keys);
          return { ok: keys.every((k) => after[k] === args.changes[k]), after };
        },
        rollback: { available: true, method: 'entra_user_update', note: '変更前の値を指定して同じ操作を再実行する。' },
        rollbackArgs: { userId: args.userId, changes: before }
      };
    },

    async entra_user_disable(args) {
      const target = args.accountEnabled === true;
      const user = await readUser(args.userId);
      if (user.accountEnabled === target) return { noChange: true };
      return {
        plan: { changes: { accountEnabled: target }, target: user.id },
        before: { id: user.id, accountEnabled: user.accountEnabled },
        write: async () => { await adapter.client.request({ method: 'PATCH', pathAndQuery: userPath(args.userId), body: { accountEnabled: target }, allowWrite }); return user.id; },
        verify: async () => { const u = await readUser(args.userId); return { ok: u.accountEnabled === target, after: { accountEnabled: u.accountEnabled } }; },
        rollback: { available: true, method: 'entra_user_disable', note: '同じ操作で accountEnabled を元の値に戻せる。' },
        rollbackArgs: { userId: args.userId, accountEnabled: user.accountEnabled }
      };
    },

    async entra_group_member_add(args) {
      await adapter.get(`/groups/${encodeURIComponent(args.groupId)}?$select=id`);
      await readUser(args.userId);
      const members = await memberIds(args.groupId);
      if (members.truncated) return { conflict: 'MEMBER_LIST_TRUNCATED' };
      if (members.ids.includes(args.userId)) return { noChange: true };
      return {
        plan: { changes: { addMember: args.userId }, target: args.groupId },
        before: { groupId: args.groupId, memberCount: members.ids.length, userIsMember: false },
        write: async () => {
          await adapter.client.request({ method: 'POST', pathAndQuery: `/groups/${encodeURIComponent(args.groupId)}/members/$ref`, allowWrite, body: { '@odata.id': `${graphBase}/directoryObjects/${encodeURIComponent(args.userId)}` } });
          return args.groupId;
        },
        verify: async () => { const m = await memberIds(args.groupId); return { ok: m.ids.includes(args.userId), after: { userIsMember: m.ids.includes(args.userId) } }; },
        rollback: { available: true, method: 'entra_group_member_remove', note: '同じ引数で entra_group_member_remove を実行すると元に戻る。' },
        rollbackArgs: { groupId: args.groupId, userId: args.userId }
      };
    },

    async entra_group_member_remove(args) {
      await adapter.get(`/groups/${encodeURIComponent(args.groupId)}?$select=id`);
      const members = await memberIds(args.groupId);
      if (members.truncated) return { conflict: 'MEMBER_LIST_TRUNCATED' };
      if (!members.ids.includes(args.userId)) return { noChange: true };
      return {
        plan: { changes: { removeMember: args.userId }, target: args.groupId },
        before: { groupId: args.groupId, memberCount: members.ids.length, userIsMember: true },
        write: async () => {
          await adapter.client.request({ method: 'DELETE', pathAndQuery: `/groups/${encodeURIComponent(args.groupId)}/members/${encodeURIComponent(args.userId)}/$ref`, allowWrite });
          return args.groupId;
        },
        verify: async () => { const m = await memberIds(args.groupId); return { ok: !m.ids.includes(args.userId), after: { userIsMember: m.ids.includes(args.userId) } }; },
        rollback: { available: true, method: 'entra_group_member_add', note: '同じ引数で entra_group_member_add を実行すると元に戻る。' },
        rollbackArgs: { groupId: args.groupId, userId: args.userId }
      };
    },

    async entra_license_assign(args) {
      const user = await readUser(args.userId);
      if (!user.usageLocation) return { conflict: 'USAGE_LOCATION_REQUIRED' };
      const skus = await adapter.call('entra_licenses_list', {});
      const sku = skus.skus.find((x) => x.skuId === args.skuId);
      if (!sku) return { conflict: 'SKU_NOT_FOUND' };
      const current = (user.assignedLicenses || []).map((l) => l.skuId);
      if (current.includes(args.skuId)) return { noChange: true };
      // 空き数が無い場合は購入せず停止する（新規ライセンス購入は禁止）。
      if (sku.available <= 0) return { conflict: 'LICENSE_UNITS_UNAVAILABLE' };
      return {
        plan: { changes: { addLicense: args.skuId }, target: user.id, skuAvailableBefore: sku.available },
        before: { id: user.id, assignedLicenseSkuIds: current },
        write: async () => { await adapter.client.request({ method: 'POST', pathAndQuery: `${userPath(args.userId)}/assignLicense`, allowWrite, body: { addLicenses: [{ skuId: args.skuId }], removeLicenses: [] } }); return user.id; },
        verify: async () => { const ids = (await licenseIds(args.userId)).map((l) => l.skuId); return { ok: ids.includes(args.skuId), after: { assignedLicenseSkuIds: ids } }; },
        rollback: { available: true, method: 'entra_license_remove', note: '同じ引数で entra_license_remove を実行すると割当てを解除できる（購入はしない）。' },
        rollbackArgs: { userId: args.userId, skuId: args.skuId }
      };
    },

    async entra_license_remove(args) {
      const user = await readUser(args.userId);
      const current = (user.assignedLicenses || []).map((l) => l.skuId);
      if (!current.includes(args.skuId)) return { noChange: true };
      return {
        plan: { changes: { removeLicense: args.skuId }, target: user.id },
        before: { id: user.id, assignedLicenseSkuIds: current },
        write: async () => { await adapter.client.request({ method: 'POST', pathAndQuery: `${userPath(args.userId)}/assignLicense`, allowWrite, body: { addLicenses: [], removeLicenses: [args.skuId] } }); return user.id; },
        verify: async () => { const ids = (await licenseIds(args.userId)).map((l) => l.skuId); return { ok: !ids.includes(args.skuId), after: { assignedLicenseSkuIds: ids } }; },
        rollback: { available: true, method: 'entra_license_assign', note: '同じ引数で entra_license_assign を実行すると割当てを戻せる（新規購入はしない）。' },
        rollbackArgs: { userId: args.userId, skuId: args.skuId }
      };
    }
  };

  async function run(operation, rawArgs = {}) {
    if (!OPERATIONS.includes(operation)) return fail('VALIDATION_FAILED', `未知のactionです（対応: ${OPERATIONS.join(', ')}）`);
    const problems = validateAction(ACTION_SCHEMAS[operation], rawArgs);
    if (problems.length) return fail('VALIDATION_FAILED', problems.join('、'));
    if (!adapter.configured) return { status: 'BLOCKED', reasonCode: 'ADAPTER_NOT_CONFIGURED', adapter: 'entra', executed: false, message: 'Entra ID（Graph）の認証が未構成のため、書込みは行いません（未確認）。', nextStep: 'Graph の書込み権限付き認証を構成し、承認後に実行する。' };
    const dryRun = rawArgs.dryRun !== false;
    if (!dryRun && rawArgs.approvedByHuman !== true) return fail('APPROVAL_REQUIRED', '外部への書込みには利用者の明示承認（approvedByHuman=true）が必要です。計画のみ（dryRun）は承認なしで実行できます。');
    const args = Object.fromEntries(Object.entries(rawArgs).filter(([k]) => !['dryRun', 'approvedByHuman'].includes(k)));
    let written = false;
    let attempted = false;
    let recovery = null;
    try {
      const spec = await specs[operation](args);
      if (spec.conflict) return fail(spec.conflict, '書込みの前提を満たさないため実行しませんでした。', { operation });
      if (spec.noChange) return { status: 'PASS', executed: false, dryRun, operation, noChange: true, rollbackAvailable: false, message: '既に目的の状態のため、変更は不要です。' };
      const snapshot = { capturedAt: now(), beforeSha256: sha256Json(spec.before) };
      const base = {
        operation, dryRun, plan: spec.plan, snapshot,
        rollback: { rollbackAvailable: spec.rollback.available, rollbackMethod: spec.rollback.method, rollbackNote: spec.rollback.note, rollbackArgs: spec.rollbackArgs || null },
        humanActions: spec.humanActions || []
      };
      if (dryRun) return { status: 'PASS', executed: false, ...base };
      recovery = base;
      attempted = true;
      const targetId = await spec.write();
      written = true;
      base.targetId = targetId;
      if (operation === 'entra_user_create') {
        base.rollback.rollbackArgs = { userId: targetId, accountEnabled: false };
      }
      const verdict = await spec.verify(targetId);
      if (!verdict.ok) return { status: 'FAIL', executed: true, verified: false, reasonCode: 'VERIFY_MISMATCH', ...base, message: '書込み後の再取得で目的の状態を確認できませんでした。Rollback を検討してください。' };
      return { status: 'PASS', executed: true, verified: true, afterSha256: sha256Json(verdict.after), ...base };
    } catch (error) {
      const failure = classifyGraphError(error, operation);
      if (written) return { ...failure, ...recovery, status: 'FAIL', executed: true, verified: false };
      // A lost write response cannot establish that no external change happened.
      if (attempted) return {
        ...failure, ...recovery, status: 'FAIL', executed: null,
        writeAttempted: true, executionUncertain: true, verified: false,
        ...(operation === 'entra_user_create' ? { rollback: {
          ...recovery.rollback, rollbackAvailable: false, reasonCode: 'TARGET_ID_UNRESOLVED'
        } } : {})
      };
      return failure;
    }
  }

  return { operations: OPERATIONS, schemas: ACTION_SCHEMAS, run, WRITE_ALLOWED, allowWrite };
}

module.exports = { createEntraWriter, ACTION_SCHEMAS, OPERATIONS, WRITE_ALLOWED, allowWrite, randomInitialPassword };
