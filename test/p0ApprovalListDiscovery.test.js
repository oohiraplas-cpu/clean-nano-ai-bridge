'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {discoverApprovalLedger}=require('../src/p0ApprovalListDiscovery');
const list=(lists,hasMore=false)=>({listLists:async()=>({status:'ok',siteId:'site',hasMore,lists})});
test('missing site blocks before read',async()=>assert.equal((await discoverApprovalLedger({reader:list([])})).reason,'site_or_reader_not_configured'));
test('partial list enumeration blocks',async()=>assert.equal((await discoverApprovalLedger({reader:list([{id:'1',displayName:'承認台帳'}],true),siteId:'site'})).reason,'list_discovery_incomplete'));
test('ambiguous approval lists block',async()=>assert.equal((await discoverApprovalLedger({reader:list([{id:'1',displayName:'承認台帳'},{id:'2',displayName:'承認履歴'}]),siteId:'site'})).reason,'ambiguous_approval_lists'));
test('one list only discovers id; columns remain unverified',async()=>{const r=await discoverApprovalLedger({reader:list([{id:'1',displayName:'承認台帳'}]),siteId:'site'});assert.equal(r.status,'DISCOVERED');assert.equal(r.listId,'1');assert.equal(r.internalColumnsVerified,false);});
test('no match blocks',async()=>assert.equal((await discoverApprovalLedger({reader:list([{id:'1',displayName:'社員台帳'}]),siteId:'site'})).reason,'approval_list_not_found'));
