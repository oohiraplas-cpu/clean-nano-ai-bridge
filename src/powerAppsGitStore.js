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
   * 読み取り専用の健全性確認。設定の有無（名前のみ）と正本branchの実在をGitHubで確認する。
   * 秘密値・トークンは返さない。
   */
  async healthCheck() {
    const missingConfiguration = [];
    if (!this.githubToken) missingConfiguration.push('POWERAPPS_GITHUB_TOKEN');
    if (!this.githubOwner) missingConfiguration.push('POWERAPPS_GITHUB_OWNER');
    if (!this.githubRepo) missingConfiguration.push('POWERAPPS_GITHUB_REPO');
    if (missingConfiguration.length) {
      return { ok: false, status: 'not_configured', missingConfiguration };
    }
    const branchName = encodeURIComponent(this.canonicalBranch);
    const branch = await this._githubRequest(`/repos/${this.githubOwner}/${this.githubRepo}/branches/${branchName}`);
    const ok = branch?.name === this.canonicalBranch;
    return { ok, status: ok ? 'ok' : 'branch_mismatch', branch: branch?.name || null, sha: branch?.commit?.sha || null };
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

    const failures = [];
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
        // Preserve non-secret diagnostic categories; never log credentials or response bodies.
        const status = Number(error.status || error.statusCode || error.response?.status);
        const category = status === 401 ? 'authentication' : status === 403 ? 'permission_or_rate_limit' : status === 404 ? 'branch_not_found' : status === 429 ? 'rate_limit' : status >= 500 ? 'upstream' : status >= 400 ? 'request_error' : 'transport_or_config';
        failures.push({ branch, category, status: Number.isInteger(status) ? status : null });
        continue;
      }
    }

    // Fail-Closed: if no branch provides valid commit SHA, cannot issue StateContext
    const error = new Error('Failed to get Git metadata for StateContext hydration: no valid commit SHA retrieved');
    error.status = 502;
    error.payload = {
      status: 'state_context_invalid',
      reason: 'Cannot retrieve commit SHA from any configured branch for StateContext authority',
      failures
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
            ...(/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filePath) ? {
              base64Content: (data.content || '').replace(/\s/g, ''),
              size: data.size ?? null,
              encoding: data.encoding
            } : {}),
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

  async updateSourceFile(relativePath, content, message, expectedBranch, expectedSha) {
    if (typeof content !== 'string') throw new Error('contentは文字列である必要があります');
    this.assertCanonicalBranch(expectedBranch, '更新');
    const current = await this.getSourceFile(relativePath);
    if (expectedSha !== undefined && current.sha !== expectedSha) {
      throw this._branchConflict('観測後に対象ファイルが変化したため更新を拒否しました');
    }
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

  async applySourceFileChange(relativePath, content, message, expectedBranch, expectedSha) {
    const update = await this.updateSourceFile(relativePath, content, message, expectedBranch, expectedSha);
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
  }  /**
   * Power Apps画像アセット統合操作
   *
   * operation:
   * - list   : 指定された画像パスを確認
   * - get    : 画像をBase64で取得
   * - export : 画像をエクスポート用形式で取得
   * - import : 新しい画像をGitHub正本へ登録
   *
   * 注意:
   * - GitHub正本に存在する画像だけが対象
   * - 元画像の上書きは禁止
   * - 正本branchだけに登録し、元画像を上書きしない
   */
  async powerAppsMediaAsset({
    operation,
    relativePath,
    relativePaths = [],
    base64Content,
    contentType,
    expectedBranch,
    message,
    approvedByHuman = false
  } = {}) {
    const supportedExtensions =
      /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

    const supportedContentTypes = new Set([
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/bmp'
    ]);

    const normalizePath = value => {
      if (typeof value !== 'string') return null;

      const normalized = value
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

      if (
        !normalized ||
        normalized.includes('../') ||
        normalized.includes('/..') ||
        normalized.startsWith('..')
      ) {
        return null;
      }

      return normalized;
    };

    const getAsset = async targetPath => {
      const normalizedPath = normalizePath(targetPath);

      if (!normalizedPath) {
        return {
          status: 'blocked',
          error: 'INVALID_RELATIVE_PATH',
          reason:
            'relativePath is required and path traversal is prohibited'
        };
      }

      if (!supportedExtensions.test(normalizedPath)) {
        return {
          status: 'blocked',
          error: 'UNSUPPORTED_MEDIA_TYPE',
          relativePath: normalizedPath
        };
      }

      try {
        const file =
          await this.getSourceFile(this.githubRoot && !normalizedPath.startsWith(this.githubRoot + '/') ? this._sourcePath(normalizedPath) : normalizedPath);

        if (!file) {
          return {
            status: 'not_found',
            error: 'MEDIA_ASSET_NOT_FOUND',
            relativePath: normalizedPath
          };
        }

        if (file.encoding !== 'base64' || !file.base64Content) {
          return { status: 'blocked', error: 'BINARY_CONTENT_UNAVAILABLE', relativePath: normalizedPath,
            reason: 'GitHub Contents APIからBase64画像データを取得できませんでした' };
        }

        return {
          status: 'ok',
          name: normalizedPath.split('/').pop(),
          relativePath: normalizedPath,
          sha: file.sha || null,
          branch: file.branch || expectedBranch || null,
          size:
            typeof file.size === 'number'
              ? file.size
              : null,
          encoding: file.encoding || 'base64',
          content:
            file.base64Content ||
            null,
          downloadUrl:
            file.downloadUrl ||
            file.download_url ||
            null
        };
      } catch (error) {
        const detail =
          String(error?.message || error);

        if (/FILE_NOT_FOUND|NOT_FOUND|404/i.test(detail)) {
          return {
            status: 'not_found',
            error: 'MEDIA_ASSET_NOT_FOUND',
            relativePath: normalizedPath
          };
        }

        return {
          status: 'blocked',
          error: 'MEDIA_ASSET_GET_FAILED',
          reason: detail,
          relativePath: normalizedPath
        };
      }
    };

    if (
      !['list', 'get', 'export', 'import'].includes(operation)
    ) {
      return {
        status: 'blocked',
        error: 'INVALID_OPERATION',
        reason:
          'operation must be list, get, export, or import'
      };
    }

    /*
     * LIST
     * ファイルシステム全体を推測探索せず、
     * 指定された候補パスだけを確認する。
     */
    if (operation === 'list') {
      if (
        !Array.isArray(relativePaths) ||
        relativePaths.length === 0
      ) {
        return {
          status: 'blocked',
          error: 'RELATIVE_PATHS_REQUIRED',
          reason:
            'relativePaths must contain one or more candidate paths'
        };
      }

      const assets = [];

      for (const candidatePath of relativePaths) {
        const result = await getAsset(candidatePath);

        assets.push({
          name:
            result.name ||
            String(candidatePath).split('/').pop(),
          relativePath:
            result.relativePath || candidatePath,
          sha: result.sha || null,
          branch: result.branch || null,
          size: result.size ?? null,
          encoding: result.encoding || null,
          status: result.status,
          error: result.error || null
        });
      }

      return {
        status: 'ok',
        operation: 'list',
        count: assets.length,
        assets,
        verified:
          assets.some(asset => asset.status === 'ok')
      };
    }

    /*
     * GET
     */
    if (operation === 'get') {
      const asset = await getAsset(relativePath);

      return {
        operation: 'get',
        ...asset,
        verified: asset.status === 'ok'
      };
    }

    /*
     * EXPORT
     */
    if (operation === 'export') {
      const asset = await getAsset(relativePath);

      if (asset.status !== 'ok') {
        return {
          operation: 'export',
          ...asset,
          verified: false
        };
      }

      return {
        status: 'ok',
        operation: 'export',
        fileName: asset.name,
        relativePath: asset.relativePath,
        sha: asset.sha,
        branch: asset.branch,
        size: asset.size,
        encoding: asset.encoding,
        base64Content: asset.content,
        downloadUrl: asset.downloadUrl,
        verified: Boolean(
          asset.content || asset.downloadUrl
        ),
        warning:
          'Binary image content must remain Base64 encoded'
      };
    }

    /*
     * IMPORT
     */
    if (operation === 'import') {
      if (approvedByHuman !== true) {
        return {
          status: 'blocked',
          error: 'HUMAN_APPROVAL_REQUIRED'
        };
      }

      const normalizedPath =
        normalizePath(relativePath);

      if (!normalizedPath) {
        return {
          status: 'blocked',
          error: 'INVALID_RELATIVE_PATH'
        };
      }

      if (!supportedExtensions.test(normalizedPath)) {
        return {
          status: 'blocked',
          error: 'UNSUPPORTED_MEDIA_TYPE',
          relativePath: normalizedPath
        };
      }

      if (
        typeof contentType !== 'string' ||
        !supportedContentTypes.has(contentType)
      ) {
        return {
          status: 'blocked',
          error: 'UNSUPPORTED_CONTENT_TYPE',
          contentType
        };
      }

      if (
        typeof expectedBranch !== 'string' ||
        !expectedBranch.trim()
      ) {
        return {
          status: 'blocked',
          error: 'EXPECTED_BRANCH_REQUIRED'
        };
      }

      this.assertCanonicalBranch(expectedBranch, '画像登録');

      if (
        typeof message !== 'string' ||
        !message.trim()
      ) {
        return {
          status: 'blocked',
          error: 'COMMIT_MESSAGE_REQUIRED'
        };
      }

      if (
        typeof base64Content !== 'string' ||
        !base64Content.trim()
      ) {
        return {
          status: 'blocked',
          error: 'BASE64_CONTENT_REQUIRED'
        };
      }

      const cleanBase64 = base64Content
        .replace(
          /^data:image\/[a-zA-Z0-9.+-]+;base64,/,
          ''
        )
        .replace(/\s/g, '');

      if (
        !cleanBase64 ||
        cleanBase64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64)
      ) {
        return {
          status: 'blocked',
          error: 'INVALID_BASE64_CONTENT'
        };
      }

      const estimatedBytes =
        Buffer.from(cleanBase64, 'base64').length;

      const maximumBytes = 10 * 1024 * 1024;

      if (estimatedBytes > maximumBytes) {
        return {
          status: 'blocked',
          error: 'MEDIA_ASSET_TOO_LARGE',
          maximumBytes,
          estimatedBytes
        };
      }

      /*
       * 既存ファイルの上書きを禁止
       */
      const existing = await getAsset(normalizedPath);

      if (existing.status === 'ok') {
        return {
          status: 'blocked',
          error: 'MEDIA_ASSET_ALREADY_EXISTS',
          reason:
            'Use a new asset name such as 20260922_185456027_iOS_v2',
          relativePath: normalizedPath,
          existingSha: existing.sha
        };
      }

      if (
        existing.status !== 'not_found' &&
        existing.error !== 'MEDIA_ASSET_NOT_FOUND'
      ) {
        return {
          status: 'blocked',
          error: 'MEDIA_EXISTENCE_CHECK_FAILED',
          reason:
            existing.reason ||
            existing.error ||
            'Unknown error',
          relativePath: normalizedPath
        };
      }

      // Contents API expects binary bytes encoded once, not a UTF-8 Base64 string.
      const filePath = this._sourcePath(normalizedPath);
      const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
      const updateResult = await this._githubRequest(
        `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}/contents/${encodedPath}`,
        { method: 'PUT', body: JSON.stringify({ message: message.trim(), content: cleanBase64, branch: this.canonicalBranch }) }
      );

      return {
        status: 'ok',
        operation: 'import',
        relativePath: normalizedPath,
        contentType,
        branch: expectedBranch.trim(),
        estimatedBytes,
        result: updateResult,
        verified: Boolean(updateResult)
      };
    }

    return {
      status: 'blocked',
      error: 'UNREACHABLE_OPERATION'
    };
  }
}

module.exports = { PowerAppsGitStore, OAuthTokenCache };
