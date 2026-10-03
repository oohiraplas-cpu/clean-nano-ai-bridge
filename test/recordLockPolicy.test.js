'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {authorize, proposedAmendment} = require('../src/recordLockPolicy');
const draft = {id:'1',version:1,state:'draft',ownerId:'u'};
const final = {...draft,state:'final'};
const user = {id:'u',authenticated:true,canRead:true};
const approval = {approved:true,recordId:'1',recordVersion:1,approvedBy:'manager',reason:'correction',requestId:'req'};
test('draft owner can edit but finalized record cannot',()=>{
 assert.equal(authorize(draft,'edit',user),true);
 assert.equal(authorize(final,'edit',{...user,canEditDraft:true}),false);
});
test('read requires authentication and reading permission',()=>{
 assert.equal(authorize(final,'read',user),true);
 assert.equal(authorize(final,'read',{...user,authenticated:false}),false);
});
test('only matching human approval permits proposed new version',()=>{
 const manager={id:'manager',authenticated:true,isHumanApprover:true};
 assert.equal(authorize(final,'amend',{...manager,humanApproval:approval}),true);
 assert.equal(authorize(final,'amend',{...manager,isHumanApprover:false,humanApproval:approval}),false);
 assert.equal(authorize(final,'amend',{...manager,humanApproval:{...approval,recordVersion:2}}),false);
 const proposal=proposedAmendment(final,approval,manager);
 assert.equal(proposal.proposedVersion,2);
 assert.equal(final.state,'final');
});
