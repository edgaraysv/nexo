import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { migrationProfiles, stripMigrationTransaction } from './migration-profiles.mjs';

const usage = `Uso:
  npm run db:migrate -- --profile f09-local --initialize
  npm run db:migrate -- --profile f10-local --initialize
  npm run db:migrate -- --profile f11-local --initialize
  npm run db:migrate -- --profile ga01-local
  npm run db:migrate -- --profile f08-local --initialize
  NEXO_MIGRATION_TARGET=lab npm run db:migrate -- --profile f09-lab --initialize --confirm-lab

DATABASE_URL es obligatorio salvo con --dry-run. --initialize solo acepta una base sin tablas de aplicación.
El runner no adopta bases existentes sin historial ni ofrece rollback automático.`;

function parseArguments(argv) {
  const options = { initialize: false, confirmLab: false, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--initialize') options.initialize = true;
    else if (argument === '--confirm-lab') options.confirmLab = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--profile') {
      assert.ok(!options.profile, '--profile solo puede indicarse una vez');
      options.profile = argv[++index];
      assert.ok(options.profile && !options.profile.startsWith('--'), 'Falta el valor de --profile');
    } else throw new Error(`Opción desconocida: ${argument}`);
  }
  return options;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

async function migrationContents(file) {
  const sql = await readFile(new URL(`../db/migrations/${file}`, import.meta.url), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return { sql: stripMigrationTransaction(sql, file), checksum };
}

async function applicationRelations(client) {
  const result = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE 'pg_%'
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT (n.nspname = 'public' AND c.relname = 'nexo_schema_migrations')
    ORDER BY n.nspname, c.relname
    LIMIT 1
  `);
  return result.rows[0];
}

async function ensureHistory(client, initialize) {
  const present = await client.query("SELECT to_regclass('public.nexo_schema_migrations') IS NOT NULL AS present");
  if (!present.rows[0].present && !initialize) {
    throw new Error('No existe historial; use --initialize únicamente para una base vacía revisada.');
  }

  if (!present.rows[0].present) {
    const relation = await applicationRelations(client);
    if (relation) {
      throw new Error(`--initialize rechazado: ya existe ${relation.schema}.${relation.name}; no se adoptan esquemas existentes.`);
    }
    await client.query(`
      CREATE TABLE public.nexo_schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  }

  const count = await client.query('SELECT count(*)::integer AS count FROM public.nexo_schema_migrations');
  if (count.rows[0].count === 0) {
    const relation = await applicationRelations(client);
    if (relation) {
      throw new Error(`Historial vacío junto a ${relation.schema}.${relation.name}; no se adoptan esquemas existentes.`);
    }
  }
}

async function applyMigrations(client, files) {
  const known = new Set(files);
  const stored = await client.query('SELECT version, checksum FROM public.nexo_schema_migrations ORDER BY applied_at, version');
  const byVersion = new Map(stored.rows.map(row => [row.version, row.checksum.trim()]));

  for (const version of byVersion.keys()) {
    if (!known.has(version)) throw new Error(`La base contiene ${version}, ajena al perfil seleccionado; se rechaza mezclar perfiles.`);
  }

  const firstMissing = files.findIndex(file => !byVersion.has(file));
  if (firstMissing !== -1 && files.slice(firstMissing + 1).some(file => byVersion.has(file))) {
    throw new Error('El historial tiene un hueco antes de una migración aplicada; se detiene sin reparar automáticamente.');
  }

  for (const file of files) {
    const { sql, checksum } = await migrationContents(file);
    const recorded = byVersion.get(file);
    if (recorded) {
      if (recorded !== checksum) throw new Error(`Checksum distinto para ${file}; no se modifica una migración aplicada.`);
      console.log(`SKIP ${file} (checksum verificado)`);
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO public.nexo_schema_migrations(version, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Falló ${file}; se revirtió su transacción y no se registró en el historial.`, { cause: error });
    }
    console.log(`APPLY ${file} ${checksum}`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }

  const profile = migrationProfiles[options.profile];
  if (!profile) throw new Error(`Perfil desconocido: ${options.profile ?? '(no indicado)'}\n${usage}`);
  for (const file of profile.migrations) assert.match(file, /^\d{3}_[a-z0-9_]+\.sql$/);

  if (profile.target === 'lab' && (!options.confirmLab || process.env.NEXO_MIGRATION_TARGET !== 'lab')) {
    throw new Error('El perfil f09-lab requiere --confirm-lab y NEXO_MIGRATION_TARGET=lab. No se ejecutó SQL.');
  }
  if (options.confirmLab && profile.target !== 'lab') throw new Error('--confirm-lab solo aplica al perfil f09-lab.');
  if (options.initialize && profile.target === 'lab' && (!options.confirmLab || process.env.NEXO_MIGRATION_TARGET !== 'lab')) {
    throw new Error('--initialize para f09-lab requiere también --confirm-lab y NEXO_MIGRATION_TARGET=lab.');
  }

  const planned = await Promise.all(profile.migrations.map(async file => ({ file, ...(await migrationContents(file)) })));
  console.log(`Perfil ${options.profile} (${profile.target}): ${planned.length} migraciones`);
  for (const { file, checksum } of planned) console.log(`${file} ${checksum}`);
  if (options.dryRun) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Defina DATABASE_URL; nunca se usa una conexión implícita.');
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL no es una URL válida; el valor se omite por seguridad.');
  }
  if (profile.target === 'local' && !isLoopback(parsed.hostname)) {
    throw new Error(`El perfil ${options.profile} solo admite PostgreSQL local; host rechazado. No se ejecutó SQL.`);
  }

  const client = new Client({ connectionString, application_name: 'nexo-migration-runner' });
  let locked = false;
  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock(1313164367, 0)');
    locked = true;
    await ensureHistory(client, options.initialize);
    await applyMigrations(client, profile.migrations);
    console.log(`Migraciones verificadas/aplicadas: ${options.profile}`);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(1313164367, 0)').catch(() => {});
    await client.end().catch(() => {});
  }
}

main().catch(error => {
  console.error(error.message);
  if (error.cause) console.error(`Causa: ${error.cause.message}`);
  process.exitCode = 1;
});
