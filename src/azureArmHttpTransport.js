'use strict';
// Opt-in Azure ARM GET transport. No credential discovery or production configuration changes.
// An authorized host must inject getToken and fetchImpl; never log tokens or response bodies.
function createArmHttpTransport({getToken,fetchImpl,subscriptionId,timeoutMs=10000}={}) {
  if(typeof getToken!=='function'||typeof fetchImpl!=='function'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(subscriptionId||'')) throw new TypeError('arm_transport_unconfigured');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000) throw new TypeError('arm_timeout_invalid');
  const prefix='/subscriptions/'+subscriptionId+'/';
  return async function armGet(path) {
    if(typeof path!=='string'||!path.startsWith(prefix)||/[\\\r\n%#]/.test(path)) throw new Error('arm_path_rejected');
    const url=new URL(path,'https://management.azure.com');
    if(url.hostname!=='management.azure.com'||url.protocol!=='https:'||!url.pathname.startsWith(prefix)||url.searchParams.get('api-version')!=='2023-12-01'||[...url.searchParams.keys()].some(k=>k!=='api-version')) throw new Error('arm_path_rejected');
    if(!(/^\/subscriptions\/[^/]+\/providers\/Microsoft\.Web\/sites$/.test(url.pathname)||/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Web\/sites\/clean-nano-ai-bridge\/deployments$/.test(url.pathname))) throw new Error('arm_path_rejected');
    let token;
    try {token=await getToken('https://management.azure.com/.default');}catch{throw new Error('arm_auth_unavailable');}
    if(typeof token!=='string'||!/^[A-Za-z0-9._~+\/-]+$/.test(token)) throw new Error('arm_auth_unavailable');
    let response;
    try {response=await fetchImpl(url.toString(),{method:'GET',headers:{Authorization:'Bearer '+token,Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(timeoutMs)});}catch{throw new Error('arm_read_unavailable');}
    if(!response||response.ok!==true) throw new Error('arm_read_unavailable');
    let data;
    try {data=await response.json();}catch{throw new Error('arm_invalid_response');}
    if(!data||typeof data!=='object'||Array.isArray(data)) throw new Error('arm_invalid_response');
    return data;
  };
}
module.exports={createArmHttpTransport};
