const assert = require('node:assert/strict');
const test = require('node:test');
const { PermissionsService } = require('../src/permissionsService');

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const SYSTEM_USER = '33333333-3333-3333-3333-333333333333';
const ROLE_ID = '44444444-4444-4444-4444-444444444444';

/** Power Apps管理API・Dataverseの状態を持つ簡易モック。applyChanges:falseで「反映されない」状況を再現できる。 */
function createStore({ applyChanges = true, appPermissions = [], dataverseRoles = [], rolesByName = {}, failWith } = {}) {
  const state = { appPermissions: [...appPermissions], dataverseRoles: [...dataverseRoles] };
  const calls = [];
  const store = {
    tenantId: 't', clientId: 'c', clientSecret: 's', environmentId: 'env-1', appId: 'app-1', orgUrl: 'https://org.crm.dynamics.com',
    async managementRequest(path, options = {}) {
      calls.push({ kind: 'management', path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (failWith) throw failWith;
      if (path.includes('/modifyPermissions')) {
        const body = JSON.parse(options.body);
        if (applyChanges) {
          for (const put of body.put || []) {
            const { principal, roleName } = put.properties;
            state.appPermissions.push({ name: `perm-${principal.id}`, properties: { principal, roleName } });
          }
          for (const del of body.delete || []) state.appPermissions = state.appPermissions.filter((item) => item.name !== del.id);
        }
        return null;
      }
      return { value: state.appPermissions, internalSecret: 'must-not-leak' };
    },
    async dataverseRequest(path, options = {}) {
      calls.push({ kind: 'dataverse', path, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
      if (failWith) throw failWith;
      if (path.startsWith('roles?')) {
        const name = decodeURIComponent(path).match(/name eq '(.*)'/)[1];
        return { value: rolesByName[name] || [] };
      }
      if (path.endsWith('/$ref') && (options.method === 'POST')) {
        if (applyChanges) state.dataverseRoles.push({ roleid: ROLE_ID, name: 'Basic User' });
        return null;
      }
      if (path.endsWith('/$ref') && options.method === 'DELETE') {
        if (applyChanges) state.dataverseRoles = state.dataverseRoles.filter((role) => !path.includes(role.roleid));
        return null;
      }
      return { value: state.dataverseRoles, token: 'must-not-leak' };
    }
  };
  return { store, calls, state };
}

const service = (store, config = {}) => new PermissionsService({
  powerAppsStore: store,
  config: { allowedPrincipalDomains: ['example.com'], allowedDataverseRoles: ['Basic User'], ...config }
});
const writes = (calls) => calls.filter((c) => c.method !== 'GET');

// ---- get_permissions ----

test('get_permissions(powerapps_app): 対象種別・取得範囲・現在権限を返し、許可フィールド以外（秘密情報）は返さない', async () => {
  const { store } = createStore({ appPermissions: [{ name: 'p1', properties: { principal: { id: USER_ID, type: 'User', displayName: '野口', email: 'noguchi@example.com', secretToken: 'x' }, roleName: 'CanEdit' } }] });
  const result = await service(store).getPermissions({ targetType: 'powerapps_app' });
  assert.equal(result.status, 'ok');
  assert.equal(result.targetType, 'powerapps_app');
  assert.deepEqual({ environmentId: result.scope.environmentId, appId: result.scope.appId }, { environmentId: 'env-1', appId: 'app-1' });
  assert.equal(result.count, 1);
  assert.deepEqual(result.permissions[0], { permissionId: 'p1', principalId: USER_ID, principalType: 'User', displayName: '野口', email: 'noguchi@example.com', roleName: 'CanEdit' });
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  assert.ok(!JSON.stringify(result).includes('secretToken'));
});

test('get_permissions(dataverse_user_roles): 指定ユーザーのロールを返す／principalId未指定は拒否', async () => {
  const { store, calls } = createStore({ dataverseRoles: [{ roleid: ROLE_ID, name: 'Basic User' }] });
  const result = await service(store).getPermissions({ targetType: 'dataverse_user_roles', principalId: SYSTEM_USER });
  assert.equal(result.targetType, 'dataverse_user_roles');
  assert.deepEqual(result.permissions, [{ principalId: SYSTEM_USER, principalType: 'User', roleId: ROLE_ID, roleName: 'Basic User' }]);
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
  assert.equal(writes(calls).length, 0, '読み取り専用');
  await assert.rejects(service(store).getPermissions({ targetType: 'dataverse_user_roles' }), (error) => error.status === 400);
});

test('get_permissions: 設定不足はnot_configuredで、アプリ未設定・org未設定を明示する', async () => {
  const { store } = createStore();
  store.appId = '';
  await assert.rejects(service(store).getPermissions({ targetType: 'powerapps_app' }),
    (error) => error.status === 503 && error.payload.status === 'not_configured' && error.payload.missingConfiguration.includes('POWERAPPS_APP_ID'));
  const { store: noOrg } = createStore();
  noOrg.orgUrl = '';
  await assert.rejects(service(noOrg).getPermissions({ targetType: 'dataverse_user_roles', principalId: SYSTEM_USER }),
    (error) => error.payload.missingConfiguration.includes('POWERAPPS_ORG_URL'));
});

test('get_permissions: 上流エラー（404/409/429/500）はupstream情報を保持したまま伝播する', async () => {
  for (const status of [404, 409, 429, 500]) {
    const failWith = Object.assign(new Error(`Power Apps管理API呼び出しに失敗しました (HTTP ${status})`), { upstream: { httpStatus: status } });
    const { store } = createStore({ failWith });
    await assert.rejects(service(store).getPermissions({ targetType: 'powerapps_app' }), (error) => error.upstream.httpStatus === status);
  }
});

// ---- update_permissions: powerapps_app ----

const grant = (overrides = {}) => ({ targetType: 'powerapps_app', action: 'grant', principalId: USER_ID, principalType: 'User', roleName: 'CanView', approvedByHuman: true, ...overrides });

test('update_permissions: CanViewを付与し、変更前後を取得して検証する', async () => {
  const { store, calls } = createStore();
  const result = await service(store).updatePermissions(grant());
  assert.equal(result.status, 'ok');
  assert.equal(result.verified, true);
  assert.equal(result.changed, true);
  assert.equal(result.before.length, 0);
  assert.equal(result.after.length, 1);
  assert.equal(result.after[0].roleName, 'CanView');
  const write = writes(calls)[0];
  assert.deepEqual(write.body.put[0].properties, { principal: { id: USER_ID, type: 'User' }, roleName: 'CanView' });
  assert.ok(result.warnings.some((w) => w.includes('外部ユーザーかどうかは確認できていません')));
});

test('update_permissions: 既に同じ権限がある場合は書き込まず、changed:falseで返す', async () => {
  const { store, calls } = createStore({ appPermissions: [{ name: 'p', properties: { principal: { id: USER_ID, type: 'User' }, roleName: 'CanView' } }] });
  const result = await service(store).updatePermissions(grant());
  assert.equal(result.changed, false);
  assert.equal(writes(calls).length, 0);
});

test('update_permissions: 権限の取消（revoke）を実行・検証する／存在しない権限は拒否', async () => {
  const { store, calls } = createStore({ appPermissions: [{ name: 'perm-x', properties: { principal: { id: USER_ID, type: 'User' }, roleName: 'CanEdit' } }] });
  const result = await service(store).updatePermissions(grant({ action: 'revoke', roleName: 'CanEdit' }));
  assert.equal(result.changed, true);
  assert.equal(result.after.length, 0);
  assert.deepEqual(writes(calls)[0].body.delete, [{ id: 'perm-x' }]);
  await assert.rejects(service(store).updatePermissions(grant({ action: 'revoke', roleName: 'CanEdit' })),
    (error) => error.status === 404 && error.payload.status === 'permission_not_found');
});

test('update_permissions: 強い権限・テナント全体共有・外部共有は既定で拒否し、書き込みも読み取りもしない', async () => {
  const { store, calls } = createStore();
  const cases = [
    [grant({ roleName: 'Owner' }), 'strong_permission'],
    [grant({ roleName: 'CanEditWithShare' }), 'strong_permission'],
    [grant({ principalType: 'Tenant', principalId: 'tenant' }), 'environment_wide_share'],
    [grant({ principalId: 'guest_other.com#EXT#@example.onmicrosoft.com' }), 'external_share'],
    [grant({ principalId: 'someone@evil.example.org' }), 'external_share']
  ];
  for (const [params, reason] of cases) {
    await assert.rejects(service(store).updatePermissions(params), (error) => error.status === 403 && error.payload.reason === reason, reason);
  }
  assert.equal(calls.length, 0);
});

test('update_permissions: メールアドレス指定で許可ドメインが未構成ならnot_configured、許可ドメインなら通る', async () => {
  const { store } = createStore();
  await assert.rejects(service(store, { allowedPrincipalDomains: [] }).updatePermissions(grant({ principalId: 'a@example.com' })),
    (error) => error.payload.status === 'not_configured' && error.payload.missingConfiguration.includes('PERMISSIONS_ALLOWED_PRINCIPAL_DOMAINS'));
  const result = await service(store).updatePermissions(grant({ principalId: 'a@example.com' }));
  assert.equal(result.status, 'ok');
});

test('update_permissions: principalIdの形式不正は400', async () => {
  const { store } = createStore();
  await assert.rejects(service(store).updatePermissions(grant({ principalId: 'not-a-guid-or-mail' })), (error) => error.status === 400);
});

test('update_permissions: 変更が反映されない場合はverification_failedで、成功扱いにしない', async () => {
  const { store } = createStore({ applyChanges: false });
  await assert.rejects(service(store).updatePermissions(grant()),
    (error) => error.status === 502 && error.payload.status === 'verification_failed' && error.payload.verified === false && error.payload.after.length === 0);
});

test('update_permissions: 上流エラー（404/409/429/500）はupstream情報を保持し、書き込みに進まない', async () => {
  for (const status of [404, 409, 429, 500]) {
    const failWith = Object.assign(new Error(`HTTP ${status}`), { upstream: { httpStatus: status } });
    const { store, calls } = createStore({ failWith });
    await assert.rejects(service(store).updatePermissions(grant()), (error) => error.upstream.httpStatus === status);
    assert.equal(writes(calls).length, 0);
  }
});

// ---- update_permissions: dataverse_user_roles ----

const dvGrant = (overrides = {}) => ({ targetType: 'dataverse_user_roles', action: 'grant', principalId: SYSTEM_USER, principalType: 'User', roleName: 'Basic User', approvedByHuman: true, ...overrides });

test('update_permissions(dataverse): 許可リストの最小ロールを付与し、変更前後を検証する', async () => {
  const { store, calls } = createStore({ rolesByName: { 'Basic User': [{ roleid: ROLE_ID, name: 'Basic User' }] } });
  const result = await service(store).updatePermissions(dvGrant());
  assert.equal(result.status, 'ok');
  assert.equal(result.verified, true);
  assert.equal(result.before.length, 0);
  assert.equal(result.after[0].roleName, 'Basic User');
  const post = writes(calls)[0];
  assert.ok(post.path.includes(`systemusers(${SYSTEM_USER})/systemuserroles_association/$ref`));
  assert.ok(post.body['@odata.id'].endsWith(`roles(${ROLE_ID})`));
});

test('update_permissions(dataverse): System Administrator等の強い権限は、許可リストに入れていても拒否する', async () => {
  const { store, calls } = createStore();
  const permissive = service(store, { allowedDataverseRoles: ['System Administrator', 'System Customizer', 'Delegate', 'Security Admin'] });
  for (const roleName of ['System Administrator', 'system administrator', 'System Customizer', 'Delegate', 'Security Admin']) {
    await assert.rejects(permissive.updatePermissions(dvGrant({ roleName })),
      (error) => error.status === 403 && error.payload.reason === 'strong_permission', roleName);
  }
  assert.equal(calls.length, 0);
});

test('update_permissions(dataverse): 許可リスト外・許可リスト未構成・ロール未存在/曖昧・不正なprincipalを拒否する', async () => {
  const { store } = createStore({ rolesByName: { 'Basic User': [{ roleid: ROLE_ID }, { roleid: ROLE_ID }] } });
  await assert.rejects(service(store).updatePermissions(dvGrant({ roleName: 'Environment Maker' })), (error) => error.payload.reason === 'role_not_in_allowlist');
  await assert.rejects(service(store, { allowedDataverseRoles: [] }).updatePermissions(dvGrant()),
    (error) => error.payload.status === 'not_configured' && error.payload.missingConfiguration.includes('PERMISSIONS_ALLOWED_DATAVERSE_ROLES'));
  await assert.rejects(service(store).updatePermissions(dvGrant()), (error) => error.status === 409 && error.payload.status === 'role_ambiguous');
  const missing = createStore({ rolesByName: {} });
  await assert.rejects(service(missing.store).updatePermissions(dvGrant()), (error) => error.status === 404 && error.payload.status === 'role_not_found');
  await assert.rejects(service(store).updatePermissions(dvGrant({ principalId: 'user@example.com' })), (error) => error.status === 400);
  await assert.rejects(service(store).updatePermissions(dvGrant({ principalType: 'Group' })), (error) => error.status === 400);
});

test('update_permissions(dataverse): ロールの取消（revoke）を検証し、存在しなければ拒否する', async () => {
  const { store, calls } = createStore({ dataverseRoles: [{ roleid: ROLE_ID, name: 'Basic User' }] });
  const result = await service(store).updatePermissions(dvGrant({ action: 'revoke' }));
  assert.equal(result.changed, true);
  assert.equal(result.after.length, 0);
  const del = writes(calls)[0];
  assert.equal(del.method, 'DELETE');
  assert.ok(del.path.includes(`systemuserroles_association(${ROLE_ID})/$ref`));
  await assert.rejects(service(store).updatePermissions(dvGrant({ action: 'revoke' })), (error) => error.status === 404);
});
