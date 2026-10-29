import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrationProfile } from './migration-test-support.mjs';
import { PostgresProviderRepository } from '../dist/product/postgres-provider-repository.js';

const container=`nexo-ga01-${randomUUID().slice(0,8)}`,image=process.env.GA01_POSTGRES_IMAGE??'postgres:17.6-bookworm';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa101',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb102';
const OWNER='11111111-1111-4111-8111-111111111101',OP='22222222-2222-4222-8222-222222222102',AUDITOR='33333333-3333-4333-8333-333333333103';
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',...options});if(result.status!==0)throw Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
function psql(input){return run('docker',['exec','-i',container,'psql','-X','-A','-t','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo'],{input});}

try{
  run('docker',['image','inspect',image]);
  run('docker',['run','--rm','-d','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=ga01-fixture-password','-e','POSTGRES_DB=nexo',image]);
  let ready=false;
  for(let i=0;i<50;i++){
    if(spawnSync('docker',['exec',container,'psql','-X','-U','postgres','-d','nexo','-c','SELECT 1']).status===0){ready=true;break;}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);
  }
  if(!ready)throw Error('PostgreSQL did not become ready');
  runMigrationProfile(container,'ga01-local','ga01-fixture-password');
  psql(`
    INSERT INTO tenants(id,slug,display_name) VALUES('${A}','ga01-a','GA-01 A'),('${B}','ga01-b','GA-01 B');
    INSERT INTO users(id,email,password_hash) VALUES('${OWNER}','ga01-owner@example.test','fixture'),('${OP}','ga01-operator@example.test','fixture'),('${AUDITOR}','ga01-auditor@example.test','fixture');
    INSERT INTO provider_users(user_id,role) VALUES('${OWNER}','owner'),('${OP}','operator'),('${AUDITOR}','auditor');
  `);
  psql(await readFile('infra/aws/lab/nexo-runtime.sql','utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'ga01-fixture-password';");

  const port=run('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',container]).trim();
  const pool=new Pool({connectionString:`postgres://nexo_runtime:ga01-fixture-password@127.0.0.1:${port}/nexo`,max:3});
  const provider=new PostgresProviderRepository(pool);

  assert.deepEqual((await provider.listOperators(OWNER)).map(row=>row.userId),[OP]);
  assert.deepEqual(await provider.listCompanyOperators(A,OWNER),[]);
  await provider.assignCompany({tenantId:A,userId:OP},OWNER);
  await provider.assignCompany({tenantId:A,userId:OP},OWNER);
  assert.deepEqual((await provider.listCompanyOperators(A,OWNER)).map(row=>row.userId),[OP]);
  assert.deepEqual((await provider.listCompanies(OP)).map(row=>row.id),[A]);
  await assert.rejects(()=>provider.assignCompany({tenantId:B,userId:OP},OP),/row-level security policy|permission denied/u);
  assert.deepEqual((await provider.listCompanies(OP)).map(row=>row.id),[A]);

  const ownerAudit=await provider.listAudit(A,OWNER,{limit:20,offset:0});
  assert.equal(ownerAudit.items.filter(row=>row.action==='operator.assigned').length,1);
  assert.equal(await provider.unassignCompany({tenantId:A,userId:OP},OWNER),true);
  assert.equal(await provider.unassignCompany({tenantId:A,userId:OP},OWNER),false);
  assert.deepEqual(await provider.listCompanyOperators(A,OWNER),[]);
  const finalAudit=await provider.listAudit(A,OWNER,{limit:20,offset:0});
  assert.equal(finalAudit.items.filter(row=>row.action==='operator.unassigned').length,1);

  const grants=await pool.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='nexo_runtime' AND table_name='provider_company_assignments' ORDER BY privilege_type");
  assert.deepEqual(grants.rows.map(row=>row.privilege_type),['DELETE','INSERT','SELECT']);
  await pool.end();
  console.log(JSON.stringify({gate:'GA-01',migrations:'001-015 + 017 + 018 (016 omitted)',operatorListing:'PASS',assignmentListing:'PASS',idempotentAssignment:'PASS',ownerOnlyMutationRls:'PASS',runtimeDeleteGrant:'PASS',assignmentAudit:'PASS',cleanup:'PASS'}));
}finally{
  spawnSync('docker',['rm','-f',container],{stdio:'ignore'});
}
