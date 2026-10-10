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
    if (missing.length) {
      const error = new Error(`GitHub設定が不足しています: ${missing.join(', ')}`);
      error.status = 502;
      error.payload = { status: 'AUTH_CONFIGURATION', missingConfiguration: missing };
      throw error;
    }
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

  /**
   * 自動解決: screenName から実ファイルを検索（完全一致のみ）
   * @param {string} screenName - 画面名（例: "S12_EquipmentOCR"）
   * @returns {Promise<{path: string, sha: string, branch: string}|{error: string, reason: string}>}
   */
  async _resolveScreenToRelativePath(screenName) {
    if (typeof screenName !== 'string' || !screenName.trim()) {
      return { error: 'INVALID_INPUT', reason: 'screenName is required (non-empty string)' };
    }
    const clean = screenName.replace(/^\/+|\/+$/g, '').trim();

    // GitHub API 呼び出し前にトークン確認
    if (!this.githubToken) {
      return {
        error: 'AUTH_CONFIGURATION',
        reason: 'POWERAPPS_GITHUB_TOKEN is not configured. Cannot auto-resolve screen names.'
      };
    }

    // GitRoot配下で該当する .pa.yaml ファイルを検索
    const candidates = await this._listSourceFilesInRoot();
    if (candidates.error) {
      return candidates; // GitHub API エラーが既に分類されている
    }

    // 完全一致のみ: screenName.pa.yaml
    const exact = candidates.find(f =>
      f.replace(/\.pa\.yaml$/, '').toLowerCase() === clean.toLowerCase()
    );
    if (exact) {
      // 見つかったファイルの SHA を取得
      try {
        const fileData = await this.getSourceFile(exact);
        return {
          path: exact,
          sha: fileData.sha,
          branch: fileData.branch
        };
      } catch (error) {
        return {
          error: 'FILE_NOT_FOUND',
          reason: `Found file ${exact} but could not retrieve its content: ${error.message}`
        };
      }
    }

    // 複数候補が見つかった場合
    const partialCandidates = candidates.filter(f =>
      f.toLowerCase().includes(clean.toLowerCase())
    );
    if (partialCandidates.length > 1) {
      return {
        error: 'AMBIGUOUS_PATH',
        reason: `Multiple files match "${clean}": ${partialCandidates.join(', ')}`
      };
    }

    // 見つからない場合
    return {
      error: 'FILE_NOT_FOUND',
      reason: `No exact match found for screen name "${screenName}" in Git root "${this.githubRoot}"`
    };
  }

  /**
   * 複数の画面名を一括解決
   * @param {string[]} targetNames - 画面名配列
   * @returns {Promise<{results: Array, errors: Array}>}
   */
  async resolveTargetNamesToFiles(targetNames) {
    if (!Array.isArray(targetNames) || targetNames.length === 0) {
      return {
        results: [],
        errors: [{ name: null, error: 'INVALID_INPUT', reason: 'targetNames must be a non-empty array' }]
      };
    }

    const results = [];
    const errors = [];

    for (const name of targetNames) {
      const resolved = await this._resolveScreenToRelativePath(name);
      if (resolved.error) {
        errors.push({ name, ...resolved });
      } else {
        results.push({ name, ...resolved });
      }
    }

    return { results, errors };
  }

  /**
   * GitRoot 配下の全 .pa.yaml ファイルをリストアップ
   * @returns {Promise<string[]|{error: string, reason: string}>} 相対パスのリストまたはエラーオブジェクト
   */
  async _listSourceFilesInRoot() {
    try {
      const encodedRoot = this.githubRoot.split('/').map(encodeURIComponent).join('/');
      const response = await this._githubRequest(
        `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedRoot}?ref=${encodeURIComponent(this.githubBranch)}`
      );

      if (!Array.isArray(response)) return [];

      return response
        .filter(item => item.type === 'file' && item.name.endsWith('.pa.yaml'))
        .map(item => item.name)
        .sort();
    } catch (error) {
      const errorMsg = String(error?.message || error);

      // GitHub API エラーを分類
      if (errorMsg.includes('404')) {
        return {
          error: 'FILE_NOT_FOUND',
          reason: `GitHub root path not found: ${this.githubRoot} (branch: ${this.githubBranch})`
        };
      }

      if (errorMsg.includes('401') || errorMsg.includes('403')) {
        return {
          error: 'AUTH_CONFIGURATION',
          reason: `GitHub API authentication failed: ${errorMsg.slice(0, 100)}`
        };
      }

      return {
        error: 'GITHUB_API_ERROR',
        reason: `Failed to list source files: ${errorMsg.slice(0, 150)}`
      };
    }
  }

  /**
   * Get metadata (branch, canonicalBranch, sha) for gitRoot without full content.
   * Used for StateContext hydration only.
   * @returns {Promise<{branch: string, canonicalBranch: string, sha: string}>}
   */
  async getSourceFileMetadata(gitRoot) {
    // CRITICAL: StateContext requires branch commit SHA (not tree SHA or directory SHA).
    // commit SHA = HEAD of the branch, the authoritative snapshot for all files in that commit.
    // Do NOT use tree SHA (directory listing) or file blob SHA as Context state identifier.
    this._assertGitHubConfig();
    const branches = [...new Set([this.githubBranch, ...this.githubFallbackBranches].filter(Boolean))];

    for (const branch of branches) {
      try {
        // Get the commit SHA for the HEAD of this branch
        // This is the StateContext authority: what exactly was committed at this point in time
        const refResponse = await this._githubRequest(
          `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/git/refs/heads/${encodeURIComponent(branch)}`
        );

        if (!refResponse || !refResponse.object || !refResponse.object.sha) {
          continue;
        }

        // Verify the SHA is a valid commit hash (40 hex chars)
        const commitSha = refResponse.object.sha;
        if (!/^[a-f0-9]{40}$/.test(commitSha)) {
          continue;
        }

        return {
          branch,
          canonicalBranch: this.canonicalBranch,
          sha: commitSha  // Commit SHA: the definitive snapshot for StateContext
        };
      } catch (error) {
        // Silently continue to next branch
        continue;
      }
    }

    // Fail-Closed: if no branch provides valid commit SHA, cannot issue StateContext
    const error = new Error('Failed to get Git metadata for StateContext hydration: no valid commit SHA retrieved');
    error.status = 502;
    error.payload = {
      status: 'state_context_invalid',
      reason: 'Cannot retrieve commit SHA from any configured branch for StateContext authority'
    };
    throw error;
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
            sourceControl: this.sourceControl,
            writable: branch === this.canonicalBranch &&
              this.sourceControl?.bridgeMirrorState !== 'hold',
            sourceState: branch === this.canonicalBranch ? 'github_canonical' : 'hold',
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
   * State Lock: write系操作は呼び出し側が実取得したbranchを必須とし、
   * 正本branchとの一致が証明できない場合はFail-Closedで拒否する。
   */
  assertCanonicalBranch(branch, action = '更新') {
    this.assertSourceControlCompatible(action);
    if (branch === undefined || branch === null || branch === '') {
      throw this._branchConflict(`State Lock未成立のため${action}を拒否しました: branchが未指定です。get_powerapps_sourceで実取得したbranchを指定してください`);
    }
    if (branch !== this.canonicalBranch) {
      throw this._branchConflict(`branch不一致のため${action}を拒否しました: 指定=${branch}, 正本branch=${this.canonicalBranch}`);
    }
    return { checked: true, branch };
  }

  assertSourceControlCompatible(action = '更新') {
    if (this.sourceControl?.bridgeMirrorState === 'hold') {
      throw this._branchConflict(`接続先不一致のため${action}を保留: ${this.sourceControl.holdReason}`);
    }
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
      if (/Not a valid solution|Unable to retrieve solution components from root folder path/i.test(detail)) {
        return {
          status: 'ok',
          update,
          sync: {
            status: 'skipped',
            reason: 'solution_not_git_integrated',
            message: 'GitHub正本ソース更新は完了しました。対象SolutionのネイティブGit同期ルートが現在のGitHub正本ルートとして成立していないため、Power Platform自動同期は安全にスキップしました。'
          }
        };
      }
      throw error;
    }
  }
}

module.exports = { PowerAppsGitStore, OAuthTokenCache };
