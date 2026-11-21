'use strict';
// Phone -> Copilot -> (this Bridge /connector/mcp) -> CNAI Router -> Google Workspace.
// Served through the read-only connector window, so it can NEVER pass approvedByHuman:
//  - READ capabilities execute automatically.
//  - Gated capabilities (send mail / post Chat / GAS / Docs / Calendar / data WRITE) are only PROPOSED: no Google call is made, the
//    response carries approvalSummary + proposalHash + routerRequestId. A human approves via the authenticated
//    POST /router/request/:id/resume ({approvedByHuman:true}); the originally proposed payload is what executes.
//  - Non-gated writes (gmail.draft) are not available here.
const crypto = require('node:crypto');
const cnaiRouter = require('./cnaiRouter');
const { CAPABILITIES } = require('./googleCapability');
const { maskDeep } = require('./secretMasking');

const ID_PATTERN = '^[A-Za-z0-9._:-]{1,128}$';
const ID_RE = new RegExp(ID_PATTERN);
const ALLOWED = Object.freeze(Object.entries(CAPABILITIES).filter(([, d]) => d.readOnly || d.humanGate).map(([name]) => name));

const GOOGLE_COPILOT_TOOL = Object.freeze({
  name: 'cnai_google_request',
  description: 'Google Workspace(Gmail/Chat/Drive/Sheets/Docs/Calendar/Apps Script/CNKK)への依頼をCNAI Routerへ渡します。読み取りは自動実行。メール送信・Chat投稿・GAS・Docs/Calendar/データ書込みは「提案」のみ作成され、人間承認後に実行されます（この入口からは承認できません）。',
  annotations: { readOnlyHint: false, destructiveHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      requestId: { type: 'string', pattern: ID_PATTERN, description: '依頼ID（同じ値の再送は二重実行されません）' },
      capability: { type: 'string', enum: ALLOWED },
      params: { type: 'object', additionalProperties: true }
    },
    required: ['requestId', 'capability'],
    additionalProperties: false
  }
});

const rejected = (errorCode, errorSummary, requestId = null) => ({ status: 'REJECTED', verificationStatus: 'UNVERIFIED', requestId, errorCode, errorSummary });

async function handle(input, { adapter, state = cnaiRouter.defaultState } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return rejected('INVALID_REQUEST', '引数はJSONオブジェクトである必要があります');
  const unknown = Object.keys(input).filter((k) => !['requestId', 'capability', 'params'].includes(k));
  if (unknown.length) return rejected('INVALID_REQUEST', `未対応のプロパティです: ${unknown.join(', ')}`);
  if (typeof input.requestId !== 'string' || !ID_RE.test(input.requestId)) return rejected('INVALID_REQUEST', 'requestIdは1〜128文字の英数字と . _ : - のみです');
  if (!ALLOWED.includes(input.capability)) return rejected('READ_ONLY_VIOLATION', `この入口で使えないcapabilityです（利用可: 読み取り + 承認付き提案）: ${String(input.capability)}`, input.requestId);
  if (input.params !== undefined && (input.params === null || typeof input.params !== 'object' || Array.isArray(input.params))) return rejected('INVALID_REQUEST', 'paramsはJSONオブジェクトである必要があります', input.requestId);
  if (!adapter) return rejected('ADAPTER_NOT_CONFIGURED', 'Google Workspace Adapterが未構成です', input.requestId);

  const snap = await cnaiRouter.routeRequest(state, {
    requestType: input.capability,
    route: 'googleWorkspace',
    riskLevel: 'LOW',
    idempotencyKey: `copilot-google:${input.requestId}`,
    payload: { capability: input.capability, params: input.params || {} }
    // approvedByHuman is intentionally never forwarded from this entry.
  }, { ...cnaiRouter.defaultAdapters(), googleWorkspace: adapter });

  const out = snap.lastDispatchOutput || {};
  const needsApproval = snap.errorCode === 'HUMAN_APPROVAL_REQUIRED';
  return maskDeep({
    status: ['COMPLETED', 'PARTIAL', 'BLOCKED', 'FAILED'].includes(snap.executionStatus) ? snap.executionStatus : 'FAILED',
    verificationStatus: snap.verificationStatus,
    requestId: input.requestId,
    routerRequestId: snap.requestId,
    auditId: snap.auditId,
    owner: 'gemini',
    result: out,
    verifier: out.verifier || null,
    errorCode: snap.errorCode,
    errorSummary: snap.errorSummary,
    ...(needsApproval ? { approval: { required: true, summary: out.approvalSummary, proposalHash: out.proposalHash, howToApprove: `承認者が認証付きの POST /router/request/${snap.requestId}/resume に {"approvedByHuman":true} を送る` } } : {}),
    ...(snap.duplicate ? { duplicate: true } : {})
  });
}

module.exports = { GOOGLE_COPILOT_TOOL, ALLOWED, handle };
