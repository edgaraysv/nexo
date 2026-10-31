import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrationProfile } from './migration-test-support.mjs';
import { PostgresVpnEnvironmentRepository } from '../dist/product/postgres-vpn-environment-repository.js';
import { PostgresVpnCredentialRepository } from '../dist/product/postgres-vpn-credential-repository.js';
import { PostgresNodeRepository } from '../dist/product/postgres-node-repository.js';

const container = `nexo-f07-${randomUUID().slice(0, 8)}`;
const image = process.env.F07_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const TENANT_A = 'a7a7a7a7-a7a7-47a7-87a7-a7a7a7a7a7a7';
const TENANT_B = 'b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7';
const OWNER = '07070707-0707-4707-8707-070707070707';
const NODE = '17171717-1717-4717-8717-171717171717';
const DEVICE_A = '27272727-2727-4727-8727-272727272727';
const DEVICE_B = '37373737-3737-4737-8737-373737373737';
function run(command, args, options = {}) { const result = spawnSync(command, args, { encoding: 'utf8', ...options }); if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`); return result.stdout; }
function psql(input) { return run('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo'], { input }); }

try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=f07-fixture-password', '-e', 'POSTGRES_DB=nexo', image]);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) { if (spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']).status === 0) { ready = true; break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }
  if (!ready) throw new Error('PostgreSQL did not become ready');
  runMigrationProfile(container, 'f07-local', 'f07-fixture-password');
  psql(`
INSERT INTO tenants(id,slug,display_name) VALUES('${TENANT_A}','f07-a','F07 A'),('${TENANT_B}','f07-b','F07 B');
INSERT INTO users(id,email,password_hash) VALUES('${OWNER}','f07-owner@example.test','fixture');
INSERT INTO provider_users(user_id,role) VALUES('${OWNER}','owner');
INSERT INTO plans(id,code,name,modules) VALUES('a7070707-0707-4707-8707-070707070707','f07-vpn','F07 VPN','{"vpn":true}'),('b7070707-0707-4707-8707-070707070707','f07-no-vpn','F07 no VPN','{"vpn":false}');
INSERT INTO subscriptions(tenant_id,plan_id,state) VALUES('${TENANT_A}','a7070707-0707-4707-8707-070707070707','active'),('${TENANT_B}','b7070707-0707-4707-8707-070707070707','active');
INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES('47070707-0707-4707-8707-070707070707',decode(repeat('11',32),'hex'),now()+interval '1 hour',1,'${OWNER}');
INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${NODE}','47070707-0707-4707-8707-070707070707','F07 Node','approved','fixture','f07-node',decode(repeat('22',32),'hex'),now(),now(),'${OWNER}');
INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by) VALUES('57070707-0707-4707-8707-070707070707','${TENANT_A}',decode(repeat('33',32),'hex'),'endpoint',0,now()+interval '1 hour','${OWNER}'),('67070707-0707-4707-8707-070707070707','${TENANT_B}',decode(repeat('44',32),'hex'),'endpoint',0,now()+interval '1 hour','${OWNER}');
INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${DEVICE_A}','${TENANT_A}','57070707-0707-4707-8707-070707070707','Endpoint A','endpoint','endpoint','approved','fixture','f07-device-a',decode(repeat('55',32),'hex'),now(),now(),'${OWNER}'),('${DEVICE_B}','${TENANT_B}','67070707-0707-4707-8707-070707070707','Endpoint B','endpoint','endpoint','approved','fixture','f07-device-b',decode(repeat('66',32),'hex'),now(),now(),'${OWNER}');
`);
  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'runtime-fixture-password';");
  const port = run('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]).trim();
  const pool = new Pool({ connectionString: `postgres://nexo_runtime:runtime-fixture-password@127.0.0.1:${port}/nexo`, max: 4 });
  const repository = new PostgresVpnEnvironmentRepository(pool);
  const credentials = new PostgresVpnCredentialRepository(pool);
  const nodes = new PostgresNodeRepository(pool);
  const active = await repository.create({ tenantId: TENANT_A, nodeId: NODE, name: 'F07 Active', listenerPort: 21294, tunnelIpv4Cidr: '10.91.0.0/24' }, OWNER);
  await repository.create({ tenantId: TENANT_A, nodeId: NODE, name: 'F07 Pending', listenerPort: 21295, tunnelIpv4Cidr: '10.92.0.0/24' }, OWNER);
  assert.equal(await repository.report(active.id, NODE, { revision: 1, observedState: 'active', configDigest: 'a'.repeat(64) }), true);
  const catalog = await repository.available(TENANT_A, DEVICE_A);
  assert.equal(catalog.moduleState, 'enabled');
  assert.deepEqual(catalog.items.map(item => item.id), [active.id]);
  assert.deepEqual(await repository.available(TENANT_A, DEVICE_B), { moduleState: 'disabled', items: [] });
  assert.deepEqual(await repository.available(TENANT_B, DEVICE_B), { moduleState: 'disabled', items: [] });
  psql(`INSERT INTO subscription_modules(tenant_id,module,state,revision) VALUES('${TENANT_A}','vpn','suspended',1);`);
  assert.deepEqual(await repository.available(TENANT_A, DEVICE_A), { moduleState: 'disabled', items: [] });
  psql(`DELETE FROM subscription_modules WHERE tenant_id='${TENANT_A}' AND module='vpn';`);
  const requested = await credentials.request({ tenantId:TENANT_A, deviceId:DEVICE_A, environmentId:active.id, csrPem:'fixture-csr', idempotencyKey:'f07-pg-issue-credential', expiresAt:Date.now()+300_000 });
  assert.equal(requested.state,'pending');
  assert.equal(await nodes.dispatch('f07-test',10),1);
  const issue = await nodes.next(NODE);
  assert.equal(issue.type,'vpn.client_certificate.issue.v1');
  assert.deepEqual(Object.keys(issue.arguments).sort(),['csr_pem','device_id','environment_id','request_id','tenant_id']);
  const issuedResult={serial:'abcdef1234567890',certificate_pem:'certificate',ca_certificate_pem:'ca',not_before:new Date().toISOString(),not_after:new Date(Date.now()+86_400_000).toISOString()};
  assert.equal(await nodes.complete(NODE,issue.id,'succeeded',issuedResult,new Date().toISOString(),issue.revision),true);
  assert.equal(await credentials.complete(issue,'succeeded',issuedResult),true);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).state,'issued');
  assert.equal(await credentials.get(TENANT_B,DEVICE_B,active.id),undefined);
  assert.equal(await credentials.revokeAllForDevice(TENANT_A,DEVICE_A,Date.now()+300_000),1);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).state,'revocation_pending');
  assert.equal(await nodes.dispatch('f07-test',10),1);
  const revoke=await nodes.next(NODE);assert.equal(revoke.type,'vpn.client_certificate.revoke.v1');
  const revokeResult={serial:'abcdef1234567890',revoked:true};
  assert.equal(await nodes.complete(NODE,revoke.id,'succeeded',revokeResult,new Date().toISOString(),revoke.revision),true);
  assert.equal(await credentials.complete(revoke,'succeeded',revokeResult),true);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).state,'revoked');
  // Cross-device revision allocation: a credential for another device on the
  // same node must not collide with revisions hidden by device-scoped RLS.
  psql(`UPDATE plans SET modules='{"vpn":true}' WHERE code='f07-no-vpn';`);
  const second = await repository.create({ tenantId: TENANT_B, nodeId: NODE, name: 'F07 Cross', listenerPort: 21296, tunnelIpv4Cidr: '10.93.0.0/24' }, OWNER);
  assert.equal(await repository.report(second.id, NODE, { revision: 1, observedState: 'active', configDigest: 'b'.repeat(64) }), true);
  const cross = await credentials.request({ tenantId:TENANT_B, deviceId:DEVICE_B, environmentId:second.id, csrPem:'fixture-csr-b', idempotencyKey:'f07-pg-issue-credential-b', expiresAt:Date.now()+300_000 });
  assert.equal(cross.state,'pending');
  const crossRevision = psql(`SELECT revision FROM node_operations WHERE type='vpn.client_certificate.issue.v1' AND arguments->>'device_id'='${DEVICE_B}'`).split('\n').map(line => line.trim()).filter(line => /^\d+$/u.test(line));
  assert.deepEqual(crossRevision, ['3']);
  // Complete the cross-device operation so the reissue below sees an empty queue.
  assert.equal(await nodes.dispatch('f07-test',10),1);
  const crossIssue=await nodes.next(NODE);assert.equal(crossIssue.type,'vpn.client_certificate.issue.v1');
  const crossResult={serial:'abcdef1234567891',certificate_pem:'certificate-b',ca_certificate_pem:'ca-b',not_before:new Date().toISOString(),not_after:new Date(Date.now()+86_400_000).toISOString()};
  assert.equal(await nodes.complete(NODE,crossIssue.id,'succeeded',crossResult,new Date().toISOString(),crossIssue.revision),true);
  assert.equal(await credentials.complete(crossIssue,'succeeded',crossResult),true);
  // A revoked credential is history: a different CSR may create a new row.
  const reissued = await credentials.request({ tenantId:TENANT_A, deviceId:DEVICE_A, environmentId:active.id, csrPem:'fixture-csr-reissued', idempotencyKey:'f07-pg-reissue-credential', expiresAt:Date.now()+300_000 });
  assert.equal(reissued.state,'pending');
  assert.notEqual(reissued.id,requested.id);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).id,reissued.id);
  assert.equal(psql(`SELECT state FROM vpn_client_credentials WHERE id='${requested.id}'`).split('\n').map(x=>x.trim()).find(x=>x==='revoked'),'revoked');
  assert.equal(await nodes.dispatch('f07-test',10),1);
  const reissue=await nodes.next(NODE);assert.equal(reissue.type,'vpn.client_certificate.issue.v1');
  const reissuedResult={serial:'abcdef1234567892',certificate_pem:'certificate-reissued',ca_certificate_pem:'ca-reissued',not_before:new Date().toISOString(),not_after:new Date(Date.now()+86_400_000).toISOString()};
  assert.equal(await nodes.complete(NODE,reissue.id,'succeeded',reissuedResult,new Date().toISOString(),reissue.revision),true);
  assert.equal(await credentials.complete(reissue,'succeeded',reissuedResult),true);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).state,'issued');
  const idempotent = await credentials.request({ tenantId:TENANT_A, deviceId:DEVICE_A, environmentId:active.id, csrPem:'fixture-csr-reissued', idempotencyKey:'f07-pg-reissue-idempotent', expiresAt:Date.now()+300_000 });
  assert.equal(idempotent.id,reissued.id);
  assert.equal(await nodes.dispatch('f07-test',10),0);
  await assert.rejects(() => credentials.request({ tenantId:TENANT_A, deviceId:DEVICE_A, environmentId:active.id, csrPem:'fixture-csr-conflict', idempotencyKey:'f07-pg-reissue-conflict', expiresAt:Date.now()+300_000 }), /credential_conflict/);
  assert.equal((await credentials.revoke({ tenantId:TENANT_A, deviceId:DEVICE_A, environmentId:active.id, serial:'abcdef1234567892', idempotencyKey:'f07-pg-revoke-reissued', expiresAt:Date.now()+300_000 })).state,'revocation_pending');
  assert.equal(await nodes.dispatch('f07-test',10),1);
  const reissuedRevoke=await nodes.next(NODE);assert.equal(reissuedRevoke.type,'vpn.client_certificate.revoke.v1');
  assert.equal(await nodes.complete(NODE,reissuedRevoke.id,'succeeded',{serial:'abcdef1234567892',revoked:true},new Date().toISOString(),reissuedRevoke.revision),true);
  assert.equal(await credentials.complete(reissuedRevoke,'succeeded',{serial:'abcdef1234567892',revoked:true}),true);
  assert.equal((await credentials.get(TENANT_A,DEVICE_A,active.id)).state,'revoked');
  await pool.end();
  console.log(JSON.stringify({ phase: 'F07', postgres: 'PASS', endpointRLS: 'PASS', tenantIsolation: 'PASS', entitlement: 'PASS', activeOnly: 'PASS', csrOperation: 'PASS', revocationOperation: 'PASS', rotation: 'PASS', image }));
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
