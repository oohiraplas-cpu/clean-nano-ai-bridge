'use strict';
// Offline comparison: same runner, dependencies and Node version. No Bridge listen/network.
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),src=path.join(root,'src');
const baseline=spawnSync('git',['show','origin/main:src/server.js'],{cwd:root,encoding:'utf8',maxBuffer:2*1024*1024});
if(baseline.status!==0) {console.error('BLOCKED: origin/main source unavailable',baseline.stderr);process.exit(2);}
const temp=path.join(src,'.startup-baseline-'+crypto.randomUUID()+'.cjs');
const probe=`const {performance}=require('node:perf_hooks');if(global.gc)global.gc();const before=process.memoryUsage().heapUsed;const t=performance.now();require(process.argv[1]);const elapsedMs=performance.now()-t;console.log(JSON.stringify({elapsedMs:+elapsedMs.toFixed(3),heapDeltaKiB:Math.round((process.memoryUsage().heapUsed-before)/1024)}));`;
function run(file){const p=spawnSync(process.execPath,['--expose-gc','-e',probe,file],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,NODE_ENV:'test'},maxBuffer:1024*1024});if(p.status!==0)throw Error(p.stderr||p.error?.message||'probe failed');return JSON.parse(p.stdout.trim().split(/\r?\n/).at(-1));}
try {
 fs.writeFileSync(temp,baseline.stdout,{flag:'wx'});
 const a=run(temp),b=run(path.join(src,'server.js'));
 console.log(JSON.stringify({baseline:a,branch:b,deltaMs:+(b.elapsedMs-a.elapsedMs).toFixed(3),deltaHeapKiB:b.heapDeltaKiB-a.heapDeltaKiB,node:process.version}));
}finally{try{fs.unlinkSync(temp)}catch(e){if(e.code!=='ENOENT')throw e}}
