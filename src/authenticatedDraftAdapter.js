'use strict';
const {githubDraftEvidenceAdapter}=require('./githubDraftEvidenceAdapter');
// Reuse PowerAppsGitStore's existing authenticated GitHub request path.
// The adapter receives no token and does not modify the canonical branch.
function createAuthenticatedDraftAdapter({gitStore,branch}) {
  if(!gitStore||typeof gitStore._githubRequest!=='function'||typeof gitStore._assertGitHubConfig!=='function')throw Error('github_store_unavailable');
  gitStore._assertGitHubConfig();
  const {githubOwner:owner,githubRepo:repo}=gitStore;
  if(typeof owner!=='string'||!owner||typeof repo!=='string'||!repo)throw Error('github_repo_unavailable');
  const request=async(path,options)=>gitStore._githubRequest(path,options||{});
  return githubDraftEvidenceAdapter({request,owner,repo,branch});
}
module.exports={createAuthenticatedDraftAdapter};
