import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';
import { docker } from './docker.mjs';
import { migrationProfiles } from './migration-profiles.mjs';

const container = `nexo-prod-migrate-${randomUUID().slice(0, 8)}`;
const image = process.env.PROD_MIGRATION_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const password = `prod-fixture-${randomUUID()}`;
const database = 'nexo_prod_fixture';

function dockerRun(args, options = {}) {
  const result = docker(args, { encoding: 'utf8', timeout: 900_000, ...options });
  if (result.status !== 0) throw new Error(`docker ${args[0]} falló: ${result.stderr || result.stdout || result.error || 'sin detalle'}`);
  return result.stdout.trim();
}

function runNode(args, env) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 900_000 });
  return result;
}

function waitForPostgres() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', database], { encoding: 'utf8', timeout: 10_000 });
    if (result.status === 0) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error('PostgreSQL local no estuvo listo dentro del límite de espera.');
}

function assertSuccessful(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} falló: ${result.stderr || result.stdout || result.error || `status=${result.status}`}`);
  }
}

let client;
try {
  const profile = migrationProfiles.production;
  assert.equal(profile.target, 'production');
  assert.equal(profile.migrations.length, 26);

  dockerRun(['image', 'inspect', image]);
  dockerRun([
    'run', '--rm', '-d', '--name', container,
    '--label', `nexo.prod-migrate-test=${container}`,
    '-p', '127.0.0.1::5432',
    '-e', `POSTGRES_PASSWORD=${password}`,
    '-e', `POSTGRES_DB=${database}`,
    image,
  ]);
  waitForPostgres();

  const port = dockerRun(['inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container]);
  assert.match(port, /^\d+$/u);
  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
  const applyEnv = { ...process.env, DATABASE_URL: connectionString, NEXO_MIGRATION_TARGET: 'production' };

  const dryEnv = { ...process.env };
  delete dryEnv.DATABASE_URL;
  delete dryEnv.NEXO_MIGRATION_TARGET;
  const dryRun = runNode(['scripts/migrate.mjs', '--profile', 'production', '--dry-run'], dryEnv);
  assertSuccessful(dryRun, 'dry-run sin DATABASE_URL');
  assert.match(dryRun.stdout, /Perfil production \(production\): 26 migraciones/u);
  assert.equal([...dryRun.stdout.matchAll(/^\d{3}_[a-z0-9_]+\.sql /gmu)].length, 26);

  const unconfirmedEnv = { ...applyEnv, NEXO_MIGRATION_TARGET: '' };
  const unconfirmed = runNode(['scripts/migrate.mjs', '--profile', 'production'], unconfirmedEnv);
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /requiere --confirm-production y NEXO_MIGRATION_TARGET=production/u);
  assert.doesNotMatch(unconfirmed.stderr, /ECONNREFUSED/u);

  const initialized = runNode(['scripts/migrate.mjs', '--profile', 'production', '--initialize', '--confirm-production'], applyEnv);
  assertSuccessful(initialized, 'aplicación en base PostgreSQL local vacía');
  assert.match(initialized.stdout, /Migraciones verificadas\/aplicadas: production/u);

  client = new Client({ connectionString, application_name: 'nexo-prod-migration-test' });
  await client.connect();
  const ledger = await client.query('SELECT version, checksum FROM public.nexo_schema_migrations ORDER BY applied_at, version');
  assert.deepEqual(ledger.rows.map(row => row.version), profile.migrations);
  for (const row of ledger.rows) {
    const sql = await readFile(new URL(`../db/migrations/${row.version}`, import.meta.url), 'utf8');
    assert.equal(row.checksum.trim(), createHash('sha256').update(sql).digest('hex'), `checksum ${row.version}`);
  }
  const tableCount = await client.query("SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f') AND c.relname <> 'nexo_schema_migrations'");
  assert.ok(tableCount.rows[0].count > 0, 'migration sequence created application relations');
  await client.end();
  client = undefined;

  const rerun = runNode(['scripts/migrate.mjs', '--profile', 'production', '--confirm-production'], applyEnv);
  assertSuccessful(rerun, 'revalidación del historial de producción');
  assert.equal([...rerun.stdout.matchAll(/^SKIP /gmu)].length, 26);

  console.log(JSON.stringify({
    result: 'PASS',
    profile: 'production',
    migrations: 26,
    orderedLedgerAndChecksums: 'PASS',
    initializeOnlyOnEmptyDatabase: 'PASS',
    rerunSkipsVerifiedHistory: 'PASS',
    dryRunWithoutDatabaseUrl: 'PASS',
    scope: 'local Unix Docker context and loopback PostgreSQL only; AWS not contacted',
    image,
  }));
} finally {
  if (client) await client.end().catch(() => {});
  docker(['rm', '-f', container], { encoding: 'utf8', timeout: 30_000, stdio: 'ignore' });
}
