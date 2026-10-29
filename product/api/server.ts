import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import { createProductApplication } from './application.js';
import { GoCertificateIssuer } from './go-certificate-issuer.js';
import { PostgresCompanyRepository } from './postgres-company-repository.js';
import { PostgresDeviceRepository } from './postgres-device-repository.js';
import { PostgresNodeRepository } from './postgres-node-repository.js';
import { PostgresOperationRepository } from './postgres-operation-repository.js';
import { PostgresProviderRepository } from './postgres-provider-repository.js';
import { PostgresIdentityRepository } from './postgres-repository.js';
import { PostgresVpnEnvironmentRepository } from './postgres-vpn-environment-repository.js';
import { PostgresVpnCredentialRepository } from './postgres-vpn-credential-repository.js';
import { PostgresPrivateNetworkRepository } from './postgres-private-network-repository.js';

export interface ServerConfig {
  host: '127.0.0.1' | '::1';
  port: number;
  postgres: { host: string; port: number; database: string; user: string; max: number };
  secretKeyFile: string;
  issuerBinary: string;
  caDirectory: string;
  privateNetworksEnabled: boolean;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`invalid_${name}`);
  return parsed;
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value?.startsWith('/') || value.includes('\0')) throw new Error(`invalid_${name}`);
  return value;
}

export function readServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const host = env.NEXO_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw new Error('invalid_nexo_host');
  const database = env.PGDATABASE ?? 'nexo';
  const user = env.PGUSER ?? 'nexo_runtime';
  const privateNetworksEnabled = env.NEXO_F08_ENABLED === 'true';
  if (env.NEXO_F08_ENABLED !== undefined && env.NEXO_F08_ENABLED !== 'true' && env.NEXO_F08_ENABLED !== 'false') throw new Error('invalid_f08_flag');
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(database) || !/^[a-z_][a-z0-9_]{0,62}$/u.test(user) || user === 'postgres') throw new Error('invalid_postgres_identity');
  return {
    host,
    port: integer(env.NEXO_PORT, 3000, 1024, 65_535, 'nexo_port'),
    postgres: {
      host: requiredPath(env.PGHOST ?? '/var/run/postgresql', 'pg_host'),
      port: integer(env.PGPORT, 5432, 1, 65_535, 'pg_port'),
      database,
      user,
      max: integer(env.PGPOOL_MAX, 10, 1, 50, 'pgpool_max')
    },
    secretKeyFile: requiredPath(env.NEXO_SECRET_KEY_FILE, 'secret_key_file'),
    issuerBinary: requiredPath(env.NEXO_ISSUER_BINARY, 'issuer_binary'),
    caDirectory: requiredPath(env.NEXO_CA_DIRECTORY, 'ca_directory'),
    privateNetworksEnabled
  };
}

export async function startServer(config: ServerConfig): Promise<void> {
  const encodedKey = (await readFile(config.secretKeyFile, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/u.test(encodedKey)) throw new Error('invalid_secret_key');
  const pool = new Pool({ ...config.postgres, application_name: 'nexo-api', idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  pool.on('error', () => process.stderr.write('nexo_database_pool_error\n'));
  await pool.query('SELECT 1');
  const identity = new PostgresIdentityRepository(pool, Buffer.from(encodedKey, 'hex'));
  const app = await createProductApplication(
    identity,
    undefined,
    new PostgresProviderRepository(pool),
    new PostgresCompanyRepository(pool),
    undefined,
    new PostgresDeviceRepository(pool),
    new GoCertificateIssuer(config.issuerBinary, config.caDirectory),
    new PostgresOperationRepository(pool),
    new PostgresNodeRepository(pool),
    new PostgresVpnEnvironmentRepository(pool),
    new PostgresVpnCredentialRepository(pool),
    new PostgresPrivateNetworkRepository(pool),
    { privateNetworksEnabled: config.privateNetworksEnabled }
  );
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close().catch(() => {});
    await pool.end().catch(() => {});
  };
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await stop();
    throw error;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  startServer(readServerConfig(process.env)).catch(() => {
    process.stderr.write('nexo_start_failed\n');
    process.exitCode = 1;
  });
}
