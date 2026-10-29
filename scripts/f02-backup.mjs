import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const backupNames = Object.freeze(['control.dump', 'node.fixture.json']);
const scope = 'F02_SYNTHETIC_ONLY';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function validateFiles(files) {
  assert.deepEqual(Object.keys(files).sort(), [...backupNames].sort(), 'Archivos de backup inesperados o ausentes.');
  for (const name of backupNames) {
    assert.ok(Buffer.isBuffer(files[name]), `${name}: se requiere un Buffer.`);
    assert.ok(files[name].length > 0 && files[name].length <= 16 * 1024 * 1024, `${name}: tamaño fuera del laboratorio.`);
  }
  const config = JSON.parse(files['node.fixture.json'].toString('utf8'));
  assert.equal(config.scope, scope, 'No aceptar configuración de otro alcance.');
  assert.equal(config.vpnEnabled, false);
  assert.equal(config.remoteSupportEnabled, false);
  assert.equal(config.commercialBackupEnabled, false);
}

export function createBackupManifest(project, files) {
  assert.match(project, /^nexo-f02-local-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  validateFiles(files);
  return { formatVersion: 1, scope, project,
    files: Object.fromEntries(backupNames.map(name => [name, { bytes: files[name].length, sha256: digest(files[name]) }])) };
}

export function verifyBackupManifest(project, files, manifest) {
  assert.equal(manifest.formatVersion, 1, 'Versión de manifiesto no admitida.');
  assert.equal(manifest.scope, scope, 'Solo backup sintético F02.');
  assert.equal(manifest.project, project, 'El backup pertenece a otro laboratorio.');
  const expected = createBackupManifest(project, files);
  assert.deepEqual(manifest.files, expected.files, 'Integridad de backup inválida: hashes, tamaños o nombres distintos.');
  return true;
}
