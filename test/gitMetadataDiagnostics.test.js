const test = require('node:test');
const assert = require('node:assert/strict');
const { PowerAppsGitStore } = require('../src/powerAppsGitStore');
const makeStore = (statuses) => {
  const calls = [];
  const store = new PowerAppsGitStore({githubToken:'test-token',githubOwner:'owner',githubRepo:'repo',githubBranch:'main',githubFallbackBranches:['fallback'],fetchImpl:async (url) => {
    calls.push(url);
    const status = statuses.shift();
    if (status === 200) return {ok:true,status,json:async()=>({object:{sha:'a'.repeat(40)}})};
    return {ok:false,status,text:async()=> 'redacted'};
  }});
  return {store,calls};
};
for (const [status,reason] of [[401,'authentication_failed'],[403,'access_forbidden'],[404,'ref_not_found'],[429,'rate_limited'],[503,'upstream_unavailable']]) {
  test('metadata fail closed '+status, async()=>{
    const {store,calls}=makeStore([status,status,status]);
    await assert.rejects(store.getSourceFileMetadata(), err=>{
      assert.equal(err.payload.status,'state_context_invalid');
      assert.equal(err.payload.diagnostics[0].reason,reason);
      assert.doesNotMatch(JSON.stringify(err.payload),/test-token|redacted/);
      return true;
    });
    assert.equal(calls.length,status===401||status===403?1:2);
  });
}
test('404 fallback to valid commit',async()=>{
  const {store,calls}=makeStore([404,200]);
  const result=await store.getSourceFileMetadata();
  assert.equal(result.branch,'fallback');
  assert.equal(result.sha,'a'.repeat(40));
  assert.equal(calls.length,2);
});
