'use strict';
// OZ Router isolated core. No network routes or production mutations are registered here.
const { runDag } = require('../orchestration/executor');
const ENTRIES = Object.freeze(['OZ_EXECUTE','OZ_QUERY','OZ_CONTROL']);
const SAFE_CONTROLS = new Set(['capabilities','checkpoint']);
const SAFE_QUERIES = new Set(['capabilities','status']);
function fail(reasonCode){return {status:'BLOCKED',reasonCode};}
function createOzRouter({lanes={}, checkpointReader=null, audit=()=>{}}={}) {
  async function dispatch(input, context={}) {
    if (!input || typeof input!=='object' || Array.isArray(input)) return fail('INVALID_INPUT');
    const {entry,operation,payload={}}=input;
    if (!ENTRIES.includes(entry) || typeof operation!=='string' || !operation || !payload || typeof payload!=='object' || Array.isArray(payload)) return fail('INVALID_INPUT');
    if (entry==='OZ_CONTROL' && SAFE_CONTROLS.has(operation)) {
      if(operation==='capabilities') return {status:'CONFIRMED',entries:ENTRIES,lanes:Object.keys(lanes)};
      if(typeof checkpointReader!=='function') return fail('CHECKPOINT_NOT_CONFIGURED');
      try {return {status:'CONFIRMED',checkpoint:await checkpointReader(context)};}catch{return fail('CHECKPOINT_READ_FAILED');}
    }
    if (entry==='OZ_QUERY' && operation==='capabilities') return {status:'CONFIRMED',entries:ENTRIES,lanes:Object.keys(lanes)};
    if (entry==='OZ_QUERY' && !SAFE_QUERIES.has(operation) && !Object.hasOwn(lanes,operation)) return fail('UNKNOWN_OPERATION');
    if (entry==='OZ_CONTROL') return fail('CONTROL_NOT_ALLOWED');
    const lane=Object.hasOwn(lanes,operation)?lanes[operation]:null;
    if(!lane || typeof lane.run!=='function') return fail('LANE_NOT_CONFIGURED');
    if(entry==='OZ_QUERY' && lane.readOnly!==true) return fail('QUERY_REQUIRES_READ_ONLY');
    if(entry==='OZ_EXECUTE') {
      if(context.authenticated!==true) return fail('AUTH_REQUIRED');
      if(lane.readOnly!==true && context.writeAuthorized!==true) return fail('WRITE_NOT_AUTHORIZED');
      if(lane.humanGate===true && context.humanApproved!==true) return fail('HUMAN_APPROVAL_REQUIRED');
      if(lane.costGate===true) return fail('COST_GATE');
    }
    const event={entry,operation,status:'STARTED'};
    try {audit(event);}catch{return fail('AUDIT_UNAVAILABLE');}
    try {
      const result=await lane.run(payload,context);
      try {audit({entry,operation,status:'FINISHED'});}catch{return fail('AUDIT_UNAVAILABLE');}
      return {status:'PARTIAL',result,verification:'UNVERIFIED'};
    } catch {
      try {audit({entry,operation,status:'FAILED'});}catch{}
      return fail('LANE_EXECUTION_FAILED');
    }
  }
  return {dispatch,runDag};
}
module.exports={createOzRouter,ENTRIES};
