import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { docker } from './docker.mjs';
import { backupNames, createBackupManifest, verifyBackupManifest } from './f02-backup.mjs';

// No aceptar nombres de proyectos, destinos, dumps ni comandos externos.
if (process.argv.length !== 2) throw new Error('F02 local solo admite su laboratorio sintético nuevo, sin argumentos.');
const project = `nexo-f02-local-${randomUUID()}`;
const directory = resolve('artifacts/f02-local', project);
const backupDirectory = resolve(directory, 'backup');
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const report = { scope: 'F02_LOCAL_SYNTHETIC_RECOVERY_NOT_AWS_ACCEPTANCE', project,
  started: new Date().toISOString(), aws: 'NOT CONTACTED', checks: [], cleanup: 'NOT RUN' };
let resourcesRequested = false;
const compose = (args, options = {}) => docker(['compose', '-p', project, '-f', 'infra/local/f02/compose.yaml', ...args], options);
function must(result, description) {
  if (result.status !== 0) throw new Error(`${description}: ${result.stderr || result.error || result.stdout}`);
  return (result.stdout ?? '').trim();
}
const sql = (service, query) => must(compose(['exec', '-T', service, 'psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'nexo_f02_fixture', '-At'], { input: query }), 'SQL sintético');
const snapshotSql = `SELECT jsonb_build_object(
  'organizations', (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM f02_fixture.organizations o),
  'endpoints', (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM f02_fixture.endpoints e))::text;`;
const inspect = service => JSON.parse(must(docker(['inspect', must(compose(['ps', '-q', service]), 'ID del contenedor')]), 'inspección'))[0];
async function check(name, fn) {
  const entry = { name, status: 'FAIL' };
  report.checks.push(entry);
  const start = performance.now();
  await fn();
  entry.status = 'PASS'; entry.elapsedMs = Math.round(performance.now() - start);
  console.log(`F02 local: ${name} PASS`);
}
async function readBackup() {
  const files = {};
  for (const name of backupNames) {
    const path = resolve(backupDirectory, name);
    assert.ok((await lstat(path)).isFile(), 'Rechazar symlinks y archivos no regulares.');
    files[name] = await readFile(path);
  }
  return files;
}
function privateContainer(container) {
  assert.equal(container.Config.Labels['com.docker.compose.project'], project);
  assert.equal(container.HostConfig.Privileged, false);
  assert.notEqual(container.HostConfig.NetworkMode, 'host');
  assert.deepEqual(container.HostConfig.PortBindings ?? {}, {});
  assert.ok(Object.values(container.NetworkSettings.Ports ?? {}).every(binding => binding === null));
  assert.ok(!container.Mounts.some(mount => mount.Destination.includes('docker.sock')));
  for (const network of Object.values(container.NetworkSettings.Networks)) {
    const details = JSON.parse(must(docker(['network', 'inspect', network.NetworkID]), 'red privada'))[0];
    assert.equal(details.Internal, true);
    assert.equal(details.Labels['com.docker.compose.project'], project);
  }
}

try {
  report.docker = JSON.parse(must(docker(['version', '--format', '{{json .Server}}']), 'Docker local'));
  // config no inicia servicios: preflight antes de solicitar recursos.
  const config = JSON.parse(must(compose(['config', '--format', 'json']), 'Compose config'));
  for (const service of Object.values(config.services)) {
    assert.ok(!service.ports?.length && !service.privileged && !service.network_mode);
    assert.ok(service.image.includes('@sha256:'));
    assert.deepEqual(Object.keys(service.environment).sort(), ['POSTGRES_DB', 'POSTGRES_HOST_AUTH_METHOD', 'POSTGRES_PASSWORD']);
  }
  console.log(`Laboratorio F02 desechable: ${project}`);
  resourcesRequested = true;
  let sourceVolume;
  let expected;
  let manifest;
  await check('source_private_and_synthetic', async () => {
    must(compose(['up', '-d', '--wait', '--wait-timeout', '120', 'source']), 'arranque origen');
    const source = inspect('source');
    privateContainer(source);
    assert.equal(sql('source', 'SHOW hba_file;'), '/fixture/pg_hba.conf');
    assert.equal(sql('source', "SELECT bool_and(auth_method='scram-sha-256') FROM pg_hba_file_rules WHERE type LIKE 'host%';"), 't');
    sourceVolume = source.Mounts.find(m => m.Destination === '/var/lib/postgresql/data').Name;
    expected = JSON.parse(sql('source', snapshotSql));
    assert.equal(expected.organizations.length, 2);
    assert.equal(expected.endpoints.length, 2);
    report.image = source.Config.Image;
  });
  await check('consistent_dump_and_external_configuration', async () => {
    must(compose(['exec', '-T', 'source', 'pg_dump', '-U', 'postgres', '-d', 'nexo_f02_fixture',
      '--format=custom', '--file=/tmp/control.dump']), 'exportación pg_dump');
    must(compose(['cp', 'source:/tmp/control.dump', resolve(backupDirectory, 'control.dump')]), 'retirar dump del nodo');
    must(compose(['cp', 'source:/fixture/node.json', resolve(backupDirectory, 'node.fixture.json')]), 'retirar configuración del nodo');
    manifest = createBackupManifest(project, await readBackup());
    await writeFile(resolve(backupDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    verifyBackupManifest(project, await readBackup(), manifest);
    report.backup = manifest;
  });
  await check('corrupt_missing_and_wrong_project_backups_rejected', async () => {
    const files = await readBackup();
    const corrupt = Buffer.from(files['control.dump']); corrupt[0] ^= 0xff;
    assert.throws(() => verifyBackupManifest(project, { ...files, 'control.dump': corrupt }, manifest));
    assert.throws(() => verifyBackupManifest(project, { 'control.dump': files['control.dump'] }, manifest));
    assert.throws(() => verifyBackupManifest(project, files, { ...manifest, project: 'another-project' }));
  });
  await check('source_changed_then_removed_before_restore', async () => {
    sql('source', "UPDATE f02_fixture.endpoints SET revision=2 WHERE organization_id='fixture-alpha'; INSERT INTO f02_fixture.endpoints(organization_id,label,revision) VALUES ('fixture-alpha','fixture-after-backup',1);");
    assert.notDeepEqual(JSON.parse(sql('source', snapshotSql)), expected);
    must(compose(['rm', '-s', '-f', 'source']), 'retirar solo contenedor origen del ensayo');
    assert.equal(must(compose(['ps', '-aq', 'source']), 'comprobar retirada origen'), '');
  });
  const restoreStarted = performance.now();
  await check('restore_fresh_database_and_configuration', async () => {
    must(compose(['up', '-d', '--wait', '--wait-timeout', '120', 'restore']), 'arranque destino limpio');
    const target = inspect('restore');
    privateContainer(target);
    assert.notEqual(target.Mounts.find(m => m.Destination === '/var/lib/postgresql/data').Name, sourceVolume);
    assert.ok(!target.Mounts.some(m => m.Name === sourceVolume));
    assert.equal(sql('restore', "SELECT to_regnamespace('f02_fixture') IS NULL;"), 't');
    const diskManifest = JSON.parse(await readFile(resolve(backupDirectory, 'manifest.json'), 'utf8'));
    verifyBackupManifest(project, await readBackup(), diskManifest);
    must(compose(['cp', resolve(backupDirectory, 'control.dump'), 'restore:/tmp/control.dump']), 'copia dump al destino');
    must(compose(['exec', '-T', 'restore', 'pg_restore', '-U', 'postgres', '-d', 'nexo_f02_fixture',
      '--no-owner', '--exit-on-error', '--single-transaction', '/tmp/control.dump']), 'restore transaccional');
    must(compose(['cp', resolve(backupDirectory, 'node.fixture.json'), 'restore:/restore-config/node.json']), 'restaurar configuración');
    assert.deepEqual(JSON.parse(sql('restore', snapshotSql)), expected);
    const restoredConfig = JSON.parse(must(compose(['exec', '-T', 'restore', 'cat', '/restore-config/node.json']), 'config recuperada'));
    assert.deepEqual(restoredConfig, JSON.parse((await readBackup())['node.fixture.json'].toString('utf8')));
    report.recovery = { restoreElapsedMs: Math.round(performance.now() - restoreStarted),
      interpretation: 'Tiempo local de arranque+restore sintético, no RTO/RPO acordado. Se excluyen deliberadamente cambios posteriores al dump.' };
  });
  await check('restored_constraints_sequence_and_read_only_role', async () => {
    const invalid = compose(['exec', '-T', 'restore', 'psql', '-X', '-w', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo_f02_fixture', '-c',
      "INSERT INTO f02_fixture.endpoints(organization_id,label,revision) VALUES ('nonexistent','fixture-invalid',1);"]);
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /foreign key constraint/);
    const nextId = sql('restore', "INSERT INTO f02_fixture.endpoints(organization_id,label,revision) VALUES ('fixture-alpha','fixture-sequence-check',1) RETURNING id;").split('\n')[0];
    assert.ok(Number(nextId) > 2, 'Secuencia identity restaurada, sin colisión con datos existentes.');
    sql('restore', "DELETE FROM f02_fixture.endpoints WHERE label='fixture-sequence-check';");
    const reader = (password, query) => compose(['exec', '-T', '-e', `PGPASSWORD=${password}`, 'restore', 'psql', '-X', '-w',
      '-h', '127.0.0.1', '-U', 'f02_reader', '-d', 'nexo_f02_fixture', '-v', 'ON_ERROR_STOP=1', '-At', '-c', query]);
    assert.equal(must(reader('public-f02-reader-fixture-only', 'SELECT count(*) FROM f02_fixture.endpoints;'), 'lectura permitida'), '2');
    const denied = reader('public-f02-reader-fixture-only', 'DELETE FROM f02_fixture.endpoints;');
    assert.notEqual(denied.status, 0); assert.match(denied.stderr, /permission denied/);
    const wrongPassword = reader('incorrect-public-fixture', 'SELECT 1;');
    assert.notEqual(wrongPassword.status, 0); assert.match(wrongPassword.stderr, /password authentication failed/);
    assert.equal(sql('restore', "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname='f02_reader';"), 'f');
    assert.equal(sql('restore', "SELECT rolpassword LIKE 'SCRAM-SHA-256$%' FROM pg_authid WHERE rolname='f02_reader';"), 't');
    assert.deepEqual(JSON.parse(sql('restore', snapshotSql)), expected);
  });
  await check('container_reconstruction_preserves_recovered_state', async () => {
    const before = inspect('restore').Id;
    must(compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '120', 'restore']), 'recrear contenedor destino');
    const after = inspect('restore');
    assert.notEqual(after.Id, before);
    privateContainer(after);
    assert.deepEqual(JSON.parse(sql('restore', snapshotSql)), expected);
    assert.deepEqual(JSON.parse(must(compose(['exec', '-T', 'restore', 'cat', '/restore-config/node.json']), 'config persistente')),
      JSON.parse((await readBackup())['node.fixture.json'].toString('utf8')));
  });
  report.status = 'PASS';
} catch (error) {
  report.status = resourcesRequested ? 'FAIL' : 'BLOCKED'; report.error = String(error); process.exitCode = 1;
  console.error(error);
  if (resourcesRequested) {
    try {
      const logs = compose(['logs', '--no-color', '--tail', '60']);
      await writeFile(resolve(directory, 'compose.log'), (logs.stdout ?? '') + (logs.stderr ?? ''), { mode: 0o600 });
    } catch (logError) { report.logError = String(logError); }
  }
} finally {
  if (resourcesRequested) {
    try {
      must(compose(['down', '--volumes', '--timeout', '10']), 'limpieza del proyecto sintético');
      for (const type of ['container', 'network', 'volume']) {
        const args = type === 'container' ? ['ps', '-aq'] : [type, 'ls', '-q'];
        assert.equal(must(docker([...args, '--filter', `label=com.docker.compose.project=${project}`]), 'inventario final'), '');
      }
      report.cleanup = 'PASS';
      if (report.backup) {
        verifyBackupManifest(project, await readBackup(), JSON.parse(await readFile(resolve(backupDirectory, 'manifest.json'), 'utf8')));
        report.backupPreservedAfterCleanup = true;
      }
    } catch (cleanupError) {
      report.cleanup = 'FAIL'; report.cleanupError = String(cleanupError); report.status = 'FAIL'; process.exitCode = 1;
    }
  } else { report.cleanup = 'NOT REQUIRED'; }
  report.finished = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await writeFile(resolve('artifacts/f02-local/latest.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidencia F02 local: ${directory}/report.json; limpieza: ${report.cleanup}`);
}
