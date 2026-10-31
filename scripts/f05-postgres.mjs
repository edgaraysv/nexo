import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runWorkerCycle } from '../dist/product/operation-worker.js';
import { PostgresNodeRepository } from '../dist/product/postgres-node-repository.js';
import { PostgresOperationRepository } from '../dist/product/postgres-operation-repository.js';

const container=`nexo-f05-${randomUUID().slice(0,8)}`,image=process.env.F05_POSTGRES_IMAGE??'postgres:17.6-bookworm';
const TENANT='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',USER='11111111-1111-4111-8111-111111111115',DEVICE='22222222-2222-4222-8222-222222222225',INVITATION='33333333-3333-4333-8333-333333333335',NODE_INVITATION='44444444-4444-4444-8444-444444444445',NODE='55555555-5555-4555-8555-555555555555';
const migrations=['001_l02_identity.sql','002_l03_provider.sql','003_l04_company_portal.sql','004_l05_device_identity.sql','005_l06_operations.sql','006_l06_node_restore.sql','007_f03_company_authorization.sql','008_f04_commercial_capabilities.sql','009_f05_operation_reliability.sql','010_f06_vpn_environments.sql','019_f03_resource_grants.sql'];
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',...options});if(result.status!==0)throw new Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
function psql(input){return run('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo'],{input});}
function repositories(port){const pool=new Pool({connectionString:`postgres://nexo_runtime:runtime-fixture-password@127.0.0.1:${port}/nexo`,max:6});return{pool,operations:new PostgresOperationRepository(pool),nodes:new PostgresNodeRepository(pool)};}

try{
  run('docker',['image','inspect',image]);run('docker',['run','--rm','-d','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=f05-fixture-password','-e','POSTGRES_DB=nexo',image]);
  let ready=false;for(let attempt=0;attempt<40;attempt++){const first=spawnSync('docker',['exec',container,'psql','-X','-U','postgres','-d','nexo','-c','SELECT 1']);if(first.status===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);if(spawnSync('docker',['exec',container,'psql','-X','-U','postgres','-d','nexo','-c','SELECT 1']).status===0){ready=true;break;}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}if(!ready)throw new Error('PostgreSQL did not become ready');
  for(const migration of migrations)psql(await readFile(`db/migrations/${migration}`,'utf8'));
  psql(`INSERT INTO tenants(id,slug,display_name) VALUES('${TENANT}','f05-company','F05 Company');
INSERT INTO users(id,email,password_hash) VALUES('${USER}','f05@example.test','fixture');
INSERT INTO memberships(tenant_id,user_id) VALUES('${TENANT}','${USER}');
INSERT INTO provider_users(user_id,role) VALUES('${USER}','owner');
INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by) VALUES('${INVITATION}','${TENANT}',decode(repeat('11',32),'hex'),'endpoint',1,now()+interval '1 hour','${USER}');
INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${DEVICE}','${TENANT}','${INVITATION}','Endpoint F05','endpoint','endpoint','approved','fixture','f05-device',decode(repeat('22',32),'hex'),now(),now(),'${USER}');
INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES('${NODE_INVITATION}',decode(repeat('33',32),'hex'),now()+interval '1 hour',1,'${USER}');
INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${NODE}','${NODE_INVITATION}','Node F05','approved','fixture','f05-node',decode(repeat('44',32),'hex'),now(),now(),'${USER}');`);
  psql(await readFile('infra/aws/lab/nexo-runtime.sql','utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'runtime-fixture-password';");
  const port=run('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',container]).trim();

  let current=repositories(port);
  const first=await current.operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-pg-operation-01',expiresAt:Date.now()+60_000,revision:1},USER);
  assert.equal((await current.operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-pg-operation-01',expiresAt:Date.now()+60_000,revision:1},USER)).id,first.id);
  await assert.rejects(()=>current.operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-pg-operation-01',expiresAt:Date.now()+60_000,revision:2},USER),/idempotency_conflict/);
  await assert.rejects(()=>current.operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-pg-stale-0001',expiresAt:Date.now()+60_000,revision:1},USER),/stale_revision/);
  const nodeOperation=await current.nodes.createOperation({targetNodeId:NODE,idempotencyKey:'f05-pg-node-0001',expiresAt:Date.now()+60_000,revision:1},USER);
  await current.pool.end();

  current=repositories(port);
  const cycle=await runWorkerCycle(current.operations,current.nodes,'f05-worker-after-restart',20);
  assert.equal(cycle.endpoint.dispatched,1);assert.equal(cycle.node.dispatched,1);
  const delivered=await current.operations.next(DEVICE),redelivered=await current.operations.next(DEVICE);assert.equal(delivered.id,first.id);assert.equal(redelivered.id,first.id);assert.equal(delivered.revision,1);
  const result={arch:'amd64',go_version:'go1.27.3',os:'linux'},observedAt=new Date().toISOString();
  assert.equal(await current.operations.complete(DEVICE,first.id,{status:'succeeded',result,observedAt,revision:0}),false);
  assert.equal(await current.operations.complete(DEVICE,first.id,{status:'succeeded',result,observedAt,revision:1}),true);
  assert.equal(await current.operations.complete(DEVICE,first.id,{status:'succeeded',result:{os:'linux',arch:'amd64',go_version:'go1.27.3'},observedAt,revision:1}),true);
  assert.equal(await current.operations.complete(DEVICE,first.id,{status:'failed',result:{code:'execution_error'},observedAt,revision:1}),false);
  assert.equal((await current.nodes.next(NODE)).id,nodeOperation.id);assert.equal((await current.nodes.next(NODE)).id,nodeOperation.id);
  assert.equal(await current.nodes.heartbeat(NODE,new Date().toISOString(),'0.1.0'),true);

  const expiring=await current.operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-pg-expiring-01',expiresAt:Date.now()+500,revision:2},USER);
  await new Promise(resolve=>setTimeout(resolve,650));
  const reconciled=await runWorkerCycle(current.operations,current.nodes,'f05-worker-reconcile',20);assert.equal(reconciled.endpoint.expired,1);
  assert.equal((await current.operations.list(TENANT)).find(item=>item.id===expiring.id).status,'expired');
  await current.pool.end();
  console.log(JSON.stringify({phase:'F05',postgres:'PASS',runtimeRole:'PASS',workerRestart:'PASS',apiIndependentWorker:'PASS',redelivery:'PASS',staleRevision:'PASS',idempotencyConflict:'PASS',expiration:'PASS',nodeHeartbeat:'PASS',image}));
}finally{spawnSync('docker',['rm','-f',container],{stdio:'ignore'});}
