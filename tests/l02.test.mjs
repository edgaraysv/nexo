import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hashOpaqueToken, hashPassword, openSecret, sealSecret, verifyPassword, verifyTotp } from '../dist/product/security.js';

test('L02 password hashes are salted and verifiable without plaintext storage', async () => {
  const encoded = await hashPassword('correct horse battery staple');
  assert.match(encoded, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(encoded, 'correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', encoded), true);
  assert.equal(await verifyPassword('wrong password', encoded), false);
});

test('L02 opaque tokens are one-way digests', () => {
  const digest = hashOpaqueToken('fixture-token-is-not-a-credential');
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(digest, 'fixture-token-is-not-a-credential');
});

test('L02 TOTP secrets are sealed and tamper detected', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = sealSecret('totp-secret-fixture', key);
  assert.equal(openSecret(sealed, key), 'totp-secret-fixture');
  const tampered = Buffer.from(sealed); tampered[tampered.length - 1] ^= 1;
  assert.throws(() => openSecret(tampered, key));
  assert.notEqual(sealed.toString('utf8'), 'totp-secret-fixture');
});

test('L02 TOTP accepts current code and rejects malformed code', () => {
  // RFC 6238-compatible Base32 secret; the expected code is generated locally.
  const secret = 'JBSWY3DPEHPK3PXP';
  const now = 1_700_000_000_000;
  const counter = Math.floor(now / 30_000);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let buffer = 0; const bytes = [];
  for (const c of secret) { buffer = (buffer << 5) | alphabet.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); } }
  const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(payload).digest();
  const offset = digest.at(-1) & 15;
  const binary = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  const code = String(binary % 1_000_000).padStart(6, '0');
  assert.equal(verifyTotp(secret, code, now, 0), true);
  assert.equal(verifyTotp(secret, 'not-code', now, 0), false);
});

test('L02 migration enables forced RLS and does not define a bypass role', async () => {
  const migration = await readFile('db/migrations/001_l02_identity.sql', 'utf8');
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/g);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/g);
  assert.doesNotMatch(migration, /CREATE ROLE[^;]*BYPASSRLS/iu);
  assert.match(migration, /current_setting\('app\.tenant_id', true\)/);
  assert.match(migration, /CREATE POLICY users_isolation/);
  assert.match(migration, /CREATE POLICY mfa_isolation/);
});
