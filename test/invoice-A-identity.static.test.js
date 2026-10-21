'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
function authorize({identity,member,partner,roster}){
 if(!identity?.verified||!identity.objectId||!member?.verified||member.objectId!==identity.objectId||!member.partnerKey||member.partnerKey!==partner?.key||partner.type!=='協力会社'||partner.active!==true||partner.status!=='Confirmed'||!Array.isArray(roster)||roster.length<1)return false;
 return roster.every(x=>x.partnerKey===partner.key&&x.active===true&&!!x.objectId)&&roster.some(x=>x.objectId===identity.objectId);
}
const base={identity:{verified:true,objectId:'u1'},member:{verified:true,objectId:'u1',partnerKey:'p1'},partner:{key:'p1',type:'協力会社',active:true,status:'Confirmed'},roster:[{objectId:'u1',partnerKey:'p1',active:true}]};
test('A verified active member accepted',()=>assert.equal(authorize(base),true));
test('A cross-partner membership denied',()=>assert.equal(authorize({...base,member:{...base.member,partnerKey:'p2'}}),false));
test('A unverified identity denied',()=>assert.equal(authorize({...base,identity:{...base.identity,verified:false}}),false));
test('A foreign roster denied',()=>assert.equal(authorize({...base,roster:[{objectId:'u1',partnerKey:'p2',active:true}]}),false));
test('A missing roster denied',()=>assert.equal(authorize({...base,roster:[]}),false));
