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
  const list={Id:'973f17d6-3566-4795-9712-2386bb7bf540',HasUniqueRoleAssignments:false};
  await assert.rejects(collectAclEvidence({get:async()=>({})}),/inheritance_unverified/);
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('roleassignments')?{}:list}),/role_assignments_unverified/);
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('getusereffectivepermissions')?{}:p.includes('roleassignments')?{value:[]}:list,principalLogins:['employee']}),/effective_permissions_unverified/);
});
test('ACL evidence adapter does not enable public unified WRITE',async()=>{
  const pm=require('../src/platformManage');
  for(const [tool,operation] of [
    ['sharepoint_manage','item_update'],
    ['powerapps_manage','screen_edit'],
    ['powerautomate_manage','edit']
  ]){
    const result=await pm.run(tool,{operation,approvedByHuman:true});
    assert.equal(result.status,'approval_required',tool);
  }
  // powerplatform_validate currently exposes READ validation operations only.
  assert.equal(pm.isReadOnlyOperation('powerplatform_validate','premium_check'),true);
  assert.equal(pm.isReadOnlyOperation('powerplatform_validate','unrecognized_write'),false);
});

test('SharePoint REST token audience and minimum read claims are fail-closed',()=>{
  const {validateSharePointTokenClaims:check}=require('../src/sharepointAclReadMock');
  assert.equal(check({aud:'https://hisyoengineer.sharepoint.com',roles:['Sites.Read.All']}).readClaimVerified,true);
  assert.equal(check({aud:'https://hisyoengineer.sharepoint.com',scp:'AllSites.Read'}).principalType,'delegated');
  assert.throws(()=>check({aud:'https://graph.microsoft.com',roles:['Sites.Read.All']}),/token_audience_mismatch/);
  assert.throws(()=>check({aud:'https://hisyoengineer.sharepoint.com',roles:['Sites.ReadWrite.All']}),/token_read_permission_unverified/);
  assert.throws(()=>check({}),/token_audience_mismatch/);
});
test('SharePoint ACL paging must remain on the exact fixed list and origin',()=>{
  const {validateSameOriginNextLink:check}=require('../src/sharepointAclReadMock');
  const valid="https://hisyoengineer.sharepoint.com/sites/cleannano/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')/roleassignments?$skiptoken=abc";
  assert.equal(check(valid),valid);
  assert.throws(()=>check(valid.replace('hisyoengineer.sharepoint.com','evil.example')),/pagination_target_mismatch/);
  assert.throws(()=>check(valid.replace('973f17d6-3566-4795-9712-2386bb7bf540','11111111-1111-1111-1111-111111111111')),/pagination_target_mismatch/);
});
test('SharePoint EditListItems permission bit uses Low bit 3 and rejects malformed masks',()=>{
  const {canEditListItems:check}=require('../src/sharepointAclReadMock');
  assert.equal(check({Low:'8',High:'0'}),true);
  assert.equal(check({Low:'4',High:'0'}),false);
  assert.equal(check({Low:'0',High:'0'}),false);
  assert.throws(()=>check({Low:'not-a-number'}),/permission_mask_invalid/);
  assert.throws(()=>check({Low:'-1'}),/permission_mask_invalid/);
});

test('ACL evidence collects every role assignment page before reporting verified',async()=>{
  const {collectAclEvidence}=require('../src/sharepointAclReadMock');
  const base="https://hisyoengineer.sharepoint.com/sites/cleannano/_api/web/lists(guid'973f17d6-3566-4795-9712-2386bb7bf540')/roleassignments";
  const seen=[];
  const get=async p=>{
    seen.push(p);
    if(p.includes('?$select=')) return {Id:'973f17d6-3566-4795-9712-2386bb7bf540',HasUniqueRoleAssignments:false};
    if(p.includes('$skiptoken=page2')) return {value:[{PrincipalId:2}]};
    return {value:[{PrincipalId:1}],'@odata.nextLink':base+'?$skiptoken=page2'};
  };
  const result=await collectAclEvidence({get});
  assert.equal(result.roleAssignments.length,2);
  assert.equal(seen.length,3);
});
test('ACL evidence fails closed on list GUID mismatch and malformed paging',async()=>{
  const {collectAclEvidence}=require('../src/sharepointAclReadMock');
  await assert.rejects(collectAclEvidence({get:async()=>({Id:'wrong',HasUniqueRoleAssignments:true})}),/inheritance_unverified/);
  const id='973f17d6-3566-4795-9712-2386bb7bf540';
  const list={Id:id,HasUniqueRoleAssignments:true};
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('?$select=')?list:{value:[],'@odata.nextLink':'https://evil.example/'}}),/pagination_target_mismatch/);
  const cycle="https://hisyoengineer.sharepoint.com/sites/cleannano/_api/web/lists(guid'"+id+"')/roleassignments?$skiptoken=same";
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('?$select=')?list:{value:[],'@odata.nextLink':cycle}}),/role_assignments_pagination_cycle/);
  let counter=0;
  await assert.rejects(collectAclEvidence({get:async p=>p.includes('?$select=')?list:{value:[],'@odata.nextLink':"https://hisyoengineer.sharepoint.com/sites/cleannano/_api/web/lists(guid'"+id+"')/roleassignments?$skiptoken="+'unique'+(counter++)}}),/role_assignments_page_limit/);
});
