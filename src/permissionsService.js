/**
 * 権限管理Service（get_permissions / update_permissions）。
 *
 * 対象は構成済みのものに限る:
 *   - powerapps_app: 構成済みアプリ(POWERAPPS_APP_ID)の共有権限
 *   - dataverse_user_roles: 指定ユーザーのDataverseセキュリティロール
 * 更新は最小権限のみ。System Administrator等の強い権限、テナント全体共有、外部共有は常に拒否する
 * （上書きするフラグは実装していない）。変更前後を取得し、結果を検証する。
 * 注意: 実際のPower Apps / Dataverse APIとの結合は、このリポジトリのテストではモックでのみ確認している。
 */
const { bridgeError, notConfiguredError } = require('./errors');
const { maskDeep } = require('./secretMasking');

const PERMISSION_TARGET_TYPES = Object.freeze(['powerapps_app', 'dataverse_user_roles']);
const PRINCIPAL_TYPES = Object.freeze(['User', 'Group', 'Tenant']);
const POWERAPPS_ALLOWED_ROLES = Object.freeze(['CanView', 'CanEdit']);
const STRONG_DATAVERSE_ROLES = Object.freeze(['system administrator', 'system customizer', 'delegate']);
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(message, reason, extra = {}) {
  return bridgeError(message, 403, { status: 'refused', reason, ...extra });
}

class PermissionsService {
  constructor({ powerAppsStore, config = {} } = {}) {
    this.store = powerAppsStore;
    this.allowedPrincipalDomains = (config.allowedPrincipalDomains || []).map((value) => String(value).toLowerCase());
    this.allowedDataverseRoles = (config.allowedDataverseRoles || []).map((value) => String(value).toLowerCase());
  }

  _assertPowerAppsConfigured() {
    const missing = [];
    if (!this.store?.tenantId) missing.push('POWERAPPS_TENANT_ID');
    if (!this.store?.clientId) missing.push('POWERAPPS_CLIENT_ID');
    if (!this.store?.clientSecret) missing.push('POWERAPPS_CLIENT_SECRET');
    if (!this.store?.environmentId) missing.push('POWERAPPS_ENVIRONMENT_ID');
    if (!this.store?.appId) missing.push('POWERAPPS_APP_ID');
    if (missing.length) throw notConfiguredError('Power Apps権限管理の設定が不足しています', missing);
  }

  _assertDataverseConfigured() {
    const missing = [];
    if (!this.store?.tenantId) missing.push('POWERAPPS_TENANT_ID');
    if (!this.store?.clientId) missing.push('POWERAPPS_CLIENT_ID');
    if (!this.store?.clientSecret) missing.push('POWERAPPS_CLIENT_SECRET');
    if (!this.store?.orgUrl) missing.push('POWERAPPS_ORG_URL');
    if (missing.length) throw notConfiguredError('Dataverse権限管理の設定が不足しています', missing);
  }

  // ---- 読み取り ----

  async _readPowerAppsPermissions() {
    this._assertPowerAppsConfigured();
    const raw = await this.store.managementRequest(
      `/providers/Microsoft.PowerApps/apps/${encodeURIComponent(this.store.appId)}/permissions?api-version=2016-11-01`
    );
    // 許可したフィールドだけを返す（生の応答は返さない）。
    return (raw?.value || []).map((item) => {
      const properties = item.properties || {};
      const principal = properties.principal || {};
      return {
        permissionId: item.name || item.id || null,
        principalId: principal.id || null,
        principalType: principal.type || null,
        displayName: principal.displayName || null,
        email: principal.email || null,
        roleName: properties.roleName || null
      };
    });
  }

  async _readDataverseRoles(principalId) {
    this._assertDataverseConfigured();
    const raw = await this.store.dataverseRequest(
      `systemusers(${principalId})/systemuserroles_association?$select=roleid,name`
    );
    return (raw?.value || []).map((item) => ({
      principalId, principalType: 'User', roleId: item.roleid || null, roleName: item.name || null
    }));
  }

  async getPermissions(params) {
    if (params.targetType === 'powerapps_app') {
      const permissions = await this._readPowerAppsPermissions();
      return maskDeep({
        status: 'ok',
        targetType: 'powerapps_app',
        scope: {
          environmentId: this.store.environmentId,
          appId: this.store.appId,
          description: '構成済みアプリに直接付与された共有権限のみ（環境全体のロールは含まれません）'
        },
        count: permissions.length,
        permissions
      });
    }
    if (params.principalId === undefined) {
      throw bridgeError('dataverse_user_roles ではprincipalId（systemuserのGUID）が必要です', 400);
    }
    const permissions = await this._readDataverseRoles(params.principalId);
    return maskDeep({
      status: 'ok',
      targetType: 'dataverse_user_roles',
      scope: { orgUrl: this.store.orgUrl, principalId: params.principalId, description: '指定ユーザーに付与されたDataverseセキュリティロールのみ' },
      count: permissions.length,
      permissions
    });
  }

  // ---- 更新 ----

  _assertPowerAppsPolicy(params) {
    const warnings = [];
    if (params.principalType === 'Tenant') {
      throw refusal('テナント全体への共有は拒否されます', 'environment_wide_share', { principalType: 'Tenant' });
    }
    if (!POWERAPPS_ALLOWED_ROLES.includes(params.roleName)) {
      throw refusal(`許可されていないロールです: ${params.roleName}（許可: ${POWERAPPS_ALLOWED_ROLES.join(', ')}）。強い権限は拒否されます`, 'strong_permission', { roleName: params.roleName });
    }
    const id = params.principalId;
    if (/#EXT#/i.test(id)) throw refusal('外部ユーザーへの共有は拒否されます', 'external_share');
    if (id.includes('@')) {
      if (!this.allowedPrincipalDomains.length) {
        throw notConfiguredError('共有を許可するドメインが構成されていません', ['PERMISSIONS_ALLOWED_PRINCIPAL_DOMAINS']);
      }
      const domain = id.split('@').pop().toLowerCase();
      if (!this.allowedPrincipalDomains.includes(domain)) {
        throw refusal(`許可されていないドメインへの共有は拒否されます: ${domain}`, 'external_share', { domain });
      }
    } else if (GUID_PATTERN.test(id)) {
      warnings.push('principalIdがオブジェクトIDのため、外部ユーザーかどうかは確認できていません（外部共有の判定は未確認）');
    } else {
      throw bridgeError('principalIdはEntraオブジェクトID（GUID）またはメールアドレスである必要があります', 400);
    }
    return warnings;
  }

  _assertDataversePolicy(params) {
    const roleLower = params.roleName.toLowerCase();
    if (params.principalType !== 'User') throw bridgeError('dataverse_user_rolesのprincipalTypeはUserのみです', 400);
    if (!GUID_PATTERN.test(params.principalId)) throw bridgeError('dataverse_user_rolesのprincipalIdはsystemuserのGUIDである必要があります', 400);
    if (STRONG_DATAVERSE_ROLES.includes(roleLower) || /admin/i.test(params.roleName)) {
      throw refusal(`強い権限のロールは拒否されます: ${params.roleName}`, 'strong_permission', { roleName: params.roleName });
    }
    if (!this.allowedDataverseRoles.length) {
      throw notConfiguredError('付与を許可するDataverseロールが構成されていません', ['PERMISSIONS_ALLOWED_DATAVERSE_ROLES']);
    }
    if (!this.allowedDataverseRoles.includes(roleLower)) {
      throw refusal(`許可リストにないロールです: ${params.roleName}`, 'role_not_in_allowlist', { roleName: params.roleName });
    }
  }

  async updatePermissions(params) {
    const isApp = params.targetType === 'powerapps_app';
    const warnings = isApp ? this._assertPowerAppsPolicy(params) : (this._assertDataversePolicy(params), []);
    const principalType = params.principalType;

    const read = isApp ? () => this._readPowerAppsPermissions() : () => this._readDataverseRoles(params.principalId);
    const before = await read();
    const matches = (entry) => entry.roleName === params.roleName
      && (isApp ? entry.principalId === params.principalId : true);
    const existing = before.find(matches);

    let changed = false;
    if (params.action === 'grant') {
      if (!existing) {
        if (isApp) {
          await this.store.managementRequest(
            `/providers/Microsoft.PowerApps/apps/${encodeURIComponent(this.store.appId)}/modifyPermissions?api-version=2016-11-01`,
            { method: 'POST', body: JSON.stringify({ put: [{ properties: { principal: { id: params.principalId, type: principalType }, roleName: params.roleName } }] }) }
          );
        } else {
          const roleId = await this._resolveDataverseRoleId(params.roleName);
          await this.store.dataverseRequest(`systemusers(${params.principalId})/systemuserroles_association/$ref`, {
            method: 'POST',
            body: JSON.stringify({ '@odata.id': `${this.store.orgUrl}/api/data/v9.2/roles(${roleId})` })
          });
        }
        changed = true;
      }
    } else {
      if (!existing) {
        throw bridgeError('取り消す対象の権限が存在しません', 404, { status: 'permission_not_found', targetType: params.targetType });
      }
      if (isApp) {
        await this.store.managementRequest(
          `/providers/Microsoft.PowerApps/apps/${encodeURIComponent(this.store.appId)}/modifyPermissions?api-version=2016-11-01`,
          { method: 'POST', body: JSON.stringify({ delete: [{ id: existing.permissionId }] }) }
        );
      } else {
        await this.store.dataverseRequest(`systemusers(${params.principalId})/systemuserroles_association(${existing.roleId})/$ref`, { method: 'DELETE' });
      }
      changed = true;
    }

    const after = await read();
    const present = after.some(matches);
    const verified = params.action === 'grant' ? present : !present;
    if (!verified) {
      throw bridgeError('権限変更後の検証に失敗しました（変更が反映されていません）', 502, {
        status: 'verification_failed', verified: false, targetType: params.targetType, action: params.action,
        before: maskDeep(before), after: maskDeep(after)
      });
    }
    return maskDeep({
      status: 'ok',
      verified: true,
      changed,
      targetType: params.targetType,
      action: params.action,
      principalId: params.principalId,
      roleName: params.roleName,
      before,
      after,
      ...(warnings.length ? { warnings } : {})
    });
  }

  async _resolveDataverseRoleId(roleName) {
    const filter = encodeURIComponent(`name eq '${roleName.replace(/'/g, "''")}'`);
    const raw = await this.store.dataverseRequest(`roles?$select=roleid,name&$filter=${filter}`);
    const roles = raw?.value || [];
    if (roles.length === 0) throw bridgeError(`ロールが見つかりません: ${roleName}`, 404, { status: 'role_not_found', roleName });
    if (roles.length > 1) throw bridgeError(`ロール名が複数存在するため特定できません: ${roleName}`, 409, { status: 'role_ambiguous', roleName, count: roles.length });
    return roles[0].roleid;
  }
}

module.exports = { PermissionsService, PERMISSION_TARGET_TYPES, PRINCIPAL_TYPES, POWERAPPS_ALLOWED_ROLES };
