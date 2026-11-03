'use strict';
// Fail-closed adapter for isolated evaluation. Never calls the legacy executor.
const {assessRecovery}=require('./lv5RecoveryGate');
const LEGACY_ACTIONS=Object.freeze({
 auto_renew:'repair',context_regenerate:'repair',rollback_retry:'rollback',
 transaction_abort:'repair',policy_exception:'permission_change',
 ledger_recovery:'repair',manual_review:null
});
function reviewLegacyRecovery({legacyAction,context,approval,evidence}={}) {
 if(typeof legacyAction!=='string' || !Object.prototype.hasOwnProperty.call(LEGACY_ACTIONS,legacyAction))
  return Object.freeze({status:'BLOCKED',reason:'unknown_legacy_action',executionAllowed:false});
 const action=LEGACY_ACTIONS[legacyAction];
 if(!action) return Object.freeze({status:'BLOCKED',reason:'manual_review_only',executionAllowed:false});
 const result=assessRecovery({action,context,approval,evidence});
 return Object.freeze({...result,legacyAction,executionAllowed:false,requiresSeparateWriteAuthorization:true});
}
module.exports={reviewLegacyRecovery,LEGACY_ACTIONS};
