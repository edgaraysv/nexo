import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'JBSWY3DPEHPK3PXP';

function totp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let buffer = 0; const bytes = [];
  for (const c of secret) { buffer = (buffer << 5) | alphabet.indexOf(c); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); } }
  const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(payload).digest(); const offset = digest.at(-1) & 15;
  return String((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000).padStart(6, '0');
}

async function fixture() {
  const deliveries = [];
  const repository = new MemoryIdentityRepository([{ id: USER_ID, email: 'owner@example.test', passwordHash: await hashPassword('correct horse battery staple'), status: 'active', mfaRequired: true, totpSecret: SECRET, memberships: [{ tenantId: TENANT_A, tenantName: 'Empresa A', roles: ['owner'] }, { tenantId: TENANT_B, tenantName: 'Empresa B', roles: ['auditor'] }] }]);
  const app = await createProductApplication(repository, { deliver: async (email, token) => deliveries.push({ email, token }) }); await app.init(); await app.getHttpAdapter().getInstance().ready(); return { app, repository, deliveries };
}

async function login(app, tenantId = TENANT_A) {
  const first = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } });
  assert.equal(first.statusCode, 200); assert.equal(first.json().memberships, undefined);
  const second = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: first.json().challenge, code: totp(SECRET) } });
  assert.equal(second.statusCode, 200); assert.equal(second.json().memberships.length, 2);
  const third = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: second.json().selection, tenant_id: tenantId } });
  assert.equal(third.statusCode, 200); return third.json().token;
}

test('L02 product login requires valid password, MFA and membership-derived tenant', async () => {
  const { app } = await fixture(); try {
    const denied = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'incorrect password' } });
    assert.equal(denied.statusCode, 401); assert.deepEqual(denied.json(), { error: 'unauthorized' });
    const token = await login(app); const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    assert.equal(me.statusCode, 200); assert.equal(me.json().tenant.id, TENANT_A); assert.deepEqual(me.json().roles, ['owner']);
  } finally { await app.close(); }
});

test('L02 tenant switch revokes old token and issues a new scoped session', async () => {
  const { app } = await fixture(); try {
    const token = await login(app); const changed = await app.inject({ method: 'POST', url: '/v1/session/switch', headers: { authorization: `Bearer ${token}` }, payload: { tenant_id: TENANT_B } });
    assert.equal(changed.statusCode, 200); const old = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } }); assert.equal(old.statusCode, 401);
    const current = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${changed.json().token}` } }); assert.equal(current.json().tenant.id, TENANT_B);
  } finally { await app.close(); }
});

test('L02 refuses arbitrary tenant and revocation invalidates subsequent requests', async () => {
  const { app } = await fixture(); try {
    const token = await login(app); const forbidden = await app.inject({ method: 'POST', url: '/v1/session/switch', headers: { authorization: `Bearer ${token}` }, payload: { tenant_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } }); assert.equal(forbidden.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/session/revoke', headers: { authorization: `Bearer ${token}` } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
  } finally { await app.close(); }
});

test('L02 serves an accessible minimal login and MFA tenant selector', async () => {
  const { app } = await fixture(); try { const page = await app.inject({ method: 'GET', url: '/' }); assert.equal(page.statusCode, 200); assert.match(page.body, /autocomplete="current-password"/); assert.match(page.body, /aria-live="polite"/); assert.match(page.body, /name="tenant_id"/); assert.equal(page.headers['cache-control'], 'no-store'); } finally { await app.close(); }
});

test('L02 recovery is non-enumerating, one-use and revokes existing sessions', async () => {
  const { app, deliveries } = await fixture(); try {
    const session = await login(app);
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/recovery/request', payload: { email: 'unknown@example.test' } });
    const known = await app.inject({ method: 'POST', url: '/v1/auth/recovery/request', payload: { email: 'owner@example.test' } });
    assert.equal(unknown.statusCode, 202); assert.deepEqual(unknown.json(), known.json()); assert.equal(deliveries.length, 1);
    const confirmed = await app.inject({ method: 'POST', url: '/v1/auth/recovery/confirm', payload: { token: deliveries[0].token, new_password: 'new correct horse battery staple' } });
    assert.equal(confirmed.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${session}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/recovery/confirm', payload: { token: deliveries[0].token, new_password: 'another correct horse battery staple' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'correct horse battery staple' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'owner@example.test', password: 'new correct horse battery staple' } })).statusCode, 200);
  } finally { await app.close(); }
});

test('L02 rejects malformed JSON safely and throttles repeated password failures', async () => {
  const { app } = await fixture(); try {
    const malformed = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: { 'content-type': 'application/json' }, payload: '{"email"' });
    assert.equal(malformed.statusCode, 422); assert.deepEqual(malformed.json(), { error: 'invalid_request' });
    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'throttle@example.test', password: 'incorrect password' } })).statusCode, 401);
    const limited = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'throttle@example.test', password: 'incorrect password' } });
    assert.equal(limited.statusCode, 429); assert.deepEqual(limited.json(), { error: 'rate_limited' });
  } finally { await app.close(); }
});
