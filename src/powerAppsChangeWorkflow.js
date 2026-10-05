/**
 * Power Apps変更ワークフロー（保存・公開・復旧・監査）。
 * 既存のPowerAppsGitStore（正本branchガード付き書き込み）・PowerAppsStore（公開・状態）・validateChangeを再利用し、
 * RequestId単位の冪等性・承認強制・JSONL監査（既存POWERAPPS_LOG_PATH）だけを追加する。
 * 外部APIには直接触れず、必要なStoreは注入される。
 */
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const { validateChange, gitBlobSha } = require('./powerAppsChangeValidation');
const { maskSecrets, containsLikelySecret } = require('./secretMasking');

const CHANGE_TYPES = Object.freeze(['STYLE', 'CONTROL', 'FORMULA', 'DATA_SOURCE', 'NAVIGATION', 'VALIDATION', 'PERMISSION', 'AUTOMATION']);
const AUDIT_KIND = 'change_audit';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HUMAN_APPROVER_DENY = /(^|[^a-z])(ai|bot|claude|copilot|cnai|gpt|chatgpt|automation|system|agent)([^a-z]|$)/i;

// STYLEで変更してよいプロパティ（外観のみ）。OnSelect/Items/Visible/DisplayMode/DataSource/Navigate等は含まない。
const STYLE_PROPERTIES = new Set([
  'Fill', 'Color', 'BorderColor', 'BorderThickness', 'BorderStyle',
  'HoverFill', 'HoverColor', 'HoverBorderColor', 'PressedFill', 'PressedColor', 'PressedBorderColor',
  'DisabledFill', 'DisabledColor', 'DisabledBorderColor', 'FocusedBorderColor', 'FocusedBorderThickness',
  'Font', 'FontWeight', 'Size', 'Italic', 'Underline', 'Strikethrough', 'Align', 'VerticalAlign', 'LineHeight',
  'RadiusTopLeft', 'RadiusTopRight', 'RadiusBottomLeft', 'RadiusBottomRight', 'Transparency'
]);
const STYLE_FORBIDDEN_CALL = /\b(Navigate|Back|Patch|SubmitForm|Remove|RemoveIf|Collect|ClearCollect|Set|UpdateContext|Launch|Notify|Reset|Refresh|Exit|Revert|\w+\.Run)\s*\(/;

function lineMultiset(text) {
  const map = new Map();
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const key = line.trim();
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

/** 行の多重集合差分。removed: 変更前にのみある行、added: 変更後にのみある行（trim済み・空行除く）。 */
function computeLineDiff(before, after) {
  const b = lineMultiset(before);
  const a = lineMultiset(after);
  const removed = [];
  const added = [];
  for (const [line, count] of b) for (let i = 0; i < count - (a.get(line) || 0); i += 1) removed.push(line);
  for (const [line, count] of a) for (let i = 0; i < count - (b.get(line) || 0); i += 1) added.push(line);
  return { added: added.sort(), removed: removed.sort() };
}

/** pa.yamlの各行が属するプロパティ名を求める（ブロックスカラーの継続行は直前のキーに属する）。 */
function lineOwners(text) {
  const owners = new Map(); // trimmed line -> Set(owner)
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  let block = null; // { indent, owner }
  const add = (line, owner) => {
    const key = line.trim();
    if (!key) return;
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key).add(owner);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (block && indent > block.indent) { add(line, block.owner); continue; }
    block = null;
    const match = line.match(/^\s*(?:-\s+)?([^:]+?):(?:\s+(.*))?$/);
    if (!match) { add(line, '?'); continue; }
    const key = match[1].trim();
    const value = (match[2] || '').trim();
    const isProperty = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !/^-\s/.test(line.trim());
    const owner = isProperty ? key : `#header:${key}`;
    add(line, owner);
    if (/^[|>][+-]?\d*$/.test(value)) block = { indent, owner };
  }
  return owners;
}

/** STYLE変更が外観プロパティのみか検証する。違反した行を返す（空なら適合）。 */
function findNonStyleChanges(relativePath, before, after, diff) {
  const violations = [];
  if (!/\.pa\.ya?ml$/i.test(relativePath)) {
    return [`STYLE変更はPower Appsの.pa.yamlのみ対象です: ${relativePath}`];
  }
  const beforeOwners = lineOwners(before);
  const afterOwners = lineOwners(after);
  const check = (line, owners, label) => {
    const set = owners.get(line);
    const owner = set ? [...set] : ['?'];
    if (!owner.every((name) => STYLE_PROPERTIES.has(name))) {
      violations.push(`${label}: ${line.slice(0, 120)}（プロパティ: ${owner.join('/')}）`);
    }
  };
  for (const line of diff.removed) check(line, beforeOwners, '削除');
  for (const line of diff.added) {
    check(line, afterOwners, '追加');
    if (STYLE_FORBIDDEN_CALL.test(line)) violations.push(`追加行に動作を伴う関数が含まれます: ${line.slice(0, 120)}`);
  }
  return violations;
}

function sameLines(planned, actual) {
  if (!Array.isArray(planned) || planned.length !== actual.length) return false;
  const normalized = planned.map((line) => String(line).trim()).sort();
  return normalized.every((line, index) => line === actual[index]);
}

function isTransient(error) {
  const text = String(error?.message || error);
  return /\((429|5\d\d)\)|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(text);
}

async function retryOnce(fn) {
  try { return await fn(); } catch (error) {
    if (!isTransient(error)) throw error;
    return fn();
  }
}

function classifyUpstream(error, fallbackStatus, fallbackCode) {
  const text = String(error?.message || error);
  if (/設定が不足|未設定/.test(text)) return { status: 'NOT_EXECUTED', errorCode: 'STATE_CHECK_FAILED', notConfigured: true };
  if (/\(404\)/.test(text)) return { status: 'BLOCKED', errorCode: 'FILE_NOT_FOUND' };
  if (/\(401\)/.test(text)) return { status: 'FAILED', errorCode: 'AUTH_FAILED' };
  if (/\(403\)/.test(text)) return { status: 'FAILED', errorCode: 'PERMISSION_DENIED' };
  if (/\((409|422)\)/.test(text)) return { status: 'CONFLICT', errorCode: 'SOURCE_CONFLICT' };
  return { status: fallbackStatus, errorCode: fallbackCode };
}

class PowerAppsChangeWorkflow {
  constructor({ gitStore, appStore, logPath, resolveTarget, environmentId = null, appId = null, secrets = [] }) {
    this.git = gitStore;
    this.app = appStore;
    this.logPath = logPath;
    this.resolveTarget = resolveTarget || null;
    this.environmentId = environmentId;
    this.appId = appId;
    this.secrets = secrets;
    this._queue = Promise.resolve();
  }

  // 編集・保存・公開・復旧は必ず直列実行する。
  _serial(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  mask(text) {
    return maskSecrets(String(text ?? ''), this.secrets).slice(0, 500);
  }

  async _readAll() {
    let content;
    try { content = await fs.readFile(this.logPath, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && entry.kind === AUDIT_KIND) entries.push(entry);
      } catch { /* 壊れた行は無視（他種別のログと同居するため） */ }
    }
    return entries;
  }

  async _events(requestId) {
    return (await this._readAll()).filter((entry) => entry.requestId === requestId);
  }

  async _record(entry) {
    const auditId = crypto.randomUUID();
    const line = JSON.stringify({
      kind: AUDIT_KIND,
      auditId,
      timestamp: new Date().toISOString(),
      environmentId: this.environmentId,
      appId: this.appId,
      ...entry
    });
    await fs.appendFile(this.logPath, `${line}\n`, 'utf8');
    return auditId;
  }

  // 失敗（BLOCKED等）の監査。直前に同一内容の記録があれば重複記録しない。
  async _recordFailure(base, event, outcome) {
    try {
      const events = await this._events(base.requestId);
      const last = events[events.length - 1];
      if (last && last.event === event && last.errorCode === outcome.errorCode && last.message === outcome.message) return last.auditId;
      return await this._record({
        requestId: base.requestId, event, tool: base.tool, relativePath: base.target, branch: base.branch,
        actor: base.actor, status: outcome.status, errorCode: outcome.errorCode, message: outcome.message,
        error: outcome.error ? this.mask(outcome.error) : undefined
      });
    } catch {
      return null;
    }
  }

  _response(base, over = {}) {
    return {
      status: 'NOT_EXECUTED',
      requestId: base.requestId ?? null,
      tool: base.tool,
      target: base.target ?? null,
      environment: this.environmentId || null,
      branch: base.branch ?? null,
      sourceHash: null,
      changed: false,
      validated: false,
      saved: false,
      published: false,
      version: null,
      errorCode: null,
      message: '',
      timestamp: new Date().toISOString(),
      auditId: null,
      rollbackAvailable: false,
      ...over
    };
  }

  async _fail(base, event, status, errorCode, message, extra = {}) {
    const outcome = { status, errorCode, message, error: extra.error };
    const auditId = await this._recordFailure(base, event, outcome);
    const { error, ...visible } = extra;
    return this._response(base, { ...visible, status, errorCode, message, auditId });
  }

  _invalid(base, message) {
    return this._response(base, { status: 'BLOCKED', errorCode: 'VALIDATION_FAILED', message });
  }

  _validateSaveParams(p) {
    if (typeof p.requestId !== 'string' || !REQUEST_ID_PATTERN.test(p.requestId)) return 'requestId（英数字と._:-、100文字以内）が必要です';
    if (!CHANGE_TYPES.includes(p.changeType)) return `changeTypeは${CHANGE_TYPES.join('/')}のいずれかである必要があります`;
    if (typeof p.target !== 'string' || !p.target.trim()) return 'target（対象ファイルのrelativePath）が必要です';
    if (typeof p.expectedBranch !== 'string' || !p.expectedBranch.trim()) return 'expectedBranchが必要です';
    if (typeof p.expectedHash !== 'string' || !SHA_PATTERN.test(p.expectedHash)) return 'expectedHash（get_powerapps_sourceのsourceHash、40桁16進）が必要です';
    if (typeof p.content !== 'string') return 'content（保存する全文）が必要です';
    const c = p.changes;
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.description !== 'string' || !c.description.trim()
      || !Array.isArray(c.added) || !Array.isArray(c.removed)
      || [...c.added, ...c.removed].some((line) => typeof line !== 'string')) {
      return 'changes（description:文字列、added/removed:予定する追加行・削除行の配列）が必要です';
    }
    if (p.appName !== undefined && (typeof p.appName !== 'string' || !p.appName.trim())) return 'appNameは空でない文字列である必要があります';
    if (p.actor !== undefined && typeof p.actor !== 'string') return 'actorは文字列である必要があります';
    return null;
  }

  async _ensureUniqueTarget(base, appName) {
    if (!appName || !this.resolveTarget) return null;
    let resolved;
    try { resolved = await retryOnce(() => this.resolveTarget(appName)); } catch (error) {
      return this._fail(base, 'blocked', 'FAILED', 'STATE_CHECK_FAILED', '対象アプリを解決できませんでした', { error: error.message });
    }
    const data = resolved?.data || {};
    if (resolved?.status === 'ambiguous') return this._fail(base, 'blocked', 'BLOCKED', 'TARGET_AMBIGUOUS', `「${appName}」は一意に解決できません`);
    if (resolved?.status === 'not_found') return this._fail(base, 'blocked', 'BLOCKED', 'TARGET_NOT_FOUND', `「${appName}」に一致するアプリがありません`);
    const confirmed = resolved?.status === 'ok'
      || (resolved?.status === 'partial' && data.appId && data.environmentId && data.gitBranch && data.sourceOnCanonicalBranch !== false);
    if (!confirmed) return this._fail(base, 'blocked', 'BLOCKED', 'STATE_CHECK_FAILED', `「${appName}」の対象を確認できていません（${resolved?.status || '不明'}）`);
    return null;
  }

  async _getSource(target) {
    return retryOnce(() => this.git.getSourceFile(target));
  }

  async _appVersion() {
    const state = await retryOnce(() => this.app.getAppState());
    if (!state || state.status !== 'ok') return { ok: false, version: null };
    return { ok: true, version: state.versionNumber ?? state.version ?? null };
  }

  // ---------------------------------------------------------------- save
  save(params) {
    return this._serial(() => this._save(params));
  }

  async _save(p) {
    const base = { requestId: typeof p?.requestId === 'string' ? p.requestId : null, tool: 'save_powerapps_source', target: p?.target ?? null, branch: p?.expectedBranch ?? null, actor: p?.actor || null };
    const paramError = this._validateSaveParams(p || {});
    if (paramError) return this._invalid(base, paramError);

    const afterHash = gitBlobSha(p.content);
    const events = await this._events(p.requestId);
    const prepared = events.find((e) => e.event === 'prepared');
    const savedEvent = events.find((e) => e.event === 'saved');
    if (prepared && prepared.fingerprint !== this._fingerprint(p)) {
      return this._fail(base, 'blocked', 'BLOCKED', 'SOURCE_CONFLICT', '同一requestIdで異なる保存内容が指定されました。新しいrequestIdを使用してください');
    }

    const unique = await this._ensureUniqueTarget(base, p.appName);
    if (unique) return unique;

    const canonical = this.git.canonicalBranch;
    if (p.expectedBranch !== canonical) {
      return this._fail(base, 'blocked', 'BLOCKED', 'BRANCH_MISMATCH', `branch不一致: 指定=${p.expectedBranch}, 正本=${canonical}`);
    }

    let source;
    try { source = await this._getSource(p.target); } catch (error) {
      const c = classifyUpstream(error, 'FAILED', 'STATE_CHECK_FAILED');
      return this._fail(base, 'blocked', c.status, c.errorCode, c.errorCode === 'FILE_NOT_FOUND'
        ? '対象ファイルが存在しません。Branch・relativePath・対象アプリを確認してください（再試行しません）'
        : 'ソースを取得できませんでした', { error: error.message });
    }
    if (source.branch !== canonical) {
      return this._fail(base, 'blocked', 'BLOCKED', 'BRANCH_MISMATCH', `ソースは正本以外のbranch(${source.branch})で見つかりました`, { branch: source.branch });
    }
    base.branch = source.branch;
    if (typeof source.content !== 'string' || source.content.length === 0) {
      return this._fail(base, 'blocked', 'BLOCKED', 'INVALID_SOURCE', '取得したソースが空または不正です');
    }

    // 冪等: 完了済みなら実状態を確認して再利用（再保存・再監査しない）。
    if (savedEvent) {
      if (source.sha === savedEvent.afterHash) {
        return this._response(base, {
          status: 'OK', sourceHash: source.sha, changed: true, validated: true, saved: true, version: savedEvent.version ?? null,
          message: '同一requestIdの保存は完了済みです（再実行せず実状態を確認しました）', auditId: savedEvent.auditId,
          rollbackAvailable: !(events.some((e) => e.event === 'rolled_back')), replayed: true
        });
      }
      return this._fail(base, 'blocked', 'CONFLICT', 'SOURCE_CONFLICT', '保存済みのrequestIdですが、現在のソースが保存結果と一致しません（他の変更が入った可能性）', { sourceHash: source.sha });
    }

    const crashedAfterWrite = Boolean(prepared) && source.sha === afterHash;
    if (!crashedAfterWrite && source.sha !== p.expectedHash.toLowerCase()) {
      return this._fail(base, 'blocked', 'CONFLICT', 'SOURCE_CONFLICT', 'sourceHash不一致: 取得後に他の変更が入っています', { sourceHash: source.sha });
    }

    const validation = validateChange(
      { branch: p.expectedBranch, relativePath: p.target, content: p.content, currentContent: source.content, currentExists: true },
      { canonicalBranch: canonical }
    );
    if (!validation.valid) {
      return this._fail(base, 'blocked', 'BLOCKED', 'VALIDATION_FAILED', `検証失敗: ${validation.errors.join(' / ')}`.slice(0, 500), { sourceHash: source.sha });
    }

    const diff = crashedAfterWrite ? { added: [], removed: [] } : computeLineDiff(source.content, p.content);
    if (!crashedAfterWrite) {
      if (diff.added.length === 0 && diff.removed.length === 0) {
        return this._response(base, { status: 'NOT_EXECUTED', sourceHash: source.sha, validated: true, message: '現在内容と差分がないため保存しません' });
      }
      if (!sameLines(p.changes.added, diff.added) || !sameLines(p.changes.removed, diff.removed)) {
        return this._fail(base, 'blocked', 'BLOCKED', 'UNEXPECTED_DIFF',
          `予定差分と実差分が一致しません（予定 +${p.changes.added.length}/-${p.changes.removed.length}、実際 +${diff.added.length}/-${diff.removed.length}）`,
          { sourceHash: source.sha, validated: true });
      }
      if (p.changeType === 'STYLE') {
        const violations = findNonStyleChanges(p.target, source.content, p.content, diff);
        if (violations.length) {
          return this._fail(base, 'blocked', 'BLOCKED', 'UNEXPECTED_DIFF', `STYLE以外の変更を検出: ${violations.slice(0, 3).join(' | ')}`, { sourceHash: source.sha, validated: true });
        }
      }
    }

    // 復旧点（変更前内容）を書き込み前に監査へ記録する。記録できなければ保存しない。
    if (!prepared) {
      if (containsLikelySecret(source.content)) {
        return this._fail(base, 'blocked', 'BLOCKED', 'VALIDATION_FAILED', '変更前ソースに秘密値らしき文字列があり、復旧点を安全に保存できません');
      }
      try {
        await this._record({
          requestId: p.requestId, event: 'prepared', tool: base.tool, relativePath: source.path, target: p.target, branch: source.branch,
          actor: p.actor || null, changeType: p.changeType, appName: p.appName || null, fingerprint: this._fingerprint(p),
          beforeHash: source.sha, afterHash, diff, changes: { description: p.changes.description },
          validation: { valid: true, warnings: validation.warnings }, rollbackPoint: { beforeHash: source.sha, beforeContent: source.content }
        });
      } catch (error) {
        return this._fail(base, 'blocked', 'BLOCKED', 'SAVE_FAILED', '復旧点を記録できないため保存を中止しました', { error: error.message });
      }
    }

    let writeError = null;
    if (!crashedAfterWrite) {
      try {
        await this.git.applySourceFileChange(p.target, p.content, p.message || `Power Apps ${p.changeType}: ${p.changes.description}`.slice(0, 200), canonical);
      } catch (error) { writeError = error; }
    }

    // 書き込み結果は応答ではなく実状態で確認する。
    let after;
    try { after = await this._getSource(p.target); } catch (error) {
      return this._fail(base, 'saved_unverified', 'PARTIAL', 'STATE_CHECK_FAILED', '保存後のソースを再取得できず、保存結果は未確認です', { error: error.message, changed: true, validated: true });
    }
    if (after.sha !== afterHash || after.content !== p.content) {
      if (writeError) {
        const c = classifyUpstream(writeError, 'FAILED', 'SAVE_FAILED');
        return this._fail(base, 'save_failed', c.status, c.errorCode, c.errorCode === 'SOURCE_CONFLICT' ? '保存時に競合しました（他の変更が入っています）' : '保存に失敗しました', { error: writeError.message, validated: true, sourceHash: after.sha });
      }
      return this._fail(base, 'save_failed', 'FAILED', 'SAVE_FAILED', '保存後のソースが期待内容と一致しません', { validated: true, sourceHash: after.sha });
    }

    let version = null;
    let stateOk = false;
    try { ({ ok: stateOk, version } = await this._appVersion()); } catch { /* 未確認として扱う */ }

    const auditId = await this._record({
      requestId: p.requestId, event: 'saved', tool: base.tool, relativePath: after.path, branch: after.branch, actor: p.actor || null,
      beforeHash: prepared?.beforeHash ?? source.sha, afterHash, version, stateVerified: stateOk,
      status: writeError ? 'PARTIAL' : 'OK', error: writeError ? this.mask(writeError.message) : undefined
    }).catch(() => null);

    const partial = Boolean(writeError) || !stateOk;
    return this._response(base, {
      status: partial ? 'PARTIAL' : 'OK', sourceHash: after.sha, changed: true, validated: true, saved: true, version, auditId, rollbackAvailable: true,
      errorCode: partial ? 'STATE_CHECK_FAILED' : null,
      message: partial
        ? `保存は確認済みですが、${writeError ? 'Power Platform同期でエラーが出ました' : '保存後のアプリ状態を確認できませんでした'}`
        : '保存を確認しました'
    });
  }

  _fingerprint(p) {
    return crypto.createHash('sha256').update(JSON.stringify([p.target, p.expectedBranch, p.expectedHash, p.content])).digest('hex');
  }

  // ------------------------------------------------------------- publish
  publish(params) {
    return this._serial(() => this._publish(params));
  }

  async _publish(p) {
    const base = { requestId: typeof p?.requestId === 'string' ? p.requestId : null, tool: 'publish_powerapps_app', target: p?.approvalScope?.relativePath ?? null, branch: p?.branch ?? p?.expectedBranch ?? null, actor: p?.actor || null };
    const approval = p?.approvalScope;
    const approved = p?.publishApproved === true && typeof p.approvedBy === 'string' && p.approvedBy.trim()
      && approval && typeof approval === 'object' && approval.requestId === p.requestId
      && typeof approval.relativePath === 'string' && typeof approval.afterHash === 'string' && SHA_PATTERN.test(approval.afterHash);
    if (typeof p?.requestId !== 'string' || !REQUEST_ID_PATTERN.test(p.requestId) || !approved) {
      const outcome = { status: 'APPROVAL_REQUIRED', errorCode: 'PUBLISH_NOT_APPROVED', message: '公開には requestId・publishApproved:true・approvedBy・approvalScope{requestId,relativePath,afterHash} が必要です。公開していません' };
      const auditId = base.requestId && REQUEST_ID_PATTERN.test(base.requestId) ? await this._recordFailure(base, 'publish_refused', outcome) : null;
      return this._response(base, { ...outcome, auditId });
    }
    if (HUMAN_APPROVER_DENY.test(p.approvedBy)) {
      return this._fail(base, 'publish_refused', 'APPROVAL_REQUIRED', 'PUBLISH_NOT_APPROVED', 'approvedByには人間の承認者名が必要です（AI・自動化は承認者になれません）');
    }

    const events = await this._events(p.requestId);
    const saved = events.find((e) => e.event === 'saved');
    if (!saved || events.some((e) => e.event === 'rolled_back')) {
      return this._fail(base, 'publish_refused', 'BLOCKED', 'PUBLISH_NOT_APPROVED', '承認対象の保存記録がない（または復旧済みの）requestIdです');
    }
    const pathMatches = approval.relativePath === saved.relativePath || approval.relativePath === saved.target;
    if (approval.afterHash.toLowerCase() !== saved.afterHash || !pathMatches) {
      return this._fail(base, 'publish_refused', 'BLOCKED', 'PUBLISH_NOT_APPROVED', '承認範囲（relativePath/afterHash）と保存済みの実差分が一致しません');
    }
    if (base.branch !== null && base.branch !== this.git.canonicalBranch) {
      return this._fail(base, 'publish_refused', 'BLOCKED', 'BRANCH_MISMATCH', `branch不一致: 指定=${base.branch}, 正本=${this.git.canonicalBranch}`);
    }
    base.branch = this.git.canonicalBranch;

    let current;
    try { current = await this._getSource(saved.relativePath); } catch (error) {
      const c = classifyUpstream(error, 'FAILED', 'STATE_CHECK_FAILED');
      return this._fail(base, 'publish_refused', c.status, c.errorCode, '公開前のソース再確認に失敗しました', { error: error.message });
    }
    if (current.sha !== saved.afterHash) {
      return this._fail(base, 'publish_refused', 'CONFLICT', 'SOURCE_CONFLICT', '承認後にソースが変更されています。再検証と再承認が必要です', { sourceHash: current.sha });
    }

    const already = events.find((e) => e.event === 'published');
    let version = null;
    if (!already) {
      let result;
      try { result = await this.app.publishApp(); } catch (error) { result = { status: 'error', error: error.message }; }
      if (!result || result.status !== 'ok') {
        const c = classifyUpstream(result?.error, 'FAILED', 'PUBLISH_FAILED');
        return this._fail(base, 'publish_failed', 'FAILED', c.errorCode === 'AUTH_FAILED' || c.errorCode === 'PERMISSION_DENIED' ? c.errorCode : 'PUBLISH_FAILED', '公開に失敗しました', { error: result?.error || 'unknown', sourceHash: current.sha, validated: true, saved: true });
      }
    }

    let stateOk = false;
    try { ({ ok: stateOk, version } = await this._appVersion()); } catch { /* 未確認として扱う */ }

    let auditId = already?.auditId ?? null;
    if (!already) {
      auditId = await this._record({
        requestId: p.requestId, event: 'published', tool: base.tool, relativePath: saved.relativePath, branch: base.branch,
        actor: p.actor || null, approvedBy: p.approvedBy, approvalScope: approval, beforeHash: saved.beforeHash, afterHash: saved.afterHash,
        version, stateVerified: stateOk
      }).catch(() => null);
    }
    return this._response(base, {
      status: stateOk ? 'OK' : 'PARTIAL', target: saved.relativePath, sourceHash: current.sha, changed: true, validated: true, saved: true, published: true,
      version, auditId, rollbackAvailable: true, errorCode: stateOk ? null : 'STATE_CHECK_FAILED',
      message: already ? '同一requestIdの公開は完了済みです（再公開せず実状態を確認しました）' : (stateOk ? '公開し、公開後のStateを確認しました' : '公開しましたが、公開後のStateを確認できていません'),
      ...(already ? { replayed: true } : {})
    });
  }

  // ------------------------------------------------------------ rollback
  rollback(params) {
    return this._serial(() => this._rollback(params));
  }

  async _rollback(p) {
    const base = { requestId: typeof p?.requestId === 'string' ? p.requestId : null, tool: 'rollback_powerapps_change', target: null, branch: p?.expectedBranch ?? null, actor: p?.actor || null };
    if (typeof p?.requestId !== 'string' || !REQUEST_ID_PATTERN.test(p.requestId)) return this._invalid(base, 'requestIdが必要です');
    if (typeof p.expectedBranch !== 'string' || !p.expectedBranch.trim()) return this._invalid(base, 'expectedBranchが必要です');
    if (p.expectedBranch !== this.git.canonicalBranch) {
      return this._fail(base, 'rollback_refused', 'BLOCKED', 'BRANCH_MISMATCH', `branch不一致: 指定=${p.expectedBranch}, 正本=${this.git.canonicalBranch}`);
    }
    const events = await this._events(p.requestId);
    const prepared = events.find((e) => e.event === 'prepared');
    const saved = events.find((e) => e.event === 'saved');
    const rolledBack = events.find((e) => e.event === 'rolled_back');
    if (!prepared || !saved || !prepared.rollbackPoint) {
      return this._fail(base, 'rollback_refused', 'BLOCKED', 'ROLLBACK_FAILED', '復旧点が記録されていないrequestIdです');
    }
    base.target = saved.relativePath;
    const { beforeHash, beforeContent } = prepared.rollbackPoint;
    if (typeof beforeContent !== 'string' || gitBlobSha(beforeContent) !== beforeHash) {
      return this._fail(base, 'rollback_refused', 'FAILED', 'ROLLBACK_FAILED', '記録済み復旧点が破損しています（ハッシュ不一致）');
    }

    let current;
    try { current = await this._getSource(saved.relativePath); } catch (error) {
      const c = classifyUpstream(error, 'FAILED', 'STATE_CHECK_FAILED');
      return this._fail(base, 'rollback_refused', c.status, c.errorCode, '復旧前のソース取得に失敗しました', { error: error.message });
    }
    base.branch = current.branch;
    if (current.branch !== this.git.canonicalBranch) {
      return this._fail(base, 'rollback_refused', 'BLOCKED', 'BRANCH_MISMATCH', `ソースは正本以外のbranch(${current.branch})です`);
    }
    if (rolledBack) {
      if (current.sha === beforeHash) {
        return this._response(base, { status: 'OK', sourceHash: current.sha, changed: true, saved: false, message: '同一requestIdの復旧は完了済みです（実状態を確認しました）', auditId: rolledBack.auditId, replayed: true, publishStateChanged: false });
      }
      return this._fail(base, 'rollback_refused', 'CONFLICT', 'SOURCE_CONFLICT', '復旧済みですが、その後ソースが変更されています', { sourceHash: current.sha });
    }
    if (current.sha !== saved.afterHash) {
      return this._fail(base, 'rollback_refused', 'CONFLICT', 'SOURCE_CONFLICT', '保存後に他の変更が入っているため、自動復旧しません', { sourceHash: current.sha });
    }

    let writeError = null;
    try {
      await this.git.applySourceFileChange(saved.relativePath, beforeContent, `Rollback Power Apps change ${p.requestId}`, this.git.canonicalBranch);
    } catch (error) { writeError = error; }
    let after;
    try { after = await this._getSource(saved.relativePath); } catch (error) {
      return this._fail(base, 'rollback_failed', 'FAILED', 'ROLLBACK_FAILED', '復旧後のソース再取得に失敗し、結果は未確認です', { error: error.message });
    }
    if (after.sha !== beforeHash) {
      return this._fail(base, 'rollback_failed', 'FAILED', 'ROLLBACK_FAILED', '復旧に失敗しました（復旧後のソースが復旧点と一致しません）', { error: writeError?.message, sourceHash: after.sha });
    }
    const auditId = await this._record({
      requestId: p.requestId, event: 'rolled_back', tool: base.tool, relativePath: saved.relativePath, branch: after.branch,
      actor: p.actor || null, beforeHash: saved.afterHash, afterHash: beforeHash, error: writeError ? this.mask(writeError.message) : undefined
    }).catch(() => null);
    const wasPublished = events.some((e) => e.event === 'published');
    return this._response(base, {
      status: writeError ? 'PARTIAL' : 'OK', sourceHash: after.sha, changed: true, auditId, errorCode: writeError ? 'STATE_CHECK_FAILED' : null,
      message: `ソースを復旧点へ戻しました。公開状態は変更していません${wasPublished ? '（公開済みバージョンへの反映には、新たな公開承認が必要です）' : ''}`,
      publishStateChanged: false, publishRequiresApproval: wasPublished
    });
  }

  // --------------------------------------------------------------- audit
  async getAudit(params = {}) {
    const base = { requestId: params.requestId ?? null, tool: 'get_powerapps_audit' };
    const limit = Number.isInteger(params.limit) ? Math.min(Math.max(params.limit, 1), 200) : 50;
    let entries;
    try { entries = await this._readAll(); } catch (error) {
      return this._response(base, { status: 'FAILED', errorCode: 'STATE_CHECK_FAILED', message: `監査ログを読み取れません: ${this.mask(error.message)}` });
    }
    if (params.requestId) entries = entries.filter((e) => e.requestId === params.requestId);
    const requests = {};
    for (const e of entries) {
      const r = requests[e.requestId] || (requests[e.requestId] = { events: [], rollbackAvailable: false });
      r.events.push(e.event);
    }
    for (const r of Object.values(requests)) {
      r.rollbackAvailable = r.events.includes('saved') && !r.events.includes('rolled_back');
    }
    const visible = entries.slice(-limit).map((e) => {
      const { rollbackPoint, fingerprint, ...rest } = e;
      return { ...rest, ...(rollbackPoint ? { rollbackPoint: { beforeHash: rollbackPoint.beforeHash, recorded: true } } : {}) };
    });
    return this._response(base, {
      status: params.requestId && entries.length === 0 ? 'NOT_EXECUTED' : 'OK',
      message: entries.length === 0 ? '該当する監査記録がありません' : `${visible.length}件の監査記録を返します`,
      count: visible.length, requests, entries: visible,
      rollbackAvailable: Boolean(params.requestId && requests[params.requestId]?.rollbackAvailable)
    });
  }
}

module.exports = { PowerAppsChangeWorkflow, CHANGE_TYPES, STYLE_PROPERTIES, computeLineDiff, findNonStyleChanges, lineOwners };
