'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGithubReadTools } = require('../src/githubReadTools');

function fakeRequest(responses) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected path ${path}`);
    const value = responses[key];
    return typeof value === 'function' ? value(path) : value;
  };
  return { request, calls };
}

function tools(request) {
  return createGithubReadTools({
    request,
    owner: 'oohiraplas-cpu',
    repo: 'clean-nano-ai-bridge',
    canonicalBranch: 'main'
  });
}

test('listCommits uses the canonical branch by default and maps only safe fields', async () => {
  const { request, calls } = fakeRequest({
    '/repos/oohiraplas-cpu/clean-nano-ai-bridge/commits': [
      { sha: 'a'.repeat(40), commit: { message: 'first line\n\nbody', author: { name: 'n', date: '2026-10-29T00:00:00Z' } }, author: { login: 'x' }, extra: 'drop' }
    ]
  });
  const result = await tools(request).listCommits({});
  assert.equal(result.branch, 'main');
  assert.equal(result.commits[0].message, 'first line');
  assert.equal(Object.prototype.hasOwnProperty.call(result.commits[0], 'extra'), false);
  assert.match(calls[0], /sha=main&per_page=20$/);
});

test('owner and repo are fixed by configuration, never taken from input', async () => {
  const { request, calls } = fakeRequest({ '/repos/': [] });
  await tools(request).listPullRequests({ owner: 'evil', repo: 'other', state: 'all' });
  assert.match(calls[0], /^\/repos\/oohiraplas-cpu\/clean-nano-ai-bridge\/pulls\?state=all/);
});

test('rejects invalid branch, page size and state', async () => {
  const { request } = fakeRequest({ '/repos/': [] });
  const t = tools(request);
  await assert.rejects(t.listCommits({ branch: '../etc' }), { code: 'invalid_branch' });
  await assert.rejects(t.listCommits({ perPage: 500 }), { code: 'invalid_per_page' });
  await assert.rejects(t.listPullRequests({ state: 'merged' }), { code: 'invalid_state' });
});

test('getFile rejects traversal and absolute paths before any request', async () => {
  const { request, calls } = fakeRequest({ '/repos/': {} });
  const t = tools(request);
  for (const path of ['../secret', '/abs', 'a//b', 'a/../b', 'a\\b', '']) {
    await assert.rejects(t.getFile({ path }), { code: 'invalid_path' });
  }
  assert.equal(calls.length, 0);
});

test('getFile decodes base64 text and refuses directories and oversized files', async () => {
  const text = 'hello';
  const ok = fakeRequest({
    '/repos/': { type: 'file', size: 5, encoding: 'base64', sha: 'b1', content: Buffer.from(text).toString('base64') }
  });
  const file = await tools(ok.request).getFile({ path: 'powerapps/a.txt' });
  assert.equal(file.content, 'hello');
  assert.equal(file.ref, 'main');

  const dir = fakeRequest({ '/repos/': [{ name: 'x' }] });
  await assert.rejects(tools(dir.request).getFile({ path: 'powerapps' }), { code: 'not_a_file' });

  const big = fakeRequest({ '/repos/': { type: 'file', size: 10 * 1024 * 1024, encoding: 'base64', content: '' } });
  await assert.rejects(tools(big.request).getFile({ path: 'big.bin' }), { code: 'file_too_large' });
});

test('listWorkflowRuns maps run status without exposing log or token fields', async () => {
  const { request } = fakeRequest({
    '/repos/': { total_count: 1, workflow_runs: [{ id: 9, name: 'CI', event: 'push', head_branch: 'main', head_sha: 'c'.repeat(40), status: 'completed', conclusion: 'success', created_at: '2026-10-29T00:00:00Z', logs_url: 'https://x', jobs_url: 'https://y' }] }
  });
  const result = await tools(request).listWorkflowRuns({ branch: 'main' });
  assert.equal(result.totalCount, 1);
  assert.deepEqual(Object.keys(result.runs[0]).sort(), ['conclusion', 'createdAt', 'event', 'headBranch', 'headSha', 'id', 'name', 'status']);
});

test('the module exposes only read functions', () => {
  const t = tools(async () => ({}));
  assert.deepEqual(Object.keys(t).sort(), ['getFile', 'listCommits', 'listPullRequests', 'listWorkflowRuns']);
});
