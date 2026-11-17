'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createRecoveryAuth}=require('../src/recoveryOAuth');
const env={
 RECOVERY_ENTRA_TENANT_ID:'11111111-1111-4111-8111-111111111111',
 RECOVERY_ENTRA_CLIENT_ID:'22222222-2222-4222-8222-222222222222',
 RECOVERY_ENTRA_AUDIENCE:'33333333-3333-4333-8333-333333333333',
 RECOVERY_ENTRA_USER_ID:'44444444-4444-4444-8444-444444444444',
 RECOVERY_MCP_ORIGIN:'https://example.invalid'
};
test('existing Entra verifier never creates principal for unsigned token',async()=>{
 const auth=createRecoveryAuth(env,async()=>{throw Error('NO_NETWORK')});
 assert.equal(typeof auth.verifiedPrincipal,'function');
 assert.equal(await auth.verifiedPrincipal('fake.token.signature'),null);
 assert.equal(await auth.verifiedPrincipal(''),null);
});
test('invalid recovery auth configuration fails closed',()=>{
 assert.equal(createRecoveryAuth({...env,RECOVERY_ENTRA_TENANT_ID:'bad'}),null);
});
