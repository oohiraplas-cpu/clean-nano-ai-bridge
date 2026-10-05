'use strict';
function authorize(record, action, actor) {
  if (!record || !actor || !actor.authenticated) return false;
  if (action === 'read') return actor.canRead === true;
  if (action === 'edit') return record.state === 'draft' && (record.ownerId === actor.id || actor.canEditDraft === true);
  if (action === 'amend') {
    const approval = actor.humanApproval;
    return record.state === 'final' && actor.isHumanApprover === true &&
      approval?.approved === true && approval.recordId === record.id &&
      approval.recordVersion === record.version && approval.approvedBy === actor.id &&
      Boolean(approval.reason && approval.requestId);
  }
  return false;
}
function proposedAmendment(original, approval, actor) {
  if (!authorize(original, 'amend', {...actor, humanApproval: approval})) throw Error('Human approval required');
  return { parentId: original.id, parentVersion: original.version,
    proposedVersion: original.version + 1, state: 'draft', approvedBy: actor.id,
    requestId: approval.requestId, reason: approval.reason };
}
module.exports = { authorize, proposedAmendment };
