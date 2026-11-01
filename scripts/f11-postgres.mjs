import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrationProfile } from './migration-test-support.mjs';
import { PostgresVpnEnvironmentRepository } from '../dist/product/postgres-vpn-environment-repository.js';
import { PostgresWireGuardPeerRepository } from '../dist/product/postgres-wireguard-peer-repository.js';

const container = `nexo-f11-${randomUUID().slice(0, 8)}`;
const image = process.env.F11_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const otherTenant = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const owner = '11111111-1111-4111-8111-111111111111';
const operator = '22222222-2222-4222-8222-222222222222';
const nodeId = '33333333-3333-4333-8333-333333333333';
const wrongNode = '44444444-4444-4444-8444-444444444444';
const deviceA = '55555555-5555-4555-8555-555555555551';
const deviceB = '55555555-5555-4555-8555-555555555552';
const deviceOtherTenant = '55555555-5555-4555-8555-555555555553';
const planId = '66666666-6666-4666-8666-666666666666';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(input) {
  return run('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo'], { input });
}

function publicKey() {
  return generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

let pool;
try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD=f11-fixture-password', '-e', 'POSTGRES_DB=nexo', image]);

  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']).status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  const port = runMigrationProfile(container, 'f11-local', 'f11-fixture-password');
  psql(`
INSERT INTO tenants(id,slug,display_name) VALUES
  ('${tenant}','f11-main','F11 Main'),('${otherTenant}','f11-other','F11 Other');
INSERT INTO users(id,email,password_hash) VALUES
  ('${owner}','f11-owner@example.test','fixture'),('${operator}','f11-operator@example.test','fixture');
INSERT INTO memberships(tenant_id,user_id) VALUES
  ('${tenant}','${owner}'),('${tenant}','${operator}'),('${otherTenant}','${owner}');
INSERT INTO provider_users(user_id,role) VALUES('${owner}','owner'),('${operator}','operator');
INSERT INTO provider_company_assignments(user_id,tenant_id) VALUES('${operator}','${tenant}');
INSERT INTO plans(id,code,name,modules) VALUES('${planId}','f11-plan','F11 Plan','{"vpn":true}');
INSERT INTO subscriptions(tenant_id,plan_id,state) VALUES
  ('${tenant}','${planId}','active'),('${otherTenant}','${planId}','active');
INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES
  ('77777777-7777-4777-8777-777777777771',decode(repeat('71',32),'hex'),now()+interval '1 hour',1,'${owner}'),
  ('77777777-7777-4777-8777-777777777772',decode(repeat('72',32),'hex'),now()+interval '1 hour',1,'${owner}');
INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES
  ('${nodeId}','77777777-7777-4777-8777-777777777771','F11 Node','approved','fixture','f11-node',decode(repeat('73',32),'hex'),now(),now(),'${owner}'),
  ('${wrongNode}','77777777-7777-4777-8777-777777777772','F11 Wrong Node','approved','fixture','f11-wrong-node',decode(repeat('74',32),'hex'),now(),now(),'${owner}');
INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by) VALUES
  ('88888888-8888-4888-8888-888888888881','${tenant}',decode(repeat('81',32),'hex'),'endpoint',1,now()+interval '1 hour','${owner}'),
  ('88888888-8888-4888-8888-888888888882','${tenant}',decode(repeat('82',32),'hex'),'endpoint',1,now()+interval '1 hour','${owner}'),
  ('88888888-8888-4888-8888-888888888883','${otherTenant}',decode(repeat('83',32),'hex'),'endpoint',1,now()+interval '1 hour','${owner}');
INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES
  ('${deviceA}','${tenant}','88888888-8888-4888-8888-888888888881','F11 Endpoint A','endpoint','endpoint','approved','fixture','f11-device-a',decode(repeat('84',32),'hex'),now(),now(),'${owner}'),
  ('${deviceB}','${tenant}','88888888-8888-4888-8888-888888888882','F11 Endpoint B','endpoint','endpoint','approved','fixture','f11-device-b',decode(repeat('85',32),'hex'),now(),now(),'${owner}'),
  ('${deviceOtherTenant}','${otherTenant}','88888888-8888-4888-8888-888888888883','F11 Other Endpoint','endpoint','endpoint','approved','fixture','f11-device-other',decode(repeat('86',32),'hex'),now(),now(),'${owner}');
`);

  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'f11-runtime-fixture-password';");
  pool = new Pool({ connectionString: `postgres://nexo_runtime:f11-runtime-fixture-password@127.0.0.1:${port}/nexo`, max: 8 });
  const environments = new PostgresVpnEnvironmentRepository(pool);
  const peers = new PostgresWireGuardPeerRepository(pool);
  const serverPublicKey = publicKey();

  const environment = await environments.create({ tenantId: tenant, nodeId, name: 'F11 WireGuard', engine: 'wireguard', listenerPort: 51820, tunnelIpv4Cidr: '10.81.0.0/24' }, owner);
  assert.equal(environment.engine, 'wireguard');
  assert.equal(environment.wireguardServerPublicKey, undefined);
  assert.equal(await environments.report(environment.id, nodeId, { revision: 1, observedState: 'active', configDigest: 'a'.repeat(64), wireguardServerPublicKey: serverPublicKey }), true);
  const applied = (await environments.list(owner)).find(item => item.id === environment.id);
  assert.equal(applied?.wireguardServerPublicKey, serverPublicKey);
  assert.equal(applied?.observedState, 'active');
  assert.equal(applied?.appliedRevision, 1);
  const visibility = await pool.connect();
  try {
    await visibility.query('BEGIN');
    await visibility.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id',$2,true)", [tenant, deviceA]);
    const visible = await visibility.query(`SELECT
      (SELECT count(*) FROM vpn_environments WHERE id=$1) AS environment,
      (SELECT count(*) FROM provider_nodes WHERE id=$2) AS node,
      (SELECT count(*) FROM wireguard_environment_config WHERE environment_id=$1) AS config,
      (SELECT count(*) FROM device_identities WHERE id=$3) AS device,
      (SELECT count(*) FROM subscriptions WHERE tenant_id=$4) AS subscription,
      (SELECT count(*) FROM plans WHERE id=$5) AS plan`, [environment.id, nodeId, deviceA, tenant, planId]);
    assert.deepEqual(Object.values(visible.rows[0]), ['1', '1', '1', '1', '1', '1']);
    const eligibility = await visibility.query(`SELECT e.engine,e.desired_state,e.observed_state,e.revision,e.applied_revision,
      w.server_public_key IS NOT NULL AS has_server_key,n.status AS node_status,d.status AS device_status,
      s.state AS subscription_state,p.modules->>'vpn' AS plan_vpn,coalesce(m.state,'active') AS module_state
      FROM vpn_environments e
      JOIN provider_nodes n ON n.id=e.node_id
      JOIN wireguard_environment_config w ON w.environment_id=e.id
      JOIN subscriptions s ON s.tenant_id=e.tenant_id
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN subscription_modules m ON m.tenant_id=e.tenant_id AND m.module='vpn'
      JOIN device_identities d ON d.id=$2 AND d.tenant_id=e.tenant_id
      WHERE e.id=$1`, [environment.id, deviceA]);
    assert.equal(eligibility.rowCount, 1, JSON.stringify(eligibility.rows));
    assert.equal(eligibility.rows[0].node_status, 'approved');
    assert.equal(eligibility.rows[0].device_status, 'approved');
    assert.equal(eligibility.rows[0].plan_vpn, 'true');
    assert.equal(eligibility.rows[0].module_state, 'active');
    assert.equal(eligibility.rows[0].has_server_key, true);
    assert.equal(eligibility.rows[0].subscription_state, 'active');
    assert.equal(eligibility.rows[0].engine, 'wireguard');
    assert.equal(eligibility.rows[0].desired_state, 'active');
    assert.equal(eligibility.rows[0].observed_state, 'active');
    assert.equal(Number(eligibility.rows[0].revision), Number(eligibility.rows[0].applied_revision));
    const eligible = await visibility.query(`SELECT e.id FROM vpn_environments e
      JOIN provider_nodes n ON n.id=e.node_id AND n.status='approved'
      JOIN wireguard_environment_config w ON w.environment_id=e.id
      JOIN subscriptions s ON s.tenant_id=e.tenant_id
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN subscription_modules m ON m.tenant_id=s.tenant_id AND m.module='vpn'
        AND (m.valid_from IS NULL OR m.valid_from<=now()) AND (m.valid_until IS NULL OR m.valid_until>now())
      JOIN device_identities d ON d.id=$2 AND d.tenant_id=e.tenant_id AND d.status='approved'
      WHERE e.id=$1 AND e.tenant_id=$3 AND e.engine='wireguard'
        AND e.desired_state='active' AND e.observed_state='active' AND e.applied_revision=e.revision
        AND w.server_public_key IS NOT NULL
        AND s.state IN ('active','grace') AND (s.valid_from IS NULL OR s.valid_from<=now())
        AND (s.valid_until IS NULL OR s.valid_until>now())
        AND coalesce((p.modules->>'vpn')::boolean,false)=true AND coalesce(m.state,'active')='active'`, [environment.id, deviceA, tenant]);
    assert.equal(eligible.rowCount, 1, JSON.stringify(eligibility.rows));
    await visibility.query('ROLLBACK');
  } catch (error) {
    await visibility.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    visibility.release();
  }

  const keyA = publicKey();
  const keyB = publicKey();
  const [registeredA, registeredB] = await Promise.all([
    peers.register({ tenantId: tenant, deviceId: deviceA, environmentId: environment.id, publicKey: keyA, action: 'register' }),
    peers.register({ tenantId: tenant, deviceId: deviceB, environmentId: environment.id, publicKey: keyB, action: 'register' }),
  ]);
  assert.deepEqual([registeredA.tunnelIpv4, registeredB.tunnelIpv4].sort(), ['10.81.0.2', '10.81.0.3']);
  assert.deepEqual(await Promise.all([
    peers.register({ tenantId: tenant, deviceId: deviceA, environmentId: environment.id, publicKey: keyA, action: 'register' }),
    peers.register({ tenantId: tenant, deviceId: deviceB, environmentId: environment.id, publicKey: keyB, action: 'register' }),
  ]), [registeredA, registeredB]);
  await assert.rejects(() => peers.register({ tenantId: otherTenant, deviceId: deviceOtherTenant, environmentId: environment.id, publicKey: publicKey(), action: 'register' }), /environment_unavailable/);
  await assert.rejects(() => peers.preview({ environmentId: environment.id, deviceId: deviceA, action: 'approve', expectedRevision: 1 }, operator), /forbidden/);

  const approvalA = await peers.preview({ environmentId: environment.id, deviceId: deviceA, action: 'approve', expectedRevision: 1 }, owner);
  await assert.rejects(() => peers.preview({ environmentId: environment.id, deviceId: deviceB, action: 'approve', expectedRevision: 1 }, owner), /preview_pending/);
  await assert.rejects(() => peers.confirm({ previewId: approvalA.id, digest: '0'.repeat(64) }, owner), /preview_digest_conflict/);
  assert.equal((await peers.confirm({ previewId: approvalA.id, digest: approvalA.digest }, owner)).state, 'active');
  assert.equal((await peers.desiredForNode(wrongNode))[environment.id], undefined);
  assert.equal((await peers.desiredForNode(nodeId))[environment.id][0].publicKey, keyA);
  assert.deepEqual(await peers.forDevice(tenant, deviceA), {});
  let current = (await environments.list(owner)).find(item => item.id === environment.id);
  assert.equal(current?.revision, 2);
  assert.equal(await environments.report(environment.id, nodeId, { revision: 2, observedState: 'active', configDigest: 'b'.repeat(64) }), true);
  let configA = (await peers.forDevice(tenant, deviceA))[environment.id];
  assert.equal(configA.clientPublicKey, keyA);
  assert.equal(configA.serverPublicKey, serverPublicKey);
  assert.deepEqual(configA.allowedIps, ['10.81.0.1/32']);
  assert.deepEqual(await peers.forDevice(tenant, deviceB), {});

  const approvalB = await peers.preview({ environmentId: environment.id, deviceId: deviceB, action: 'approve', expectedRevision: 2 }, owner);
  await peers.confirm({ previewId: approvalB.id, digest: approvalB.digest }, owner);
  current = (await environments.list(owner)).find(item => item.id === environment.id);
  assert.equal(current?.revision, 3);
  assert.equal(await environments.report(environment.id, nodeId, { revision: 3, observedState: 'active', configDigest: 'c'.repeat(64) }), true);
  assert.equal(Object.keys(await peers.forDevice(tenant, deviceA)).length, 1);
  assert.equal((await peers.forDevice(tenant, deviceB))[environment.id].clientPublicKey, keyB);
  assert.equal((await peers.desiredForNode(nodeId))[environment.id].length, 2);

  const nextKeyA = publicKey();
  await peers.register({ tenantId: tenant, deviceId: deviceA, environmentId: environment.id, publicKey: nextKeyA, action: 'rotate' });
  const rotation = await peers.preview({ environmentId: environment.id, deviceId: deviceA, action: 'rotate', expectedRevision: 3 }, owner);
  assert.equal(rotation.summary.oldKeyFingerprint?.length, 16);
  assert.equal(rotation.summary.newKeyFingerprint?.length, 16);
  const rotated = await peers.confirm({ previewId: rotation.id, digest: rotation.digest }, owner);
  assert.notEqual(rotated.publicKeyFingerprint, undefined);
  assert.equal((await peers.desiredForNode(nodeId))[environment.id].length, 2);
  current = (await environments.list(owner)).find(item => item.id === environment.id);
  assert.equal(current?.revision, 4);
  assert.equal(await environments.report(environment.id, nodeId, { revision: 4, observedState: 'active', configDigest: 'd'.repeat(64) }), true);
  configA = (await peers.forDevice(tenant, deviceA))[environment.id];
  assert.equal(configA.clientPublicKey, nextKeyA);
  assert.equal((await peers.forDevice(tenant, deviceB))[environment.id].clientPublicKey, keyB);

  const revokeB = await peers.preview({ environmentId: environment.id, deviceId: deviceB, action: 'revoke', expectedRevision: 4 }, owner);
  await peers.confirm({ previewId: revokeB.id, digest: revokeB.digest }, owner);
  assert.equal((await peers.desiredForNode(nodeId))[environment.id].length, 1);
  current = (await environments.list(owner)).find(item => item.id === environment.id);
  assert.equal(current?.revision, 5);
  assert.equal(await environments.report(environment.id, nodeId, { revision: 5, observedState: 'active', configDigest: 'e'.repeat(64) }), true);
  assert.deepEqual(await peers.forDevice(tenant, deviceB), {});
  assert.equal((await peers.forDevice(tenant, deviceA))[environment.id].clientPublicKey, nextKeyA);

  const rls = await pool.connect();
  try {
    await rls.query('BEGIN');
    await rls.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id',$2,true)", [tenant, deviceB]);
    assert.equal(Number((await rls.query('SELECT count(*) AS count FROM wireguard_peers')).rows[0].count), 1);
    await rls.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.device_id',$2,true)", [otherTenant, deviceOtherTenant]);
    assert.equal(Number((await rls.query('SELECT count(*) AS count FROM wireguard_peers')).rows[0].count), 0);
    await rls.query('ROLLBACK');
  } catch (error) {
    await rls.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    rls.release();
  }

  const auditor = await pool.connect();
  try {
    await auditor.query('BEGIN');
    await auditor.query("SELECT set_config('app.user_id',$1,true),set_config('app.provider_role','owner',true)", [owner]);
    const audit = await auditor.query("SELECT count(*) AS count FROM provider_audit_events WHERE tenant_id=$1 AND action LIKE 'wireguard.peer.%'", [tenant]);
    assert.equal(Number(audit.rows[0].count), 4);
    await auditor.query('ROLLBACK');
  } catch (error) {
    await auditor.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    auditor.release();
  }
  console.log(JSON.stringify({ phase: 'F11', postgres: 'PASS', migrationProfile: 'f11-local', runtimeRole: 'PASS', concurrentAllocation: 'PASS', deviceAndTenantRLS: 'PASS', previewConfirmation: 'PASS', rotation: 'PASS', revocation: 'PASS', audit: 'PASS', handshake: 'NOT_RUN', image }));
} finally {
  if (pool) await pool.end();
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
