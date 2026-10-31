import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryDeviceRepository } from '../dist/product/device-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { MemorySupportRepository } from '../dist/product/support-repository.js';
import { SupportTransportError, SyntheticSupportTransport, withSupportTransportDeadline } from '../dist/product/support-transport.js';
import { hashOpaqueToken, hashPassword } from '../dist/product/security.js';

const TENANT='a1010101-0101-4101-8101-010101010101';
const ADMIN='a2020202-0202-4202-8202-020202020202';
const TECH='a3030303-0303-4303-8303-030303030303';
const AUDITOR='a4040404-0404-4404-8404-040404040404';
const MFA_SECRET='JBSWY3DPEHPK3PXP';
const PASSWORD='correct horse battery staple';

test('F10 transport deadline bounds adapters that do not settle after abort',async()=>{
  const started=performance.now();
  await assert.rejects(()=>withSupportTransportDeadline(()=>new Promise(()=>{}),25),error=>error.code==='transport_timeout');
  assert.ok(performance.now()-started<500);
});

function totp(){const payload=Buffer.alloc(8);payload.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(payload).digest();const offset=digest.at(-1)&15;return String((((digest[offset]&127)<<24)|(digest[offset+1]<<16)|(digest[offset+2]<<8)|digest[offset+3])%1_000_000).padStart(6,'0');}

async function setup({entitled=true,transport}={}){
  const passwordHash=await hashPassword(PASSWORD);
  const members=[
    {id:ADMIN,email:'admin-f10@example.test',role:'company.admin'},
    {id:TECH,email:'tech-f10@example.test',role:'company.technician'},
    {id:AUDITOR,email:'audit-f10@example.test',role:'company.auditor'},
  ];
  const identity=new MemoryIdentityRepository(members.map(member=>({id:member.id,email:member.email,passwordHash,status:'active',mfaRequired:true,totpSecret:MFA_SECRET,memberships:[{tenantId:TENANT,tenantName:'F10 Synthetic',roles:[member.role]}]})));
  const company=new MemoryCompanyRepository({[TENANT]:members.map(member=>({userId:member.id,email:member.email,status:'active',roles:[member.role]}))},entitled?new Set([TENANT]):new Set());
  const devices=new MemoryDeviceRepository(),support=new MemorySupportRepository(transport,{allowSyntheticTestTransport:true});
  const app=await createProductApplication(identity,undefined,undefined,company,undefined,devices,undefined,undefined,undefined,undefined,undefined,undefined,{privateNetworksEnabled:true},support);
  await app.init();await app.getHttpAdapter().getInstance().ready();
  const endpoint=await createEndpoint(devices);
  const deviceGrant=await company.createResourceGrant(TENANT,{userId:TECH,resourceType:'device_identity',resourceId:endpoint.id,permission:'company.support.start'},ADMIN);
  return{app,company,devices,support,endpoint,deviceGrant,transport};
}

async function createEndpoint(devices){
  const invitation=randomUUID(),challenge=randomUUID(),claim=randomUUID(),sessionToken=randomUUID(),authChallenge=randomUUID();
  const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}).toString(),tokenHash=hashOpaqueToken(invitation),keyFingerprint=randomUUID(),serial=`F10-${randomUUID()}`;
  await devices.createInvitation(TENANT,{deviceKind:'endpoint',tokenHash,uses:1,expiresAt:Date.now()+60_000},ADMIN);
  const enrollment=await devices.beginEnrollment({tokenHash,name:'Endpoint sintético',audience:'endpoint',publicKeyPem,keyFingerprint,claimTokenHash:hashOpaqueToken(claim),challengeHash:hashOpaqueToken(challenge),challengeExpiresAt:Date.now()+60_000});
  assert.ok(enrollment);
  assert.equal(await devices.markEnrollmentProof(enrollment.deviceId,hashOpaqueToken(challenge)),true);
  const certificate={serial,certificatePem:'synthetic-certificate-only',notBefore:new Date(Date.now()-1000).toISOString(),notAfter:new Date(Date.now()+3600_000).toISOString()};
  assert.equal(await devices.approve(TENANT,enrollment.deviceId,certificate,ADMIN),true);
  assert.ok(await devices.createAuthenticationChallenge({deviceId:enrollment.deviceId,serial,certificatePem:certificate.certificatePem,challengeHash:hashOpaqueToken(authChallenge),expiresAt:Date.now()+60_000}));
  assert.ok(await devices.getAuthenticationProof({deviceId:enrollment.deviceId,serial,challengeHash:hashOpaqueToken(authChallenge)}));
  assert.equal(await devices.completeAuthentication({deviceId:enrollment.deviceId,serial,challengeHash:hashOpaqueToken(authChallenge),sessionTokenHash:hashOpaqueToken(sessionToken),sessionExpiresAt:Date.now()+60*60_000}),true);
  return{id:enrollment.deviceId,headers:{authorization:`Bearer ${sessionToken}`}};
}

async function createPendingEndpoint(devices){
  const invitation=randomUUID(),challenge=randomUUID(),claim=randomUUID(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKeyPem=pair.publicKey.export({type:'spki',format:'pem'}).toString(),tokenHash=hashOpaqueToken(invitation);
  await devices.createInvitation(TENANT,{deviceKind:'endpoint',tokenHash,uses:1,expiresAt:Date.now()+60_000},ADMIN);
  const enrollment=await devices.beginEnrollment({tokenHash,name:'Endpoint pendiente',audience:'endpoint',publicKeyPem,keyFingerprint:randomUUID(),claimTokenHash:hashOpaqueToken(claim),challengeHash:hashOpaqueToken(challenge),challengeExpiresAt:Date.now()+60_000});
  assert.ok(enrollment);
  return enrollment.deviceId;
}

async function companyToken(app,email,tenantId=TENANT){
  const login=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email,password:PASSWORD}});
  assert.equal(login.statusCode,200);
  const mfa=await app.inject({method:'POST',url:'/v1/auth/mfa',payload:{challenge:login.json().challenge,code:totp()}});
  assert.equal(mfa.statusCode,200);
  const selected=await app.inject({method:'POST',url:'/v1/session/select',payload:{selection:mfa.json().selection,scope_kind:'tenant',tenant_id:tenantId}});
  assert.equal(selected.statusCode,200);
  return{authorization:`Bearer ${selected.json().token}`};
}

async function requestSession(app,headers,deviceId,extra={}){
  return app.inject({method:'POST',url:'/v1/company/support/sessions',headers,payload:{device_id:deviceId,mode:'assisted',capabilities:['screen','terminal'],...extra}});
}

async function consentNonce(app,endpoint,sessionId){
  const pending=await app.inject({method:'GET',url:'/v1/device/support/sessions/pending',headers:endpoint.headers});
  assert.equal(pending.statusCode,200,pending.body);
  const item=pending.json().items.find(value=>value.id===sessionId);
  assert.ok(item?.consent_nonce,'pending endpoint must receive a one-use nonce');
  return item.consent_nonce;
}

async function decide(app,endpoint,sessionId,decision,nonce){
  return app.inject({method:'POST',url:`/v1/device/support/sessions/${sessionId}/consent`,headers:endpoint.headers,payload:{decision,consent_nonce:nonce}});
}

test('F10 creates an assisted request only with role, per-device grant, module entitlement and approved endpoint',async()=>{
  const{app,company,devices,endpoint}=await setup();
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),admin=await companyToken(app,'admin-f10@example.test'),auditor=await companyToken(app,'audit-f10@example.test');
    const created=await requestSession(app,tech,endpoint.id);
    assert.equal(created.statusCode,201,created.body);
    assert.equal(created.json().mode,'assisted');
    assert.equal(created.json().status,'pending_consent');
    assert.equal(created.json().consent.status,'pending');
    assert.equal(created.json().consent.requested_at,created.json().requested_at);
    assert.equal((await requestSession(app,tech,randomUUID())).statusCode,403,'ungranted device must fail closed');
    assert.equal((await requestSession(app,auditor,endpoint.id)).statusCode,403,'auditor role cannot start support');
    assert.equal((await requestSession(app,tech,endpoint.id,{mode:'unattended'})).statusCode,422,'unattended mode is not enabled');
    assert.equal((await requestSession(app,tech,endpoint.id,{capabilities:['screen','shell']})).statusCode,422,'unknown capabilities are rejected');
    assert.equal((await requestSession(app,admin,endpoint.id)).statusCode,403,'admin needs a resource grant too');
    const pendingDevice=await createPendingEndpoint(devices);
    await company.createResourceGrant(TENANT,{userId:TECH,resourceType:'device_identity',resourceId:pendingDevice,permission:'company.support.start'},ADMIN);
    assert.equal((await requestSession(app,tech,pendingDevice)).statusCode,409,'pending endpoint must not receive a support request');
    const currentGrant=(await company.listResourceGrants(TENANT)).find(grant=>grant.resourceId===endpoint.id&&grant.permission==='company.support.start');
    assert.ok(currentGrant);
    await company.revokeResourceGrant(TENANT,currentGrant.id,ADMIN);
    await company.createResourceGrant(TENANT,{userId:TECH,resourceType:'device_identity',resourceId:endpoint.id,permission:'company.support.start',validFrom:new Date(Date.now()-120_000).toISOString(),validUntil:new Date(Date.now()-60_000).toISOString()},ADMIN);
    assert.equal((await requestSession(app,tech,endpoint.id)).statusCode,403,'expired device grant must fail closed');
  }finally{await app.close();}
});

test('F10 endpoint consent gates transport authorization; requester revocation blocks it immediately',async()=>{
  const{app,devices,endpoint}=await setup();
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal(created.statusCode,201,created.body);
    const otherEndpoint=await createEndpoint(devices);
    assert.equal((await app.inject({method:'POST',url:`/v1/device/support/sessions/${created.json().id}/consent`,headers:otherEndpoint.headers,payload:{decision:'accepted',consent_nonce:randomUUID()}})).statusCode,404,'consent is bound to the requested endpoint');
    const nonce=await consentNonce(app,endpoint,created.json().id);
    const before=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}});
    assert.equal(before.statusCode,409);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',nonce)).statusCode,204);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',nonce)).statusCode,409,'consent response cannot be replayed');
    const authorized=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}});
    assert.equal(authorized.statusCode,200,authorized.body);assert.equal(authorized.json().authorized,true);assert.equal(authorized.json().transport_started,false);assert.equal(authorized.json().session.status,'consented');
    const start=performance.now(),revoked=await app.inject({method:'DELETE',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech}),elapsed=performance.now()-start;
    assert.equal(revoked.statusCode,204);assert.ok(elapsed<5000,`local state revocation took ${elapsed} ms`);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,409);
    assert.equal((await app.inject({method:'GET',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).json().status,'revoked');

    const second=await requestSession(app,tech,endpoint.id);
    assert.equal(second.statusCode,201,second.body);
    assert.equal((await decide(app,endpoint,second.json().id,'accepted',await consentNonce(app,endpoint,second.json().id))).statusCode,204);
    assert.equal((await app.inject({method:'POST',url:`/v1/device/support/sessions/${second.json().id}/revoke`,headers:endpoint.headers})).statusCode,204);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${second.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,409);
  }finally{await app.close();}
});

test('F10 rejection and consent timeout never authorize transport',async()=>{
  const{app,endpoint}=await setup();
  try{
    const tech=await companyToken(app,'tech-f10@example.test');
    const rejected=await requestSession(app,tech,endpoint.id),rejectResult=await decide(app,endpoint,rejected.json().id,'rejected',await consentNonce(app,endpoint,rejected.json().id));
    assert.equal(rejectResult.statusCode,204);
    assert.equal((await app.inject({method:'GET',url:`/v1/company/support/sessions/${rejected.json().id}`,headers:tech})).json().status,'rejected');
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${rejected.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,409);

    const timed=await requestSession(app,tech,endpoint.id,{consent_timeout_seconds:1});
    assert.equal(timed.statusCode,201,timed.body);
    const timedNonce=await consentNonce(app,endpoint,timed.json().id);
    await new Promise(resolve=>setTimeout(resolve,1100));
    const late=await decide(app,endpoint,timed.json().id,'accepted',timedNonce);
    assert.equal(late.statusCode,409);
    const timedStatus=(await app.inject({method:'GET',url:`/v1/company/support/sessions/${timed.json().id}`,headers:tech})).json();
    assert.equal(timedStatus.status,'rejected');assert.equal(timedStatus.consent.status,'rejected');assert.equal(timedStatus.consent.decision_origin,'timeout');
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${timed.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,409);
  }finally{await app.close();}
});

test('F10 transport gate rechecks module, grant and endpoint status after consent',async()=>{
  const{app,company,devices,endpoint,deviceGrant}=await setup();
  try{
    const tech=await companyToken(app,'tech-f10@example.test');
    const created=await requestSession(app,tech,endpoint.id);
    assert.equal(created.statusCode,201,created.body);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    await company.revokeResourceGrant(TENANT,deviceGrant.id,ADMIN);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,403);
    await company.createResourceGrant(TENANT,{userId:TECH,resourceType:'device_identity',resourceId:endpoint.id,permission:'company.support.start'},ADMIN);
    company.supportEntitledTenants.delete(TENANT);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,403);
    company.supportEntitledTenants.add(TENANT);
    assert.equal(await devices.revoke(TENANT,endpoint.id,ADMIN),true);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/transport-authorization`,headers:tech,payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:`/v1/device/support/sessions/${created.json().id}/revoke`,headers:endpoint.headers})).statusCode,401,'revoked endpoint session cannot withdraw or act');
  }finally{await app.close();}
});

test('F10 module entitlement is mandatory before a request can be created',async()=>{
  const{app,endpoint}=await setup({entitled:false});
  try{
    const tech=await companyToken(app,'tech-f10@example.test');
    const result=await requestSession(app,tech,endpoint.id);
    assert.equal(result.statusCode,403);
  }finally{await app.close();}
});

test('F10 retries a definite synthetic open failure with the same accepted consent and terminates within five seconds on revocation',async()=>{
  const transport=new SyntheticSupportTransport({openBeforeCreation:1}),{app,endpoint}=await setup({transport});
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    const nonce=await consentNonce(app,endpoint,created.json().id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',nonce)).statusCode,204);
    const opened=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(opened.statusCode,200,opened.body);
    assert.equal(opened.json().status,'opened');
    assert.equal(opened.json().session.status,'active');
    assert.equal(Object.hasOwn(opened.json().session,'engine_session_id'),false,'transport identifiers are not exposed through the API');
    assert.equal(opened.json().session.open_attempts,2);
    assert.equal(transport.openCalls,2);
    assert.equal(transport.sessions.size,1,'retries use one stable idempotency key');

    const started=performance.now(),revoked=await app.inject({method:'DELETE',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech}),elapsed=performance.now()-started;
    assert.equal(revoked.statusCode,204);
    assert.ok(elapsed<5000,`synthetic termination took ${elapsed} ms`);
    const current=(await app.inject({method:'GET',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).json();
    assert.equal(current.status,'revoked');
    assert.equal(current.termination_status,'confirmed');
    assert.equal(current.consent.status,'accepted','session revocation does not rewrite consent history');
    assert.ok(current.consent.accepted_at);
    assert.equal(transport.terminateCalls,1);
    assert.equal(transport.sessions.size,0);
  }finally{await app.close();}
});

test('F10 reconciles an ambiguous open acknowledgement before retrying and exposes bounded open_failed',async()=>{
  const transport=new SyntheticSupportTransport({openAfterCreation:1}),{app,endpoint}=await setup({transport});
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    const opened=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(opened.statusCode,200,opened.body);
    assert.equal(opened.json().session.status,'active');
    assert.equal(opened.json().session.open_attempts,1);
    assert.equal(transport.sessions.size,1,'ambiguous result is reconciled, not opened a second time');
  }finally{await app.close();}

  const failingTransport=new SyntheticSupportTransport({openBeforeCreation:3}),failing=await setup({transport:failingTransport});
  try{
    const tech=await companyToken(failing.app,'tech-f10@example.test'),created=await requestSession(failing.app,tech,failing.endpoint.id);
    assert.equal((await decide(failing.app,failing.endpoint,created.json().id,'accepted',await consentNonce(failing.app,failing.endpoint,created.json().id))).statusCode,204);
    const failed=await failing.app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(failed.statusCode,200,failed.body);
    assert.equal(failed.json().status,'open_failed');
    assert.equal(failed.json().session.open_attempts,3);
    assert.deepEqual(failingTransport.sessions.size,0);
    const repeated=await failing.app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(repeated.json().session.open_attempts,3,'exhausted retries require a new request and consent');
  }finally{await failing.app.close();}
});

test('F10 keeps an unresolved open outcome unknown and blocks blind retries',async()=>{
  const transport={kind:'synthetic_test',openCalls:0,async open(){this.openCalls+=1;throw new Error('ambiguous timeout');},async findByIdempotencyKey(){return{status:'pending'};},async terminate(){}};
  const{app,endpoint}=await setup({transport});
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    const opened=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(opened.statusCode,200,opened.body);
    assert.equal(opened.json().status,'opening_unknown');
    assert.equal(opened.json().session.open_attempts,1);
    const retry=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(retry.json().status,'opening_unknown');
    assert.equal(transport.openCalls,1,'unresolved outcomes never trigger a blind second open');
  }finally{await app.close();}
});

test('F10 does not overwrite a concurrent revocation when open later fails definitively',async()=>{
  let startedResolve,rejectOpen;
  const started=new Promise(resolve=>{startedResolve=resolve;});
  const openPromise=new Promise((_resolve,reject)=>{rejectOpen=reject;});
  const transport={kind:'synthetic_test',openCalls:0,async open(){this.openCalls+=1;startedResolve();return openPromise;},async findByIdempotencyKey(){return{status:'not_found'};},async terminate(){}};
  const{app,endpoint}=await setup({transport});
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    const opening=app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    await started;
    assert.equal((await app.inject({method:'DELETE',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).statusCode,204);
    rejectOpen(new SupportTransportError('synthetic_open_unavailable','not_opened'));
    const result=await opening;
    assert.equal(result.statusCode,200,result.body);
    assert.equal(result.json().session.status,'revoked');
    assert.equal(result.json().session.termination_status,'confirmed');
    assert.equal(transport.openCalls,1);
  }finally{await app.close();}
});

test('F10 requires explicit test opt-in for the synthetic motor and leaves the default API transport disabled',async()=>{
  assert.throws(()=>new MemorySupportRepository(new SyntheticSupportTransport()),/synthetic_support_transport_requires_test_opt_in/u);
  const{app,endpoint}=await setup();
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    const opened=await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}});
    assert.equal(opened.statusCode,503);
    assert.equal(opened.json().error,'support_transport_disabled');
    assert.equal((await app.inject({method:'GET',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).json().status,'consented');
  }finally{await app.close();}
});

test('F10 durable termination retry remains fail-closed when the synthetic motor initially fails',async()=>{
  const transport=new SyntheticSupportTransport({terminate:1}),{app,endpoint,support}=await setup({transport});
  try{
    const tech=await companyToken(app,'tech-f10@example.test'),created=await requestSession(app,tech,endpoint.id);
    assert.equal((await decide(app,endpoint,created.json().id,'accepted',await consentNonce(app,endpoint,created.json().id))).statusCode,204);
    assert.equal((await app.inject({method:'POST',url:`/v1/company/support/sessions/${created.json().id}/open`,headers:tech,payload:{}})).json().session.status,'active');
    assert.equal((await app.inject({method:'DELETE',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).statusCode,204);
    const failed=(await app.inject({method:'GET',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).json();
    assert.equal(failed.status,'revoked');assert.equal(failed.termination_status,'failed');
    assert.equal(await support.dispatchTerminationOutbox('synthetic-test-worker',10),1);
    const confirmed=(await app.inject({method:'GET',url:`/v1/company/support/sessions/${created.json().id}`,headers:tech})).json();
    assert.equal(confirmed.termination_status,'confirmed');assert.equal(transport.sessions.size,0);
    assert.equal(transport.terminateCalls,2);
  }finally{await app.close();}
});
