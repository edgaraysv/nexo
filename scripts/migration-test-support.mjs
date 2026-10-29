import { spawnSync } from 'node:child_process';
import { migrationProfiles } from './migration-profiles.mjs';

export function runMigrationProfile(container, profileName, password, database = 'nexo') {
  const profile = migrationProfiles[profileName];
  if (!profile || profile.target !== 'local') throw new Error(`Perfil de prueba no local: ${profileName}`);

  const inspected = spawnSync('docker', [
    'inspect', '--format', '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}', container,
  ], { encoding: 'utf8' });
  if (inspected.status !== 0) throw new Error(`No se pudo obtener el puerto PostgreSQL: ${inspected.stderr || inspected.stdout}`);
  const port = inspected.stdout.trim();
  if (!/^\d+$/.test(port)) throw new Error('Docker devolvió un puerto PostgreSQL inválido.');

  const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}`;
  const env = { ...process.env, DATABASE_URL: connectionString };
  const result = spawnSync(process.execPath, [
    'scripts/migrate.mjs', '--profile', profileName, '--initialize',
  ], {
    encoding: 'utf8',
    env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Runner falló (${profileName}): ${result.stderr || result.stdout}`);

  const checked = spawnSync(process.execPath, ['scripts/check-migration-history.mjs', profileName], {
    encoding: 'utf8',
    env,
  });
  if (checked.stdout) process.stdout.write(checked.stdout);
  if (checked.stderr) process.stderr.write(checked.stderr);
  if (checked.status !== 0) throw new Error(`Historial inválido (${profileName}): ${checked.stderr || checked.stdout}`);
  return port;
}
