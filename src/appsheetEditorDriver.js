'use strict';
// Safe browser automation for what the AppSheet official API cannot do (editing the app definition) and for mobile display tests.
// Playwright is loaded lazily (not a Bridge dependency): run this where a browser exists (e.g. the Windows worker host).
//
// Guardrails
//  - Logged-in session comes from a storageState file (path from env). Never printed; no credentials are typed by automation.
//    A login/consent screen => AUTH_REQUIRED (the one human step), never an attempt to sign in.
//  - Top-level navigation is restricted to allowedHosts; anything else aborts.
//  - Editor operations run ONLY through `recipes` (functions recorded against the real Editor). No recipe => EDITOR_RECIPE_MISSING
//    (fail-closed). This module ships no guessed selectors; recipes must be verified on the real Editor before use.
//  - Screenshots are hashed (sha256); only the hash is returned.
const crypto = require('node:crypto');

const DEFAULT_HOSTS = ['www.appsheet.com', 'appsheet.com'];
const AUTH_HOSTS = ['accounts.google.com'];

class EditorDriverError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function defaultLoadPlaywright() {
  try { return require('playwright'); } catch (_) { throw new EditorDriverError('Playwrightが利用できません（ブラウザ実行環境が必要）', 'NOT_CONFIGURED'); }
}

async function openContext({ storageStatePath, loadPlaywright = defaultLoadPlaywright, allowedHosts = DEFAULT_HOSTS, headless = true, contextOptions = {} }) {
  if (!storageStatePath) throw new EditorDriverError('AppSheetのログイン済みセッション(storageState)が未設定です', 'NOT_CONFIGURED');
  const pw = loadPlaywright();
  const browser = await pw.chromium.launch({ headless });
  const context = await browser.newContext({ storageState: storageStatePath, ...contextOptions });
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.isNavigationRequest() && req.frame() === req.frame()?.page().mainFrame()) {
      let host = '';
      try { host = new URL(req.url()).hostname; } catch (_) { return route.abort(); }
      if (![...allowedHosts, ...AUTH_HOSTS].includes(host)) return route.abort();
    }
    return route.continue();
  });
  return { browser, context, close: async () => { await context.close().catch(() => {}); await browser.close().catch(() => {}); } };
}

function assertSignedIn(page) {
  let host = '';
  try { host = new URL(page.url()).hostname; } catch (_) { /* about:blank */ }
  if (AUTH_HOSTS.includes(host)) throw new EditorDriverError('AppSheetのログイン/同意が必要です（人間が1回ログインしstorageStateを更新）', 'AUTH_REQUIRED');
}

function createEditorDriver(options = {}) {
  const { recipes = {}, editorUrl = (appId) => `https://www.appsheet.com/Template/AppDef?appName=${encodeURIComponent(appId)}` } = options;
  async function withPage(appId, fn) {
    const session = await openContext(options);
    try {
      const page = await session.context.newPage();
      await page.goto(editorUrl(appId), { waitUntil: 'domcontentloaded' });
      assertSignedIn(page);
      return await fn(page);
    } finally { await session.close(); }
  }
  const run = (name) => async (appId, arg) => {
    const recipe = recipes[name];
    if (typeof recipe !== 'function') throw new EditorDriverError(`Editor手順(${name})が未登録です。実Editorで検証済みのrecipeが必要です`, 'EDITOR_RECIPE_MISSING');
    return withPage(appId, (page) => recipe({ page, appId, arg }));
  };
  const applyRecipe = run('apply');
  return {
    channel: 'editor_browser',
    readDefinition: run('readDefinition'),
    apply: (appId, op, step) => { const r = recipes[op] ? run(op)(appId, step) : applyRecipe(appId, { op, ...step }); return r; },
    save: run('save'),
    deploy: (appId, opts) => run('deploy')(appId, opts),
    readSharing: run('readSharing'),
    restore: (appId, definition) => run('restore')(appId, definition)
  };
}

/** Mobile (portrait) display runner for the deployed/prototype app. Used by the independent verifier. */
function createMobileRunner(options = {}) {
  const { appUrl = (appId) => `https://www.appsheet.com/start/${encodeURIComponent(appId)}`, minTap = 32, timeoutMs = 20000 } = options;
  return {
    async run(appId, { viewport = { width: 390, height: 844 }, screens = [] } = {}) {
      const session = await openContext({ ...options, contextOptions: { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } });
      const results = [];
      try {
        const page = await session.context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
        await page.goto(appUrl(appId), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        assertSignedIn(page);
        for (const screen of screens) {
          errors.length = 0;
          if (screen.navigateText) await page.getByText(screen.navigateText, { exact: false }).first().click({ timeout: timeoutMs });
          await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {});
          const m = await page.evaluate(({ min, vw }) => {
            const els = [...document.querySelectorAll('button, a[href], [role=button], input, select, textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            return { horizontalOverflow: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) > vw + 1, smallTargets: els.filter((e) => { const r = e.getBoundingClientRect(); return r.width < min || r.height < min; }).length, interactive: els.length };
          }, { min: minTap, vw: viewport.width });
          let expectedTextFound = true;
          for (const t of screen.expectText || []) if (!(await page.getByText(t, { exact: false }).first().isVisible().catch(() => false))) expectedTextFound = false;
          const shot = await page.screenshot({ fullPage: false });
          results.push({ screen: screen.name || screen.navigateText || 'start', rendered: m.interactive > 0 || (await page.locator('body').innerText()).trim().length > 0, horizontalOverflow: m.horizontalOverflow, tapTargetsOk: m.smallTargets === 0, smallTargets: m.smallTargets, expectedTextFound, screenshotSha256: crypto.createHash('sha256').update(shot).digest('hex'), errors: [...errors], viewport });
        }
      } finally { await session.close(); }
      return results;
    }
  };
}

module.exports = { EditorDriverError, createEditorDriver, createMobileRunner, DEFAULT_HOSTS };
