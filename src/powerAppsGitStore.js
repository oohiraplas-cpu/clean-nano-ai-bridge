const crypto = require('node:crypto');
const { bridgeError, notConfiguredError } = require('./errors');

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
    this.githubFallbackBranches = [...new Set([...(config.githubFallbackBranches || []), 'sync/cn-aiiraidaicho-live-review-20260926', 'main'].filter(Boolean))];
    this.githubFallbackRoots = [...new Set([...(config.githubFallbackRoots || []), 'powerapps/CN_AI依頼台帳/Source'].map((value) => String(value || '').replace(/^\/+|\/+$/g, '')).filter(Boolean))];
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

  // Inspection never falls back to another branch/root and pins every blob to one commit.
  async getSourceBundle(branch) {
    if (branch !== this.canonicalBranch) throw this._branchConflict('構造解析のbranchが正本と一致しません');
    const required = [['POWERAPPS_GITHUB_TOKEN', this.githubToken], ['POWERAPPS_GITHUB_OWNER', this.githubOwner], ['POWERAPPS_GITHUB_REPO', this.githubRepo], ['POWERAPPS_GITHUB_ROOT', this.githubRoot]];
    const missing = required.filter(([, value]) => !value).map(([key]) => key);
    if (missing.length) throw notConfiguredError('powerapps_source', missing);
    const root = this.githubRoot;
    if (root.split('/').some(p => !p || p === '.' || p === '..') || /[\\:\x00-\x1f]/.test(root)) throw bridgeError('ソースrootが不正です');
    const base = `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}`;
    const head = await this._githubRequest(`${base}/commits/${encodeURIComponent(branch)}`);
    const commitSha = head?.sha;
    if (!/^[0-9a-f]{40}$/i.test(commitSha || '')) throw bridgeError('ソースcommitが不正です', 502);
    const tree = await this._githubRequest(`${base}/git/trees/${commitSha}?recursive=1`);
    if (tree?.truncated !== false || !Array.isArray(tree.tree)) throw bridgeError('ソースtreeの取得が不完全です', 502);
    const entries = tree.tree.filter(e => typeof e.path === 'string' && e.path.startsWith(`${root}/`) && e.type !== 'tree');
    if (!entries.length) throw bridgeError('ソースが存在しません', 404);
    if (entries.length > 100 || entries.some(e => e.type !== 'blob' || e.mode !== '100644' || !/\.(?:yaml|yml|json)$/.test(e.path) || !Number.isInteger(e.size) || e.size > 1000000 || !/^[0-9a-f]{40}$/i.test(e.sha)) || entries.reduce((n, e) => n + e.size, 0) > 4000000) throw bridgeError('ソース形式またはサイズが非対応です', 422);
    const files = [];
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      const data = await this._githubRequest(`${base}/git/blobs/${entry.sha}`);
      if (data?.encoding !== 'base64' || typeof data.content !== 'string' || data.sha !== entry.sha) throw bridgeError('ソースblobが不完全です', 502);
      const bytes = Buffer.from(data.content, 'base64');
      const hash = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (hash !== entry.sha || bytes.length !== entry.size) throw bridgeError('ソースblobの整合性検査に失敗しました', 502);
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
      catch { throw bridgeError('ソースencodingが非対応です', 422); }
      files.push({ relativePath: entry.path.slice(root.length + 1), content });
    }
    return { branch, commitSha, complete: true, files, source: { host: 'github.com', owner: this.githubOwner, repository: this.githubRepo, root: this.githubRoot } };
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
    if (branch === undefined || branch === null) return { checked: false };
    if (branch !== this.canonicalBranch) {
      throw this._branchConflict(`branch不一致のため${action}を拒否しました: 指定=${branch}, 正本branch=${this.canonicalBranch}`);
    }
    return { checked: true, branch };
  }

  async updateSourceFile(relativePath, content, message, expectedBranch) {
    if (typeof content !== 'string') throw new Error('contentは文字列である必要があります');
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
