import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerConfig } from '../dist/product/server.js';
import { NullNotificationSink } from '../dist/product/application.js';

const valid = {
  NEXO_SECRET_KEY_FILE: '/etc/nexo/seal.key',
  NEXO_ISSUER_BINARY: '/usr/local/lib/nexo/nexo-issuer',
  NEXO_CA_DIRECTORY: '/var/lib/nexo/ca',
  NEXO_SMTP_HOST: 'smtp.example.test',
  NEXO_SMTP_PORT: '587',
  NEXO_SMTP_USER: 'nexo@example.test',
  NEXO_SMTP_PASSWORD_FILE: '/etc/nexo/smtp-password',
  NEXO_MAIL_FROM: 'noreply@example.test',
  NEXO_PUBLIC_URL: 'https://control.example.test'
};

test('server config defaults to loopback, peer-compatible PostgreSQL and bounded pool', () => {
  assert.deepEqual(readServerConfig(valid), {
    host: '127.0.0.1',
    port: 3000,
    postgres: { host: '/var/run/postgresql', port: 5432, database: 'nexo', user: 'nexo_runtime', max: 10 },
    secretKeyFile: '/etc/nexo/seal.key',
    issuerBinary: '/usr/local/lib/nexo/nexo-issuer',
    caDirectory: '/var/lib/nexo/ca',
    privateNetworksEnabled: false,
    mail: { host: 'smtp.example.test', port: 587, tlsMode: 'starttls', username: 'nexo@example.test', passwordFile: '/etc/nexo/smtp-password', from: 'noreply@example.test', publicUrl: 'https://control.example.test' }
  });
});

test('server config rejects network exposure, relative secrets and invalid identities', () => {
  assert.throws(() => readServerConfig({ ...valid, NEXO_HOST: '0.0.0.0' }), /invalid_nexo_host/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_SECRET_KEY_FILE: 'seal.key' }), /invalid_secret_key_file/);
  assert.throws(() => readServerConfig({ ...valid, PGUSER: 'postgres' }), /invalid_postgres_identity/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_PORT: '80' }), /invalid_nexo_port/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_F08_ENABLED: 'yes' }), /invalid_f08_flag/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_SMTP_TLS_MODE: 'plain' }), /invalid_nexo_smtp_tls_mode/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_PUBLIC_URL: 'http://control.example.test' }), /invalid_nexo_public_url/);
  assert.throws(() => readServerConfig({ ...valid, NEXO_SMTP_HOST: 'smtp.example.test', NEXO_SMTP_PORT: undefined }), /invalid_nexo_smtp_port/);
});

test('server config allows SMTP to be omitted and the null notification sink is safe to call', async () => {
  assert.equal(readServerConfig({ ...valid, NEXO_SMTP_HOST: undefined }).mail, undefined);
  const sink = new NullNotificationSink();
  await assert.doesNotReject(sink.deliver('user@example.test', 'opaque-token'));
  await assert.doesNotReject(sink.deliver('user@example.test', 'opaque-token', 'tenant-id'));
  assert.doesNotThrow(() => sink.close());
});
