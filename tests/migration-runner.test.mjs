import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrationProfiles, stripMigrationTransaction } from '../scripts/migration-profiles.mjs';

test('F09 lab profile fixes the deployed sequence and excludes local F03/GA-01 migrations', () => {
  const expected = [...Array.from({ length: 15 }, (_, index) => `${String(index + 1).padStart(3, '0')}_`), '017_'];
  assert.equal(migrationProfiles['f09-lab'].migrations.length, 16);
  assert.deepEqual(migrationProfiles['f09-lab'].migrations.map(file => file.slice(0, 4)), expected);
  assert.deepEqual(migrationProfiles['f09-local'].migrations.slice(0, -2), migrationProfiles['f09-lab'].migrations);
  assert.deepEqual(migrationProfiles['f09-local'].migrations.slice(-2), [
    '019_f03_resource_grants.sql',
    '020_f10_support_consent.sql',
  ]);
  assert.equal(migrationProfiles['f09-local'].target, 'local');
  assert.deepEqual(migrationProfiles['f09-local'].migrations, [
    ...migrationProfiles['f09-lab'].migrations,
    '019_f03_resource_grants.sql',
    '020_f10_support_consent.sql',
  ]);
  assert.ok(!migrationProfiles['f09-lab'].migrations.some(file => file.startsWith('019_') || file.startsWith('020_')));
});

test('GA-01 is local-only, orders 018 before the F03 local closure, and excludes 016', () => {
  const ga01 = migrationProfiles['ga01-local'].migrations;
  assert.equal(migrationProfiles['ga01-local'].target, 'local');
  assert.deepEqual(ga01.slice(0, -2), migrationProfiles['f09-lab'].migrations);
  assert.equal(ga01.at(-2), '018_ga01_assignment_permissions.sql');
  assert.equal(ga01.at(-1), '019_f03_resource_grants.sql');
  assert.ok(!ga01.some(file => file.startsWith('016_')));
});

test('F10 support consent is local-only and follows the verified F03 grant migration', () => {
  const f10 = migrationProfiles['f10-local'];
  assert.equal(f10.target, 'local');
  assert.equal(f10.migrations.at(-3), '019_f03_resource_grants.sql');
  assert.equal(f10.migrations.at(-2), '020_f10_support_consent.sql');
  assert.equal(f10.migrations.at(-1), '021_f10_support_lifecycle.sql');
  assert.ok(!migrationProfiles['f09-lab'].migrations.includes('020_f10_support_consent.sql'));
  assert.ok(!migrationProfiles['f09-lab'].migrations.includes('021_f10_support_lifecycle.sql'));
});

test('F07 PostgreSQL fixture combines credential rotation with runtime grants in a dedicated local profile', () => {
  const f07 = migrationProfiles['f07-local'];
  assert.equal(f07.target, 'local');
  assert.deepEqual(f07.migrations, migrationProfiles['f08-local'].migrations);
  assert.ok(!f07.migrations.includes('018_ga01_assignment_permissions.sql'));
});

test('F08 local profile includes the runtime closure and retains credential rotation 016', () => {
  const f08 = migrationProfiles['f08-local'];
  const f09 = migrationProfiles['f09-local'].migrations.slice(0, -1);
  assert.equal(f08.target, 'local');
  assert.deepEqual(f08.migrations, [
    ...f09.slice(0, 15),
    '016_f07_vpn_credential_rotation.sql',
    ...f09.slice(15),
    '020_f10_support_consent.sql',
  ]);
});

test('016 is available only in disposable F07/F08 local profiles', () => {
  const profilesWith016 = Object.entries(migrationProfiles)
    .filter(([, profile]) => profile.migrations.some(file => file.startsWith('016_')))
    .map(([name]) => name).sort();
  assert.deepEqual(profilesWith016, ['f07-local', 'f08-local']);
  assert.equal(migrationProfiles['f07-local'].target, 'local');
  assert.equal(migrationProfiles['f08-local'].target, 'local');
});

test('migration transaction wrapper is removed while inner SQL blocks remain intact', async () => {
  const sql = await readFile(new URL('../db/migrations/016_f07_vpn_credential_rotation.sql', import.meta.url), 'utf8');
  const body = stripMigrationTransaction(sql, '016_f07_vpn_credential_rotation.sql');
  assert.match(body, /DO \$\$[\s\S]*?BEGIN[\s\S]*?END \$\$/);
  assert.doesNotMatch(body, /^BEGIN\s*;/i);
  assert.doesNotMatch(body, /COMMIT\s*;\s*$/i);
});

test('F03 resource-grant migration is atomic and encodes tenant/resource constraints', async () => {
  const sql = await readFile(new URL('../db/migrations/019_f03_resource_grants.sql', import.meta.url), 'utf8');
  const body = stripMigrationTransaction(sql, '019_f03_resource_grants.sql');
  assert.match(body, /CREATE TABLE resource_grants/u);
  assert.match(body, /FOREIGN KEY\(tenant_id,user_id\) REFERENCES memberships\(tenant_id,user_id\)/u);
  assert.match(body, /FOREIGN KEY\(tenant_id,declared_device_id\) REFERENCES declared_devices\(tenant_id,id\)/u);
  assert.match(body, /FOREIGN KEY\(tenant_id,device_identity_id\) REFERENCES device_identities\(tenant_id,id\)/u);
  assert.match(body, /declared_device_id IS NOT NULL AND declared_device_id=resource_id/u);
  assert.match(body, /device_identity_id IS NOT NULL AND device_identity_id=resource_id/u);
  assert.match(body, /ENABLE ROW LEVEL SECURITY;\s*ALTER TABLE resource_grants FORCE ROW LEVEL SECURITY/u);
  assert.match(body, /valid_until IS NULL OR valid_until>valid_from/u);
  assert.match(body, /WHERE revoked_at IS NULL/u);
});

test('F10 migration persists consent with tenant/device RLS and limits contracted mode to assisted support', async () => {
  const sql = await readFile(new URL('../db/migrations/020_f10_support_consent.sql', import.meta.url), 'utf8');
  const body = stripMigrationTransaction(sql, '020_f10_support_consent.sql');
  assert.match(body, /CREATE TABLE support_sessions/u);
  assert.match(body, /CREATE TABLE support_consent/u);
  assert.match(body, /CHECK\(mode='assisted'\)/u);
  assert.match(body, /company\.support\.start/u);
  assert.match(body, /FOREIGN KEY\(tenant_id,support_session_id,device_identity_id\)/u);
  assert.match(body, /ALTER TABLE support_consent FORCE ROW LEVEL SECURITY/u);
  assert.match(body, /device_identity_id::text=current_setting\('app\.device_id',true\)/u);
});

test('F10 lifecycle migration records hashed one-use consent, engine attempts and transactional termination outbox', async () => {
  const sql = await readFile(new URL('../db/migrations/021_f10_support_lifecycle.sql', import.meta.url), 'utf8');
  const body = stripMigrationTransaction(sql, '021_f10_support_lifecycle.sql');
  assert.match(body, /RENAME COLUMN support_session_id TO session_id/u);
  assert.match(body, /ADD COLUMN operator_id uuid/u);
  assert.match(body, /RENAME COLUMN device_identity_id TO device_id/u);
  assert.match(body, /ADD COLUMN accepted_at timestamptz/u);
  assert.match(body, /ADD COLUMN decision_origin text/u);
  assert.match(body, /ADD COLUMN nonce_hash bytea/u);
  assert.ok(body.includes("WHEN 'expired' THEN 'timeout'"));
  assert.match(body, /CREATE TABLE support_session_attempts/u);
  assert.match(body, /CREATE TABLE support_session_outbox/u);
  assert.match(body, /ALTER TABLE support_session_outbox FORCE ROW LEVEL SECURITY/u);
  assert.match(body, /engine_session_id/u);
});

test('runner rejects migration files without atomic wrapper boundaries', () => {
  assert.throws(() => stripMigrationTransaction('CREATE TABLE sample(id integer); COMMIT;'), /debe empezar con BEGIN/);
  assert.throws(() => stripMigrationTransaction('BEGIN; CREATE TABLE sample(id integer);'), /debe terminar con COMMIT/);
});
