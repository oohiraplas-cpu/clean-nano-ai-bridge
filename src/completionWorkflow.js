'use strict';
// Pure, fail-closed prototype. No production list writes, permission changes or schema assumptions.
const crypto = require('node:crypto');
const STATES = Object.freeze({ DRAFT: 'draft', COMPLETED: 'completed', CHANGE_REQUESTED: 'change_requested', REVISION_OPEN: 'revision_open' });
function requireActor(actor) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim()) throw Error('Authenticated actor required');
}
function createDraft(recordId, content, actor, now = new Date().toISOString()) {
  requireActor(actor);
  if (!recordId || !content || typeof content !== 'object' || Array.isArray(content)) throw Error('Invalid draft');
  return { recordId, state: STATES.DRAFT, version: 0, content: structuredClone(content), history: [], requests: [], owner: actor.id, updatedAt: now };
}
function canEdit(record, actor) {
  requireActor(actor);
  return (record.state === STATES.DRAFT && record.owner === actor.id) ||
    (record.state === STATES.REVISION_OPEN && record.revisionEditor === actor.id);
}
function edit(record, patch, actor) {
  if (!canEdit(record, actor)) throw Error('Edit denied: locked or unauthorized');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('Invalid patch');
  return { ...record, content: { ...record.content, ...structuredClone(patch) } };
}
function snapshot(content) {
  const json = JSON.stringify(content);
  return { content: structuredClone(content), sha256: crypto.createHash('sha256').update(json).digest('hex') };
}
function complete(record, actor, now = new Date().toISOString()) {
  if (!canEdit(record, actor)) throw Error('Completion denied');
  const version = record.version + 1;
  const entry = { version, at: now, by: actor.id, ...snapshot(record.content) };
  return { ...record, state: STATES.COMPLETED, version, history: [...record.history, entry],
    revisionEditor: undefined, updatedAt: now };
}
function requestRevision(record, actor, reason, now = new Date().toISOString()) {
  requireActor(actor);
  if (record.state !== STATES.COMPLETED || !reason?.trim()) throw Error('Revision request denied');
  const request = { id: crypto.randomUUID(), requestedBy: actor.id, reason: reason.trim(), at: now, status: 'pending' };
  return { ...record, state: STATES.CHANGE_REQUESTED, requests: [...record.requests, request] };
}
function decideRevision(record, approver, requestId, decision, editorId, now = new Date().toISOString()) {
  requireActor(approver);
  if (!approver.canApprove || record.state !== STATES.CHANGE_REQUESTED) throw Error('Approval denied');
  const request = record.requests.find(x => x.id === requestId && x.status === 'pending');
  if (!request || approver.id === request.requestedBy || !['approve', 'reject'].includes(decision)) throw Error('Invalid approval');
  if (decision === 'approve' && (!editorId || typeof editorId !== 'string')) throw Error('Editor required');
  return { ...record, state: decision === 'approve' ? STATES.REVISION_OPEN : STATES.COMPLETED,
    revisionEditor: decision === 'approve' ? editorId : undefined,
    requests: record.requests.map(x => x.id === requestId ? { ...x, status: decision, decidedBy: approver.id, decidedAt: now } : x) };
}
module.exports = { STATES, createDraft, canEdit, edit, complete, requestRevision, decideRevision };
