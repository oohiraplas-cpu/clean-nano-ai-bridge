'use strict';
// Atomic, process-local approval consumption. Production requires a durable
// transactional store; this module deliberately does not authorize writes.
const { resolveApprovalUtterance } = require('./connectionRepairCoordinator');
function createApprovalGate() {
  const requests = new Map();
  function register(request) {
    if (!request || request.source !== 'trusted_server' || request.status !== 'pending' ||
        typeof request.requestId !== 'string' || request.requestId.length < 8 ||
        typeof request.subjectId !== 'string' || !request.subjectId ||
        !Number.isFinite(request.expiresAt) || request.expiresAt <= Date.now() ||
        requests.has(request.requestId)) return { status: 'BLOCKED' };
    requests.set(request.requestId, Object.freeze({...request}));
    return {status:'PARTIAL',reason:'pending_approval_registered'};
  }
  function consume({requestId,subjectId,utterance} = {}) {
    const pending=requests.get(requestId);
    if (!pending || !subjectId || pending.subjectId !== subjectId)
      return {status:'BLOCKED',reason:'request_or_identity_mismatch'};
    const checked=resolveApprovalUtterance(utterance,pending);
    if (checked.status !== 'PARTIAL') return checked;
    requests.delete(requestId); // single-use, synchronous consumption
    return {status:'PARTIAL',reason:'approval_consumed_no_write',
      requestId,service:pending.service,action:pending.action,execution:'not_executed'};
  }
  return {register,consume};
}
module.exports={createApprovalGate};
