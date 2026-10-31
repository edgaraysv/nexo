import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrationProfile } from './migration-test-support.mjs';
import { PostgresCompanyRepository } from '../dist/product/postgres-company-repository.js';
import { PostgresNodeRepository } from '../dist/product/postgres-node-repository.js';
import { PostgresOperationRepository } from '../dist/product/postgres-operation-repository.js';
import { PostgresProviderRepository } from '../dist/product/postgres-provider-repository.js';
import { PostgresVpnEnvironmentRepository } from '../dist/product/postgres-vpn-environment-repository.js';

const container=`nexo-f09-${randomUUID().slice(0,8)}`,image=process.env.F09_POSTGRES_IMAGE??'postgres:17.6-bookworm';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa91',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb92';
const OWNER='11111111-1111-4111-8111-111111111191',OP='22222222-2222-4222-8222-222222222292',AUDITOR='33333333-3333-4333-8333-333333333393';
const DEVICE='44444444-4444-4444-8444-444444444494',INVITATION='55555555-5555-4555-8555-555555555595';
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',...options});if(result.status!==0)throw Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
function psql(input){return run('docker',['exec','-i',container,'psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo'],{input});}

try{
  run('docker',['image','inspect',image]);
  run('docker',['run','--rm','-d','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=f09-fixture-password','-e','POSTGRES_DB=nexo',image]);
  let ready=false;
  for(let i=0;i<50;i++){
    if(spawnSync('docker',['exec',container,'psql','-X','-U','postgres','-d','nexo','-c','SELECT 1']).status===0){ready=true;break;}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
  }
  if(!ready)throw Error('PostgreSQL did not become ready');
  runMigrationProfile(container,'f09-local','f09-fixture-password');
  psql(`
    INSERT INTO tenants(id,slug,display_name) VALUES('${A}','f09-a','F09 A'),('${B}','f09-b','F09 B');
    INSERT INTO users(id,email,password_hash) VALUES('${OWNER}','f09-owner@example.test','fixture'),('${OP}','f09-operator@example.test','fixture'),('${AUDITOR}','f09-auditor@example.test','fixture');
    INSERT INTO provider_users(user_id,role) VALUES('${OWNER}','owner'),('${OP}','operator'),('${AUDITOR}','auditor');
    INSERT INTO provider_company_assignments(user_id,tenant_id) VALUES('${OP}','${A}'),('${AUDITOR}','${A}');
    INSERT INTO memberships(tenant_id,user_id,status) VALUES('${A}','${OWNER}','active');
    INSERT INTO roles(tenant_id,name) VALUES('${A}','company.admin'),('${A}','company.auditor');
    INSERT INTO membership_roles(tenant_id,user_id,role_id) SELECT '${A}','${OWNER}',id FROM roles WHERE tenant_id='${A}' AND name='company.admin';
    INSERT INTO provider_audit_events(actor_user_id,actor_kind,actor_id,tenant_id,action,resource_type,resource_id,metadata) VALUES
      ('${OWNER}','user','${OWNER}','${A}','subscription.changed','subscription','A','{"revision":1}'),
      ('${OWNER}','user','${OWNER}','${B}','subscription.changed','subscription','B','{"revision":1}'),
      ('${OWNER}','user','${OWNER}',NULL,'setting.changed','provider_setting','global','{"secret_ref":"must_not_be_returned"}');
    INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id) VALUES('${A}','${OWNER}','company.test','report','A'),('${B}','${OWNER}','company.test','report','B');
    INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by) VALUES('${INVITATION}','${A}',decode('aa','hex'),'endpoint',0,now()+interval '1 hour','${OWNER}');
    INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${DEVICE}','${A}','${INVITATION}','Endpoint F09','endpoint','endpoint','approved','fixture','f09-device',decode('bb','hex'),now(),now(),'${OWNER}');
    INSERT INTO plans(code,name,modules,quotas) VALUES('f09-plan','F09 Plan','{"vpn":true}','{}');
    INSERT INTO subscriptions(tenant_id,plan_id,state) SELECT '${A}',id,'active' FROM plans WHERE code='f09-plan';
  `);
  psql(await readFile('infra/aws/lab/nexo-runtime.sql','utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'f09-fixture-password';");

  const port=run('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',container]).trim();
  const pool=new Pool({connectionString:`postgres://nexo_runtime:f09-fixture-password@127.0.0.1:${port}/nexo`,max:4});
  const provider=new PostgresProviderRepository(pool),company=new PostgresCompanyRepository(pool),operations=new PostgresOperationRepository(pool),nodes=new PostgresNodeRepository(pool),vpn=new PostgresVpnEnvironmentRepository(pool);
  const options={limit:10,offset:0};

  assert.deepEqual((await provider.listAudit(A,OP,options)).items.map(row=>row.tenantId),[A]);
  assert.equal((await provider.listAudit(B,OP,options)).total,0);
  assert.deepEqual((await provider.listAudit(B,AUDITOR,options)).items,[]);
  assert.deepEqual((await provider.listAudit(B,OWNER,options)).items.map(row=>row.tenantId),[B]);
  assert.equal((await provider.listGlobalAudit(OWNER,options)).total,1);
  await assert.rejects(()=>provider.listGlobalAudit(OP,options),/forbidden/u);
  assert.equal((await company.listAudit(A,options)).total,1);
  assert.equal((await company.listAudit(B,options)).total,1);

  const permission=await pool.query("SELECT count(*)::int AS count FROM permissions WHERE id='company.report.export'");
  const defaults=await pool.query("SELECT count(*)::int AS count FROM role_permissions WHERE permission_id='company.report.export'");
  assert.equal(permission.rows[0].count,1);
  assert.equal(defaults.rows[0].count,0);
  assert.equal((await company.setExportGrant(A,'company.auditor',true,OWNER)).changed,true);
  assert.equal((await company.setExportGrant(A,'company.auditor',true,OWNER)).changed,false);
  assert.equal((await company.listExportGrants(A)).find(row=>row.role==='company.auditor')?.enabled,true);
  assert.equal((await company.setExportGrant(A,'company.auditor',false,OWNER)).changed,true);
  assert.equal((await company.setExportGrant(A,'company.auditor',false,OWNER)).changed,false);
  const grantAudit=await company.listAudit(A,{...options,action:'report.export_permission.granted'}),revokeAudit=await company.listAudit(A,{...options,action:'report.export_permission.revoked'});
  assert.equal(grantAudit.total,1);
  assert.equal(revokeAudit.total,1);

  const operation=await operations.create(A,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f09-operation',expiresAt:Date.now()+60_000},OWNER);
  assert.equal(await operations.dispatch('f09-worker',10),1);
  const observedAt=new Date().toISOString();
  assert.equal(await operations.complete(DEVICE,operation.id,{status:'succeeded',result:{platform:'fixture'},observedAt,revision:operation.revision}),true);
  assert.equal(await operations.complete(DEVICE,operation.id,{status:'succeeded',result:{platform:'fixture'},observedAt,revision:operation.revision}),true);
  assert.equal(await operations.heartbeat(DEVICE,{observedAt,agentVersion:'1.0.0'}),true);
  assert.equal(await operations.heartbeat(DEVICE,{observedAt,agentVersion:'1.0.0'}),true);
  const operationEvents=await company.listAudit(A,{...options,action:'operation.completed'}),heartbeatEvents=await company.listAudit(A,{...options,action:'device.heartbeat.received'});
  assert.equal(operationEvents.total,1);
  assert.equal(heartbeatEvents.total,1);

  const tokenHash='11'.repeat(32),claimHash='22'.repeat(32),challengeHash='33'.repeat(32);
  await nodes.createInvitation({tokenHash,expiresAt:Date.now()+60_000,uses:1},OWNER);
  const enrollment=await nodes.begin({tokenHash,name:'Node F09',publicKeyPem:'fixture',fingerprint:'f09-node',claimHash,challengeHash,challengeExpiresAt:Date.now()+60_000});
  assert.ok(enrollment);
  assert.equal(await nodes.markProof(enrollment.nodeId,challengeHash),true);
  assert.equal(await nodes.approve(enrollment.nodeId,{serial:'f09-node-cert',certificatePem:'fixture',notBefore:new Date().toISOString(),notAfter:new Date(Date.now()+60_000).toISOString()},OWNER),true);
  const nodeOperation=await nodes.createOperation({targetNodeId:enrollment.nodeId,idempotencyKey:'f09-node-operation',expiresAt:Date.now()+60_000},OWNER);
  assert.equal(await nodes.dispatch('f09-worker',10),1);
  assert.equal(await nodes.complete(enrollment.nodeId,nodeOperation.id,'succeeded',{platform:'fixture'},observedAt,nodeOperation.revision),true);
  assert.equal(await nodes.complete(enrollment.nodeId,nodeOperation.id,'succeeded',{platform:'fixture'},observedAt,nodeOperation.revision),true);
  assert.equal(await nodes.heartbeat(enrollment.nodeId,observedAt,'1.0.0'),true);
  assert.equal(await nodes.heartbeat(enrollment.nodeId,observedAt,'1.0.0'),true);

  const environment=await vpn.create({tenantId:A,nodeId:enrollment.nodeId,name:'F09 VPN',listenerPort:21194,tunnelIpv4Cidr:'10.91.0.0/24'},OWNER);
  const suspended=await vpn.changeState(environment.id,{desiredState:'suspended',expectedRevision:environment.revision},OWNER);
  assert.ok(suspended);
  assert.equal(await vpn.report(environment.id,enrollment.nodeId,{revision:suspended.revision,observedState:'suspended',configDigest:'a'.repeat(64)}),true);
  assert.equal(await vpn.report(environment.id,enrollment.nodeId,{revision:suspended.revision,observedState:'suspended',configDigest:'a'.repeat(64)}),true);

  const global=await provider.listGlobalAudit(OWNER,{limit:100,offset:0});
  assert.equal(global.items.filter(event=>event.action==='node.operation.completed').length,1);
  assert.equal(global.items.filter(event=>event.action==='node.heartbeat.received').length,1);
  const tenantAudit=await provider.listAudit(A,OWNER,{limit:100,offset:0});
  assert.equal(tenantAudit.items.filter(event=>event.action==='vpn.environment.created').length,1);
  assert.equal(tenantAudit.items.filter(event=>event.action==='vpn.environment.desired_state_changed').length,1);
  assert.equal(tenantAudit.items.filter(event=>event.action==='vpn.environment.observed_state_reported').length,1);
  assert.equal(tenantAudit.items.find(event=>event.action==='vpn.environment.observed_state_reported')?.actorKind,'node');

  const legacyActor=psql(`INSERT INTO provider_audit_events(actor_user_id,tenant_id,action,resource_type,resource_id,metadata) VALUES('${OWNER}',NULL,'f09.rollback_compatibility_probe','compatibility','legacy-release','{}') RETURNING actor_kind||'|'||actor_id;`);
  assert.equal(legacyActor.trim(),`user|${OWNER}`);

  await pool.end();
  console.log(JSON.stringify({phase:'F09 PostgreSQL scope and audit',migrations:'001-015 + 017 + 019 + 020 (016 omitted; 020 closes local runtime grants)',runtimeAuditSelectGrants:'PASS',providerOwnerGlobal:'PASS',providerOperatorAssignedTenantOnly:'PASS',providerAuditorAssignedTenantOnly:'PASS',companyTenantRls:'PASS',exportGrantLifecycle:'PASS',atomicAudit:'PASS',idempotentEmitterDeduplication:'PASS',typedActors:'PASS',legacyReleaseRollbackCompatibility:'PASS',implicitExportGrants:0}));
}finally{
  spawnSync('docker',['rm','-f',container],{stdio:'ignore'});
}
