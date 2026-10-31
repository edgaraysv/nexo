import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { runMigrationProfile } from './migration-test-support.mjs';
import { PostgresSupportRepository } from '../dist/product/postgres-support-repository.js';
import { SyntheticSupportTransport } from '../dist/product/support-transport.js';

const container = `nexo-f10-${randomUUID().slice(0, 8)}`;
const image = process.env.F10_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const password = 'f10-fixture-password';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10';
const USER = '11111111-1111-4111-8111-111111111110';
const INVITATION = '22222222-2222-4222-8222-222222222210';
const DEVICE = '33333333-3333-4333-8333-333333333310';
const LEGACY_PENDING = '44444444-4444-4444-8444-444444444410';
const LEGACY_ACCEPTED = '55555555-5555-4555-8555-555555555510';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(input) {
  return run('docker', ['exec', '-i', container, 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo'], { input });
}

function scalar(sql) {
  return run('docker', ['exec', container, 'psql', '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo', '-c', sql]).trim();
}

class DeferredTransport {
  kind = 'synthetic_test';
  sessions = new Map();
  ended = new Set();
  #started;
  #release;
  started = new Promise(resolve => { this.#started = resolve; });
  #opened = new Promise(resolve => { this.#release = resolve; });

  async open(input) {
    this.key = input.idempotencyKey;
    this.#started();
    return this.#opened;
  }

  async findByIdempotencyKey({ idempotencyKey }) {
    const engineSessionId = this.sessions.get(idempotencyKey);
    if (engineSessionId) return { status: 'opened', engineSessionId };
    return this.key === idempotencyKey ? { status: 'pending' } : { status: 'not_found' };
  }

  async terminate({ engineSessionId }) {
    this.ended.add(engineSessionId);
    for (const [key, value] of this.sessions) if (value === engineSessionId) this.sessions.delete(key);
  }

  release() {
    const engineSessionId = `race-${randomUUID()}`;
    this.sessions.set(this.key, engineSessionId);
    this.#release({ engineSessionId });
  }
}

let pool;
try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=nexo', image]);
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    if (spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']).status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  const port = runMigrationProfile(container, 'f09-local', password);
  psql(`
    INSERT INTO tenants(id,slug,display_name) VALUES('${TENANT}','f10-local','F10 Local');
    INSERT INTO users(id,email,password_hash) VALUES('${USER}','f10@example.test','fixture');
    INSERT INTO memberships(tenant_id,user_id,status) VALUES('${TENANT}','${USER}','active');
    INSERT INTO roles(tenant_id,name) VALUES('${TENANT}','company.admin');
    INSERT INTO membership_roles(tenant_id,user_id,role_id)
      SELECT '${TENANT}','${USER}',id FROM roles WHERE tenant_id='${TENANT}' AND name='company.admin';
    INSERT INTO role_permissions(role_id,permission_id)
      SELECT id,'company.support.start' FROM roles WHERE tenant_id='${TENANT}' AND name='company.admin'
      ON CONFLICT DO NOTHING;
    INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by)
      VALUES('${INVITATION}','${TENANT}',decode(repeat('aa',32),'hex'),'endpoint',0,now()+interval '1 hour','${USER}');
    INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by)
      VALUES('${DEVICE}','${TENANT}','${INVITATION}','F10 endpoint','endpoint','endpoint','approved','fixture','f10-device',decode(repeat('bb',32),'hex'),now(),now(),'${USER}');
    INSERT INTO plans(code,name,modules,quotas) VALUES('f10-local','F10 local','{"support":true}','{}');
    INSERT INTO subscriptions(tenant_id,plan_id,state) SELECT '${TENANT}',id,'active' FROM plans WHERE code='f10-local';
    INSERT INTO support_sessions(id,tenant_id,device_identity_id,requested_by_user_id,mode,capabilities,status,consent_expires_at,expires_at)
      VALUES('${LEGACY_PENDING}','${TENANT}','${DEVICE}','${USER}','assisted',ARRAY['screen'],'pending_consent',now()+interval '1 minute',now()+interval '15 minutes'),
            ('${LEGACY_ACCEPTED}','${TENANT}','${DEVICE}','${USER}','assisted',ARRAY['screen'],'consented',now()+interval '1 minute',now()+interval '15 minutes');
    INSERT INTO support_consent(tenant_id,support_session_id,device_identity_id,decision,requested_at,expires_at,responded_at,responded_by_device_id)
      VALUES('${TENANT}','${LEGACY_PENDING}','${DEVICE}','pending',now(),now()+interval '1 minute',NULL,NULL),
            ('${TENANT}','${LEGACY_ACCEPTED}','${DEVICE}','accepted',now(),now()+interval '1 minute',now(),'${DEVICE}');
  `);

  runMigrationProfile(container, 'f10-local', password);
  assert.equal(scalar(`SELECT c.status||'|'||c.decision_origin||'|'||s.status FROM support_consent c JOIN support_sessions s ON s.tenant_id=c.tenant_id AND s.id=c.session_id WHERE c.session_id='${LEGACY_PENDING}'`), 'rejected|migration_021|rejected');
  assert.equal(scalar(`SELECT c.status||'|'||c.decision_origin||'|'||(c.accepted_at IS NOT NULL)::text||'|'||(c.nonce_hash IS NULL)::text FROM support_consent c WHERE c.session_id='${LEGACY_ACCEPTED}'`), 'accepted|legacy_api|true|true');
  psql(`INSERT INTO resource_grants(tenant_id,user_id,resource_type,resource_id,device_identity_id,permission_id,granted_by)
    VALUES('${TENANT}','${USER}','device_identity','${DEVICE}','${DEVICE}','company.support.start','${USER}');`);

  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));
  psql(`ALTER ROLE nexo_runtime PASSWORD '${password}';`);
  pool = new Pool({ connectionString: `postgres://nexo_runtime:${password}@127.0.0.1:${port}/nexo`, max: 4, connectionTimeoutMillis: 5_000 });
  const transport = new SyntheticSupportTransport({ openBeforeCreation: 1, terminate: 1 });
  const repository = new PostgresSupportRepository(pool, transport, { allowSyntheticTestTransport: true });
  const input = { tenantId: TENANT, deviceId: DEVICE, requesterUserId: USER, capabilities: ['screen'], consentTimeoutSeconds: 60 };
  const requested = await repository.createRequest(input);
  assert.ok(requested);
  assert.equal(requested.consent.status, 'pending');
  const pending1 = await repository.listPendingForDevice({ tenantId: TENANT, deviceId: DEVICE });
  const pending2 = await repository.listPendingForDevice({ tenantId: TENANT, deviceId: DEVICE });
  assert.equal(pending1.length, 1);
  assert.equal(pending2.length, 1);
  const expectedHash = createHash('sha256').update(pending2[0].consentNonce).digest('hex');
  assert.equal(scalar(`SELECT encode(nonce_hash,'hex') FROM support_consent WHERE session_id='${requested.id}'`), expectedHash);
  assert.equal(await repository.respondToConsent({ tenantId: TENANT, deviceId: DEVICE, sessionId: requested.id, decision: 'accepted', nonce: pending1[0].consentNonce }), 'invalid_nonce');
  assert.equal(await repository.respondToConsent({ tenantId: TENANT, deviceId: DEVICE, sessionId: requested.id, decision: 'accepted', nonce: pending2[0].consentNonce }), 'updated');
  assert.equal(await repository.respondToConsent({ tenantId: TENANT, deviceId: DEVICE, sessionId: requested.id, decision: 'accepted', nonce: pending2[0].consentNonce }), 'already_decided');

  const opened = await repository.openSession({ tenantId: TENANT, requesterUserId: USER, sessionId: requested.id });
  assert.equal(opened.status, 'opened');
  assert.equal(opened.session.openAttempts, 2);
  assert.equal(transport.sessions.size, 1);
  const unscopedRead = await pool.query('SELECT 1 FROM support_consent WHERE session_id=$1', [requested.id]);
  assert.equal(unscopedRead.rows.length, 0, 'tenant RLS denies an unscoped runtime read');
  assert.equal(scalar(`SELECT (c.nonce_consumed_at IS NOT NULL)::text||'|'||c.decided_by_device_id::text||'|'||s.open_attempt_count::text||'|'||s.engine_session_id||'|'||encode(c.nonce_hash,'hex') FROM support_consent c JOIN support_sessions s ON s.tenant_id=c.tenant_id AND s.id=c.session_id WHERE c.session_id='${requested.id}'`), `true|${DEVICE}|2|${opened.session.engineSessionId}|${expectedHash}`, 'only the one-way nonce hash is persisted');

  assert.equal(await repository.revokeByRequester({ tenantId: TENANT, requesterUserId: USER, sessionId: requested.id }), true);
  assert.equal((await repository.getForRequester({ tenantId: TENANT, requesterUserId: USER, sessionId: requested.id })).terminationStatus, 'failed');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(await repository.dispatchTerminationOutbox('f10-worker', 10), 1);
  const revoked = await repository.getForRequester({ tenantId: TENANT, requesterUserId: USER, sessionId: requested.id });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.terminationStatus, 'confirmed');
  assert.equal(revoked.consent.status, 'accepted', 'revocation does not rewrite consent history');
  assert.equal(transport.sessions.size, 0);

  const raceTransport = new DeferredTransport();
  const raceRepository = new PostgresSupportRepository(pool, raceTransport, { allowSyntheticTestTransport: true });
  const raceRequest = await raceRepository.createRequest(input);
  assert.ok(raceRequest);
  const raceNonce = (await raceRepository.listPendingForDevice({ tenantId: TENANT, deviceId: DEVICE }))[0].consentNonce;
  assert.equal(await raceRepository.respondToConsent({ tenantId: TENANT, deviceId: DEVICE, sessionId: raceRequest.id, decision: 'accepted', nonce: raceNonce }), 'updated');
  const openingPromise = raceRepository.openSession({ tenantId: TENANT, requesterUserId: USER, sessionId: raceRequest.id });
  await raceTransport.started;
  assert.equal(await raceRepository.revokeByRequester({ tenantId: TENANT, requesterUserId: USER, sessionId: raceRequest.id }), true);
  raceTransport.release();
  const racedOpen = await openingPromise;
  assert.equal(racedOpen.status, 'open_failed');
  assert.equal(racedOpen.session.status, 'revoked');
  await new Promise(resolve => setTimeout(resolve, 1_100));
  assert.equal(await raceRepository.dispatchTerminationOutbox('f10-race-worker', 10), 1);
  assert.equal((await raceRepository.getForRequester({ tenantId: TENANT, requesterUserId: USER, sessionId: raceRequest.id })).terminationStatus, 'confirmed');
  assert.equal(raceTransport.ended.size, 1);

  const audit = await scalar(`SELECT count(*) FROM support_session_attempts WHERE tenant_id='${TENANT}' AND operation='open' AND outcome='succeeded'`);
  assert.equal(Number(audit), 2);
  await pool.end();
  pool = undefined;
  console.log(JSON.stringify({ phase: 'F10 PostgreSQL lifecycle', postgres: image, migrations: '020→021 upgrade with legacy backfill PASS', runtimeRlsAndGrants: 'PASS', consentNonceHashAndReplay: 'PASS', definiteOpenRetry: 'PASS', revocationOutboxRetry: 'PASS', revocationDuringOpening: 'PASS', remoteTransport: 'NOT RUN (synthetic only)' }));
} finally {
  if (pool) await pool.end().catch(() => {});
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
