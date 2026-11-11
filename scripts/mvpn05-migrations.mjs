import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { migrationProfiles, stripMigrationTransaction } from './migration-profiles.mjs';

const container=`nexo-mvpn05-${randomUUID().slice(0,8)}`,image=process.env.MVPN05_POSTGRES_IMAGE??'postgres:17.6-bookworm';
function run(args,input){const result=spawnSync('docker',args,{encoding:'utf8',input,timeout:900_000});if(result.status!==0)throw new Error(result.stderr||result.stdout||`docker ${args[0]} failed`);return result.stdout;}
function psql(sql,expectFailure=false){const result=spawnSync('docker',['exec','-i',container,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','nexo'],{encoding:'utf8',input:sql,timeout:900_000});if(expectFailure){assert.notEqual(result.status,0,'migration 027 must reject incoherent legacy rows');return result.stderr;}if(result.status!==0)throw new Error(result.stderr||result.stdout);return result.stdout;}

try{
  run(['image','inspect',image]);
  run(['run','--rm','-d','--name',container,'-e','POSTGRES_PASSWORD=mvpn05-fixture','-e','POSTGRES_DB=nexo',image]);
  let ready=false;for(let i=0;i<60;i++){if(spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','nexo'],{stdio:'ignore'}).status===0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);if(spawnSync('docker',['exec',container,'pg_isready','-U','postgres','-d','nexo'],{stdio:'ignore'}).status===0){ready=true;break;}}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,250);}if(!ready)throw new Error('PostgreSQL did not become stably ready');
  const production=migrationProfiles.production.migrations;assert.equal(production.at(-1),'027_f08_gateway_device_audience.sql');
  for(const file of production.slice(0,-1))psql(await readFile(new URL(`../db/migrations/${file}`,import.meta.url),'utf8'));
  psql(`
    INSERT INTO tenants(id,slug,display_name) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','mvpn05','M-VPN-05');
    INSERT INTO users(id,email,password_hash) VALUES('11111111-1111-4111-8111-111111111115','mvpn05@example.test','fixture');
    INSERT INTO memberships(tenant_id,user_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','11111111-1111-4111-8111-111111111115');
    INSERT INTO sites(id,tenant_id,code,name) VALUES('22222222-2222-4222-8222-222222222225','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','branch','Branch');
    INSERT INTO device_invitations(id,tenant_id,site_id,token_hash,device_kind,audience,uses_remaining,expires_at,created_by)
      VALUES('33333333-3333-4333-8333-333333333334','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225',decode(repeat('09',32),'hex'),'endpoint','endpoint',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115');
    INSERT INTO device_identities(id,tenant_id,site_id,invitation_id,name,device_kind,audience,public_key_pem,key_fingerprint,claim_token_hash)
      VALUES('44444444-4444-4444-8444-444444444444','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333334','Existing endpoint','endpoint','endpoint','fixture','existing-endpoint',decode(repeat('08',32),'hex'));
    INSERT INTO device_invitations(id,tenant_id,site_id,token_hash,device_kind,audience,uses_remaining,expires_at,created_by)
      VALUES('33333333-3333-4333-8333-333333333335','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225',decode(repeat('aa',32),'hex'),'gateway','endpoint',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115');
    INSERT INTO device_identities(id,tenant_id,site_id,invitation_id,name,device_kind,audience,public_key_pem,key_fingerprint,claim_token_hash)
      VALUES('44444444-4444-4444-8444-444444444445','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333335','Legacy gateway','gateway','endpoint','fixture','legacy-gateway',decode(repeat('bb',32),'hex'));
  `);
  const migration=await readFile(new URL('../db/migrations/027_f08_gateway_device_audience.sql',import.meta.url),'utf8');
  assert.match(psql(migration,true),/gateway audience migration requires coherent existing device rows/u);
  assert.match(psql("SELECT device_kind||'/'||audience pair FROM device_identities WHERE id='44444444-4444-4444-8444-444444444445';"),/gateway\/endpoint/u);
  psql(`DELETE FROM device_identities WHERE id='44444444-4444-4444-8444-444444444445'; DELETE FROM device_invitations WHERE id='33333333-3333-4333-8333-333333333335';`);
  psql(migration);
  assert.match(psql("SELECT device_kind||'/'||audience pair FROM device_identities WHERE id='44444444-4444-4444-8444-444444444444';"),/endpoint\/endpoint/u);
  const body=stripMigrationTransaction(migration,'027_f08_gateway_device_audience.sql');assert.match(body,/device_invitations/u);assert.match(body,/device_identities/u);
  psql(`
    INSERT INTO device_invitations(id,tenant_id,site_id,token_hash,device_kind,audience,uses_remaining,expires_at,created_by) VALUES
      ('33333333-3333-4333-8333-333333333336','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225',decode(repeat('cc',32),'hex'),'endpoint','endpoint',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115'),
      ('33333333-3333-4333-8333-333333333337','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225',decode(repeat('dd',32),'hex'),'gateway','gateway',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115');
    INSERT INTO device_identities(id,tenant_id,site_id,invitation_id,name,device_kind,audience,public_key_pem,key_fingerprint,claim_token_hash) VALUES
      ('44444444-4444-4444-8444-444444444446','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333336','Endpoint','endpoint','endpoint','fixture','endpoint-ok',decode(repeat('ee',32),'hex')),
      ('44444444-4444-4444-8444-444444444447','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333337','Gateway','gateway','gateway','fixture','gateway-ok',decode(repeat('ff',32),'hex'));
  `);
  for(const sql of[
    "INSERT INTO device_invitations(tenant_id,token_hash,device_kind,audience,uses_remaining,expires_at,created_by) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',decode(repeat('01',32),'hex'),'endpoint','gateway',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115')",
    "INSERT INTO device_invitations(tenant_id,token_hash,device_kind,audience,uses_remaining,expires_at,created_by) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',decode(repeat('02',32),'hex'),'gateway','endpoint',1,now()+interval '1 hour','11111111-1111-4111-8111-111111111115')",
  ])assert.match(psql(`${sql};`,true),/device_invitations_audience_check/u);
  for(const sql of[
    "INSERT INTO device_identities(id,tenant_id,site_id,invitation_id,name,device_kind,audience,public_key_pem,key_fingerprint,claim_token_hash) VALUES('44444444-4444-4444-8444-444444444448','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333337','Bad endpoint','endpoint','gateway','fixture','bad-endpoint',decode(repeat('05',32),'hex'))",
    "INSERT INTO device_identities(id,tenant_id,site_id,invitation_id,name,device_kind,audience,public_key_pem,key_fingerprint,claim_token_hash) VALUES('44444444-4444-4444-8444-444444444449','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','22222222-2222-4222-8222-222222222225','33333333-3333-4333-8333-333333333336','Bad gateway','gateway','endpoint','fixture','bad-gateway',decode(repeat('06',32),'hex'))",
  ])assert.match(psql(`${sql};`,true),/device_identities_audience_check/u);
  console.log(JSON.stringify({phase:'M-VPN-05-A1',postgres:'PASS',legacyAbort:'PASS',invitationPairs:'PASS',identityPairs:'PASS',migrations:production.length,image}));
}finally{spawnSync('docker',['rm','-f',container],{stdio:'ignore'});}
