'use strict';
const base = process.env.MCP_BASE_URL;
const key = process.env.CN_MCP_API_KEY;
if (!base || !/^https:\/\//.test(base) || !key) { console.error('BLOCKED: missing URL or secret'); process.exit(1); }
const rows = [];
const rpc = (method, id) => ({jsonrpc:'2.0',id,method,params:method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'prod-smoke',version:'1'}}:{}});
async function probe(label, path, method='GET', body=null, authenticated=false, check=()=>true) {
  let status=null, ok=false, detail=''; let data=null;
  try {
    const headers={'Accept':'application/json, text/event-stream'};
    if (body) headers['Content-Type']='application/json';
    if (authenticated) headers['X-API-Key']=key;
    const response=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    status=response.status;
    const raw=await response.text();
    try { data=JSON.parse(raw); } catch {
      const event=raw.split('\n').find(s=>s.startsWith('data:'));
      if(event) try {data=JSON.parse(event.slice(5).trim());}catch {}
    }
    ok=check(status,data);
    detail=ok?'expected_response':'unexpected_response';
  } catch(e) {detail=e?.name==='TimeoutError'?'timeout':'network_error';}
  rows.push({step:label,httpStatus:status,result:ok?'PASS':'FAIL',detail});
  return data;
}
const success=(s,d)=>s===200 && !!d?.result && !d?.error;
(async()=>{
 await probe('1 GET /health','/health','GET',null,false,s=>s===200);
 await probe('2 GET /ready','/ready','GET',null,false,s=>s===200);
 await probe('3 GET /version','/version','GET',null,false,s=>s===200);
 await probe('4 unauth POST /mcp','/mcp','POST',rpc('initialize',1),false,s=>s===401);
 await probe('5 initialize','/mcp','POST',rpc('initialize',2),true,success);
 const tools=await probe('6 tools/list','/mcp','POST',rpc('tools/list',3),true,(s,d)=>success(s,d)&&Array.isArray(d.result.tools));
 await probe('7 resources/list','/mcp','POST',rpc('resources/list',4),true,(s,d)=>success(s,d)&&Array.isArray(d.result.resources));
 await probe('8 resources/templates/list','/mcp','POST',rpc('resources/templates/list',5),true,(s,d)=>success(s,d)&&Array.isArray(d.result.resourceTemplates));
 const count=tools?.result?.tools?.length ?? null;
 rows.push({step:'9 exactly 12 tools',httpStatus:rows[5].httpStatus,result:count===12?'PASS':'FAIL',detail:count===null?'count_unavailable':'tool_count='+count});
 for(const row of rows) console.log(JSON.stringify(row));
 if(rows.some(r=>r.result!=='PASS')) process.exitCode=1;
 else console.log('PRODUCTION MCP VERIFIED');
})().catch(()=>{console.error('smoke_runner_failed');process.exitCode=1;});
