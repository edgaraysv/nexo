import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryVpnCredentialRepository } from '../dist/product/vpn-credential-repository.js';

const TENANT='f7f7f7f7-f7f7-47f7-87f7-f7f7f7f7f7f7';
const DEVICE='88888888-8888-4888-8888-888888888888';
const ENVIRONMENT='99999999-9999-4999-8999-999999999999';
const NODE='77777777-7777-4777-8777-777777777777';

function nodeRepository(){
  let revision=0;
  return {operations:[],async createInternalOperation(input){revision+=1;const operation={id:`00000000-0000-4000-8000-${String(revision).padStart(12,'0')}`,targetNodeId:input.targetNodeId,type:input.type,arguments:input.arguments,idempotencyKey:input.idempotencyKey,expiresAt:input.expiresAt,requestedDeviceId:input.requestedDeviceId,revision,status:'pending'};this.operations.push(operation);return operation;}};
}
const request=(credentials,csr,key)=>credentials.request({tenantId:TENANT,deviceId:DEVICE,environmentId:ENVIRONMENT,csrPem:csr,idempotencyKey:key,expiresAt:Date.now()+60_000});
const issueResult=(serial)=>({serial,certificate_pem:`certificate-${serial}`,ca_certificate_pem:`ca-${serial}`,not_before:new Date().toISOString(),not_after:new Date(Date.now()+3_600_000).toISOString()});

test('F07 credential history permits reissue only after a terminal state',async()=>{
  const nodes=nodeRepository(),credentials=new MemoryVpnCredentialRepository(nodes);credentials.allow(ENVIRONMENT,TENANT,NODE);
  const first=await request(credentials,'csr-one','issue-one');assert.equal(first.state,'pending');
  assert.equal(await credentials.complete(nodes.operations[0],'succeeded',issueResult('1001')),true);
  const issued=await credentials.get(TENANT,DEVICE,ENVIRONMENT);assert.equal(issued.state,'issued');assert.equal(issued.serial,'1001');
  assert.equal((await request(credentials,'csr-one','issue-idempotent')).id,first.id);
  await assert.rejects(()=>request(credentials,'csr-other','issue-conflict'),/credential_conflict/);
  const revoke=await credentials.revoke({tenantId:TENANT,deviceId:DEVICE,environmentId:ENVIRONMENT,serial:'1001',idempotencyKey:'revoke-one',expiresAt:Date.now()+60_000});
  assert.equal(revoke.state,'revocation_pending');
  assert.equal(await credentials.complete(nodes.operations[1],'succeeded',{serial:'1001',revoked:true}),true);
  assert.equal((await credentials.get(TENANT,DEVICE,ENVIRONMENT)).state,'revoked');
  const second=await request(credentials,'csr-two','issue-two');assert.equal(second.state,'pending');assert.notEqual(second.id,first.id);
  assert.equal((await credentials.get(TENANT,DEVICE,ENVIRONMENT)).id,second.id);
  assert.equal(await credentials.complete(nodes.operations[2],'succeeded',issueResult('2002')),true);
  assert.equal((await credentials.get(TENANT,DEVICE,ENVIRONMENT)).serial,'2002');
  assert.equal((await credentials.revoke({tenantId:TENANT,deviceId:DEVICE,environmentId:ENVIRONMENT,serial:'1001',idempotencyKey:'revoke-old',expiresAt:Date.now()+60_000})).state,'revoked');
  assert.equal(await credentials.revoke({tenantId:TENANT,deviceId:DEVICE,environmentId:ENVIRONMENT,serial:'2002',idempotencyKey:'revoke-new',expiresAt:Date.now()+60_000})!==undefined,true);
  assert.equal(nodes.operations.at(-1).arguments.serial,'2002');
});
