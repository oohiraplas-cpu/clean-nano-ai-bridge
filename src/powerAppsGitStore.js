const crypto = require('node:crypto');
const applicationRules = require('../config/application-rules.json');

class OAuthTokenCache {
  constructor() {
    this.token = null;
    this.expiresAt = 0;
  }

  async getToken(fetchFn, tokenUrl, clientId, clientSecret, scope) {
    const now = Date.now();
    if (this.token && now < this.expiresAt - 30000) return this.token;

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope,
      grant_type: 'client_credentials'
    });

    const response = await fetchFn(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Dataverse認証に失敗しました (${response.status}): ${detail.slice(0, 200)}`);
    }

    const data = await response.json();
    this.token = data.access_token;
    this.expiresAt = now + Number(data.expires_in || 3600) * 1000;
    return this.token;
  }
}

class PowerAppsGitStore {
  constructor(config = {}) {
    this.tenantId = config.tenantId || '';
    this.clientId = config.clientId || '';
    this.clientSecret = config.clientSecret || '';
    this.orgUrl = (config.orgUrl || '').replace(/\/$/, '');
    this.solutionUniqueName = config.solutionUniqueName || '';
    this.githubToken = config.githubToken || '';
    this.githubOwner = config.githubOwner || '';
    this.githubRepo = config.githubRepo || '';
    this.githubBranch = config.githubBranch || 'main';
    // 更新・保存・公開の対象にしてよい唯一のbranch（正本branch）。fallback branchは読み取り専用。
    this.canonicalBranch = this.githubBranch;
    this.githubRoot = (config.githubRoot || '').replace(/^\/+|\/+$/g, '');
    this.sourceControl = Object.values(applicationRules.apps || {}).find(rule =>
      rule.sourceControl && (rule.sourceControl.solutionUniqueName === this.solutionUniqueName ||
        (rule.gitRoot === this.githubRoot && rule.sourceControl.bridgeMirrorRepository === `${this.githubOwner}/${this.githubRepo}`)))?.sourceControl || null;
    this.githubFallbackBranches = [...new Set([...(config.githubFallbackBranches || []), 'sync/cn-aiiraidaicho-live-review-20260926', 'main'].filter(Boolean))];
    this.githubFallbackRoots = [...new Set([...(config.githubFallbackRoots || []), 'powerapps/CN_AI依頼台帳/Source'].map((value) => String(value || '').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
    this.azureDevOps = config.azureDevOps || {};
    this._fetch = config.fetchImpl || fetch;
    this._tokenCache = new OAuthTokenCache();
  }

  _assertDataverseConfig() {
    const required = [
      ['POWERAPPS_TENANT_ID', this.tenantId],
      ['POWERAPPS_CLIENT_ID', this.clientId],
      ['POWERAPPS_CLIENT_SECRET', this.clientSecret],
      ['POWERAPPS_ORG_URL', this.orgUrl],
      ['POWERAPPS_SOLUTION_UNIQUE_NAME', this.solutionUniqueName]
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`Git同期設定が不足しています: ${missing.join(', ')}`);
  }

  _assertGitHubConfig() {
    const required = [
      ['POWERAPPS_GITHUB_TOKEN', this.githubToken],
      ['POWERAPPS_GITHUB_OWNER', this.githubOwner],
      ['POWERAPPS_GITHUB_REPO', this.githubRepo],
      ['POWERAPPS_GITHUB_BRANCH', this.githubBranch]
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) throw new Error(`GitHub設定が不足しています: ${missing.join(', ')}`);
  }

  _sourcePath(relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length < 1) {
      throw new Error('relativePathが必要です');
    }
    if (relativePath.includes('..')) throw new Error('relativePathに..は使用できません');
    const clean = relativePath.replace(/^\/+/, '');
    return this.githubRoot ? `${this.githubRoot}/${clean}` : clean;
  }

  async _githubRequest(path, options = {}) {
    this._assertGitHubConfig();
    const response = await this._fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.githubToken}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`GitHub API エラー (${response.status}): ${detail.slice(0, 300)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  // 読み取り専用の探索用に、GitHub API呼び出しを公開する（書き込み系は既存の正本branchガード経由のみ）。
  async githubRequest(path) {
    return this._githubRequest(path);
  }

  _useAzureDevOps() {
    return this.sourceControl?.powerAppsAuthority === 'azure_devops_only';
  }

  _assertAzureDevOpsConfig() {
    const a = this.azureDevOps || {};
    const required = [['POWERAPPS_AZDO_ORGANIZATION', a.organization], ['POWERAPPS_AZDO_PROJECT', a.project], ['POWERAPPS_AZDO_REPOSITORY', a.repository], ['POWERAPPS_AZDO_PAT', a.pat]];
    const missing = required.filter(([,v]) => !v).map(([n]) => n);
    if (missing.length) throw new Error(`Azure DevOps設定が不足しています: ${missing.join(', ')}`);
  }

  async _azureDevOpsRequest(path, options = {}) {
    this._assertAzureDevOpsConfig();
    const a = this.azureDevOps;
    const base = `https://dev.azure.com/${encodeURIComponent(a.organization)}/${encodeURIComponent(a.project)}/_apis/git/repositories/${encodeURIComponent(a.repository)}`;
    const auth = Buffer.from(`:${a.pat}`).toString('base64');
    const response = await this._fetch(`${base}${path}`, { ...options, headers: { authorization: `Basic ${auth}`, accept: 'application/json', 'content-type': 'application/json', ...(options.headers || {}) } });
    if (!response.ok) { const detail = await response.text().catch(()=>''); throw new Error(`Azure DevOps API エラー (${response.status}): ${detail.slice(0,300)}`); }
    return response.status === 204 ? null : response.json();
  }

  async _getAzureDevOpsSourceFile(relativePath) {
    const a = this.azureDevOps;
    const branch = a.branch || this.sourceControl?.branch || 'main';
    const root = (a.root || this.sourceControl?.folder || this.githubRoot || '').replace(/^\/+|\/+$/g,'');
    const clean = String(relativePath || '').replace(/^\/+/, '');
    if (!clean || clean.includes('..')) throw new Error('relativePathが不正です');
    const filePath = `/${root ? `${root}/` : ''}${clean}`;
    const data = await this._azureDevOpsRequest(`/items?path=${encodeURIComponent(filePath)}&versionDescriptor.versionType=branch&versionDescriptor.version=${encodeURIComponent(branch)}&includeContent=true&api-version=7.1`);
    return { status:'ok', path:filePath.replace(/^\//,''), sha:data?.objectId || null, branch, canonicalBranch:branch, isCanonicalBranch:true, sourceControl:this.sourceControl, writable:true, sourceState:'azure_devops_authority', content:data?.content || '' };
  }

  async getSourceFile(relativePath) {
    if (this._useAzureDevOps()) return this._getAzureDevOpsSourceFile(relativePath);
    const clean = String(relativePath || '').replace(/^\/+/, '');
    if (!clean) throw new Error('relativePathが必要です');
    if (clean.includes('..')) throw new Error('relativePathに..は使用できません');

    const explicitPath = clean.includes('/');
    const roots = explicitPath
      ? ['']
      : [...new Set([this.githubRoot, ...this.githubFallbackRoots, ''].filter((value) => value !== undefined))];
    const branches = [...new Set([this.githubBranch, ...this.githubFallbackBranches].filter(Boolean))];
    let lastNotFound = null;

    for (const branch of branches) {
      for (const root of roots) {
        const filePath = root ? `${root}/${clean}` : clean;
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
        try {
          const data = await this._githubRequest(
            `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
          );
          if (!data || data.type !== 'file') continue;
          return {
            status: 'ok',
            path: filePath,
            sha: data.sha,
            branch,
            canonicalBranch: this.canonicalBranch,
            isCanonicalBranch: branch === this.canonicalBranch,
            sourceControl: this.sourceControl,
            writable: branch === this.canonicalBranch &&
              !this.sourceControl?.bridgeMirrorState &&
              this.sourceControl?.powerAppsAuthority !== 'azure_devops_only',
            sourceState: this.sourceControl?.powerAppsAuthority === 'azure_devops_only'
              ? 'azure_devops_authority'
              : (this.sourceControl?.bridgeMirrorState || (branch === this.canonicalBranch ? 'configured' : 'hold')),
            content: Buffer.from(data.content || '', 'base64').toString('utf8')
          };
        } catch (error) {
          if (String(error?.message || error).includes('GitHub API エラー (404)')) {
            lastNotFound = error;
            continue;
          }
          throw error;
        }
      }
    }
    throw lastNotFound || new Error('指定したPower Appsソースファイルを取得できません');
  }

  // 正本branch以外への更新・保存・公開を拒否するための共通ガード（HTTP 409相当）。
  _branchConflict(message) {
    const error = new Error(message);
    error.status = 409;
    error.payload = { status: 'branch_mismatch', canonicalBranch: this.canonicalBranch };
    return error;
  }

  /**
   * get_powerapps_sourceが返したbranch等、呼び出し側が把握しているbranchが正本branchと一致するか確認する。
   * branch未指定なら何もしない（後方互換）。
   */
  assertCanonicalBranch(branch, action = '更新') {
    this.assertSourceControlCompatible(action);
    if (branch === undefined || branch === null) return { checked: false };
    if (branch !== this.canonicalBranch) {
      throw this._branchConflict(`branch不一致のため${action}を拒否しました: 指定=${branch}, 正本branch=${this.canonicalBranch}`);
    }
    return { checked: true, branch };
  }

  assertSourceControlCompatible(action = '更新') {
    if (this.sourceControl?.powerAppsAuthority === 'azure_devops_only') {
      if (this.azureDevOps?.organization && this.azureDevOps?.project && this.azureDevOps?.repository && this.azureDevOps?.pat) return;
      throw this._branchConflict(`Power Appsの${action}にはAzure DevOps正本接続設定が必要です。`);
    }
    if (this.sourceControl?.bridgeMirrorState === 'hold') {
      throw this._branchConflict(`接続先不一致のため${action}を保留: ${this.sourceControl.holdReason}`);
    }
  }

  async updateSourceFile(relativePath, content, message, expectedBranch) {
    if (typeof content !== 'string') throw new Error('contentは文字列である必要があります');
    if (this._useAzureDevOps()) {
      const current = await this._getAzureDevOpsSourceFile(relativePath);
      const branch = current.branch;
      if (expectedBranch && expectedBranch !== branch) throw this._branchConflict(`branch不一致のため更新を拒否しました: 指定=${expectedBranch}, 正本branch=${branch}`);
      const a=this.azureDevOps; const root=(a.root || this.sourceControl?.folder || this.githubRoot || '').replace(/^\/+|\/+$/g,''); const clean=String(relativePath).replace(/^\/+/, ''); const itemPath=`/${root ? `${root}/` : ''}${clean}`;
      const refs=await this._azureDevOpsRequest(`/refs?filter=${encodeURIComponent(`heads/${branch}`)}&api-version=7.1`); const oldObjectId=refs?.value?.[0]?.objectId; if(!oldObjectId) throw new Error(`Azure DevOps branchを解決できません: ${branch}`);
      const body={refUpdates:[{name:`refs/heads/${branch}`,oldObjectId}],commits:[{comment:message || `Update Power Apps source: ${itemPath}`,changes:[{changeType:'edit',item:{path:itemPath},newContent:{content,contentType:'rawtext'}}]}]};
      const result=await this._azureDevOpsRequest(`/pushes?api-version=7.1`,{method:'POST',body:JSON.stringify(body)});
      return {status:'ok',operationId:crypto.randomUUID(),path:itemPath.replace(/^\//,''),branch,commitSha:result?.commits?.[0]?.commitId || null,contentSha:null,provider:'AzureDevOps'};
    }
    this.assertCanonicalBranch(expectedBranch, '更新');
    const current = await this.getSourceFile(relativePath);
    // フォールバック先（過去branch等）でソースが見つかった場合は、そのbranchへ書き込まない。
    if (current.branch !== this.canonicalBranch) {
      throw this._branchConflict(
        `正本branch不一致のため更新を拒否しました: ソースはbranch「${current.branch}」で見つかりましたが、正本branchは「${this.canonicalBranch}」です。過去branchへの書き込みを防止しています`
      );
    }
    const filePath = current.path;
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const operationId = crypto.randomUUID();
    const body = {
      message: message || `Update Power Apps source: ${filePath}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: current.sha,
      branch: current.branch
    };
    const result = await this._githubRequest(
      `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedPath}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    return {
      status: 'ok',
      operationId,
      path: filePath,
      branch: current.branch,
      commitSha: result?.commit?.sha || null,
      contentSha: result?.content?.sha || null
    };
  }

  async _dataversePost(actionName, body) {
    this._assertDataverseConfig();
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const token = await this._tokenCache.getToken(
      this._fetch,
      tokenUrl,
      this.clientId,
      this.clientSecret,
      `${this.orgUrl}/.default`
    );
    const response = await this._fetch(`${this.orgUrl}/api/data/v9.2/${actionName}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'odata-version': '4.0',
        'if-none-match': 'null'
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Dataverse ${actionName} エラー (${response.status}): ${detail.slice(0, 300)}`);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async _resolveSolutionUniqueName() {
    this._assertDataverseConfig();
    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const token = await this._tokenCache.getToken(this._fetch, tokenUrl, this.clientId, this.clientSecret, `${this.orgUrl}/.default`);
    const filter = encodeURIComponent(`uniquename eq '${this.solutionUniqueName.replace(/'/g, "''")}' and ismanaged eq false`);
    const response = await this._fetch(`${this.orgUrl}/api/data/v9.2/solutions?$select=uniquename,friendlyname&$filter=${filter}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'odata-version': '4.0' }
    });
    if (!response.ok) throw new Error(`Dataverse Solution確認エラー (${response.status})`);
    const data = await response.json();
    if (data.value?.length === 1) return data.value[0].uniquename;
    throw new Error(`Power Apps Solutionが見つかりません: ${this.solutionUniqueName}`);
  }

  async refreshFromGit() {
    const solutionUniqueName = await this._resolveSolutionUniqueName();
    const result = await this._dataversePost('RefreshChangesFromGit', {
      SolutionUniqueName: solutionUniqueName
    });
    return { status: 'ok', action: 'RefreshChangesFromGit', solutionUniqueName, result };
  }

  async pullFromGit() {
    const solutionUniqueName = await this._resolveSolutionUniqueName();
    const result = await this._dataversePost('PullChangesFromGit', {
      SolutionUniqueName: solutionUniqueName
    });
    return { status: 'ok', action: 'PullChangesFromGit', solutionUniqueName, result };
  }

  async applySourceFileChange(relativePath, content, message, expectedBranch) {
    const update = await this.updateSourceFile(relativePath, content, message, expectedBranch);
    try {
      const refresh = await this.refreshFromGit();
      const pull = await this.pullFromGit();
      return { status: 'ok', update, sync: { status: 'ok', refresh, pull } };
    } catch (error) {
      const detail = String(error?.message || error);
      if (/Not a valid solution/i.test(detail)) {
        return {
          status: 'ok',
          update,
          sync: {
            status: 'skipped',
            reason: 'solution_not_git_integrated',
            message: 'GitHubソース更新は完了しました。対象SolutionがGit統合SolutionではないためPower Platform自動同期は実行していません。'
          }
        };
      }
      throw error;
    }
  }
}

module.exports = { PowerAppsGitStore, OAuthTokenCache };
