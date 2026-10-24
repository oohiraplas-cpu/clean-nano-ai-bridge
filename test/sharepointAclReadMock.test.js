'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {collectAclEvidence}=require('../src/sharepointAclReadMock');
const seen=[];
const mock=async(path)=>{
  seen.push(path);
  if(path.includes('getusereffectivepermissions')) return {GetUserEffectivePermissions:{High:'0',Low:'4'}};
  if(path.includes('roleassignments')) return {value:[{PrincipalId:10,RoleDefinitionBindings:[{Name:'Read'}]}]};
  return {Id:'973f17d6-3566-4795-9712-2386bb7bf540',HasUniqueRoleAssignments:true};
};
test('ACL evidence mock issues only fixed-list GET queries and reports limitations',async()=>{
  seen.length=0;
  const r=await collectAclEvidence({get:mock,principalLogins:['i:0#.f|membership|employee@example.test']});
  assert.equal(r.verified,true);assert.equal(r.hasUniqueRoleAssignments,true);
  assert.equal(r.roleAssignments.length,1);assert.equal(r.effective.length,1);
  assert.equal(seen.length,3);assert.ok(seen.every(p=>p.startsWith("/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')")));
  assert.ok(r.limitations.includes('service_principal_app_only_permissions_unverified'));
});
test('ACL evidence mock fails closed for missing transport, changed target and invalid principals',async()=>{
  await assert.rejects(collectAclEvidence({}),/read_transport_unavailable/);
  await assert.rejects(collectAclEvidence({get:mock,listId:'other'}),/target_mismatch/);
  await assert.rejects(collectAclEvidence({get:mock,principalLogins:[5]}),/principal_login_invalid/);
});
test('ACL evidence mock refuses missing inheritance, role assignments and permissions',async()=>{
  await assert.rejects(collectAclEvidence({get:async()=>({})}),/inheritance_unverified/);
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('roleassignments')?{}:{HasUniqueRoleAssignments:false}}),/role_assignments_unverified/);
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('getusereffectivepermissions')?{}:p.includes('roleassignments')?{value:[]}:{HasUniqueRoleAssignments:true},principalLogins:['employee']}),/effective_permissions_unverified/);
});
test('ACL evidence adapter does not enable public unified WRITE',async()=>{
  const pm=require('../src/platformManage');
  for(const tool of ['sharepoint_manage','powerapps_manage','powerautomate_manage','powerplatform_validate']){
    const result=await pm.run(tool,{operation:'item_update',approvedByHuman:true});
    assert.equal(result.status,'approval_required',tool);
  }
});
