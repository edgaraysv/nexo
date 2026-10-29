import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBackupManifest, verifyBackupManifest } from '../scripts/f02-backup.mjs';

const project = 'nexo-f02-local-11111111-1111-4111-8111-111111111111';
const files = { 'control.dump': Buffer.from('synthetic-only-unit-test-not-a-postgres-dump'),
  'node.fixture.json': await readFile('infra/local/f02/node.fixture.json') };
const manifest = createBackupManifest(project, files);

test('backup F02 identifica tamaños, hashes y proyecto del ensayo', () => {
  assert.equal(verifyBackupManifest(project, files, manifest), true);
  assert.equal(manifest.files['control.dump'].bytes, files['control.dump'].length);
  assert.match(manifest.files['control.dump'].sha256, /^[a-f0-9]{64}$/);
});
test('backup F02 rechaza corrupción o truncamiento', () => {
  assert.throws(() => verifyBackupManifest(project, { ...files, 'control.dump': Buffer.from('changed') }, manifest));
  assert.throws(() => verifyBackupManifest(project, { ...files, 'control.dump': Buffer.alloc(0) }, manifest));
});
test('backup F02 rechaza archivos ausentes, adicionales y nombres con traversal', () => {
  assert.throws(() => verifyBackupManifest(project, { 'control.dump': files['control.dump'] }, manifest));
  assert.throws(() => verifyBackupManifest(project, { ...files, '../control.dump': Buffer.from('unexpected') }, manifest));
  assert.throws(() => verifyBackupManifest(project, files, { ...manifest, files: { ...manifest.files, '../control.dump': {} } }));
});
test('backup F02 rechaza otra identidad, alcance o versión', () => {
  for (const change of [{ project: 'other' }, { scope: 'production' }, { formatVersion: 2 }]) {
    assert.throws(() => verifyBackupManifest(project, files, { ...manifest, ...change }));
  }
});
test('backup F02 rechaza configuración ajena al laboratorio o módulos activos', () => {
  for (const change of [{ scope: 'production' }, { vpnEnabled: true }, { remoteSupportEnabled: true }, { commercialBackupEnabled: true }]) {
    const config = { ...JSON.parse(files['node.fixture.json']), ...change };
    assert.throws(() => createBackupManifest(project, { ...files, 'node.fixture.json': Buffer.from(JSON.stringify(config)) }));
  }
});
test('F02 exige SCRAM en todo TCP incluido loopback, sin puertos publicados', async () => {
  const hba = await readFile('infra/local/f02/pg_hba.conf', 'utf8');
  const rules = hba.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.deepEqual(rules, ['local all postgres trust', 'local all all reject',
    'host all all 0.0.0.0/0 scram-sha-256', 'host all all ::/0 scram-sha-256']);
  const compose = await readFile('infra/local/f02/compose.yaml', 'utf8');
  assert.match(compose, /hba_file=\/fixture\/pg_hba.conf/);
  assert.doesNotMatch(compose, /^\s*(ports|privileged|network_mode):/m);
  assert.equal((compose.match(/pg_hba.conf:ro/g) ?? []).length, 2);
});
