'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {LightweightCoordinator,LANES}=require('../src/lightweightCoordinator');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('six lanes and fail-closed defaults',async()=>{
 assert.equal(LANES.length,6);
 assert.throws(()=>new LightweightCoordinator(),/authorization/);
 const q=new LightweightCoordinator({authorize:async()=>false,handlers:{github:async()=>42}});
 assert.throws(()=>q.submit({lane:'github',operation:'publish',target:'main'}),/unsafe/);
 const id=q.submit({lane:'github',operation:'read',target:'a'});await settle();
 assert.equal(q.status(id).status,'blocked');
});
test('read work executes and same target is serialized',async()=>{
 let active=0,peak=0;
 const q=new LightweightCoordinator({authorize:async()=>true,handlers:{github:async()=>{active++;peak=Math.max(peak,active);await settle();active--;return true;}}});
 const a=q.submit({lane:'github',operation:'read',target:'same'});
 const b=q.submit({lane:'github',operation:'read',target:'same'});
 await new Promise(resolve=>setTimeout(resolve,30));
 assert.equal(q.status(a).status,'done');assert.equal(q.status(b).status,'done');assert.equal(peak,1);
});
test('version bound cache expires and returns copies',()=>{
 let t=0;const q=new LightweightCoordinator({authorize:()=>true,now:()=>t});
 const sha='a'.repeat(40);q.cacheObservation({key:'x',sha,value:{n:1},ttlMs:5});
 const x=q.getObservation('x',sha);x.n=2;
 assert.equal(q.getObservation('x',sha).n,1);
 assert.equal(q.getObservation('x','b'.repeat(40)),null);
 q.cacheObservation({key:'x',sha,value:1,ttlMs:5});t=6;assert.equal(q.getObservation('x',sha),null);
});
