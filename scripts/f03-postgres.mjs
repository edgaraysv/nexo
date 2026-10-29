import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createProductApplication } from '../dist/product/application.js';
import { PostgresCompanyRepository } from '../dist/product/postgres-company-repository.js';
import { PostgresIdentityRepository } from '../dist/product/postgres-repository.js';
import { hashPassword, sealSecret } from '../dist/product/security.js';

const container=`nexo-f03-${randomUUID().slice(0,8)}`;
const image=process.env.F03_POSTGRES_IMAGE??'postgres:17.6-bookworm';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN_A='11111111-1111-4111-8111-111111111111',ADMIN_B='22222222-2222-4222-8222-222222222222',TECH='33333333-3333-4333-8333-333333333333',AUDITOR='44444444-4444-4444-8444-444444444444';
const SECRET='JBSWY3DPEHPK3PXP';
const migrations=['001_l02_identity.sql','002_l03_provider.sql','003_l04_company_portal.sql','004_l05_device_identity.sql','005_l06_operations.sql','006_l06_node_restore.sql'];
function run(command,args,options={}){const result=spawnSync(command,args,{encoding:'utf8',...options});if(result.status!==0)throw new Error(`${command} failed: ${result.stderr||result.stdout}`);return result.stdout;}
function psql(database,input){return run('docker',['exec','-i',container,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],{input});}
function totp(){const payload=Buffer.alloc(8);payload.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const digest=createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(payload).digest();const offset=digest.at(-1)&15;return String((((digest[offset]&127)<<24)|(digest[offset+1]<<16)|(digest[offset+2]<<8)|digest[offset+3])%1_000_000).padStart(6,'0');}
async function token(app,email,tenantId){const first=await app.inject({method:'POST',url:'/v1/auth/login',payload:{email,password:'correct horse battery staple'}});assert.equal(first.statusCode,200);const second=await app.inject({method:'POST',url:'/v1/auth/mfa',payload:{challenge:first.json().challenge,code:totp()}});assert.equal(second.statusCode,200);const selected=await app.inject({method:'POST',url:'/v1/session/select',payload:{selection:second.json().selection,scope_kind:'tenant',tenant_id:tenantId}});assert.equal(selected.statusCode,200);return{authorization:`Bearer ${selected.json().token}`};}

try{
  run('docker',['image','inspect',image]);
  run('docker',['run','--rm','-d','--name',container,'-p','127.0.0.1::5432','-e','POSTGRES_PASSWORD=f03-fixture-password','-e','POSTGRES_DB=nexo_f03',image]);
  let ready=false;for(let i=0;i<40;i++){if(spawnSync('docker',['exec',container,'psql','-U','postgres','-d','nexo_f03','-c','SELECT 1']).status===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);if(spawnSync('docker',['exec',container,'psql','-U','postgres','-d','nexo_f03','-c','SELECT 1']).status===0){ready=true;break;}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}if(!ready)throw new Error('PostgreSQL did not become ready');
  for(const file of migrations)psql('nexo_f03',await readFile(`db/migrations/${file}`,'utf8'));
  psql('nexo_f03',await readFile('db/tests/l02_rls.sql','utf8'));
  const port=run('docker',['inspect','--format','{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}',container]).trim();
  const admin=new Pool({connectionString:`postgres://postgres:f03-fixture-password@127.0.0.1:${port}/nexo_f03`,max:1}),key=Buffer.alloc(32,3),passwordHash=await hashPassword('correct horse battery staple'),sealed=sealSecret(SECRET,key);
  await admin.query("INSERT INTO users(id,email,password_hash) VALUES($1,'tech-f03@example.test',$3),($2,'audit-f03@example.test',$3)",[TECH,AUDITOR,passwordHash]);
  await admin.query("INSERT INTO memberships(tenant_id,user_id,status) VALUES($1,$2,'active'),($1,$3,'active')",[A,TECH,AUDITOR]);
  await admin.query('UPDATE users SET password_hash=$1 WHERE id IN($2,$3)',[passwordHash,ADMIN_A,ADMIN_B]);
  await admin.query("INSERT INTO mfa_factors(user_id,type,secret_ciphertext,enabled_at) VALUES($1,'totp',$5,now()),($2,'totp',$5,now()),($3,'totp',$5,now()),($4,'totp',$5,now())",[ADMIN_A,ADMIN_B,TECH,AUDITOR,sealed]);
  const roles=await admin.query("INSERT INTO roles(tenant_id,name) VALUES($1,'company.admin'),($1,'company.technician'),($1,'company.auditor'),($2,'company.admin') RETURNING id,tenant_id,name",[A,B]);
  const roleId=(tenant,name)=>roles.rows.find(x=>x.tenant_id===tenant&&x.name===name).id;
  await admin.query('INSERT INTO membership_roles(tenant_id,user_id,role_id) VALUES($1,$2,$3),($1,$4,$5),($1,$6,$7),($8,$9,$10)',[A,ADMIN_A,roleId(A,'company.admin'),TECH,roleId(A,'company.technician'),AUDITOR,roleId(A,'company.auditor'),B,ADMIN_B,roleId(B,'company.admin')]);
  await admin.end();
  psql('nexo_f03',await readFile('db/migrations/007_f03_company_authorization.sql','utf8'));

  const pool=new Pool({connectionString:`postgres://nexo_l02_runtime:l02-runtime-fixture-password@127.0.0.1:${port}/nexo_f03`,max:4}),identity=new PostgresIdentityRepository(pool,key),company=new PostgresCompanyRepository(pool),app=await createProductApplication(identity,undefined,undefined,company);await app.init();await app.getHttpAdapter().getInstance().ready();
  try{
    const adminA=await token(app,'a@example.test',A),adminB=await token(app,'b@example.test',B),tech=await token(app,'tech-f03@example.test',A),auditor=await token(app,'audit-f03@example.test',A);
    const site=await app.inject({method:'POST',url:'/v1/company/sites',headers:adminA,payload:{code:'f03-central',name:'F03 Central',networks:['10.63.0.0/24']}});assert.equal(site.statusCode,201);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/sites',headers:tech,payload:{code:'blocked',name:'Blocked',networks:['10.64.0.0/24']}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/devices',headers:tech,payload:{site_id:site.json().id,name:'Equipo técnico',platform:'linux'}})).statusCode,201);
    assert.equal((await app.inject({method:'POST',url:'/v1/company/devices',headers:auditor,payload:{name:'No permitido',platform:'linux'}})).statusCode,403);
    const siteB=await app.inject({method:'POST',url:'/v1/company/sites',headers:adminB,payload:{code:'f03-other',name:'Otra empresa',networks:['10.73.0.0/24']}});assert.equal(siteB.statusCode,201);
    const audit=await app.inject({method:'GET',url:'/v1/company/audit',headers:auditor});assert.equal(audit.statusCode,200);assert.ok(audit.json().items.some(x=>x.action==='site.created'));assert.ok(audit.json().items.every(x=>x.resourceId!==siteB.json().id));
    assert.equal((await app.inject({method:'GET',url:'/v1/company/sites',headers:adminB})).json().items.length,1);
    const techMe=await app.inject({method:'GET',url:'/v1/me',headers:tech});assert.ok(techMe.json().permissions.includes('company.device.create'));assert.ok(!techMe.json().permissions.includes('company.site.create'));
    assert.equal((await app.inject({method:'PUT',url:`/v1/company/users/${ADMIN_A}/role`,headers:adminA,payload:{role:'company.auditor'}})).statusCode,409);
    assert.equal((await app.inject({method:'PUT',url:`/v1/company/users/${TECH}/role`,headers:adminA,payload:{role:'company.admin'}})).statusCode,204);
    assert.equal((await app.inject({method:'PUT',url:`/v1/company/users/${ADMIN_A}/role`,headers:adminA,payload:{role:'company.auditor'}})).statusCode,204);
    const formerAdmin=await app.inject({method:'GET',url:'/v1/me',headers:adminA});assert.ok(formerAdmin.json().permissions.includes('company.audit.read'));assert.ok(!formerAdmin.json().permissions.includes('company.user.roles.manage'));
    assert.equal((await app.inject({method:'PUT',url:`/v1/company/users/${AUDITOR}/role`,headers:tech,payload:{role:'company.admin'}})).statusCode,204);
    const race=await Promise.allSettled([company.setUserRole(A,TECH,'company.auditor',AUDITOR),company.setUserRole(A,AUDITOR,'company.auditor',TECH)]);assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.filter(x=>x.status==='rejected'&&x.reason instanceof Error&&x.reason.message==='last_admin').length,1);
  }finally{await app.close();await identity.close();}
  console.log(JSON.stringify({phase:'F03',postgres:'PASS',rls:'PASS',action_authorization:'PASS',audit_scope:'PASS',last_admin_race:'PASS',roles:['company.admin','company.technician','company.auditor'],image}));
}finally{spawnSync('docker',['rm','-f',container],{stdio:'ignore'});}
