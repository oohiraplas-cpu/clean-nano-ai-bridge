'use strict';
// Read-only GitHub tools for the configured canonical repository.
// The owner and repository are fixed by configuration, never taken from caller input.
// Every call is a GET through the injected request function. Nothing here writes to GitHub.

const BRANCH_PATTERN = /^[A-Za-z0-9._\-\/]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_PER_PAGE = 50;

function requestError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function clampPerPage(value, fallback = 20) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PER_PAGE) {
    throw requestError('invalid_per_page');
  }
  return value;
}

function checkBranch(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !BRANCH_PATTERN.test(value) || value.includes('..')) {
    throw requestError('invalid_branch');
  }
  return value;
}

/** Repository-relative path. No absolute paths, no parent segments, no empty segments. */
function checkPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw requestError('invalid_path');
  }
  if (value.startsWith('/') || value.includes('\\')) throw requestError('invalid_path');
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) throw requestError('invalid_path');
  return value;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function firstLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n', 1)[0];
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/**
 * @param {object} options
 * @param {(path: string) => Promise<any>} options.request  GET-only request to api.github.com
 * @param {string} options.owner
 * @param {string} options.repo
 * @param {string} options.canonicalBranch
 */
function createGithubReadTools({ request, owner, repo, canonicalBranch }) {
  if (typeof request !== 'function') throw requestError('github_request_unavailable');
  if (!owner || !repo) throw requestError('github_not_configured');
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function listCommits({ branch, perPage } = {}) {
    const ref = checkBranch(branch) || canonicalBranch;
    const n = clampPerPage(perPage);
    const data = await request(`${base}/commits?sha=${encodeURIComponent(ref)}&per_page=${n}`);
    const commits = (Array.isArray(data) ? data : []).map((c) => ({
      sha: typeof c.sha === 'string' ? c.sha : null,
      message: firstLine(c.commit?.message),
      authorName: c.commit?.author?.name ?? null,
      authoredAt: c.commit?.author?.date ?? null,
    }));
    return { branch: ref, commits };
  }

  async function getFile({ path, ref } = {}) {
    const filePath = checkPath(path);
    const refName = checkBranch(ref) || canonicalBranch;
    const data = await request(`${base}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(refName)}`);
    if (Array.isArray(data) || data?.type !== 'file') throw requestError('not_a_file');
    if (typeof data.size === 'number' && data.size > MAX_FILE_BYTES) throw requestError('file_too_large');
    if (data.encoding !== 'base64' || typeof data.content !== 'string') throw requestError('unsupported_encoding');
    const buffer = Buffer.from(data.content, 'base64');
    if (buffer.length > MAX_FILE_BYTES) throw requestError('file_too_large');
    return {
      path: filePath,
      ref: refName,
      blobSha: typeof data.sha === 'string' ? data.sha : null,
      size: buffer.length,
      content: buffer.toString('utf8'),
    };
  }

  async function listPullRequests({ state, perPage } = {}) {
    const allowed = ['open', 'closed', 'all'];
    const s = state === undefined ? 'open' : state;
    if (!allowed.includes(s)) throw requestError('invalid_state');
    const n = clampPerPage(perPage);
    const data = await request(`${base}/pulls?state=${s}&per_page=${n}`);
    const pulls = (Array.isArray(data) ? data : []).map((p) => ({
      number: typeof p.number === 'number' ? p.number : null,
      title: typeof p.title === 'string' ? p.title.slice(0, 200) : null,
      state: p.state ?? null,
      merged: p.merged_at != null,
      headRef: p.head?.ref ?? null,
      headSha: p.head?.sha ?? null,
      baseRef: p.base?.ref ?? null,
      htmlUrl: typeof p.html_url === 'string' ? p.html_url : null,
    }));
    return { state: s, pulls };
  }

  async function listWorkflowRuns({ branch, perPage } = {}) {
    const n = clampPerPage(perPage);
    const query = branch === undefined ? '' : `&branch=${encodeURIComponent(checkBranch(branch))}`;
    const data = await request(`${base}/actions/runs?per_page=${n}${query}`);
    const runs = (Array.isArray(data?.workflow_runs) ? data.workflow_runs : []).map((r) => ({
      id: typeof r.id === 'number' ? r.id : null,
      name: r.name ?? null,
      event: r.event ?? null,
      headBranch: r.head_branch ?? null,
      headSha: r.head_sha ?? null,
      status: r.status ?? null,
      conclusion: r.conclusion ?? null,
      createdAt: r.created_at ?? null,
    }));
    return { totalCount: typeof data?.total_count === 'number' ? data.total_count : runs.length, runs };
  }

  return Object.freeze({ listCommits, getFile, listPullRequests, listWorkflowRuns });
}

module.exports = { createGithubReadTools, SHA_PATTERN };
