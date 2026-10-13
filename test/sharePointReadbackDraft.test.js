'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createSharePointReadback}=require('../src/sharePointReadbackDraft');
const plan={operation:'update_item',siteId:'s',listId:'l',itemId:'1',params:{fields:{Title:'A'}}};
test('update readback requires exact fields',async()=>{
 const yes=createSharePointReadback({getItemFields:async()=>({Title:'A'})});
 const no=createSharePointReadback({getItemFields:async()=>({Title:'B'})});
 assert.equal(await yes({plan,result:{itemId:'1'}}),true);
 assert.equal(await no({plan,result:{itemId:'1'}}),false);
});
test('column readback denies incomplete pages',async()=>{
 const col={...plan,operation:'create_column',params:{name:'NewCol',displayName:'New Column',columnDefinition:{name:'NewCol',displayName:'New Column',text:{}}}};
 const check=createSharePointReadback({getColumns:async()=>({value:[{id:'2',name:'NewCol',displayName:'New Column',text:{}}],'@odata.nextLink':'next'})});
 assert.equal(await check({plan:col,result:{id:'2'}}),false);
});
test('missing readback adapter denies',async()=>{
 assert.equal(await createSharePointReadback(null)({plan,result:{}}),false);
});
