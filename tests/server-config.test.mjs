import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerConfig } from '../dist/product/server.js';

const valid = {
  NEXO_SECRET_KEY_FILE: '/etc/nexo/seal.key',
  NEXO_ISSUER_BINARY: '/usr/local/lib/nexo/nexo-issuer',
  NEXO_CA_DIRECTORY: '/var/lib/nexo/ca'
};

test('server config defaults to loopback, peer-compatible PostgreSQL and bounded pool', () => {
  assert.deepEqual(readServerConfig(valid), {
    host: '127.0.0.1',
    port: 3000,
    postgres: { host: '/var/run/postgresql', port: 5432, database: 'nexo', user: 'nexo_runtime', max: 10 },
    secretKeyFile: '/etc/nexo/seal.key',
    issuerBinary: '/usr/local/lib/nexo/nexo-issuer',
    caDirectory: '/var/lib/nexo/ca',
    privateNetworksEnabled: false
  });
});

test('server config rejects network exposure, relative secrets and invalid identities', () => {
  assert.throws(() => readServerConfig({ ...valid, NEXO_HOST: '0.0.0.0' }), /invalid_nexo_host/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_SECRET_KEY_FILE: 'seal.key' }), /invalid_secret_key_file/);
  assert.throws(() => readServerConfig({ ...valid, PGUSER: 'postgres' }), /invalid_postgres_identity/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_PORT: '80' }), /invalid_nexo_port/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_F08_ENABLED: 'yes' }), /invalid_f08_flag/);
});
