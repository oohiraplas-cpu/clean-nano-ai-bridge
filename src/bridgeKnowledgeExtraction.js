/**
 * アプリ対象解決（App ID / Environment / Branch の自動特定）
 *
 * 原則:
 * - 固定データを持たない。App ID・Environment・Branchは実環境（Dataverse / Power Platform / GitHub）から取得する。
 * - 取得できなかった項目は推測で埋めず、unconfirmed に「未確認」として返す。
 * - 人手で確認済みの事実（承認者・別名・gitRoot）だけを config/application-rules.json から読む。
 * - すべて読み取り専用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { createCommonResponse } = require('./bridgeCapabilities');

const DEFAULT_RULES_PATH = path.join(__dirname, '..', 'config', 'application-rules.json');

function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_\-・]/g, '');
}

function loadRules(rulesPath = DEFAULT_RULES_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    return { rules: parsed, warning: null };
  } catch (error) {
    return { rules: { apps: {} }, warning: `application-rules.json を読み込めません: ${error.code || error.message}` };
  }
}

function errorText(error) {
  return String(error?.upstream?.errorMessage || error?.message || error).slice(0, 300);
}

class AppTargetResolver {
  constructor({ powerAppsStore, powerAppsGitStore, rulesPath, ttlMs = 60000 } = {}) {
    this.store = powerAppsStore;
    this.git = powerAppsGitStore;
    const loaded = loadRules(rulesPath);
    this.rules = loaded.rules;
    this.rulesWarning = loaded.warning;
    this.ttlMs = ttlMs;
    this._cache = new Map();
  }

  async _cached(key, loader) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await loader();
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Dataverseのcanvasappsから実在アプリを取得。失敗時は構成済みアプリ1件のみにフォールバック。 */
  async listApps() {
    return this._cached('apps', async () => {
      const environmentId = this.store.environmentId || null;
      try {
        const data = await this.store.dataverseRequest(
          'canvasapps?$select=canvasappid,displayname,status,lastpublishtime,lastmodifiedtime&$orderby=displayname'
        );
        const apps = (data?.value || []).map((a) => ({
          appId: a.canvasappid,
          displayName: a.displayname,
          environmentId,
          status: a.status ?? null,
          lastPublishTime: a.lastpublishtime || null,
          lastModifiedTime: a.lastmodifiedtime || null
        }));
        return { apps, source: 'dataverse', verified: true, warnings: [] };
      } catch (listError) {
        const warnings = [`アプリ一覧(Dataverse)を取得できません: ${errorText(listError)}`];
        try {
          const info = await this.store.getAppInfo();
          return {
            apps: [{ appId: info.appId, displayName: info.displayName, environmentId: info.environmentId || environmentId, status: null, lastPublishTime: null, lastModifiedTime: null }],
            source: 'configured_app_only',
            verified: true,
            warnings: [...warnings, '構成済みアプリ1件のみ取得（一覧は未確認）']
          };
        } catch (infoError) {
          return { apps: [], source: 'unavailable', verified: false, warnings: [...warnings, `構成済みアプリも取得できません: ${errorText(infoError)}`] };
        }
      }
    });
  }

  /** Power Platform管理APIからEnvironment一覧。権限不足なら構成値のみ（未検証）。 */
  async listEnvironments() {
    return this._cached('environments', async () => {
      try {
        const environments = await this.store.listEnvironments();
        return { environments, configuredEnvironmentId: this.store.environmentId || null, source: 'power_platform_api', verified: true, warnings: [] };
      } catch (error) {
        const id = this.store.environmentId || null;
        return {
          environments: id ? [{ environmentId: id, displayName: null, type: null }] : [],
          configuredEnvironmentId: id,
          source: id ? 'config' : 'unavailable',
          verified: false,
          warnings: [`Environment一覧を取得できません（構成値のみ・名称/種別は未確認）: ${errorText(error)}`]
        };
      }
    });
  }

  /** GitHub APIから実在Branch一覧。正本Branchは構成値。 */
  async listBranches() {
    return this._cached('branches', async () => {
      const owner = this.git.githubOwner;
      const repo = this.git.githubRepo;
      const canonicalBranch = this.git.canonicalBranch;
      try {
        const names = [];
        for (let page = 1; page <= 5; page += 1) {
          const batch = await this.git.githubRequest(`/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
          for (const b of batch || []) names.push(b.name);
          if (!batch || batch.length < 100) break;
        }
        const warnings = names.includes(canonicalBranch) ? [] : [`正本Branch「${canonicalBranch}」がGitHub上に見つかりません`];
        return { branches: names, canonicalBranch, source: 'github_api', verified: true, warnings };
      } catch (error) {
        return { branches: [], canonicalBranch, source: 'unavailable', verified: false, warnings: [`Branch一覧を取得できません: ${errorText(error)}`] };
      }
    });
  }

  /** gitRootが指定Branch上に実在するかをGitHubで確認（true/false/null=確認不能）。 */
  async _sourceExistsOn(branch, gitRoot) {
    try {
      const encodedPath = gitRoot.split('/').map(encodeURIComponent).join('/');
      await this.git.githubRequest(`/repos/${this.git.githubOwner}/${this.git.githubRepo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`);
      return true;
    } catch (error) {
      return /\(404\)/.test(String(error.message)) ? false : null;
    }
  }

  getRules(appName) {
    const entry = this.rules.apps?.[appName] || null;
    return {
      publishApprover: this.rules.publishApprover || null,
      app: entry,
      approvalRequired: true,
      basis: 'ユーザー確認済みの設定ファイルのみ。未記載の項目は未確認'
    };
  }

  _candidateNames(app) {
    const names = [app.displayName];
    for (const [key, entry] of Object.entries(this.rules.apps || {})) {
      if (normalize(key) === normalize(app.displayName)) names.push(key, ...(entry.aliases || []));
    }
    return names.filter(Boolean);
  }

  _match(query, apps) {
    const q = normalize(query);
    if (!q) return { kind: 'empty', matches: [] };
    const exact = apps.filter((a) => this._candidateNames(a).some((n) => normalize(n) === q));
    if (exact.length === 1) return { kind: 'exact', matches: exact };
    if (exact.length > 1) return { kind: 'ambiguous', matches: exact };
    const partial = apps.filter((a) => this._candidateNames(a).some((n) => normalize(n).includes(q) || q.includes(normalize(n))));
    if (partial.length === 1) return { kind: 'partial', matches: partial };
    if (partial.length > 1) return { kind: 'ambiguous', matches: partial };
    return { kind: 'none', matches: [] };
  }

  async resolve(query) {
    const warnings = [];
    const unconfirmed = [];
    if (this.rulesWarning) warnings.push(this.rulesWarning);

    const list = await this.listApps();
    warnings.push(...list.warnings);
    const matched = this._match(query, list.apps);

    if (matched.kind === 'empty') {
      return createCommonResponse({ status: 'error', errors: ['queryが空です'], summary: 'アプリ名が指定されていません', warnings });
    }
    if (matched.kind === 'none') {
      const listComplete = list.source === 'dataverse';
      return createCommonResponse({
        status: listComplete ? 'not_found' : 'unavailable',
        data: { query, availableApps: list.apps.map((a) => a.displayName) },
        warnings,
        unconfirmed: listComplete ? [] : ['アプリ一覧を取得できていないため、アプリの有無は未確認です（存在しないとは言えません）'],
        summary: listComplete ? `「${query}」に一致するアプリはありません` : `アプリ一覧を取得できず「${query}」を特定できません（有無は未確認）`
      });
    }
    if (matched.kind === 'ambiguous') {
      return createCommonResponse({
        status: 'ambiguous',
        data: { query, candidates: matched.matches.map((a) => ({ appId: a.appId, displayName: a.displayName })) },
        warnings,
        summary: `「${query}」は複数のアプリに該当します。候補から選択が必要です`
      });
    }

    const app = matched.matches[0];
    if (matched.kind === 'partial') warnings.push(`「${query}」は部分一致で「${app.displayName}」に解決しました`);

    const ruleKey = Object.keys(this.rules.apps || {}).find((k) => normalize(k) === normalize(app.displayName));
    const ruleEntry = ruleKey ? this.rules.apps[ruleKey] : null;
    const gitRoot = ruleEntry?.gitRoot || null;
    const branch = this.git.canonicalBranch || null;

    let sourceOnCanonicalBranch = null;
    let sourceFoundOn = [];
    if (gitRoot && branch) {
      sourceOnCanonicalBranch = await this._sourceExistsOn(branch, gitRoot);
      if (sourceOnCanonicalBranch === false) {
        for (const fb of this.git.githubFallbackBranches || []) {
          if (fb === branch) continue;
          if (await this._sourceExistsOn(fb, gitRoot)) sourceFoundOn.push(fb);
        }
        warnings.push(`gitRoot「${gitRoot}」は正本Branch「${branch}」に存在しません${sourceFoundOn.length ? `（存在確認: ${sourceFoundOn.join(', ')}）` : ''}。書き込み前に正本Branchの確認が必要です`);
      } else if (sourceOnCanonicalBranch === null) {
        unconfirmed.push(`gitRoot「${gitRoot}」の正本Branch上での存在を確認できませんでした`);
      }
    }
    if (!app.appId) unconfirmed.push('App ID');
    if (!app.environmentId) unconfirmed.push('Environment ID');
    if (!branch) unconfirmed.push('正本Branch');
    if (!gitRoot) unconfirmed.push('gitRoot（このアプリのGit上の場所は設定に未記載）');

    const complete = Boolean(app.appId && app.environmentId && branch && gitRoot && sourceOnCanonicalBranch === true);
    return createCommonResponse({
      status: complete ? 'ok' : 'partial',
      verified: complete && list.verified,
      data: {
        query,
        matchType: matched.kind,
        appId: app.appId || null,
        displayName: app.displayName,
        environmentId: app.environmentId || null,
        gitBranch: branch,
        gitRoot,
        sourceOnCanonicalBranch,
        sourceFoundOnOtherBranches: sourceFoundOn,
        fieldSources: {
          appId: list.source,
          environmentId: 'config(POWERAPPS_ENVIRONMENT_ID)',
          gitBranch: 'config(POWERAPPS_GITHUB_BRANCH, 正本Branch)',
          gitRoot: ruleEntry ? 'config/application-rules.json' : null
        },
        rules: this.getRules(ruleKey || app.displayName)
      },
      approvalRequired: true,
      warnings,
      unconfirmed,
      summary: complete
        ? `「${app.displayName}」を解決: App ID・Environment・正本Branch・gitRootを確認済み`
        : `「${app.displayName}」を部分的に解決。未確認項目があります（unconfirmed参照）`
    });
  }

  /** Copilot Studio Knowledgeへ貼る/アップロードする用のMarkdown。どこにも保存しない。 */
  async exportKnowledgeSnapshot() {
    const [apps, envs, branches] = await Promise.all([this.listApps(), this.listEnvironments(), this.listBranches()]);
    const now = new Date().toISOString();
    const lines = [
      '# Bridge 取得スナップショット（自動生成）',
      `取得日時: ${now}`,
      '値は取得時点のもの。古い可能性があるため、判断前に resolve_app_target で再確認すること。',
      '',
      `## Power Apps（取得元: ${apps.source}）`,
      ...apps.apps.map((a) => `- ${a.displayName} | appId=${a.appId} | environmentId=${a.environmentId}`),
      '',
      `## Environment（取得元: ${envs.source}、検証=${envs.verified ? '済' : '未'}）`,
      ...envs.environments.map((e) => `- ${e.displayName || '(名称未確認)'} | environmentId=${e.environmentId}${e.environmentId === envs.configuredEnvironmentId ? ' | 構成済み' : ''}`),
      '',
      `## Git Branch（取得元: ${branches.source}、正本Branch=${branches.canonicalBranch}）`,
      ...branches.branches.map((b) => `- ${b}${b === branches.canonicalBranch ? ' (正本)' : ''}`),
      '',
      '## 公開承認者（ユーザー確認済み設定）',
      this.rules.publishApprover ? `- ${this.rules.publishApprover.name}（${this.rules.publishApprover.title}）` : '- 未設定',
      '',
      '## 取得できなかった項目',
      ...[...apps.warnings, ...envs.warnings, ...branches.warnings].map((w) => `- ${w}`)
    ];
    return createCommonResponse({
      status: [apps, envs, branches].every((x) => x.verified) ? 'ok' : 'partial',
      verified: [apps, envs, branches].every((x) => x.verified),
      data: { markdown: lines.join('\n'), generatedAt: now },
      warnings: [...apps.warnings, ...envs.warnings, ...branches.warnings],
      summary: 'Knowledge用スナップショットを生成しました（保存はしていません）'
    });
  }
}

module.exports = { AppTargetResolver, normalize, loadRules };
