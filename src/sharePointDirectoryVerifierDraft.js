'use strict';
// Draft-only independent directory verifier. No Graph credentials or permissions are added.
// Both allowlist and directory lookup must be supplied by trusted server configuration.
const OBJECT_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function createDirectoryHumanVerifier({allowedObjectIds,fetchDirectoryUser}={}){
  if(!Array.isArray(allowedObjectIds)||allowedObjectIds.length===0||
     allowedObjectIds.some(id=>typeof id!=='string'||!OBJECT_ID.test(id))||
     typeof fetchDirectoryUser!=='function') throw Error('DIRECTORY_VERIFIER_NOT_CONFIGURED');
  const allowed=new Set(allowedObjectIds.map(id=>id.toLowerCase()));
  return async function verifyDirectoryHuman(approverId){
    if(typeof approverId!=='string'||!OBJECT_ID.test(approverId)||!allowed.has(approverId.toLowerCase())) return false;
    try{
      const user=await fetchDirectoryUser(approverId);
      return Boolean(user&&typeof user.id==='string'&&user.id.toLowerCase()===approverId.toLowerCase()&&user.accountEnabled===true);
    }catch{return false;}
  };
}
module.exports={createDirectoryHumanVerifier};
