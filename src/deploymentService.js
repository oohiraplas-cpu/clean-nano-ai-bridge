/**
 * デプロイ連携Service（deploy_to_test / verify_deployment / get_deployment_logs / rollback_deployment）。
 *
 * - デプロイ実行基盤: GitHub Actionsのworkflow_dispatch（構成済みのテスト用workflowのみ）。
 *   workflow側は入力 `environment` と `git_ref` を受け取り、指定commitを指定環境へだけ配備する契約。
 * - 本番へのデプロイ（deploy_to_test）は常に拒否する。本番はrollback_deployment（approvedByHuman:true必須）のみ。
 * - 未構成の項目がある場合はダミー成功にせず、status:'not_configured'・reason・missingConfigurationを返す。
 * - 実行履歴は data/deployments.jsonl（JSONL）に記録し、「確認済みの復旧元」の判定に使う。
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { bridgeError, notConfiguredError, upstreamResponseError } = require('./errors');
const { maskSecrets, maskDeep } = require('./secretMasking');

const PRODUCTION_LIKE = /prod/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEPLOYMENT_ACTIONS = new Set(['deploy', 'rollback']);

class DeploymentService {
  constructor(config = {}, options = {}) {
    this.githubToken = config.githubToken || '';
    this.githubOwner = config.githubOwner || '';
    this.githubRepo = config.githubRepo || '';
    this.allowedBranches = Array.isArray(config.allowedBranches) ? config.allowedBranches : [];
    this.testWorkflow = config.testWorkflow || '';
    this.testEnvironmentName = config.testEnvironmentName || '';
    this.testBaseUrl = (config.testBaseUrl || '').replace(/\/+$/, '');
    this.productionWorkflow = config.productionWorkflow || '';
    this.productionEnvironmentName = config.productionEnvironmentName || '';
    this.productionBaseUrl = (config.productionBaseUrl || '').replace(/\/+$/, '');
    this.historyPath = config.historyPath || path.resolve('data/deployments.jsonl');
    this.healthAttempts = Math.max(1, Number.isInteger(config.healthAttempts) ? config.healthAttempts : 3);
    this.healthRetryDelayMs = Number.isInteger(config.healthRetryDelayMs) ? config.healthRetryDelayMs : 5000;
    this._fetch = config.fetchImpl || fetch;
    this._sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this._now = options.now || (() => new Date());
  }

  _mask(text) {
    return maskSecrets(text, [this.githubToken]);
  }

  _maskDeep(value) {
    return maskDeep(value, [this.githubToken]);
  }

  // ---- 環境の解決（本番拒否・環境不明拒否） ----

  _resolveEnvironment(requested, { allowProduction }) {
    const productionName = this.productionEnvironmentName;
    if (requested === undefined) {
      return { kind: 'test', name: this.testEnvironmentName, workflow: this.testWorkflow, baseUrl: this.testBaseUrl };
    }
    const isProduction = (productionName && requested === productionName) || PRODUCTION_LIKE.test(requested);
    if (isProduction) {
      if (!allowProduction) {
        throw bridgeError('本番環境は対象外です。deploy_to_testは構成済みの非本番テスト環境にのみ実行できます', 403, {
          status: 'refused', reason: 'production_environment_not_allowed', environment: requested
        });
      }
      if (!productionName || requested !== productionName) {
        throw bridgeError(`環境が不明です: ${requested}`, 403, { status: 'refused', reason: 'unknown_environment', environment: requested });
      }
      return { kind: 'production', name: productionName, workflow: this.productionWorkflow, baseUrl: this.productionBaseUrl };
    }
    if (!this.testEnvironmentName) {
      throw notConfiguredError('テスト環境が構成されていません', ['DEPLOY_TEST_ENVIRONMENT_NAME']);
    }
    if (requested !== this.testEnvironmentName) {
      throw bridgeError(`環境が不明です: ${requested}（構成済みのテスト環境のみ指定できます）`, 403, {
        status: 'refused', reason: 'unknown_environment', environment: requested
      });
    }
    return { kind: 'test', name: this.testEnvironmentName, workflow: this.testWorkflow, baseUrl: this.testBaseUrl };
  }

  // テスト環境設定が本番と同一・本番相当の場合は、設定誤りとして拒否する。
  _assertTestEnvironmentSafe() {
    const looksLikeProduction = PRODUCTION_LIKE.test(this.testEnvironmentName)
      || (this.productionEnvironmentName && this.testEnvironmentName === this.productionEnvironmentName)
      || (this.productionBaseUrl && this.testBaseUrl === this.productionBaseUrl)
      || (this.productionWorkflow && this.testWorkflow === this.productionWorkflow);
    if (looksLikeProduction) {
      throw bridgeError('テスト環境の設定が本番と同一または本番相当です。設定を確認してください', 403, {
        status: 'refused', reason: 'test_environment_looks_like_production'
      });
    }
  }

  _missing(env, { needBaseUrl = false, needWorkflow = true } = {}) {
    const prefix = env.kind === 'production' ? 'DEPLOY_PRODUCTION' : 'DEPLOY_TEST';
    const missing = [];
    if (!this.githubToken) missing.push('DEPLOY_GITHUB_TOKEN');
    if (!this.githubOwner) missing.push('DEPLOY_GITHUB_OWNER');
    if (!this.githubRepo) missing.push('DEPLOY_GITHUB_REPO');
    if (needWorkflow && !env.workflow) missing.push(`${prefix}_WORKFLOW`);
    if (!env.name) missing.push(`${prefix}_ENVIRONMENT_NAME`);
    if (needBaseUrl && !env.baseUrl) missing.push(`${prefix}_BASE_URL`);
    return missing;
  }

  _assertConfigured(env, options) {
    const missing = this._missing(env, options);
    if (missing.length) throw notConfiguredError('デプロイ連携の設定が不足しています', missing);
  }

  // ---- GitHub / 履歴 ----

  async _github(step, apiPath, options = {}) {
    const response = await this._fetch(`https://api.github.com${apiPath}`, {
      ...options,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.githubToken}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw await upstreamResponseError(step, response, (text) => this._mask(text));
    return response;
  }

  _repoPath() {
    return `/repos/${encodeURIComponent(this.githubOwner)}/${encodeURIComponent(this.githubRepo)}`;
  }

  async _readHistory() {
    try {
      const content = await fs.readFile(this.historyPath, 'utf8');
      return content.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  async _appendHistory(entry) {
    try {
      await fs.mkdir(path.dirname(this.historyPath), { recursive: true });
      await fs.appendFile(this.historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return null;
    } catch (error) {
      return `実行履歴を記録できませんでした: ${this._mask(String(error.message)).slice(0, 200)}`;
    }
  }

  async _resolveRef(branch, ref) {
    if (ref) return ref.toLowerCase();
    const response = await this._github('ブランチ先頭コミットの取得', `${this._repoPath()}/commits/${encodeURIComponent(branch)}`);
    const body = await response.json();
    if (!body || typeof body.sha !== 'string' || !SHA_PATTERN.test(body.sha)) {
      throw bridgeError('ブランチ先頭のコミットSHAを解決できませんでした', 502);
    }
    return body.sha.toLowerCase();
  }

  async _dispatch(workflow, branch, inputs) {
    await this._github(
      'GitHub Actions workflow_dispatch',
      `${this._repoPath()}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { method: 'POST', body: JSON.stringify({ ref: branch, inputs }) }
    );
  }

  // ---- health ----

  async _checkHealthOnce(baseUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this._fetch(`${baseUrl}/health`, { headers: { accept: 'application/json' }, signal: controller.signal });
      const text = await response.text().catch(() => '');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const safeBody = body !== null && typeof body === 'object'
        ? this._maskDeep(body)
        : { raw: this._mask(text).slice(0, 500) };
      return {
        reachable: true,
        httpStatus: response.status,
        body: safeBody,
        ok: response.status === 200 && body !== null && typeof body === 'object' && body.status === 'ok'
      };
    } catch (error) {
      return { reachable: false, httpStatus: null, body: null, ok: false, error: this._mask(String(error.message)).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
  }

  async _checkHealth(baseUrl, attempts = 1) {
    let result;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      result = await this._checkHealthOnce(baseUrl);
      if (result.ok || attempt === attempts) break;
      if (this.healthRetryDelayMs > 0) await this._sleep(this.healthRetryDelayMs);
    }
    return result;
  }

  // ---- deploy_to_test ----

  async deployToTest(params) {
    const env = this._resolveEnvironment(params.environment, { allowProduction: false });
    this._assertTestEnvironmentSafe();
    const missing = this._missing(env);
    if (!this.allowedBranches.length) missing.push('DEPLOY_ALLOWED_BRANCHES');
    if (missing.length) throw notConfiguredError('デプロイ連携の設定が不足しています', missing);

    if (!this.allowedBranches.includes(params.branch)) {
      throw bridgeError(`branch不一致のためデプロイを拒否しました: 指定=${params.branch}, 許可=${this.allowedBranches.join(', ')}`, 409, {
        status: 'branch_mismatch', allowedBranches: this.allowedBranches
      });
    }

    const ref = await this._resolveRef(params.branch, params.ref);
    await this._dispatch(env.workflow, params.branch, { environment: env.name, git_ref: ref });

    const deploymentId = crypto.randomUUID();
    const requestedAt = this._now().toISOString();
    const warning = await this._appendHistory({
      action: 'deploy', deploymentId, environment: env.name, environmentKind: 'test',
      branch: params.branch, ref, workflow: env.workflow, status: 'dispatched', requestedAt
    });
    return {
      status: 'dispatched',
      deploymentId,
      environment: env.name,
      environmentKind: 'test',
      branch: params.branch,
      ref,
      workflow: env.workflow,
      requestedAt,
      ...(warning ? { warning } : {}),
      message: 'テスト環境へのデプロイを要求しました（完了は未確認）。verify_deploymentでデプロイ結果とhealthを確認してください。'
    };
  }

  // ---- 実行履歴・Actions run ----

  async _findDeployment(deploymentId) {
    const history = await this._readHistory();
    const entry = history.find((item) => DEPLOYMENT_ACTIONS.has(item.action) && item.deploymentId === deploymentId);
    if (!entry) {
      throw bridgeError(`deploymentIdが見つかりません: ${deploymentId}`, 404, { status: 'deployment_not_found', deploymentId });
    }
    return { entry, history };
  }

  async _findRunForDeployment(env, entry) {
    const query = new URLSearchParams({ branch: entry.branch, event: 'workflow_dispatch', per_page: '20' });
    const response = await this._github(
      'GitHub Actions run一覧の取得',
      `${this._repoPath()}/actions/workflows/${encodeURIComponent(env.workflow)}/runs?${query}`
    );
    const body = await response.json();
    const requestedAt = Date.parse(entry.requestedAt) - 60000;
    const candidates = (body.workflow_runs || [])
      .filter((run) => Date.parse(run.created_at) >= requestedAt)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    return candidates[0] || null;
  }

  // ---- verify_deployment ----

  async verifyDeployment(params) {
    const env = this._resolveEnvironment(params.environment, { allowProduction: true });
    if (env.kind === 'test') this._assertTestEnvironmentSafe();
    const missing = [];
    if (!env.name) missing.push(env.kind === 'production' ? 'DEPLOY_PRODUCTION_ENVIRONMENT_NAME' : 'DEPLOY_TEST_ENVIRONMENT_NAME');
    if (!env.baseUrl) missing.push(env.kind === 'production' ? 'DEPLOY_PRODUCTION_BASE_URL' : 'DEPLOY_TEST_BASE_URL');
    if (missing.length) throw notConfiguredError('検証対象環境の設定が不足しています', missing);

    const checks = [{ name: 'environment', status: 'passed', environment: env.name, environmentKind: env.kind, baseUrl: env.baseUrl }];

    const health = await this._checkHealth(env.baseUrl, 1);
    checks.push(health.httpStatus === 200
      ? { name: 'health_http', status: 'passed', httpStatus: 200 }
      : { name: 'health_http', status: 'failed', httpStatus: health.httpStatus, reason: health.reachable ? `healthのHTTP状態が異常です (${health.httpStatus})` : `healthに接続できません: ${health.error}` });
    if (health.reachable) {
      checks.push(health.ok
        ? { name: 'health_body', status: 'passed' }
        : { name: 'health_body', status: 'failed', reason: 'healthの応答内容が異常です（status:"ok"のJSONではありません）' });
    }

    if (params.expectedVersion !== undefined) {
      const reported = health.body && typeof health.body === 'object' ? health.body.version : undefined;
      if (reported === undefined) {
        checks.push({ name: 'version', status: 'failed', expected: params.expectedVersion, reason: 'healthの応答にversionが含まれていないため、バージョンを確認できません' });
      } else {
        checks.push({ name: 'version', status: String(reported) === params.expectedVersion ? 'passed' : 'failed', expected: params.expectedVersion, actual: String(reported), ...(String(reported) === params.expectedVersion ? {} : { reason: 'バージョンが一致しません' }) });
      }
    }

    let deploymentEntry = null;
    if (params.deploymentId !== undefined) {
      ({ entry: deploymentEntry } = await this._findDeployment(params.deploymentId));
      if (deploymentEntry.environment !== env.name) {
        checks.push({ name: 'deployment_environment', status: 'failed', reason: `deploymentIdの対象環境(${deploymentEntry.environment})と指定環境(${env.name})が一致しません` });
      } else if (this._missing(env).length) {
        checks.push({ name: 'deployment_result', status: 'skipped', reason: 'GitHub Actionsの設定が不足しているため、デプロイ結果を確認できません', missingConfiguration: this._missing(env) });
      } else {
        const run = await this._findRunForDeployment(env, deploymentEntry);
        if (!run) checks.push({ name: 'deployment_result', status: 'skipped', reason: '対応するworkflow runがまだ見つかりません（未開始または未反映）' });
        else if (run.status !== 'completed') checks.push({ name: 'deployment_result', status: 'skipped', reason: `デプロイが完了していません (status=${run.status})`, runId: run.id });
        else checks.push({ name: 'deployment_result', status: run.conclusion === 'success' ? 'passed' : 'failed', runId: run.id, conclusion: run.conclusion, ...(run.conclusion === 'success' ? {} : { reason: `デプロイ結果が成功ではありません (conclusion=${run.conclusion})` }) });
      }
    }

    const failed = checks.filter((check) => check.status === 'failed');
    const skipped = checks.filter((check) => check.status === 'skipped');
    const status = failed.length ? 'failed' : (skipped.length ? 'incomplete' : 'verified');

    let warning;
    if (status === 'verified' && deploymentEntry) {
      warning = await this._appendHistory({
        action: 'verify', deploymentId: deploymentEntry.deploymentId, environment: env.name,
        status: 'verified', verifiedAt: this._now().toISOString(), healthHttpStatus: health.httpStatus
      });
    }
    return {
      status,
      verified: status === 'verified',
      environment: env.name,
      environmentKind: env.kind,
      ...(params.deploymentId ? { deploymentId: params.deploymentId } : {}),
      health: { reachable: health.reachable, httpStatus: health.httpStatus, body: health.body },
      checks,
      errors: failed.map((check) => check.reason || `${check.name}が不一致です`),
      ...(skipped.length ? { notVerified: skipped.map((check) => check.reason) } : {}),
      ...(warning ? { warning } : {})
    };
  }

  // ---- get_deployment_logs ----

  async getDeploymentLogs(params) {
    const env = this._resolveEnvironment(params.environment, { allowProduction: true });
    if (env.kind === 'test') this._assertTestEnvironmentSafe();
    this._assertConfigured(env);

    const limit = params.limit || 5;
    const history = (await this._readHistory()).filter((item) => item.environment === env.name).slice(-limit).reverse();

    let selectedRun = null;
    let runs = [];
    if (params.runId !== undefined) {
      const response = await this._github('GitHub Actions runの取得', `${this._repoPath()}/actions/runs/${params.runId}`);
      selectedRun = await response.json();
      runs = [selectedRun];
    } else if (params.deploymentId !== undefined) {
      const { entry } = await this._findDeployment(params.deploymentId);
      selectedRun = await this._findRunForDeployment(env, entry);
      runs = selectedRun ? [selectedRun] : [];
    } else {
      const response = await this._github(
        'GitHub Actions run一覧の取得',
        `${this._repoPath()}/actions/workflows/${encodeURIComponent(env.workflow)}/runs?per_page=${limit}`
      );
      runs = (await response.json()).workflow_runs || [];
      selectedRun = runs[0] || null;
    }

    let jobs = [];
    if (selectedRun) {
      const response = await this._github('GitHub Actions job一覧の取得', `${this._repoPath()}/actions/runs/${selectedRun.id}/jobs?per_page=30`);
      jobs = ((await response.json()).jobs || []).map((job) => ({
        id: job.id, name: job.name, status: job.status, conclusion: job.conclusion,
        startedAt: job.started_at, completedAt: job.completed_at,
        steps: (job.steps || []).map((step) => ({ name: step.name, status: step.status, conclusion: step.conclusion }))
      }));
      if (params.includeJobLogs === true) {
        for (const job of jobs.slice(0, 5)) {
          try {
            const logResponse = await this._github('GitHub Actions jobログの取得', `${this._repoPath()}/actions/jobs/${job.id}/logs`);
            const lines = (await logResponse.text()).split(/\r?\n/);
            job.logTail = lines.slice(-100).join('\n');
          } catch (error) {
            job.logError = this._mask(String(error.message)).slice(0, 200);
          }
        }
      }
    }

    const summarize = (run) => ({
      id: run.id, runNumber: run.run_number, status: run.status, conclusion: run.conclusion, event: run.event,
      headBranch: run.head_branch, headSha: run.head_sha, createdAt: run.created_at, htmlUrl: run.html_url
    });
    return this._maskDeep({
      status: 'ok',
      environment: env.name,
      environmentKind: env.kind,
      workflow: env.workflow,
      masked: true,
      selectedRun: selectedRun ? summarize(selectedRun) : null,
      runs: runs.map(summarize),
      jobs,
      history,
      ...(selectedRun ? {} : { message: '該当するworkflow runが見つかりません' })
    });
  }

  // ---- rollback_deployment ----

  async rollbackDeployment(params) {
    const env = this._resolveEnvironment(params.environment, { allowProduction: true });
    if (env.kind === 'production' && params.approvedByHuman !== true) {
      throw bridgeError('本番環境へのロールバックにはapprovedByHuman:trueが必要です（人間承認が必要な操作です）', 403, {
        status: 'approval_required', environment: env.name
      });
    }
    if (env.kind === 'test') this._assertTestEnvironmentSafe();
    this._assertConfigured(env, { needBaseUrl: true });

    const { entry: target, history } = await this._findDeployment(params.targetDeploymentId).catch((error) => {
      if (error.status === 404) {
        throw bridgeError(`復旧元が見つかりません: ${params.targetDeploymentId}`, 404, { status: 'rollback_source_not_found', targetDeploymentId: params.targetDeploymentId });
      }
      throw error;
    });
    if (target.environment !== env.name) {
      throw bridgeError(`復旧元の対象環境(${target.environment})と指定環境(${env.name})が一致しません`, 409, { status: 'rollback_source_environment_mismatch' });
    }
    const verified = history.some((item) => item.action === 'verify' && item.deploymentId === target.deploymentId && item.status === 'verified');
    if (!verified || !SHA_PATTERN.test(String(target.ref))) {
      throw bridgeError('確認済み（verify_deploymentでverified）の復旧元のみ指定できます', 409, {
        status: 'rollback_source_not_verified', targetDeploymentId: target.deploymentId
      });
    }

    await this._dispatch(env.workflow, target.branch, { environment: env.name, git_ref: target.ref });

    const deploymentId = crypto.randomUUID();
    const requestedAt = this._now().toISOString();
    const warning = await this._appendHistory({
      action: 'rollback', deploymentId, rollbackOf: target.deploymentId, environment: env.name,
      environmentKind: env.kind, branch: target.branch, ref: target.ref, workflow: env.workflow,
      status: 'dispatched', requestedAt, approvedByHuman: params.approvedByHuman === true
    });

    const health = await this._checkHealth(env.baseUrl, this.healthAttempts);
    return {
      status: health.ok ? 'ok' : 'health_check_failed',
      healthVerified: health.ok,
      deploymentId,
      rollbackOf: target.deploymentId,
      environment: env.name,
      environmentKind: env.kind,
      branch: target.branch,
      ref: target.ref,
      health: { reachable: health.reachable, httpStatus: health.httpStatus, body: health.body },
      ...(warning ? { warning } : {}),
      message: health.ok
        ? 'ロールバックを要求し、healthを再確認しました（デプロイ完了はverify_deploymentで確認してください）。'
        : 'ロールバックを要求しましたが、healthの再確認に失敗しました。状態を確認してください。'
    };
  }
}

module.exports = { DeploymentService };
