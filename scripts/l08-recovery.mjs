import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHECKPOINT_SCHEMA,
  RECOVERY_SCHEMA,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  signSecurityCheckpoint,
  verifySecurityCheckpoint
} from '../dist/product/recovery.js';

const image = process.env.L08_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const source = `nexo-l08-source-${randomUUID().slice(0, 8)}`;
const restored = `nexo-l08-restored-${randomUUID().slice(0, 8)}`;
const archiveDir = await mkdtemp('/mnt/c/laragon/tmp/nexo-l08-archive-');
const custodyDir = await mkdtemp('/tmp/opencode/nexo-l08-custody-');
const restoreDir = await mkdtemp('/tmp/opencode/nexo-l08-restored-');
const startedAt = Date.now();
const migrations = [
  'db/migrations/001_l02_identity.sql',
  'db/migrations/002_l03_provider.sql',
  'db/migrations/003_l04_company_portal.sql',
  'db/migrations/004_l05_device_identity.sql',
  'db/migrations/005_l06_operations.sql',
  'db/migrations/006_l06_node_restore.sql',
  'db/migrations/007_f03_company_authorization.sql',
  'db/migrations/008_f04_commercial_capabilities.sql',
  'db/migrations/009_f05_operation_reliability.sql',
  'db/migrations/010_f06_vpn_environments.sql'
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function waitForPostgres(container, database) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', database, '-c', 'SELECT 1']).status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      if (spawnSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', database, '-c', 'SELECT 1']).status === 0) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL ${container} did not become ready`);
}

function psql(container, database, sql) {
  return run('docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { input: sql });
}

try {
  run('docker', ['image', 'inspect', image]);
  for (const [container, database, password] of [[source, 'nexo_source', 'source-fixture'], [restored, 'nexo_restored', 'restore-fixture']]) {
    run('docker', ['run', '--rm', '-d', '--name', container, '--network', 'none', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, image]);
    waitForPostgres(container, database);
  }

  for (const migration of migrations) psql(source, 'nexo_source', await readFile(migration, 'utf8'));
  psql(source, 'nexo_source', await readFile('db/tests/l02_rls.sql', 'utf8'));

  const tenant = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const user = '11111111-1111-4111-8111-111111111111';
  const invitation = '88888888-8888-4888-8888-888888888881';
  const device = '88888888-8888-4888-8888-888888888882';
  const sessionHash = randomBytes(32).toString('hex');
  psql(source, 'nexo_source', `
    INSERT INTO device_invitations(id,tenant_id,token_hash,device_kind,uses_remaining,expires_at,created_by)
      VALUES('${invitation}','${tenant}',decode('${randomBytes(32).toString('hex')}','hex'),'endpoint',0,now()+interval '1 hour','${user}');
    INSERT INTO device_identities(id,tenant_id,invitation_id,name,device_kind,audience,status,public_key_pem,key_fingerprint,claim_token_hash,proof_verified_at,approved_at,approved_by)
      VALUES('${device}','${tenant}','${invitation}','L08 Restore Device','endpoint','endpoint','approved','fixture-public','fixture-fingerprint',decode('${randomBytes(32).toString('hex')}','hex'),now(),now(),'${user}');
    INSERT INTO device_credentials(tenant_id,device_id,serial,certificate_pem,not_before,not_after)
      VALUES('${tenant}','${device}','l08-serial','fixture-cert',now()-interval '1 minute',now()+interval '1 day');
    INSERT INTO device_sessions(token_hash,tenant_id,device_id,expires_at)
      VALUES(decode('${sessionHash}','hex'),'${tenant}','${device}',now()+interval '1 hour');
  `);

  const roleState = run('docker', ['exec', source, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_source', '-c', "SELECT rolsuper||'|'||rolbypassrls||'|'||rolinherit FROM pg_roles WHERE rolname='nexo_l02_runtime'"]).trim();
  assert.equal(roleState, 'false|false|false');
  const databaseSql = run('docker', ['exec', source, 'pg_dump', '--no-owner', '--no-acl', '-U', 'postgres', '-d', 'nexo_source']);
  const emissionSecret = randomBytes(48).toString('base64');
  const payload = {
    schema: RECOVERY_SCHEMA,
    databaseSql,
    roles: [{ name: 'nexo_l02_runtime', superuser: false, bypassRls: false, inherit: false }],
    configuration: { schemaVersion: 6, environment: 'local-fixture', databaseCredentialReference: 'restore-operator-supplied' },
    emission: { kind: 'development-fixture', privateMaterial: emissionSecret }
  };

  const keyV1 = randomBytes(32), keyV2 = randomBytes(32), checkpointKey = randomBytes(32);
  await writeFile(join(custodyDir, 'recovery-v1.key'), keyV1, { mode: 0o600 });
  await writeFile(join(custodyDir, 'recovery-v2.key'), keyV2, { mode: 0o600 });
  await writeFile(join(custodyDir, 'checkpoint.key'), checkpointKey, { mode: 0o600 });
  const bundleV1 = encryptRecoveryBundle(payload, keyV1, 'local-v1');
  const bundleV2 = encryptRecoveryBundle(payload, keyV2, 'local-v2');
  await writeFile(join(archiveDir, 'control-v1.nexo'), bundleV1, { mode: 0o600 });
  await writeFile(join(archiveDir, 'control-v2.nexo'), bundleV2, { mode: 0o600 });
  assert.equal(decryptRecoveryBundle(bundleV1, keyV1, 'local-v1').schema, RECOVERY_SCHEMA);
  assert.equal(decryptRecoveryBundle(bundleV2, keyV2, 'local-v2').schema, RECOVERY_SCHEMA);
  assert.throws(() => decryptRecoveryBundle(bundleV1, keyV2, 'local-v1'));
  assert.doesNotMatch(bundleV2.toString('utf8'), new RegExp(emissionSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const postBackupOperation = randomUUID();
  psql(source, 'nexo_source', `
    UPDATE device_identities SET status='revoked',revoked_at=now() WHERE id='${device}';
    UPDATE device_credentials SET status='revoked' WHERE device_id='${device}';
    UPDATE device_sessions SET revoked_at=now() WHERE device_id='${device}';
    UPDATE control_security_state SET epoch=epoch+1,updated_at=now();
    INSERT INTO operations(id,tenant_id,target_device_id,type,idempotency_key,expires_at,created_by,revision)
      VALUES('${postBackupOperation}','${tenant}','${device}','endpoint.runtime_info.v1','l08-post-backup-operation',now()+interval '5 minutes','${user}',1);
  `);
  const checkpoint = signSecurityCheckpoint({
    schema: CHECKPOINT_SCHEMA,
    epoch: 2,
    issuedAt: new Date().toISOString(),
    revokedDeviceIds: [device],
    missingOperationIds: [postBackupOperation]
  }, checkpointKey);
  await writeFile(join(custodyDir, 'security-checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  assert.throws(() => verifySecurityCheckpoint({ ...checkpoint, mac: '00'.repeat(32) }, checkpointKey, 2));
  assert.throws(() => verifySecurityCheckpoint(checkpoint, checkpointKey, 3));

  const recovered = decryptRecoveryBundle(await readFile(join(archiveDir, 'control-v2.nexo')), await readFile(join(custodyDir, 'recovery-v2.key')), 'local-v2');
  const restoredSql = join(restoreDir, 'control.sql');
  const restoredConfig = join(restoreDir, 'configuration.json');
  const restoredEmission = join(restoreDir, 'emission.json');
  await writeFile(restoredSql, recovered.databaseSql, { mode: 0o600 });
  await writeFile(restoredConfig, JSON.stringify(recovered.configuration), { mode: 0o600 });
  await writeFile(restoredEmission, JSON.stringify(recovered.emission), { mode: 0o600 });
  psql(restored, 'nexo_restored', await readFile(restoredSql, 'utf8'));
  psql(restored, 'nexo_restored', `
    CREATE ROLE nexo_l02_runtime LOGIN PASSWORD 'restored-runtime-fixture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO nexo_l02_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexo_l02_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexo_l02_runtime;
  `);
  const verifiedCheckpoint = verifySecurityCheckpoint(JSON.parse(await readFile(join(custodyDir, 'security-checkpoint.json'), 'utf8')), await readFile(join(custodyDir, 'checkpoint.key')), 2);
  psql(restored, 'nexo_restored', `
    UPDATE control_security_state SET quarantined=true,checkpoint_epoch=${verifiedCheckpoint.epoch},updated_at=now();
    UPDATE device_identities SET status='revoked',revoked_at=coalesce(revoked_at,now()) WHERE id='${device}';
    UPDATE device_credentials SET status='revoked' WHERE device_id='${device}';
    UPDATE device_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE device_id='${device}';
    INSERT INTO security_reconciliation_events(checkpoint_epoch,resource_type,resource_id,event)
      VALUES(${verifiedCheckpoint.epoch},'device','${device}','revoked_after_backup'),
            (${verifiedCheckpoint.epoch},'operation','${postBackupOperation}','missing_after_backup');
  `);

  const securityState = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', "SELECT quarantined||'|'||checkpoint_epoch FROM control_security_state"]).trim();
  const deviceState = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', `SELECT status FROM device_identities WHERE id='${device}'`]).trim();
  const activeSessions = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', `SELECT count(*) FROM device_sessions WHERE device_id='${device}' AND revoked_at IS NULL`]).trim();
  const missingOperation = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', `SELECT count(*) FROM operations WHERE id='${postBackupOperation}'`]).trim();
  const reconciliation = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', 'SELECT count(*) FROM security_reconciliation_events WHERE checkpoint_epoch=2']).trim();
  const tenantRows = run('docker', ['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', `SET ROLE nexo_l02_runtime; SET app.tenant_id='${tenant}'; SET app.user_id='${user}'; SELECT count(*) FROM tenants; RESET ROLE;`]).trim().split('\n').find((line) => /^\d+$/.test(line));
  assert.equal(securityState, 'true|2');
  assert.equal(deviceState, 'revoked');
  assert.equal(activeSessions, '0');
  assert.equal(missingOperation, '0');
  assert.equal(reconciliation, '2');
  assert.equal(tenantRows, '1');
  assert.equal(JSON.parse(await readFile(restoredConfig, 'utf8')).schemaVersion, 6);
  assert.equal(JSON.parse(await readFile(restoredEmission, 'utf8')).privateMaterial, emissionSecret);
  assert.equal((await stat(restoredConfig)).mode & 0o777, 0o600);
  assert.equal((await stat(restoredEmission)).mode & 0o777, 0o600);

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs <= 600_000, `restore objective exceeded: ${elapsedMs}ms`);
  const report = {
    phase: 'L08',
    recoveryScope: 'volume',
    rpo: 'snapshot-point',
    objectiveMs: 600_000,
    elapsedMs,
    encryptedBundle: 'PASS',
    keySeparation: 'PASS_SAME_HOST',
    wrongKeyAndTamper: 'PASS',
    keyRotation: 'PASS',
    restoreNewTarget: 'PASS',
    rolesAndRls: 'PASS',
    configurationAndEmission: 'PASS',
    quarantineAndCheckpoint: 'PASS',
    postBackupRevocation: 'PASS',
    postBackupOperationGap: 'RECORDED',
    totalHostLoss: 'NOT_RUN',
    image
  };
  await mkdir('artifacts/l08', { recursive: true });
  await writeFile('artifacts/l08/recovery-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  spawnSync('docker', ['rm', '-f', source, restored], { stdio: 'ignore' });
  await rm(archiveDir, { recursive: true, force: true });
  await rm(custodyDir, { recursive: true, force: true });
  await rm(restoreDir, { recursive: true, force: true });
}
