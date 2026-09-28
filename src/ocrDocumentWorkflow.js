'use strict';

// Pure, side-effect-free workflow. OCR, SharePoint, PDF and FAX adapters are
// deliberately supplied by the caller after their contracts are verified.
const { extractCandidate } = require('./equipmentOcrExtraction');
const PHASES = Object.freeze({ READ: '読取確認', DRAFT: '自動記載済み', FINAL: '完成確認', APPROVED: '送付承認済み' });

function start(text, masterRows, { kind = 'equipment', documentId } = {}) {
  if (!documentId || !['equipment', 'mydata', 'company'].includes(kind))
    return { ok: false, errors: ['帳票種別または帳票識別子がありません'], saved: false };
  // The existing 9A validator applies only to equipment records. Do not use a
  // customer-number match to validate personal or company identity documents.
  if (kind !== 'equipment')
    return { ok: false, errors: ['本人・自社帳票の抽出定義と正本が未確認です'], saved: false };
  const candidate = extractCandidate(text, masterRows);
  if (!candidate.ok) return candidate;
  return { ok: true, phase: PHASES.READ, kind, documentId, candidate,
    saved: false, delivered: false };
}

function confirmRead(state, { actor, corrections = {} } = {}) {
  if (!state?.ok || state.phase !== PHASES.READ || !actor)
    return { ok: false, errors: ['読取確認者または読取プレビューがありません'], saved: false };
  // Corrections must go back through source-specific validation; no silent
  // override of a validated candidate is permitted.
  if (Object.keys(corrections).length)
    return { ok: false, errors: ['訂正後の再照合が必要です'], saved: false };
  return { ...state, phase: PHASES.DRAFT, readConfirmedBy: actor,
    draft: { ...state.candidate.preview }, saved: false };
}

function previewFinal(state, { recipient, templateId } = {}) {
  if (!state?.ok || state.phase !== PHASES.DRAFT || !recipient || !templateId)
    return { ok: false, errors: ['記載内容・宛先・帳票テンプレートを確認してください'], saved: false };
  return { ...state, phase: PHASES.FINAL, recipient, templateId,
    delivered: false, saved: false };
}

function approveFinal(state, { actor } = {}) {
  if (!state?.ok || state.phase !== PHASES.FINAL || !actor || actor === 'AI')
    return { ok: false, errors: ['完成帳票の人間による承認が必要です'], saved: false };
  return { ...state, phase: PHASES.APPROVED, finalApprovedBy: actor,
    delivered: false, saved: false };
}

function outputIntent(state, format, { faxNumber, confirmedFaxNumber } = {}) {
  if (!state?.ok || state.phase !== PHASES.APPROVED)
    return { ok: false, errors: ['完成帳票の承認前は出力できません'] };
  if (format === 'fax' && (!faxNumber || faxNumber !== confirmedFaxNumber))
    return { ok: false, errors: ['FAX宛先の再確認が必要です'] };
  if (!['fax', 'pdf'].includes(format))
    return { ok: false, errors: ['出力形式が不正です'] };
  // An intent is not a PDF binary or a sent fax. An adapter must explicitly
  // consume this only after E2E tests, permissions and destination checks.
  return { ok: true, format, documentId: state.documentId,
    templateId: state.templateId, recipient: state.recipient,
    faxNumber: format === 'fax' ? faxNumber : undefined,
    approvedBy: state.finalApprovedBy, generated: false, sent: false };
}

module.exports = { PHASES, start, confirmRead, previewFinal, approveFinal, outputIntent };
