'use strict';
const crypto=require('node:crypto');
const SHA=/^[a-f0-9]{40}$/i;
function githubDraftEvidenceAdapter({request,owner,repo,branch}) {
  if(typeof request!=='function'||!owner||!repo||typeof branch!=='string'||!/^draft\/[a-z0-9][a-z0-9._/-]*$/i.test(branch)||branch.includes('..')) throw Error('draft_github_config_required');
  const root='/repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(repo);
  const call=async(path,opts)=>{
    const res=await request(root+path,opts);
    if(!res||typeof res!=='object')throw Error('github_response_missing');
    return res;
  };
  return {
    async getCiEvidence({plan,planHash}) {
      if(plan.operation!=='ci_verify'||!SHA.test(plan.headSha))throw Error('invalid_ci_plan');
      const data=await call('/actions/runs?head_sha='+encodeURIComponent(plan.headSha)+'&per_page=30');
      const runs=Array.isArray(data.workflow_runs)?data.workflow_runs:[];
      const run=runs.find(r=>r.head_sha===plan.headSha&&r.head_branch===branch&&r.status==='completed'&&r.conclusion==='success'&&Number.isSafeInteger(r.id)&&r.id>0);
      if(!run)return {verified:false};
      return {verified:true,planHash,evidenceId:'github-actions:'+run.id};
    },
    async applyDraftChange({plan,planHash,evidence}) {
      if(plan.operation!=='draft_edit'||!evidence||typeof evidence.path!=='string'||!evidence.path||
         evidence.path.startsWith('/')||evidence.path.split('/').includes('..')|| !/^(src|test)\/[a-z0-9._/-]+$/i.test(evidence.path)||
         typeof evidence.content!=='string'||typeof evidence.message!=='string'||!evidence.message.trim())throw Error('invalid_draft_change');
      const ref=await call('/git/ref/heads/'+branch.split('/').map(encodeURIComponent).join('/'));
      if(ref.object?.sha!==plan.headSha)throw Error('branch_sha_mismatch');
      const path=evidence.path.split('/').map(encodeURIComponent).join('/');
      const current=await call('/contents/'+path+'?ref='+encodeURIComponent(branch));
      if(!current.sha||!current.type||current.type!=='file')throw Error('file_metadata_missing');
      const updated=await call('/contents/'+path,{method:'PUT',body:JSON.stringify({
        message:evidence.message,content:Buffer.from(evidence.content,'utf8').toString('base64'),sha:current.sha,branch
      })});
      if(!SHA.test(updated.commit?.sha||'')||!SHA.test(updated.content?.sha||'')||\n         !Array.isArray(updated.commit?.parents)||updated.commit.parents.length!==1||updated.commit.parents[0]?.sha!==plan.headSha)return {verified:false};
      const after=await call('/contents/'+path+'?ref='+encodeURIComponent(branch));
      const actual=crypto.createHash('sha1').update(Buffer.concat([Buffer.from('blob '+Buffer.byteLength(evidence.content)+'\0'),Buffer.from(evidence.content)])).digest('hex');
      if(after.sha!==actual||updated.content.sha!==actual)return {verified:false};\n      const newRef=await call('/git/ref/heads/'+branch.split('/').map(encodeURIComponent).join('/'));\n      if(newRef.object?.sha!==updated.commit.sha)return {verified:false};
      return {verified:true,planHash,evidenceId:'github-commit:'+updated.commit.sha};
    }
  };
}
module.exports={githubDraftEvidenceAdapter};
