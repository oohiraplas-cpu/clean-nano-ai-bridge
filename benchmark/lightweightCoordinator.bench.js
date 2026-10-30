'use strict';
// Offline benchmark only. No server start, network calls, secrets or production writes.
// Run: node --expose-gc benchmark/lightweightCoordinator.bench.js
const { performance } = require('node:perf_hooks');
const { LightweightCoordinator } = require('../src/lightweightCoordinator');
const { StateContextRegistry } = require('../src/stateContext');
const crypto = require('node:crypto');
const now = () => performance.now();
const memory = () => Math.round(process.memoryUsage().heapUsed / 1024);
async function measure(label, fn) {
  if (global.gc) global.gc();
  const before = memory(), t = now();
  const result = await fn();
  console.log(JSON.stringify({label,elapsedMs:+(now()-t).toFixed(3),heapDeltaKiB:memory()-before,...result}));
}
(async()=>{
  await measure('state_registry_1000',()=>{
    const reg=new StateContextRegistry({maxEntries:1001});
    for(let i=0;i<1000;i++) reg.begin({appId:'app',environmentId:'env',correlationId:crypto.randomUUID()},'benchmark');
    return {operations:1000};
  });
  await measure('sha_cache_10000',()=>{
    const q=new LightweightCoordinator({authorize:()=>true}),sha='a'.repeat(40);
    for(let i=0;i<10000;i++){q.cacheObservation({key:'key',sha,value:{i}});q.getObservation('key',sha);}
    return {operations:20000};
  });
  await measure('six_lane_dispatch_1000',async()=>{
    const handlers=Object.fromEntries(['powerapps','sharepoint','github','azure','powerautomate','audit'].map(l=>[l,async()=>true]));
    const q=new LightweightCoordinator({authorize:()=>true,handlers,maxPending:1100});
    const ids=Array.from({length:1000},(_,i)=>q.submit({lane:Object.keys(handlers)[i%6],operation:'read',target:String(i)}));
    while(ids.some(id=>['queued','running'].includes(q.status(id).status))) await new Promise(r=>setImmediate(r));
    const blocked=ids.filter(id=>q.status(id).status!=='done').length;
    if(blocked) throw new Error('unexpected blocked jobs: '+blocked);
    return {operations:ids.length,blocked};
  });
})().catch(e=>{console.error(e);process.exitCode=1;});
