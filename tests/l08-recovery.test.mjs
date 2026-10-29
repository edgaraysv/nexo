import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CHECKPOINT_SCHEMA,
  RECOVERY_SCHEMA,
  decryptRecoveryBundle,
  encryptRecoveryBundle,
  signSecurityCheckpoint,
  verifySecurityCheckpoint
} from '../dist/product/recovery.js';

function payload() {
  return {
    schema: RECOVERY_SCHEMA,
    databaseSql: 'SELECT 1;',
    roles: [{ name: 'nexo_l02_runtime', superuser: false, bypassRls: false, inherit: false }],
    configuration: { environment: 'local' },
    emission: { fixture: 'encrypted-only' }
  };
}

test('L08 bundle authenticates database, configuration, emission material and key generation', () => {
  const key = randomBytes(32);
  const bundle = encryptRecoveryBundle(payload(), key, 'local-v1');
  assert.deepEqual(decryptRecoveryBundle(bundle, key, 'local-v1'), payload());
  assert.doesNotMatch(bundle.toString('utf8'), /SELECT 1|encrypted-only/);
  assert.throws(() => decryptRecoveryBundle(bundle, randomBytes(32), 'local-v1'), /authentication failed/);
  assert.throws(() => decryptRecoveryBundle(bundle, key, 'local-v2'), /key id mismatch/);
});

test('L08 rejects altered bundles and preserves independently decryptable key generations', () => {
  const first = randomBytes(32), second = randomBytes(32);
  const firstBundle = encryptRecoveryBundle(payload(), first, 'local-v1');
  const secondBundle = encryptRecoveryBundle(payload(), second, 'local-v2');
  const altered = JSON.parse(secondBundle.toString('utf8'));
  altered.ciphertext = `${altered.ciphertext.slice(0, -2)}AA`;
  assert.throws(() => decryptRecoveryBundle(Buffer.from(JSON.stringify(altered)), second, 'local-v2'), /authentication failed/);
  assert.equal(decryptRecoveryBundle(firstBundle, first, 'local-v1').schema, RECOVERY_SCHEMA);
  assert.equal(decryptRecoveryBundle(secondBundle, second, 'local-v2').schema, RECOVERY_SCHEMA);
  assert.throws(() => decryptRecoveryBundle(firstBundle, second, 'local-v1'));
});

test('L08 checkpoint rejects tamper and stale epochs', () => {
  const key = randomBytes(32);
  const checkpoint = { schema: CHECKPOINT_SCHEMA, epoch: 4, issuedAt: new Date().toISOString(), revokedDeviceIds: ['11111111-1111-4111-8111-111111111111'], missingOperationIds: ['22222222-2222-4222-8222-222222222222'] };
  const signed = signSecurityCheckpoint(checkpoint, key);
  assert.deepEqual(verifySecurityCheckpoint(signed, key, 4), checkpoint);
  assert.throws(() => verifySecurityCheckpoint({ ...signed, mac: '00'.repeat(32) }, key, 4), /invalid/);
  assert.throws(() => verifySecurityCheckpoint(signed, key, 5), /stale/);
});
