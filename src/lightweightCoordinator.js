'use strict';
// Opt-in, dependency-free scheduler. It does not bypass the existing DispatchEngine,
// ApprovalLedger, StateContextRegistry or persistence layer.
const crypto = require('node:crypto');
const LANES = Object.freeze(['powerapps','sharepoint','github','azure','powerautomate','audit']);
const READ_OPERATIONS = new Set(['inspect','read','health','validate','compare','test']);
class LightweightCoordinator {
  constructor({handlers={}, authorize, maxConcurrent=6, maxPending=100, now=Date.now}={}) {
    if(typeof authorize!=='function') throw new Error('authorization callback required');
    if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>6) throw new Error('invalid concurrency');
    this.handlers=handlers; this.authorize=authorize; this.maxConcurrent=maxConcurrent; this.maxPending=maxPending; this.now=now;
    this.pending=[]; this.running=0; this.locks=new Set(); this.jobs=new Map(); this.cache=new Map();
  }
  submit({lane,operation,target,context,approval}={}) {
    if(!LANES.includes(lane)||!READ_OPERATIONS.has(operation)||typeof target!=='string'||!target.trim()) throw new Error('unsupported or unsafe request');
    if(this.pending.length>=this.maxPending) throw new Error('queue full');
    const id=crypto.randomUUID(), job={id,lane,operation,target,status:'queued',createdAt:this.now(),context,approval};
    this.jobs.set(id,job); this.pending.push(job); queueMicrotask(()=>this.drain()); return id;
  }
  status(id) { const j=this.jobs.get(id); return j?{id:j.id,lane:j.lane,operation:j.operation,status:j.status,error:j.error||null}:null; }
  async drain() {
    while(this.running<this.maxConcurrent&&this.pending.length) {
      const idx=this.pending.findIndex(j=>!this.locks.has(j.lane+':'+j.target));
      if(idx<0) return;
      const [job]=this.pending.splice(idx,1), key=job.lane+':'+job.target;
      this.running++; this.locks.add(key); job.status='running';
      void (async()=>{
        try {
          // Authorization is checked at execution time, not merely on enqueue.
          if(await this.authorize(job)!==true) throw new Error('authorization denied');
          const handler=this.handlers[job.lane];
          if(typeof handler!=='function') throw new Error('handler unavailable');
          job.result=await handler({operation:job.operation,target:job.target,context:job.context});
          job.status='done';
        } catch(e) {job.status='blocked';job.error=e instanceof Error?e.message:'execution failed';}
        finally {this.locks.delete(key);this.running--;this.drain();}
      })();
    }
  }
  // Only immutable, source-version-bound observations may be cached; never credentials or ACL.
  cacheObservation({key,sha,value,ttlMs=30000}) {
    if(typeof key!=='string'||!key||!/^[a-f0-9]{40}$/.test(sha)||!Number.isInteger(ttlMs)||ttlMs<1||ttlMs>60000) throw new Error('invalid cache identity');
    this.cache.set(key,{sha,value:structuredClone(value),expires:this.now()+ttlMs});
  }
  getObservation(key,sha) {
    const e=this.cache.get(key);
    if(!e||e.sha!==sha||this.now()>=e.expires) {this.cache.delete(key);return null;}
    return structuredClone(e.value);
  }
}
module.exports={LightweightCoordinator,LANES};
