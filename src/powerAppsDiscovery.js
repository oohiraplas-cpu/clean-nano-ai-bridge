'use strict';

// discover_powerapps_structure: appId + environmentId のみで、対象アプリの
// 画面一覧・遷移マップ・未参照画面・コントロール一覧を読み取り専用で生成する。
// 単一アプリ前提（POWERAPPS_APP_ID固定比較）を使わない。
// ソース root は config/application-rules.json に登録された対象のみ解決し、推測しない。
// 書き込み（PUT/POST/PATCH/DELETE）は一切行わない。

const YAML = require('js-yaml');
const applicationRules = require('../config/application-rules.json');
const { parseAndAnalyzePowerAppsSource } = require('./bridgeEnhancedFeatures');

const APP_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const MAX_SOURCE_FILES = 100;
const MAX_CONTROLS_PER_SCREEN = 500;

function validateDiscoveryParams(params = {}) {
  const errors = [];
  if (typeof params.appId !== 'string' || !APP_ID_PATTERN.test(params.appId)) {
    errors.push('appId: 有効なApp ID（GUID）が必要です');
  }
  if (typeof params.environmentId !== 'string' || !ENVIRONMENT_ID_PATTERN.test(params.environmentId)) {
    errors.push('environmentId: 有効なEnvironment IDが必要です');
  }
  return errors;
}

// 登録済みルールからのみ解決する（名称の部分一致や推測は行わない）
function resolveSourceRoot(displayName) {
  if (typeof displayName !== 'string' || !displayName) return null;
  for (const [key, rule] of Object.entries(applicationRules.apps || {})) {
    const names = [key, ...(rule.aliases || [])];
    if (names.includes(displayName) && typeof rule.gitRoot === 'string' && rule.gitRoot) {
      return { gitRoot: rule.gitRoot.replace(/^\/+|\/+$/g, ''), ruleKey: key };
    }
  }
  return null;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function decodeContent(data) {
  if (!data || typeof data.content !== 'string') return null;
  return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
}

function errorMessage(error) {
  return String(error?.message || error).slice(0, 200);
}

/**
 * App ID + Environment ID から対象を動的に解決する（名称・固定値を使わない）。
 * 読み取り専用。未登録のソースrootは推測せず unconfirmed とする。
 */
async function resolveAppTargetById({ appId, environmentId, getAppInfo, canonicalBranch }) {
  const errors = validateDiscoveryParams({ appId, environmentId });
  if (errors.length) {
    return { status: 'error', verified: false, data: null, warnings: [], unconfirmed: [], errors, summary: '入力が不正です', approvalRequired: false, rollbackPoint: null, auditReference: null };
  }
  let app;
  try {
    app = await getAppInfo({ appId, environmentId });
  } catch (error) {
    return { status: 'error', verified: false, data: null, warnings: [], unconfirmed: [`app info: ${errorMessage(error)}`], errors: ['App情報を取得できませんでした'], summary: '対象アプリを解決できませんでした', approvalRequired: false, rollbackPoint: null, auditReference: null };
  }
  const resolved = resolveSourceRoot(app.displayName);
  const unconfirmed = [];
  if (!resolved) unconfirmed.push(`ソース root: ${app.displayName} は application-rules に未登録のため解決できません（推測しません）`);
  return {
    status: resolved ? 'ok' : 'partial',
    verified: Boolean(resolved),
    data: {
      appId,
      environmentId,
      displayName: app.displayName,
      gitRoot: resolved ? resolved.gitRoot : null,
      ruleKey: resolved ? resolved.ruleKey : null,
      canonicalBranch: canonicalBranch || null
    },
    warnings: [],
    unconfirmed,
    errors: [],
    summary: resolved ? `${app.displayName} を解決（正本root: ${resolved.gitRoot}）` : `${app.displayName} は確認できたが、ソースrootが未登録です`,
    approvalRequired: false,
    rollbackPoint: null,
    auditReference: null
  };
}

/**
 * App.pa.yaml（Manifest）から、起動時の遷移（App.OnStart / StartScreen）を読み取る。
 * 解析できない場合は例外を投げ、呼び出し側で未確認として扱う。
 */
function parseManifest(text) {
  const parsed = YAML.load(text);
  if (!parsed || typeof parsed !== 'object' || !parsed.App || typeof parsed.App !== 'object') {
    throw new Error('App（Manifest）が見つかりません');
  }
  const props = parsed.App.Properties || {};
  const navigations = [];
  for (const property of ['OnStart', 'StartScreen']) {
    const value = props[property];
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(/Navigate\(\s*(\w+)\s*[,)]/g)) {
      navigations.push({ from: 'App', to: match[1], property });
    }
  }
  let startScreen = null;
  if (typeof props.StartScreen === 'string') {
    const m = props.StartScreen.match(/^=?\s*(\w+)\s*$/);
    if (m) startScreen = m[1];
  }
  return { startScreen, navigations, hasOnStart: typeof props.OnStart === 'string' };
}

/**
 * @param {Object} options
 * @param {string} options.appId
 * @param {string} options.environmentId
 * @param {(q:{appId:string, environmentId:string}) => Promise<{displayName:string}>} options.getAppInfo
 * @param {(path:string) => Promise<any>} options.githubRequest  GET専用
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.branch  正本branch（読み取り対象）
 */
async function discoverPowerAppsStructure(options = {}) {
  const { appId, environmentId, getAppInfo, githubRequest, owner, repo, branch } = options;
  const unconfirmed = [];
  const errors = validateDiscoveryParams({ appId, environmentId });
  if (errors.length) {
    return {
      status: 'error', verified: false, data: { structure: null }, warnings: [],
      unconfirmed: [], errors, summary: '入力が不正です',
      approvalRequired: false, rollbackPoint: null, auditReference: null
    };
  }

  // 1. 対象アプリ情報（環境指定の管理API・読み取り）
  let app;
  try {
    app = await getAppInfo({ appId, environmentId });
  } catch (error) {
    return {
      status: 'error', verified: false, data: { structure: null }, warnings: [],
      unconfirmed: [`app info: ${errorMessage(error)}`], errors: ['App情報を取得できませんでした'],
      summary: '対象アプリを解決できませんでした', approvalRequired: false, rollbackPoint: null, auditReference: null
    };
  }
  const displayName = app.displayName;

  // 2. Source Resolver（登録済みルールのみ）
  const resolved = resolveSourceRoot(displayName);
  if (!resolved) {
    return {
      status: 'partial', verified: false,
      data: { structure: { appId, environmentId, displayName, sourceRoot: null, screens: { count: 0, list: [] }, navigationMap: { edges: [] }, missingTargets: [], unreferencedScreens: [] } },
      warnings: [], unconfirmed: [`ソース root: ${displayName} は application-rules に未登録のため解決できません（推測しません）`],
      errors: [], summary: '対象アプリは確認できたが、ソース root が未登録です',
      approvalRequired: false, rollbackPoint: null, auditReference: null
    };
  }

  // 3. Screen Inventory（ファイル一覧・読み取り）
  let listing;
  try {
    listing = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(resolved.gitRoot)}?ref=${encodeURIComponent(branch)}`);
  } catch (error) {
    return {
      status: 'partial', verified: false,
      data: { structure: { appId, environmentId, displayName, sourceRoot: resolved.gitRoot } },
      warnings: [], unconfirmed: [`ソース一覧: ${errorMessage(error)}`], errors: [],
      summary: 'ソース一覧を取得できませんでした', approvalRequired: false, rollbackPoint: null, auditReference: null
    };
  }
  const items = Array.isArray(listing) ? listing : [];
  // App.pa.yaml は Manifest（Screensを持たない）のため画面解析の対象から除外し、存在のみ確認する
  const sourceFiles = items.filter(item => item.type === 'file' && item.name.endsWith('.pa.yaml') && item.name !== 'App.pa.yaml').map(item => item.name).sort();
  const hasManifest = items.some(item => item.type === 'file' && item.name === 'App.pa.yaml');
  const truncated = sourceFiles.length > MAX_SOURCE_FILES;
  const targetFiles = sourceFiles.slice(0, MAX_SOURCE_FILES);
  if (truncated) unconfirmed.push(`ソースファイルが${MAX_SOURCE_FILES}件を超えるため先頭${MAX_SOURCE_FILES}件のみ解析`);
  if (!hasManifest) unconfirmed.push('App.pa.yaml（Manifest）が対象rootに存在せず、Manifest情報は未確認');

  // 4. Manifest Discovery（App.pa.yaml の起動遷移・読み取りのみ）
  const screens = [];
  const edges = [];
  let manifest = null;
  if (hasManifest) {
    try {
      const data = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(`${resolved.gitRoot}/App.pa.yaml`)}?ref=${encodeURIComponent(branch)}`);
      const text = decodeContent(data);
      if (text === null) throw new Error('内容を取得できませんでした');
      manifest = parseManifest(text);
      for (const nav of manifest.navigations) edges.push(nav);
    } catch (error) {
      unconfirmed.push(`App.pa.yaml: 解析失敗（${errorMessage(error)}）`);
    }
  }

  // 5. Screen・Control・Navigation の解析（読み取りのみ）
  const controlsByScreen = {};
  let parsedFiles = 0;
  for (const name of targetFiles) {
    let text;
    try {
      const data = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(`${resolved.gitRoot}/${name}`)}?ref=${encodeURIComponent(branch)}`);
      text = decodeContent(data);
      if (text === null) throw new Error('内容を取得できませんでした');
    } catch (error) {
      unconfirmed.push(`${name}: 取得失敗（${errorMessage(error)}）`);
      continue;
    }
    let analysis;
    try {
      analysis = parseAndAnalyzePowerAppsSource(text, 'github_canonical');
    } catch (error) {
      unconfirmed.push(`${name}: 解析失敗（${errorMessage(error)}）`);
      continue;
    }
    parsedFiles += 1;
    for (const screen of analysis.screens) {
      screens.push({ name: screen.name, sourceFile: name, controlCount: screen.controls.length, formulaCount: screen.formulas.length });
      controlsByScreen[screen.name] = screen.controls.slice(0, MAX_CONTROLS_PER_SCREEN);
    }
    for (const nav of analysis.navigations) {
      edges.push({ from: nav.from, to: nav.target, property: nav.property, ...(nav.controlName ? { controlName: nav.controlName } : {}) });
    }
  }

  // 5. Navigation Map・未参照画面・欠落遷移先
  const definedNames = new Set(screens.map(s => s.name));
  const referencedNames = new Set(edges.map(e => e.to));
  const missingTargetMap = new Map();
  for (const edge of edges) {
    if (!definedNames.has(edge.to)) {
      if (!missingTargetMap.has(edge.to)) missingTargetMap.set(edge.to, new Set());
      missingTargetMap.get(edge.to).add(edge.from);
    }
  }
  const missingTargets = [...missingTargetMap.entries()].map(([name, froms]) => ({ name, referencedFrom: [...froms].sort() }));
  const unreferencedScreens = screens.filter(s => !referencedNames.has(s.name)).map(s => s.name);

  const verified = parsedFiles === targetFiles.length && targetFiles.length > 0 && !truncated;
  return {
    status: verified ? 'ok' : 'partial',
    verified,
    data: {
      structure: {
        appId,
        environmentId,
        displayName,
        sourceRoot: resolved.gitRoot,
        sourceRuleKey: resolved.ruleKey,
        branch,
        hasManifest,
        manifest,
        screens: { count: screens.length, list: screens },
        controls: { byScreen: controlsByScreen },
        navigationMap: { edgeCount: edges.length, edges },
        missingTargets,
        unreferencedScreens,
        parsedFiles,
        sourceFileCount: sourceFiles.length
      }
    },
    warnings: [],
    unconfirmed,
    errors: [],
    summary: `画面${screens.length}件・遷移${edges.length}件・欠落遷移先${missingTargets.length}件（読み取りのみ）`,
    approvalRequired: false,
    rollbackPoint: null,
    auditReference: null
  };
}

module.exports = { discoverPowerAppsStructure, resolveAppTargetById, resolveSourceRoot, validateDiscoveryParams, parseManifest };
