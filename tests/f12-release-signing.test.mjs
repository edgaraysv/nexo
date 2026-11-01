import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { rawEd25519KeyFromSpki, signingPayload, verifyKmsSignature } from '../scripts/sign-agent-release.mjs';

test('F12 KMS manifest payload has stable Go struct field order and empty rollback list', () => {
  const manifest = {
    schema: 'nexo.agent-update.v2', version: '0.2.0', operating_system: 'windows', architecture: 'amd64',
    size: 3, sha256: 'a'.repeat(64), minimum_current_version: '0.1.0', minimum_allowed_version: '0.2.0',
    metadata_version: 1, security_epoch: 1, blocked_rollback_versions: [], key_id: 'release-1',
    issued_at: '2026-10-31T12:00:00Z', expires_at: '2026-11-30T12:00:00Z',
  };
  assert.equal(signingPayload(manifest).toString(), '{"schema":"nexo.agent-update.v2","version":"0.2.0","operating_system":"windows","architecture":"amd64","size":3,"sha256":"' + 'a'.repeat(64) + '","minimum_current_version":"0.1.0","minimum_allowed_version":"0.2.0","metadata_version":1,"security_epoch":1,"blocked_rollback_versions":[],"key_id":"release-1","issued_at":"2026-10-31T12:00:00Z","expires_at":"2026-11-30T12:00:00Z"}');
});

test('F12 KMS Ed25519 SPKI export is the raw key consumed by Go trust keyring', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawKey = rawEd25519KeyFromSpki(spki);
  assert.equal(rawKey.length, 32);
  const manifest = {
    schema: 'nexo.agent-update.v2', version: '0.2.0', operating_system: 'windows', architecture: 'amd64',
    size: 3, sha256: 'a'.repeat(64), minimum_current_version: '0.1.0', minimum_allowed_version: '0.2.0',
    metadata_version: 1, security_epoch: 1, blocked_rollback_versions: [], key_id: 'release-1',
    issued_at: '2026-10-31T12:00:00Z', expires_at: '2026-11-30T12:00:00Z',
  };
  const signature = sign(null, signingPayload(manifest), privateKey);
  assert.equal(signature.length, 64);
  assert.equal(verifyKmsSignature(manifest, signature, { 'release-1': rawKey.toString('base64') }), true);
  assert.equal(verifyKmsSignature(manifest, signature, { 'other-key': rawKey.toString('base64') }), false);
  assert.equal(verifyKmsSignature({ ...manifest, version: '0.3.0' }, signature, { 'release-1': rawKey.toString('base64') }), false);
});
