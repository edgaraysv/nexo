import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { PostgresVpnEnvironmentRepository } from '../dist/product/postgres-vpn-environment-repository.js';

const container = `nexo-f06-${randomUUID().slice(0, 8)}`;
const image = process.env.F06_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6';
const USER   = '11111111-1111-4111-8111-111111111116';
const NODE   = '55555555-5555-4555-8555-555555555556';
const NODE2  = '66666666-6666-4666-8666-666666666666';
const NODE_INV  = '44444444-4444-4444-8444-444444444446';
const NODE_INV2 = '44444444-4444-4444-8444-444444444447';
const TENANT2= 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER2  = '22222222-2222-4222-8222-222222222222';

const migrations = [
  '001_l02_identity.sql',
  '002_l03_provider.sql',
  '003_l04_company_portal.sql',
  '004_l05_device_identity.sql',
  '005_l06_operations.sql',
  '006_l06_node_restore.sql',
  '007_f03_company_authorization.sql',
  '008_f04_commercial_capabilities.sql',
  '009_f05_operation_reliability.sql',
  '010_f06_vpn_environments.sql',
];

function run(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (r.status !== 0) throw new Error(`${command} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function psql(input) {
  return run('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo'], { input });
}

try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432',
    '-e', 'POSTGRES_PASSWORD=f06-fixture-password', '-e', 'POSTGRES_DB=nexo', image]);

  let ready = false;
  for (let i = 0; i < 40; i++) {
    const r = spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']);
    if (r.status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']).status === 0) { ready = true; break; }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  for (const m of migrations) psql(await readFile(`db/migrations/${m}`, 'utf8'));

  psql(`
INSERT INTO tenants(id,slug,display_name) VALUES('${TENANT}','f06-company','F06 Company');
INSERT INTO tenants(id,slug,display_name) VALUES('${TENANT2}','f06-company-b','F06 Company B');
INSERT INTO users(id,email,password_hash) VALUES('${USER}','f06@example.test','fixture');
INSERT INTO users(id,email,password_hash) VALUES('${USER2}','f06b@example.test','fixture');
INSERT INTO memberships(tenant_id,user_id) VALUES('${TENANT}','${USER}');
INSERT INTO memberships(tenant_id,user_id) VALUES('${TENANT2}','${USER2}');
INSERT INTO provider_users(user_id,role) VALUES('${USER}','owner');
INSERT INTO provider_users(user_id,role) VALUES('${USER2}','operator');
INSERT INTO provider_company_assignments(user_id,tenant_id) VALUES('${USER2}','${TENANT}');
-- Suscripción VPN activa para TENANT
INSERT INTO plans(id,code,name,modules) VALUES('aaaaaaaa-4aaa-4aaa-4aaa-aaaaaaaaaaaf','f06-plan','F06 Plan','{"vpn":true}');
INSERT INTO subscriptions(tenant_id,plan_id,state) VALUES('${TENANT}','aaaaaaaa-4aaa-4aaa-4aaa-aaaaaaaaaaaf','active');
-- Nodos aprobados
INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES('${NODE_INV}',decode(repeat('aa',32),'hex'),now()+interval '1 hour',1,'${USER}');
INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES('${NODE_INV2}',decode(repeat('bb',32),'hex'),now()+interval '1 hour',1,'${USER}');
INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${NODE}','${NODE_INV}','Node F06','approved','fixture','f06-node-a',decode(repeat('cc',32),'hex'),now(),now(),'${USER}');
INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES('${NODE2}','${NODE_INV2}','Node F06-B','approved','fixture','f06-node-b',decode(repeat('dd',32),'hex'),now(),now(),'${USER}');
`);

  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'runtime-fixture-password';");

  const port = run('docker', ['inspect', '--format',
    '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]).trim();
  const pool = new Pool({ connectionString: `postgres://nexo_runtime:runtime-fixture-password@127.0.0.1:${port}/nexo`, max: 4 });
  const repo = new PostgresVpnEnvironmentRepository(pool);

  // 1. Crear entorno VPN — debe generar namespace_name con patrón nexo-[a-f0-9]{12}
  const env1 = await repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Oficina Central', listenerPort: 1194, tunnelIpv4Cidr: '10.8.0.0/24' }, USER);
  assert.equal(env1.engine, 'openvpn');
  assert.equal(env1.protocol, 'udp');
  assert.equal(env1.desiredState, 'active');
  assert.equal(env1.observedState, 'pending');
  assert.equal(env1.revision, 1);
  assert.equal(env1.ipv6Enabled, false);
  assert.ok(/^nexo-[a-f0-9]{12}$/.test(env1.namespaceName), `namespace_name inválido: ${env1.namespaceName}`);
  assert.equal(env1.listenerPort, 1194);

  // 2. Idempotencia de lista
  const list1 = await repo.list(USER);
  assert.equal(list1.length, 1);
  assert.equal(list1[0].id, env1.id);

  // 3. Conflicto de puerto en el mismo nodo
  await assert.rejects(
    () => repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Sucursal A', listenerPort: 1194, tunnelIpv4Cidr: '10.9.0.0/24' }, USER),
    /environment_conflict/,
  );

  // 4. Puerto distinto en el mismo nodo — debe funcionar
  const env2 = await repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Sucursal A', listenerPort: 1195, tunnelIpv4Cidr: '10.9.0.0/24' }, USER);
  assert.notEqual(env2.namespaceName, env1.namespaceName);
  assert.deepEqual((await repo.desired(NODE)).map(environment => environment.id).sort(), [env1.id, env2.id].sort());
  assert.deepEqual(await repo.desired(NODE2), []);

  // 5. Tenant sin suscripción VPN activa es rechazado
  await assert.rejects(
    () => repo.create({ tenantId: TENANT2, nodeId: NODE, name: 'Sin licencia', listenerPort: 1196, tunnelIpv4Cidr: '10.10.0.0/24' }, USER),
    /vpn_not_entitled/,
  );
  await assert.rejects(
    () => repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Público', listenerPort: 1196, tunnelIpv4Cidr: '203.0.113.0/24' }, USER),
    /vpn_environments_tunnel_ipv4_cidr_check/,
  );
  psql(`INSERT INTO subscriptions(tenant_id,plan_id,state) VALUES('${TENANT2}','aaaaaaaa-4aaa-4aaa-4aaa-aaaaaaaaaaaf','active');`);
  const otherTenantEnvironment = await repo.create({ tenantId: TENANT2, nodeId: NODE2, name: 'Empresa B', listenerPort: 1194, tunnelIpv4Cidr: '10.10.0.0/24' }, USER);
  assert.deepEqual((await repo.desired(NODE2)).map(environment => environment.id), [otherTenantEnvironment.id]);

  // 6. Nodo no aprobado/inexistente es rechazado
  await assert.rejects(
    () => repo.create({ tenantId: TENANT, nodeId: randomUUID(), name: 'Nodo X', listenerPort: 1197, tunnelIpv4Cidr: '10.11.0.0/24' }, USER),
    /invalid_node/,
  );

  // 7. Operator puede listar (asignado a TENANT) pero no mutar
  const opList = await repo.list(USER2);
  assert.ok(opList.length >= 1);
  assert.ok(opList.every(environment => environment.tenantId === TENANT));
  assert.equal(opList.some(environment => environment.id === otherTenantEnvironment.id), false);
  await assert.rejects(
    () => repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Op create', listenerPort: 1200, tunnelIpv4Cidr: '10.20.0.0/24' }, USER2),
    /forbidden/,
  );

  // 8. Cambio de estado con revisión correcta
  assert.equal(await repo.report(env1.id, NODE, { revision: 1, observedState: 'provisioning' }), true);
  assert.equal((await repo.list(USER)).find(environment => environment.id === env1.id).appliedRevision, undefined);
  const suspended = await repo.changeState(env1.id, { desiredState: 'suspended', expectedRevision: 1 }, USER);
  assert.ok(suspended);
  assert.equal(suspended.desiredState, 'suspended');
  assert.equal(suspended.revision, 2);
  assert.equal(suspended.observedState, 'pending');

  // 9. Conflicto de revisión
  await assert.rejects(
    () => repo.changeState(env1.id, { desiredState: 'active', expectedRevision: 1 }, USER),
    /revision_conflict/,
  );

  // 10. Agente reporta estado observado (requiere nodeId correcto)
  const reported = await repo.report(env1.id, NODE, { revision: 2, observedState: 'suspended', configDigest: 'a'.repeat(64) });
  assert.equal(reported, true);
  const afterReport = await repo.list(USER);
  const env1After = afterReport.find(e => e.id === env1.id);
  assert.equal(env1After.observedState, 'suspended');
  assert.equal(env1After.appliedRevision, 2);
  assert.equal(env1After.configDigest, 'a'.repeat(64));

  // 11. Nodo incorrecto no puede reportar
  const wrongNode = await repo.report(env1.id, NODE2, { revision: 2, observedState: 'active' });
  assert.equal(wrongNode, false);

  // 12. Revisión obsoleta en reporte es rechazada
  const stale = await repo.report(env1.id, NODE, { revision: 1, observedState: 'active' });
  assert.equal(stale, false);

  // 13. Retirar entorno
  const retired = await repo.changeState(env1.id, { desiredState: 'retired', expectedRevision: 2 }, USER);
  assert.ok(retired);
  assert.equal(retired.desiredState, 'retired');

  // 14. Entorno retirado no puede reactivarse
  await assert.rejects(
    () => repo.changeState(env1.id, { desiredState: 'active', expectedRevision: 3 }, USER),
    /retired_environment/,
  );

  // 15. La retirada conserva historial pero libera el puerto en el nodo.
  const replacement = await repo.create({ tenantId: TENANT, nodeId: NODE, name: 'Reemplazo', listenerPort: 1194, tunnelIpv4Cidr: '10.12.0.0/24' }, USER);
  assert.notEqual(replacement.id, env1.id);
  assert.equal((await repo.list(USER)).find(e => e.id === env1.id)?.desiredState, 'retired');

  await pool.end();
  console.log(JSON.stringify({
    phase: 'F06',
    postgres: 'PASS',
    runtimeRole: 'PASS',
    namespacePattern: 'PASS',
    portConflict: 'PASS',
    vpnEntitlement: 'PASS',
    operatorRLS: 'PASS',
    revisionConflict: 'PASS',
    agentReport: 'PASS',
    wrongNodeReport: 'PASS',
    retiredGuard: 'PASS',
    image,
  }));
} finally {
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
