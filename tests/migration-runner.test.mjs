import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrationProfiles, stripMigrationTransaction } from '../scripts/migration-profiles.mjs';

test('F09 lab profile fixes the sequence and excludes 016 and 018', () => {
  const expected = [...Array.from({ length: 15 }, (_, index) => `${String(index + 1).padStart(3, '0')}_`), '017_'];
  assert.equal(migrationProfiles['f09-lab'].migrations.length, 16);
  assert.deepEqual(migrationProfiles['f09-lab'].migrations.map(file => file.slice(0, 4)), expected);
  assert.deepEqual(migrationProfiles['f09-local'].migrations, migrationProfiles['f09-lab'].migrations);
});

test('GA-01 is local-only, adds 018 after F09, and still excludes 016', () => {
  const ga01 = migrationProfiles['ga01-local'].migrations;
  assert.equal(migrationProfiles['ga01-local'].target, 'local');
  assert.deepEqual(ga01.slice(0, -1), migrationProfiles['f09-local'].migrations);
  assert.equal(ga01.at(-1), '018_ga01_assignment_permissions.sql');
  assert.ok(!ga01.some(file => file.startsWith('016_')));
});

test('016 is available only in the disposable F08 local profile', () => {
  const profilesWith016 = Object.entries(migrationProfiles)
    .filter(([, profile]) => profile.migrations.some(file => file.startsWith('016_')))
    .map(([name]) => name);
  assert.deepEqual(profilesWith016, ['f08-local']);
  assert.equal(migrationProfiles['f08-local'].target, 'local');
});

test('migration transaction wrapper is removed while inner SQL blocks remain intact', async () => {
  const sql = await readFile(new URL('../db/migrations/016_f07_vpn_credential_rotation.sql', import.meta.url), 'utf8');
  const body = stripMigrationTransaction(sql, '016_f07_vpn_credential_rotation.sql');
  assert.match(body, /DO \$\$[\s\S]*?BEGIN[\s\S]*?END \$\$/);
  assert.doesNotMatch(body, /^BEGIN\s*;/i);
  assert.doesNotMatch(body, /COMMIT\s*;\s*$/i);
});

test('runner rejects migration files without atomic wrapper boundaries', () => {
  assert.throws(() => stripMigrationTransaction('CREATE TABLE sample(id integer); COMMIT;'), /debe empezar con BEGIN/);
  assert.throws(() => stripMigrationTransaction('BEGIN; CREATE TABLE sample(id integer);'), /debe terminar con COMMIT/);
});
