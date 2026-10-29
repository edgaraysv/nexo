import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createProductApplication } from '../dist/product/application.js';
import { PostgresCompanyRepository } from '../dist/product/postgres-company-repository.js';
import { PostgresIdentityRepository } from '../dist/product/postgres-repository.js';
import { hashPassword, sealSecret } from '../dist/product/security.js';

const name=`nexo-l04-${randomUUID().slice(0,8)}`;
const image=process.env.L04_POSTGRES_IMAGE??'postgres:17.6-bookworm';
const TENANT_A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',TENANT_B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',ADMIN='11111111-1111-4111-8111-111111111111',INVITED='22222222-2222-4222-8222-222222222222',SECRET='JBSWY3DPEHPK3PXP';
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',...options});if(result.status!==0)throw new Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
function totp(){const payload=Buffer.alloc(8);payload.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30_000)));const digest=createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(payload).digest();const offset=digest.at(-1)&15;return String((((digest[offset]&127)<<24)|(digest[offset+1]<<16)|(digest[offset+2]<<8)|digest[offset+3])%1_000_000).padStart(6,'0');}
async function login(app,email,tenantId){const first=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email,password:'correct horse battery staple'}});assert.equal(first.statusCode,200);const second=await app.inject({method:'POST',url:'/v1/auth/mfa',payload:{challenge:first.json().challenge,code:totp()}});assert.equal(second.statusCode,200);const selected=await app.inject({method:'POST',url:'/v1/session/select',payload:{selection:second.json().selection,scope_kind:'tenant',tenant_id:tenantId}});assert.equal(selected.statusCode,200);return selected.json().token;}

try{
  run('docker',['image','inspect',image]);
  run('docker',['run','--rm','-d','--name',name,'-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=l04-fixture-password','-e','POSTGRES_DB=nexo_l04',image]);
  let ready=false;for(let attempt=0;attempt<30;attempt++){const result=spawnSync('docker',['exec',name,'psql','-U','postgres','-d','nexo_l04','-c','SELECT 1'],{encoding:'utf8'});if(result.status===0){ready=true;break;}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}if(!ready)throw new Error('PostgreSQL did not become ready');
  for(const file of ['db/migrations/001_l02_identity.sql','db/migrations/002_l03_provider.sql','db/migrations/003_l04_company_portal.sql','db/tests/l02_rls.sql'])run('docker',['exec','-i',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo_l04'],{input:await readFile(file,'utf8')});
  const port=run('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',name]).trim();
  const adminPool=new Pool({connectionString:`postgres://postgres:l04-fixture-password@127.0.0.1:${port}/nexo_l04`,max:1});const key=Buffer.alloc(32,7),passwordHash=await hashPassword('correct horse battery staple');
  await adminPool.query('UPDATE users SET password_hash=$1 WHERE id IN ($2,$3)',[passwordHash,ADMIN,INVITED]);
  await adminPool.query("INSERT INTO mfa_factors(user_id,type,secret_ciphertext,enabled_at) VALUES($1,'totp',$3,now()),($2,'totp',$3,now())",[ADMIN,INVITED,sealSecret(SECRET,key)]);
  const roles=(await adminPool.query("INSERT INTO roles(tenant_id,name) VALUES($1,'company.admin'),($2,'company.auditor') RETURNING id,tenant_id",[TENANT_A,TENANT_B])).rows;
  await adminPool.query('INSERT INTO membership_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3),($4,$5,$6)',[TENANT_A,ADMIN,roles.find(x=>x.tenant_id===TENANT_A).id,TENANT_B,INVITED,roles.find(x=>x.tenant_id===TENANT_B).id]);await adminPool.end();
  run('docker',['exec','-i',name,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo_l04'],{input:await readFile('db/migrations/007_f03_company_authorization.sql','utf8')});
  const pool=new Pool({connectionString:`postgres://nexo_l02_runtime:l02-runtime-fixture-password@127.0.0.1:${port}/nexo_l04`,max:4});const identity=new PostgresIdentityRepository(pool,key),company=new PostgresCompanyRepository(pool),deliveries=[];const app=await createProductApplication(identity,undefined,undefined,company,{deliver:async(email,token,tenantId)=>deliveries.push({email,token,tenantId})});await app.init();await app.getHttpAdapter().getInstance().ready();
  try{
    const adminToken=await login(app,'a@example.test',TENANT_A),adminHeaders={authorization:`Bearer ${adminToken}`};
    const site=await app.inject({method:'POST',url:'/v1/company/sites',headers:adminHeaders,payload:{code:'central',name:'Central',networks:['10.44.0.0/24']}});assert.equal(site.statusCode,201);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/sites',headers:adminHeaders,payload:{code:'overlap',name:'Overlap',networks:['10.44.0.128/25']}})).statusCode,409);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/devices',headers:adminHeaders,payload:{site_id:site.json().id,name:'Gateway central',platform:'gateway'}})).statusCode,201);
    const policy=await app.inject({method:'POST',url:'/v1/company/policies',headers:adminHeaders,payload:{name:'Soporte',effect:'allow',action:'support.session:start',resource_type:'device',status:'active'}});assert.equal(policy.statusCode,201);assert.equal((await app.inject({method:'PUT',url:`/v1/company/policies/${policy.json().id}`,headers:adminHeaders,payload:{name:'Soporte',effect:'allow',action:'support.session:start',resource_type:'device',status:'retired',expected_revision:1}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/invitations',headers:adminHeaders,payload:{email:'b@example.test',role:'company.technician'}})).statusCode,202);assert.equal(deliveries.length,1);
    const invitedToken=await login(app,'b@example.test',TENANT_B),invitedHeaders={authorization:`Bearer ${invitedToken}`};assert.deepEqual((await app.inject({method:'GET',url:'/v1/company/sites',headers:invitedHeaders})).json().items,[]);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/invitations/accept',headers:invitedHeaders,payload:{token:deliveries[0].token}})).statusCode,200);assert.equal((await app.inject({method:'POST',url:'/v1/company/invitations/accept',headers:invitedHeaders,payload:{token:deliveries[0].token}})).statusCode,401);
    const tenantAToken=await login(app,'b@example.test',TENANT_A),tenantAHeaders={authorization:`Bearer ${tenantAToken}`};assert.equal((await app.inject({method:'GET',url:'/v1/company/sites',headers:tenantAHeaders})).json().items.length,1);assert.equal((await app.inject({method:'POST',url:'/v1/company/sites',headers:tenantAHeaders,payload:{code:'forbidden',name:'Forbidden',networks:['10.55.0.0/24']}})).statusCode,403);
    assert.deepEqual((await app.inject({method:'GET',url:'/v1/company/summary',headers:adminHeaders})).json(),{sites:1,devices:1,users:2,activePolicies:0});
  }finally{await app.close();await identity.close();}
  console.log(JSON.stringify({phase:'L04',postgres:'PASS',rls:'PASS',company_flow:'PASS',invitations:'PASS',image}));
}finally{spawnSync('docker',['rm','-f',name],{stdio:'ignore'});}
