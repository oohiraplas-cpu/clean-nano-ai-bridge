const assert = require('node:assert/strict');
const test = require('node:test');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');

function makeStore(fetchImpl, overrides = {}) {
  return new PowerAppsGitStore({
    githubToken: 'gh-token',
    githubOwner: 'owner-1',
    githubRepo: 'repo-1',
    githubBranch: 'main',
    githubRoot: 'powerapps/App/Source',
    fetchImpl,
    ...overrides
  });
}

test('getSourceFileはGitHub Contents APIから内容を取得する', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /\/repos\/owner-1\/repo-1\/contents\/powerapps\/App\/Source\/App\.pa\.yaml\?ref=main$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({ type: 'file', sha: 'abc123', content: Buffer.from('hello').toString('base64') })
    };
  };
  const store = makeStore(fetchImpl);
  const result = await store.getSourceFile('App.pa.yaml');
  assert.equal(result.status, 'ok');
  assert.equal(result.content, 'hello');
  assert.equal(result.sha, 'abc123');
});

test('GitHub APIがエラーを返した場合はステータス付きの日本語メッセージで失敗する', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, text: async () => 'Not Found' });
  const store = makeStore(fetchImpl);
  await assert.rejects(store.getSourceFile('missing.yaml'), /GitHub API エラー \(404\)/);
});

test('GitHub APIへの接続がハングした場合はタイムアウトして応答不能を回避する', async () => {
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted');
      error.name = 'TimeoutError';
      reject(error);
    });
  });
  const store = makeStore(fetchImpl, { githubRequestTimeoutMs: 50 });
  // AbortSignal.timeout()の内部タイマーはunrefされているため、
  // イベントループを維持するタイマーを張って発火を待つ。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(store.getSourceFile('App.pa.yaml'), /タイムアウトしました/);
  } finally {
    clearInterval(keepAlive);
  }
});
