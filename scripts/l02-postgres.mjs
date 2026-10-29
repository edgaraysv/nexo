import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { createProductApplication } from '../dist/product/application.js';
import { PostgresIdentityRepository } from '../dist/product/postgres-repository.js';
import { PostgresProviderRepository } from '../dist/product/postgres-provider-repository.js';
import { hashPassword, sealSecret } from '../dist/product/security.js';

const name = `nexo-l02-${randomUUID().slice(0, 8)}`;
const image = process.env.L02_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_PASSWORD=l02-fixture-password', '-e', 'POSTGRES_DB=nexo_l02', image]);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('docker', ['exec', name, 'psql', '-U', 'postgres', '-d', 'nexo_l02', '-c', 'SELECT 1'], { encoding: 'utf8' });
    if (result.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');
  for (const file of ['db/migrations/001_l02_identity.sql', 'db/migrations/002_l03_provider.sql', 'db/tests/l02_rls.sql']) {
    run('docker', ['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo_l02'], { input: await readFile(file, 'utf8') });
  }
  const port = run('docker', ['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', name]).trim();
  const admin = new Pool({ connectionString: `postgres://postgres:l02-fixture-password@127.0.0.1:${port}/nexo_l02`, max: 1 });
  const key = Buffer.alloc(32, 9); const userId = '33333333-3333-4333-8333-333333333333'; const operatorId = '44444444-4444-4444-8444-444444444444'; const tenantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; const secret = 'JBSWY3DPEHPK3PXP';
  await admin.query('INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,$3)', [tenantId, 'empresa-c', 'Empresa C']);
  await admin.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [userId, 'owner@example.test', await hashPassword('correct horse battery staple')]);
  await admin.query('INSERT INTO memberships(tenant_id,user_id) VALUES($1,$2)', [tenantId, userId]);
  await admin.query("INSERT INTO mfa_factors(user_id,type,secret_ciphertext,enabled_at) VALUES($1,'totp',$2,now())", [userId, sealSecret(secret, key)]);
  await admin.query("INSERT INTO provider_users(user_id,role) VALUES($1,'owner')", [userId]);
  await admin.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [operatorId, 'operator@example.test', await hashPassword('correct horse battery staple')]);
  await admin.query("INSERT INTO mfa_factors(user_id,type,secret_ciphertext,enabled_at) VALUES($1,'totp',$2,now())", [operatorId, sealSecret(secret, key)]);
  await admin.query("INSERT INTO provider_users(user_id,role) VALUES($1,'operator')", [operatorId]);
  await admin.end();
  const runtimePool = new Pool({ connectionString: `postgres://nexo_l02_runtime:l02-runtime-fixture-password@127.0.0.1:${port}/nexo_l02`, max: 3 });
  const deliveries = []; const repository = new PostgresIdentityRepository(runtimePool, key); const provider = new PostgresProviderRepository(runtimePool); const app = await createProductApplication(repository, { deliver: async (email, token) => deliveries.push({ email, token }) }, provider); await app.init(); await app.getHttpAdapter().getInstance().ready();
  try {
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } }); assert.equal(login.statusCode, 200);
    const counter = Math.floor(Date.now() / 30_000); const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(counter)); const bytes = Buffer.from('48656c6c6f21deadbeef', 'hex'); const digest = createHmac('sha1', bytes).update(payload).digest(); const offset = digest.at(-1) & 15; const code = String((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000).padStart(6, '0');
    const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code } }); assert.equal(mfa.statusCode, 200); assert.equal(mfa.json().memberships.length, 1);
    const selected = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: mfa.json().selection, tenant_id: tenantId } }); assert.equal(selected.statusCode, 200);
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${selected.json().token}` } }); assert.equal(me.statusCode, 200); assert.equal(me.json().tenant.id, tenantId);
    await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: { authorization: `Bearer ${selected.json().token}` } });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${selected.json().token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/recovery/request', payload: { email: 'owner@example.test' } })).statusCode, 202); assert.equal(deliveries.length, 1);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/recovery/confirm', payload: { token: deliveries[0].token, new_password: 'new correct horse battery staple' } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'new correct horse battery staple' } })).statusCode, 200);
    const providerLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'new correct horse battery staple' } });
    const providerMfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: providerLogin.json().challenge, code } }); assert.equal(providerMfa.json().provider.role, 'owner');
    const providerSession = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: providerMfa.json().selection, scope_kind: 'provider' } }); assert.equal(providerSession.statusCode, 200); const providerHeaders = { authorization: `Bearer ${providerSession.json().token}` };
    const company = await app.inject({ method: 'POST', url: '/v1/provider/companies', headers: providerHeaders, payload: { slug: 'empresa-provider', name: 'Empresa Provider' } }); assert.equal(company.statusCode, 201);
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/provider/companies/${company.json().id}/operators/${operatorId}`, headers: providerHeaders })).statusCode, 204);
    const plan = await app.inject({ method: 'POST', url: '/v1/provider/plans', headers: providerHeaders, payload: { code: 'local', name: 'Local', modules: { vpn: true }, quotas: { endpoints: 1 } } }); assert.equal(plan.statusCode, 201);
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/provider/companies/${company.json().id}/subscription`, headers: providerHeaders, payload: { plan_id: plan.json().id, state: 'active' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/provider/companies/${company.json().id}/quotas/endpoints/reserve`, headers: providerHeaders, payload: { amount: 1 } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/provider/companies/${company.json().id}/quotas/endpoints/reserve`, headers: providerHeaders, payload: { amount: 1 } })).statusCode, 409);
    const setting = await app.inject({ method: 'PUT', url: '/v1/provider/settings/aws.workload_role', headers: providerHeaders, payload: { sensitivity: 'secret_ref', secret_ref: 'local://fixture/aws-role' } }); assert.equal(setting.statusCode, 200); assert.equal(JSON.stringify(setting.json()).includes('local://fixture'), false);
    const operatorLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'operator@example.test', password: 'correct horse battery staple' } }); const operatorMfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: operatorLogin.json().challenge, code } }); const operatorSession = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: operatorMfa.json().selection, scope_kind: 'provider' } }); const operatorCompanies = await app.inject({ method: 'GET', url: '/v1/provider/companies', headers: { authorization: `Bearer ${operatorSession.json().token}` } }); assert.deepEqual(operatorCompanies.json().items.map(item => item.id), [company.json().id]);
  } finally { await app.close(); await repository.close(); }
  console.log(JSON.stringify({ phases: ['L02','L03'], postgres: 'PASS', isolation: 'PASS', identity_flow: 'PASS', provider_flow: 'PASS', image }));
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
