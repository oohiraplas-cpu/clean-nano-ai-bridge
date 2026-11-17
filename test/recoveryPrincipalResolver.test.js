'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRecoveryPrincipalResolver}=require('../src/recoveryPrincipalResolver');
const env={
 RECOVERY_ENTRA_TENANT_ID:'11111111-1111-4111-8111-111111111111',
 RECOVERY_ENTRA_CLIENT_ID:'22222222-2222-4222-8222-222222222222',
 RECOVERY_ENTRA_AUDIENCE:'33333333-3333-4333-8333-333333333333',
 RECOVERY_ENTRA_USER_ID:'44444444-4444-4444-8444-444444444444',
 RECOVERY_MCP_ORIGIN:'https://example.invalid'
};
test('missing trusted middleware context blocks identity resolution',async()=>{
 const resolver=createRecoveryPrincipalResolver(env);
 assert.equal(await resolver.resolveVerifiedPrincipal({bearerToken:'fake.token.signature'}),null);
 assert.equal(await resolver.resolveVerifiedPrincipal(null),null);
});
test('spoofed bearer payload never produces verified principal',async()=>{
 const resolver=createRecoveryPrincipalResolver(env,async()=>{throw Error('NO_NETWORK')});
 assert.equal(await resolver.resolveVerifiedPrincipal({trustedMiddleware:true,bearerToken:'fake.token.signature'}),null);
});
test('missing Entra settings prevents resolver creation',()=>{
 assert.equal(createRecoveryPrincipalResolver({}),null);
});
