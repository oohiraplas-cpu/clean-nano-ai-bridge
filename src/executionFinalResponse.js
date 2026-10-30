'use strict';
// MCP requests must receive a bounded response. This helper waits for a terminal
// queue state without claiming completion or bypassing approval.
const TERMINAL = new Set(['完了','停止','人間承認待ち']);
async function waitForExecutionResult(queue, requestId, {timeoutMs=20000,pollMs=200}={}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs<0 || timeoutMs>25000) throw new RangeError('timeoutMs must be 0..25000');
  const deadline=Date.now()+timeoutMs;
  while(true) {
    const result=queue.getStatus(requestId);
    if (TERMINAL.has(result.status)) return {
      ...result, finalOnly:true, resultKind:result.status==='完了'?'completed':result.status==='停止'?'failed':'approval_required',
      terminal:true
    };
    if(Date.now()>=deadline) return {
      requestId,status:'BLOCKED',resultKind:'timeout',terminal:false,finalOnly:true,
      reason:'execution_not_finished',retryable:true
    };
    await new Promise(resolve=>setTimeout(resolve,Math.min(pollMs,Math.max(1,deadline-Date.now()))));
  }
}
module.exports={waitForExecutionResult};
