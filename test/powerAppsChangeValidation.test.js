const assert = require('node:assert/strict');
const test = require('node:test');
const { validateChange, verifySaveResult, diffStats, gitBlobSha } = require('../src/powerAppsChangeValidation');

const ctx = { canonicalBranch: 'main' };
const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n');

test('正常な更新はvalid:trueで、summaryに差分情報を含む', () => {
  const result = validateChange({
    branch: 'main', relativePath: 'Screen3.pa.yaml',
    currentContent: `${lines(20)}\n`, content: `${lines(20).replace('line5', 'changed5')}\n`
  }, ctx);
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.operation, 'update');
  assert.equal(result.summary.diffChecked, true);
  assert.equal(result.summary.added, 1);
  assert.equal(result.summary.removed, 1);
});

test('branch不一致はエラーにする', () => {
  const result = validateChange({ branch: 'sync/old', relativePath: 'a.pa.yaml', content: 'a: 1', currentContent: 'a: 2' }, ctx);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('branch不一致')));
});

test('relativePathの不正（..、バックスラッシュ、拡張子、連続スラッシュ）を拒否する', () => {
  for (const relativePath of ['../secret.json', 'a\\b.yaml', 'a//b.yaml', 'run.sh', 'C:/x.json', '']) {
    const result = validateChange({ branch: 'main', relativePath, content: 'a: 1', currentContent: 'a: 2' }, ctx);
    assert.equal(result.valid, false, relativePath);
  }
});

test('先頭スラッシュは警告になる', () => {
  const result = validateChange({ branch: 'main', relativePath: '/App.pa.yaml', content: 'a: 1', currentContent: 'a: 2' }, ctx);
  assert.ok(result.warnings.some((w) => w.includes('先頭スラッシュ')));
});

test('空の更新内容・構文エラー（YAML/JSON）・秘密値の混入を拒否する', () => {
  assert.ok(validateChange({ branch: 'main', relativePath: 'a.pa.yaml', content: '  \n', currentContent: 'a: 1' }, ctx).errors.some((e) => e.includes('空')));
  assert.ok(validateChange({ branch: 'main', relativePath: 'a.pa.yaml', content: 'a: [1, 2', currentContent: 'a: 1' }, ctx).errors.some((e) => e.includes('構文エラー')));
  assert.ok(validateChange({ branch: 'main', relativePath: 'm.json', content: '{broken', currentContent: '{}' }, ctx).errors.some((e) => e.includes('構文エラー')));
  const leaked = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', content: `token: ghp_${'d'.repeat(30)}`, currentContent: 'a: 1' }, ctx);
  assert.ok(leaked.errors.some((e) => e.includes('秘密値')));
});

test('対象ファイル不存在の更新は拒否し、create:trueなら新規作成として許可する', () => {
  const missing = validateChange({ branch: 'main', relativePath: 'New.pa.yaml', content: 'a: 1', currentExists: false }, ctx);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes('存在しません')));
  const created = validateChange({ branch: 'main', relativePath: 'New.pa.yaml', content: 'a: 1', currentExists: false, create: true }, ctx);
  assert.equal(created.valid, true);
  assert.equal(created.summary.operation, 'create');
});

test('削除: 存在するファイルは警告、重要ファイル・存在しないファイル・contentとの併用は拒否する', () => {
  const ok = validateChange({ branch: 'main', relativePath: 'Screen9.pa.yaml', delete: true, currentContent: 'a: 1' }, ctx);
  assert.equal(ok.valid, true);
  assert.equal(ok.summary.operation, 'delete');
  assert.ok(ok.warnings.some((w) => w.includes('削除')));
  assert.equal(validateChange({ branch: 'main', relativePath: 'App.pa.yaml', delete: true, currentContent: 'a: 1' }, ctx).valid, false);
  assert.equal(validateChange({ branch: 'main', relativePath: 'Gone.pa.yaml', delete: true, currentExists: false }, ctx).valid, false);
  assert.equal(validateChange({ branch: 'main', relativePath: 'A.pa.yaml', delete: true, content: 'a: 1', currentContent: 'a: 1' }, ctx).valid, false);
});

test('大規模差分: 80%以上はエラー、allowLargeDiffで許可、50%以上は警告、小さいファイルは対象外', () => {
  const current = `${lines(30, 'old')}\n`;
  const rewritten = `${lines(30, 'new')}\n`;
  const blocked = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', currentContent: current, content: rewritten }, ctx);
  assert.equal(blocked.valid, false);
  assert.ok(blocked.errors.some((e) => e.includes('大規模差分')));
  const allowed = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', currentContent: current, content: rewritten, allowLargeDiff: true }, ctx);
  assert.equal(allowed.valid, true);
  const half = `${lines(15, 'old')}\n${lines(15, 'new')}\n`;
  const warned = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', currentContent: current, content: half }, ctx);
  assert.equal(warned.valid, true);
  assert.ok(warned.warnings.some((w) => w.includes('変更率')));
  const small = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', currentContent: 'a: 1', content: 'a: 2' }, ctx);
  assert.equal(small.valid, true);
});

test('現在内容が不明な場合は差分検査を実行していないことを警告し、成功扱いの根拠にしない', () => {
  const result = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', content: 'a: 1' }, ctx);
  assert.equal(result.summary.diffChecked, false);
  assert.ok(result.warnings.some((w) => w.includes('diffChecked=false')));
});

test('差分なしは警告になる', () => {
  const result = validateChange({ branch: 'main', relativePath: 'a.pa.yaml', content: 'a: 1\n', currentContent: 'a: 1\n' }, ctx);
  assert.ok(result.warnings.some((w) => w.includes('差分がありません')));
});

test('diffStatsは行の追加・削除を数える', () => {
  assert.deepEqual(diffStats('a\nb\nc', 'a\nb\nd'), { linesBefore: 3, linesAfter: 3, added: 1, removed: 1, changeRatio: 0.333 });
});

// ---- verifySaveResult ----

function saveDeps(overrides = {}) {
  return {
    canonicalBranch: 'main',
    getSourceFile: async () => ({ status: 'ok', path: 'powerapps/app/Source/Screen3.pa.yaml', sha: gitBlobSha('new'), branch: 'main', content: 'new' }),
    getAppState: async () => ({ status: 'ok', versionNumber: '1.2' }),
    ...overrides
  };
}

test('保存結果の検証: 期待内容・SHAが一致すればverified', async () => {
  const byContent = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedContent: 'new' }, saveDeps());
  assert.equal(byContent.status, 'verified');
  assert.equal(byContent.verified, true);
  const byCheck = byContent.checks.map((c) => `${c.name}:${c.status}`);
  assert.deepEqual(byCheck, ['branch:passed', 'relative_path:passed', 'expected_content:passed', 'app_state:passed']);
  const bySha = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedSha: gitBlobSha('new') }, saveDeps());
  assert.equal(bySha.verified, true);
});

test('保存未反映（SHA・内容の不一致）はfailedで、成功扱いにしない', async () => {
  const sha = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedSha: gitBlobSha('something else') }, saveDeps());
  assert.equal(sha.status, 'failed');
  assert.ok(sha.errors.some((e) => e.includes('保存未反映')));
  const content = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedContent: 'not saved yet' }, saveDeps());
  assert.equal(content.verified, false);
  assert.ok(content.errors.some((e) => e.includes('保存未反映')));
});

test('保存結果の検証: 正本以外のbranchで見つかった場合・指定branch不一致はfailed', async () => {
  const fallback = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedContent: 'new' }, saveDeps({
    getSourceFile: async () => ({ path: 'powerapps/app/Source/Screen3.pa.yaml', sha: gitBlobSha('new'), branch: 'sync/old', content: 'new' })
  }));
  assert.equal(fallback.verified, false);
  assert.equal(fallback.checks.find((c) => c.name === 'branch').status, 'failed');
  const requested = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedContent: 'new', branch: 'sync/old' }, saveDeps());
  assert.equal(requested.verified, false);
});

test('保存結果の検証: 正本ソース不存在・アプリ状態エラー・relativePath不一致はfailed', async () => {
  const notFound = await verifySaveResult({ relativePath: 'Gone.pa.yaml', expectedContent: 'x' }, saveDeps({
    getSourceFile: async () => { throw new Error('GitHub API エラー (404): Not Found'); }
  }));
  assert.equal(notFound.verified, false);
  assert.ok(notFound.errors.some((e) => e.includes('対象不存在')));
  const appError = await verifySaveResult({ relativePath: 'Screen3.pa.yaml', expectedContent: 'new' }, saveDeps({
    getAppState: async () => { const e = new Error('Power Apps管理API呼び出しに失敗しました (HTTP 500)'); e.upstream = { httpStatus: 500 }; throw e; }
  }));
  assert.equal(appError.verified, false);
  assert.equal(appError.checks.find((c) => c.name === 'app_state').upstream.httpStatus, 500);
  const wrongPath = await verifySaveResult({ relativePath: 'Other.pa.yaml', expectedContent: 'new' }, saveDeps());
  assert.equal(wrongPath.checks.find((c) => c.name === 'relative_path').status, 'failed');
});

test('保存結果の検証: GitHub/Power Apps設定不足はnot_configured（status・reason・missingConfiguration）で拒否する', async () => {
  await assert.rejects(
    verifySaveResult({ relativePath: 'a.pa.yaml', expectedContent: 'x' }, saveDeps({
      getSourceFile: async () => { throw new Error('GitHub設定が不足しています: POWERAPPS_GITHUB_TOKEN, POWERAPPS_GITHUB_REPO'); }
    })),
    (error) => error.status === 503
      && error.payload.status === 'not_configured'
      && error.payload.missingConfiguration.includes('POWERAPPS_GITHUB_TOKEN')
      && typeof error.payload.reason === 'string'
  );
  await assert.rejects(
    verifySaveResult({ relativePath: 'a.pa.yaml', expectedContent: 'new' }, saveDeps({
      getAppState: async () => { throw new Error('environmentIdおよびappIdが未設定です'); }
    })),
    (error) => error.payload.missingConfiguration.includes('POWERAPPS_APP_ID')
  );
});
