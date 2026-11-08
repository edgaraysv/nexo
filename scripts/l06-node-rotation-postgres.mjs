import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { PostgresNodeRepository } from '../dist/product/postgres-node-repository.js';
import { runMigrationProfile } from './migration-test-support.mjs';

const container = `nexo-l06-rotation-${randomUUID().slice(0, 8)}`;
const image = process.env.L06_ROTATION_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const password = 'l06-rotation-fixture-password';
const USER = '11111111-1111-4111-8111-111111111126';
const INVITATION = '22222222-2222-4222-8222-222222222226';
const NODE = '33333333-3333-4333-8333-333333333336';
const PENDING_INVITATION = '44444444-4444-4444-8444-444444444446';
const PENDING_NODE = '55555555-5555-4555-8555-555555555556';
let pool;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function psql(input) {
  return run('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo'], { input });
}

try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=nexo', image]);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (spawnSync('docker', ['exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']).status === 0) {
      ready = true;
      break;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');

  const port = runMigrationProfile(container, 'f08-local', password);
  psql(`
    INSERT INTO users(id,email,password_hash) VALUES('${USER}','rotation-owner@example.test','fixture');
    INSERT INTO provider_users(user_id,role) VALUES('${USER}','owner');
    INSERT INTO provider_node_invitations(id,token_hash,expires_at,uses_remaining,created_by) VALUES
      ('${INVITATION}',decode(repeat('11',32),'hex'),now()+interval '1 hour',0,'${USER}'),
      ('${PENDING_INVITATION}',decode(repeat('22',32),'hex'),now()+interval '1 hour',0,'${USER}');
    INSERT INTO provider_nodes(id,invitation_id,name,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by) VALUES
      ('${NODE}','${INVITATION}','Approved expired node','approved','fixture-public-key','rotation-node',decode(repeat('33',32),'hex'),now(),now(),'${USER}'),
      ('${PENDING_NODE}','${PENDING_INVITATION}','Pending node','pending','fixture-public-key','rotation-pending',decode(repeat('44',32),'hex'),NULL,NULL,NULL);
    INSERT INTO node_credentials(node_id,serial,certificate_pem,not_before,not_after) VALUES
      ('${NODE}','PG-NODE-OLD','expired-certificate',now()-interval '2 days',now()-interval '1 day'),
      ('${PENDING_NODE}','PG-NODE-PENDING','pending-certificate',now()-interval '2 days',now()-interval '1 day');
  `);
  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));
  psql("ALTER ROLE nexo_runtime PASSWORD 'l06-rotation-runtime-password';");
  pool = new Pool({ connectionString: `postgresql://nexo_runtime:l06-rotation-runtime-password@127.0.0.1:${port}/nexo`, max: 8 });
  const nodes = new PostgresNodeRepository(pool);

  const requests = await Promise.all([
    nodes.requestCredentialRotation({ nodeId: NODE, idempotencyKey: 'l06-node-rotation-idem-01', actor: USER, expiresAt: Date.now() + 15 * 60_000 }),
    nodes.requestCredentialRotation({ nodeId: NODE, idempotencyKey: 'l06-node-rotation-idem-01', actor: USER, expiresAt: Date.now() + 15 * 60_000 }),
  ]);
  assert.ok(requests.every(Boolean));
  assert.equal(requests[0].id, requests[1].id);
  assert.deepEqual(requests.map(value => value.created).sort(), [false, true]);
  await assert.rejects(
    () => nodes.requestCredentialRotation({ nodeId: NODE, idempotencyKey: 'l06-node-rotation-other-01', actor: USER, expiresAt: Date.now() + 15 * 60_000 }),
    /credential_rotation_pending/u,
  );
  assert.equal(await nodes.requestCredentialRotation({ nodeId: PENDING_NODE, idempotencyKey: 'l06-node-rotation-pending', actor: USER, expiresAt: Date.now() + 15 * 60_000 }), undefined);

  const rotationId = requests[0].id;
  const proof = await nodes.rotationProof(rotationId, NODE);
  assert.equal(proof?.status, 'pending');
  const claims = await Promise.all([
    nodes.claimCredentialRotation(rotationId, NODE),
    nodes.claimCredentialRotation(rotationId, NODE),
  ]);
  assert.deepEqual(claims.sort(), [false, true], 'only one concurrent completer may reserve issuance');
  const notBefore = new Date(Date.now() - 60_000).toISOString();
  const notAfter = new Date(Date.now() + 30 * 24 * 60 * 60_000 + 60_000).toISOString();
  assert.equal(await nodes.completeCredentialRotation(rotationId, NODE, {
    serial: 'PG-NODE-NEW', certificatePem: 'new-certificate', notBefore, notAfter,
  }), true);
  assert.equal(await nodes.completeCredentialRotation(rotationId, NODE, {
    serial: 'PG-NODE-SECOND', certificatePem: 'duplicate-certificate', notBefore, notAfter,
  }), false);
  assert.equal(await nodes.credentialStatus(NODE, 'PG-NODE-OLD'), 'rotated');
  assert.equal(await nodes.credentialStatus(NODE, 'PG-NODE-NEW'), 'active');
  const replay = await nodes.rotationProof(rotationId, NODE);
  assert.equal(replay?.status, 'completed');
  assert.equal(replay?.certificate?.serial, 'PG-NODE-NEW');
  assert.equal((await nodes.list()).find(node => node.id === NODE)?.status, 'approved');

  await pool.end();
  pool = undefined;
  console.log(JSON.stringify({ phase: 'L06 node credential rotation', postgres: 'PASS', idempotency: 'PASS', oneOpenRotation: 'PASS', concurrentIssuanceClaim: 'PASS', credentialHistory: 'PASS', approvedStatusPreserved: 'PASS', rlsRuntimeRole: 'PASS', image }));
} finally {
  if (pool) await pool.end().catch(() => {});
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
}
