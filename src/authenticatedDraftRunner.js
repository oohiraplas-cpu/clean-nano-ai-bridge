'use strict';
const {githubDraftEvidenceAdapter}=require('./githubDraftEvidenceAdapter');
const {executeApprovedDraft}=require('./approvedDraftExecution');
// Existing PowerAppsGitStore owns authentication and the canonical GitHub
// request implementation. Never accept credentials or arbitrary URL from callers.
function createAuthenticatedDraftRunner({store,owner,repo,branch}) {
  if(!store||typeof store._githubRequest!=='function'||typeof store._assertGitHubConfig!=='function'||
     typeof store.githubToken!=='string'||!store.githubToken.trim()||
     store.githubOwner!==owner||store.githubRepo!==repo||
     typeof branch!=='string'||!branch.startsWith('draft/'))throw Error('authenticated_draft_store_required');
  store._assertGitHubConfig();
  const request=async(path,options)=>{
    // Enforce the known repository prefix before handing requests to the
    // existing authenticated client. No other host is accepted.
    const prefix='/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo)+'/';
    if(!path.startsWith(prefix))throw Error('github_repo_scope_mismatch');
    return store._githubRequest(path,options);
  };
  const adapter=githubDraftEvidenceAdapter({request,owner,repo,branch});
  return async ({plan,evidence})=>{
    if(plan?.targetId!==owner+'/'+repo||plan?.environmentId!==branch)return {status:'BLOCKED',reason:'target_scope_mismatch'};
    return executeApprovedDraft({plan,adapter,evidence});
  };
}
module.exports={createAuthenticatedDraftRunner};
