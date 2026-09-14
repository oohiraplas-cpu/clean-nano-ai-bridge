const crypto = require('node:crypto');

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
    this.githubRoot = (config.githubRoot || '').replace(/^\/+|\/+$/g, '');
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

  async getSourceFile(relativePath) {
    const filePath = this._sourcePath(relativePath);
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await this._githubRequest(
      `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(this.githubBranch)}`
    );
    if (!data || data.type !== 'file') throw new Error('指定したPower Appsソースファイルを取得できません');
    return {
      status: 'ok',
      path: filePath,
      sha: data.sha,
      branch: this.githubBranch,
      content: Buffer.from(data.content || '', 'base64').toString('utf8')
    };
  }

  async updateSourceFile(relativePath, content, message) {
    if (typeof content !== 'string') throw new Error('contentは文字列である必要があります');
    const current = await this.getSourceFile(relativePath);
    const filePath = current.path;
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const operationId = crypto.randomUUID();
    const body = {
      message: message || `Update Power Apps source: ${filePath}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: current.sha,
      branch: this.githubBranch
    };
    const result = await this._githubRequest(
      `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedPath}`,
      { method: 'PUT', body: JSON.stringify(body) }
    );
    return {
      status: 'ok',
      operationId,
      path: filePath,
      branch: this.githubBranch,
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

  async refreshFromGit() {
    const result = await this._dataversePost('RefreshChangesFromGit', {
      SolutionUniqueName: this.solutionUniqueName
    });
    return { status: 'ok', action: 'RefreshChangesFromGit', solutionUniqueName: this.solutionUniqueName, result };
  }

  async pullFromGit() {
    const result = await this._dataversePost('PullChangesFromGit', {
      SolutionUniqueName: this.solutionUniqueName
    });
    return { status: 'ok', action: 'PullChangesFromGit', solutionUniqueName: this.solutionUniqueName, result };
  }

  async applySourceFileChange(relativePath, content, message) {
    const update = await this.updateSourceFile(relativePath, content, message);
    const refresh = await this.refreshFromGit();
    const pull = await this.pullFromGit();
    return { status: 'ok', update, refresh, pull };
  }
}

module.exports = { PowerAppsGitStore, OAuthTokenCache };
