import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docker } from './docker.mjs';
import {
  CHECKPOINT_SCHEMA,
  RECOVERY_SCHEMA,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  signSecurityCheckpoint,
  verifySecurityCheckpoint
} from '../dist/product/recovery.js';

const image = 'postgres:17.6-bookworm@sha256:f3bd19c606e442c3d7bdfa8002e03fe260a1023351e0ea4598032022b68dd6e3';
const runId = randomUUID();
const source = `nexo-l08-${runId}-source`;
const restored = `nexo-l08-${runId}-restored`;
const sourceVolume = `nexo-l08-${runId}-source-data`;
const restoredVolume = `nexo-l08-${runId}-restored-data`;
const ownedContainers = new Set([source, restored]);
const ownedVolumes = new Set([sourceVolume, restoredVolume]);
const reportDirectory = join('artifacts', 'l08', 'recovery-runs', runId);
const reportPath = join(reportDirectory, 'report.json');
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
  'db/migrations/010_f06_vpn_environments.sql',
  'db/migrations/011_f07_endpoint_vpn_catalog.sql',
  'db/migrations/012_f07_vpn_client_credentials.sql',
  'db/migrations/013_f08_private_networks.sql',
  'db/migrations/014_f07_tls_crypt_envelope.sql',
  'db/migrations/015_f07_revision_assigner.sql',
  'db/migrations/016_f07_vpn_credential_rotation.sql',
  'db/migrations/017_f09_reporting_permissions.sql',
  'db/migrations/018_ga01_assignment_permissions.sql'
];

const report = {
  phase: 'L08',
  recoveryScope: 'volume',
  syntheticOnly: true,
  aws: 'NOT CONTACTED',
  runId,
  status: 'BLOCKED',
  rpo: 'snapshot-point',
  objectiveMs: 600_000,
  objectiveScope: 'L08 local D07 only',
  migrationCoverage: 'local-synthetic-001-018',
  image,
  keySeparation: 'NOT_RUN',
  totalHostLoss: 'NOT_RUN',
  checks: {},
  cleanup: 'NOT_RUN'
};

let phase = 'preflight';
let resourcesRequested = false;
let tempRoot;
let archiveDirectory;
let custodyDirectory;
let restoreDirectory;
let startedAt;
let emissionSecret;

function run(args, options = {}) {
  const result = docker(args, options);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr || result.error || result.stdout || 'unknown error'}`);
  }
  return (result.stdout ?? '').trim();
}

function runJson(args) {
  return JSON.parse(run(args));
}

function tryDocker(args) {
  return docker(args);
}

function waitForPostgres(container, database) {
  const ready = () => tryDocker(['exec', container, 'psql', '-U', 'postgres', '-d', database, '-c', 'SELECT 1']).status === 0;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (ready()) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
      if (ready()) return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`PostgreSQL ${container} did not become ready`);
}

function psql(container, database, sql) {
  return run(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], { input: sql });
}

function createVolume(name, kind) {
  run(['volume', 'create', '--label', `com.nexo.recovery.run=${runId}`, '--label', `com.nexo.recovery.kind=${kind}`, name]);
  const volume = runJson(['volume', 'inspect', name])[0];
  assert.equal(volume.Name, name);
  assert.equal(volume.Labels['com.nexo.recovery.run'], runId);
  assert.equal(volume.Labels['com.nexo.recovery.kind'], kind);
}

function startPostgres(container, database, password, volume, kind) {
  run(['run', '-d', '--name', container,
    '--label', `com.nexo.recovery.run=${runId}`,
    '--label', `com.nexo.recovery.kind=${kind}`,
    '--network', 'none',
    '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${database}`,
    image]);
  const inspect = runJson(['container', 'inspect', container])[0];
  assert.equal(inspect.Config.Labels['com.nexo.recovery.run'], runId);
  assert.equal(inspect.Config.Labels['com.nexo.recovery.kind'], kind);
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.ok(inspect.HostConfig.PortBindings == null || Object.keys(inspect.HostConfig.PortBindings).length === 0);
  assert.ok(inspect.Mounts.some(mount => mount.Name === volume && mount.Destination === '/var/lib/postgresql/data'));
  waitForPostgres(container, database);
}

async function cleanOwnedResources() {
  const failures = [];
  const cleanup = { containers: 'NOT_REQUIRED', volumes: 'NOT_REQUIRED', scratch: 'NOT_REQUIRED' };

  if (resourcesRequested) {
    try {
      const ids = run(['container', 'ls', '-aq', '--filter', `label=com.nexo.recovery.run=${runId}`]).split('\n').filter(Boolean);
      for (const id of ids) {
        const container = runJson(['container', 'inspect', id])[0];
        const name = container.Name.replace(/^\//, '');
        const owner = container.Config.Labels['com.nexo.recovery.run'];
        if (owner !== runId || !ownedContainers.has(name)) {
          failures.push(`Refused to remove container outside this run: ${name}`);
          continue;
        }
        run(['container', 'rm', '--force', '--volumes', id]);
      }
      const remaining = run(['container', 'ls', '-aq', '--filter', `label=com.nexo.recovery.run=${runId}`]);
      if (remaining) throw new Error(`Containers with this run label remain: ${remaining}`);
      cleanup.containers = 'PASS';
    } catch (error) {
      cleanup.containers = 'FAIL';
      failures.push(String(error));
    }

    try {
      const names = run(['volume', 'ls', '-q', '--filter', `label=com.nexo.recovery.run=${runId}`]).split('\n').filter(Boolean);
      for (const name of names) {
        const volume = runJson(['volume', 'inspect', name])[0];
        const owner = volume.Labels?.['com.nexo.recovery.run'];
        if (owner !== runId || !ownedVolumes.has(volume.Name)) {
          failures.push(`Refused to remove volume outside this run: ${volume.Name}`);
          continue;
        }
        run(['volume', 'rm', volume.Name]);
      }
      const remaining = run(['volume', 'ls', '-q', '--filter', `label=com.nexo.recovery.run=${runId}`]);
      if (remaining) throw new Error(`Volumes with this run label remain: ${remaining}`);
      cleanup.volumes = 'PASS';
    } catch (error) {
      cleanup.volumes = 'FAIL';
      failures.push(String(error));
    }
  }

  if (tempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: false });
      try {
        await stat(tempRoot);
        throw new Error('Temporary recovery directory still exists after cleanup');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      cleanup.scratch = 'PASS';
    } catch (error) {
      cleanup.scratch = 'FAIL';
      failures.push(String(error));
    }
  }

  report.cleanupChecks = cleanup;
  report.cleanup = failures.length === 0 ? 'PASS' : 'FAIL';
  if (failures.length) {
    report.cleanupError = failures.join('; ').slice(0, 1200);
    report.status = 'FAIL';
    process.exitCode = 1;
  }
}

try {
  startedAt = Date.now();
  report.startedAt = new Date(startedAt).toISOString();
  run(['image', 'inspect', image]);
  tempRoot = await mkdtemp('/tmp/opencode/nexo-l08-recovery-');
  archiveDirectory = join(tempRoot, 'archive');
  custodyDirectory = join(tempRoot, 'custody');
  restoreDirectory = join(tempRoot, 'restored-files');
  await Promise.all([archiveDirectory, custodyDirectory, restoreDirectory]
    .map(path => mkdir(path, { mode: 0o700 })));

  phase = 'source-provision';
  resourcesRequested = true;
  createVolume(sourceVolume, 'source-data');
  startPostgres(source, 'nexo_source', 'source-fixture', sourceVolume, 'source');
  for (const migration of migrations) psql(source, 'nexo_source', await readFile(migration, 'utf8'));
  psql(source, 'nexo_source', await readFile('db/tests/l02_rls.sql', 'utf8'));
  report.checks.sourceSchema = 'PASS';
  report.checks.localMigrations001To018 = 'PASS';

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

  const sourceRoleState = run(['exec', source, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_source', '-c',
    "SELECT rolsuper||'|'||rolbypassrls||'|'||rolinherit FROM pg_roles WHERE rolname='nexo_l02_runtime'"]).trim();
  assert.equal(sourceRoleState, 'false|false|false');
  const databaseSql = run(['exec', source, 'pg_dump', '--no-owner', '--no-acl', '-U', 'postgres', '-d', 'nexo_source']);
  emissionSecret = randomBytes(48).toString('base64');
  const payload = {
    schema: RECOVERY_SCHEMA,
    databaseSql,
    roles: [{ name: 'nexo_l02_runtime', superuser: false, bypassRls: false, inherit: false }],
    configuration: { schemaVersion: 18, environment: 'local-fixture', databaseCredentialReference: 'restore-operator-supplied' },
    emission: { kind: 'development-fixture', privateMaterial: emissionSecret }
  };

  const keyV1 = randomBytes(32), keyV2 = randomBytes(32), checkpointKey = randomBytes(32);
  await writeFile(join(custodyDirectory, 'recovery-v1.key'), keyV1, { mode: 0o600 });
  await writeFile(join(custodyDirectory, 'recovery-v2.key'), keyV2, { mode: 0o600 });
  await writeFile(join(custodyDirectory, 'checkpoint.key'), checkpointKey, { mode: 0o600 });
  const bundleV1 = encryptRecoveryBundle(payload, keyV1, 'local-v1');
  const bundleV2 = encryptRecoveryBundle(payload, keyV2, 'local-v2');
  await writeFile(join(archiveDirectory, 'control-v1.nexo'), bundleV1, { mode: 0o600 });
  await writeFile(join(archiveDirectory, 'control-v2.nexo'), bundleV2, { mode: 0o600 });
  assert.equal(decryptRecoveryBundle(bundleV1, keyV1, 'local-v1').schema, RECOVERY_SCHEMA);
  assert.equal(decryptRecoveryBundle(bundleV2, keyV2, 'local-v2').schema, RECOVERY_SCHEMA);
  assert.throws(() => decryptRecoveryBundle(bundleV1, keyV2, 'local-v1'));
  assert.doesNotMatch(bundleV2.toString('utf8'), new RegExp(emissionSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  report.keySeparation = 'PASS_SAME_HOST';
  report.checks.encryptedBundleAndKeyGenerations = 'PASS';

  const postBackupOperation = randomUUID();
  psql(source, 'nexo_source', `
    UPDATE device_identities SET status='revoked',revoked_at=now() WHERE id='${device}';
    UPDATE device_credentials SET status='revoked' WHERE device_id='${device}';
    UPDATE device_sessions SET revoked_at=now() WHERE device_id='${device}';
    UPDATE control_security_state SET epoch=epoch+1,updated_at=now();
    INSERT INTO operations(id,tenant_id,target_device_id,type,idempotency_key,expires_at,created_by,revision)
      VALUES('${postBackupOperation}','${tenant}','${device}','endpoint.runtime_info.v1','l08-post-backup-operation',now()+interval '5 minutes','${user}',1);
  `);
  const sourceEpoch = Number(run(['exec', source, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_source', '-c',
    'SELECT epoch FROM control_security_state']).trim());
  assert.equal(sourceEpoch, 2);
  const checkpoint = signSecurityCheckpoint({
    schema: CHECKPOINT_SCHEMA,
    epoch: sourceEpoch,
    issuedAt: new Date().toISOString(),
    revokedDeviceIds: [device],
    missingOperationIds: [postBackupOperation]
  }, checkpointKey);
  await writeFile(join(custodyDirectory, 'security-checkpoint.json'), JSON.stringify(checkpoint), { mode: 0o600 });
  assert.throws(() => verifySecurityCheckpoint({ ...checkpoint, mac: '00'.repeat(32) }, checkpointKey, 1));
  assert.throws(() => verifySecurityCheckpoint(checkpoint, checkpointKey, sourceEpoch + 1));
  report.checks.postSnapshotSecurityChanges = 'PASS';

  phase = 'restore';
  const restoreStarted = performance.now();
  createVolume(restoredVolume, 'restored-data');
  startPostgres(restored, 'nexo_restored', 'restore-fixture', restoredVolume, 'restored');
  const recovered = decryptRecoveryBundle(await readFile(join(archiveDirectory, 'control-v2.nexo')),
    await readFile(join(custodyDirectory, 'recovery-v2.key')), 'local-v2');
  const restoredSql = join(restoreDirectory, 'control.sql');
  const restoredConfig = join(restoreDirectory, 'configuration.json');
  const restoredEmission = join(restoreDirectory, 'emission.json');
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
  const restoredRoleState = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    "SELECT rolsuper||'|'||rolcreatedb||'|'||rolcreaterole||'|'||rolreplication||'|'||rolbypassrls||'|'||rolinherit FROM pg_roles WHERE rolname='nexo_l02_runtime'"]).trim();
  assert.equal(restoredRoleState, 'false|false|false|false|false|false');
  const expectedEpoch = Number(run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    'SELECT epoch FROM control_security_state']).trim());
  const verifiedCheckpoint = verifySecurityCheckpoint(
    JSON.parse(await readFile(join(custodyDirectory, 'security-checkpoint.json'), 'utf8')),
    await readFile(join(custodyDirectory, 'checkpoint.key')),
    expectedEpoch
  );
  psql(restored, 'nexo_restored', `
    UPDATE control_security_state
      SET epoch=GREATEST(epoch,${verifiedCheckpoint.epoch}),quarantined=true,checkpoint_epoch=${verifiedCheckpoint.epoch},updated_at=now();
  `);
  for (const deviceId of verifiedCheckpoint.revokedDeviceIds) {
    psql(restored, 'nexo_restored', `
      UPDATE device_identities SET status='revoked',revoked_at=coalesce(revoked_at,now()) WHERE id='${deviceId}';
      UPDATE device_credentials SET status='revoked' WHERE device_id='${deviceId}';
      UPDATE device_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE device_id='${deviceId}';
      INSERT INTO security_reconciliation_events(checkpoint_epoch,resource_type,resource_id,event)
        VALUES(${verifiedCheckpoint.epoch},'device','${deviceId}','revoked_after_backup')
        ON CONFLICT DO NOTHING;
    `);
  }
  for (const operationId of verifiedCheckpoint.missingOperationIds) {
    psql(restored, 'nexo_restored', `
      INSERT INTO security_reconciliation_events(checkpoint_epoch,resource_type,resource_id,event)
        VALUES(${verifiedCheckpoint.epoch},'operation','${operationId}','missing_after_backup')
        ON CONFLICT DO NOTHING;
    `);
  }

  const securityState = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    'SELECT epoch||\'|\'||quarantined||\'|\'||checkpoint_epoch FROM control_security_state']).trim();
  const deviceState = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SELECT status FROM device_identities WHERE id='${device}'`]).trim();
  const credentialState = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SELECT status FROM device_credentials WHERE device_id='${device}'`]).trim();
  const activeSessions = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SELECT count(*) FROM device_sessions WHERE device_id='${device}' AND revoked_at IS NULL`]).trim();
  const missingOperation = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SELECT count(*) FROM operations WHERE id='${postBackupOperation}'`]).trim();
  const reconciliation = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SELECT count(*) FROM security_reconciliation_events WHERE checkpoint_epoch=${verifiedCheckpoint.epoch}`]).trim();
  const tenantRows = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SET ROLE nexo_l02_runtime; SET app.tenant_id='${tenant}'; SET app.user_id='${user}'; SELECT count(*) FROM tenants; RESET ROLE;`])
    .trim().split('\n').find(line => /^\d+$/.test(line));
  const leakedTenantRows = run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    `SET ROLE nexo_l02_runtime; SET app.tenant_id='${tenant}'; SET app.user_id='${user}'; SELECT count(*) FROM tenants WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; RESET ROLE;`])
    .trim().split('\n').find(line => /^\d+$/.test(line));
  assert.equal(securityState, '2|true|2');
  assert.equal(deviceState, 'revoked');
  assert.equal(credentialState, 'revoked');
  assert.equal(activeSessions, '0');
  assert.equal(missingOperation, '0');
  assert.equal(reconciliation, String(verifiedCheckpoint.revokedDeviceIds.length + verifiedCheckpoint.missingOperationIds.length));
  assert.equal(tenantRows, '1');
  assert.equal(leakedTenantRows, '0');
  assert.equal(run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', 'SELECT count(*) FROM tenants']).trim(), '2');
  assert.equal(run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c', 'SELECT count(*) FROM users']).trim(), '2');
  assert.equal(run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    "SELECT to_regclass('public.vpn_client_credentials') IS NOT NULL AND to_regprocedure('public.nexo_node_latest_revision(uuid)') IS NOT NULL AND to_regclass('public.vpn_client_credentials_active_key') IS NOT NULL"]).trim(), 't');
  assert.equal(run(['exec', restored, 'psql', '-At', '-U', 'postgres', '-d', 'nexo_restored', '-c',
    "SELECT count(*) FROM pg_policies WHERE tablename='provider_company_assignments' AND policyname IN ('provider_assignments_read','provider_assignments_owner_insert','provider_assignments_owner_delete')"]).trim(), '3');
  assert.equal(JSON.parse(await readFile(restoredConfig, 'utf8')).schemaVersion, 18);
  assert.equal(JSON.parse(await readFile(restoredEmission, 'utf8')).privateMaterial, emissionSecret);
  assert.equal((await stat(restoredConfig)).mode & 0o777, 0o600);
  assert.equal((await stat(restoredEmission)).mode & 0o777, 0o600);
  report.checks.databaseIntegrityAndCurrentLocalSchema = 'PASS';
  report.checks.rolesAndTenantRls = 'PASS';
  report.checks.quarantineRevocationsAndOperationGap = 'PASS';
  report.checks.configurationAndSyntheticEmission = 'PASS';

  report.restoreElapsedMs = Math.round(performance.now() - restoreStarted);
  report.recovery = {
    restoreElapsedMs: report.restoreElapsedMs,
    objectiveMs: report.objectiveMs,
    measurement: 'new target creation through database, role, configuration, checkpoint reconciliation and integrity checks; cleanup excluded',
    interpretation: 'L08 local synthetic objective only; not an F02/PV12 RTO'
  };
  assert.ok(report.restoreElapsedMs <= report.objectiveMs, `local restore objective exceeded: ${report.restoreElapsedMs}ms`);
  report.status = 'PASS';
} catch (error) {
  report.status = resourcesRequested ? 'FAIL' : 'BLOCKED';
  report.failurePhase = phase;
  report.error = error instanceof Error ? error.name : 'Error';
  process.exitCode = 1;
  console.error(`L08 synthetic recovery failed during ${phase}:`, error);
} finally {
  await cleanOwnedResources();
  report.finishedAt = new Date().toISOString();
  report.runElapsedMs = startedAt ? Date.now() - startedAt : undefined;
  try {
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    console.log(`L08 synthetic recovery ${report.status}; cleanup ${report.cleanup}; report ${reportPath}`);
  } catch (error) {
    process.exitCode = 1;
    console.error(`Unable to preserve unique L08 report ${reportPath}:`, error);
  }
}
