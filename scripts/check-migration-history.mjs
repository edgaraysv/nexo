import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { migrationProfiles } from './migration-profiles.mjs';

const profileName = process.argv[2];
const profile = migrationProfiles[profileName];
if (!profile) throw new Error(`Uso: node scripts/check-migration-history.mjs <${Object.keys(migrationProfiles).join('|')}>`);
if (profile.target !== 'local') throw new Error('La comprobación de historial solo admite perfiles locales.');
if (!process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL.');

const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'nexo-migration-history-check' });
try {
  await client.connect();
  const result = await client.query('SELECT version, checksum FROM public.nexo_schema_migrations ORDER BY applied_at, version');
  assert.deepEqual(result.rows.map(row => row.version), profile.migrations, 'El historial no coincide exactamente con el perfil');
  for (const row of result.rows) {
    const sql = await readFile(new URL(`../db/migrations/${row.version}`, import.meta.url), 'utf8');
    assert.equal(row.checksum.trim(), createHash('sha256').update(sql).digest('hex'), `Checksum incorrecto: ${row.version}`);
  }
  const expected016 = profile.migrations.some(file => file.startsWith('016_'));
  assert.equal(result.rows.some(row => row.version.startsWith('016_')), expected016, 'La presencia de 016 no coincide con el perfil');
  console.log(`Historial PASS: ${profileName}, ${result.rows.length} migraciones, checksums íntegros.`);
} finally {
  await client.end().catch(() => {});
}
