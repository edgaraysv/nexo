import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Script } from 'node:vm';
import { createProductApplication } from '../dist/product/application.js';
import { accountAccessPage } from '../dist/product/account-access-ui.js';
import { SmtpNotificationSink } from '../dist/product/mail-sink.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const ADMIN = '77777777-7777-4777-8777-777777777777';
const INVITEE = '99999999-9999-4999-8999-999999999999';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SECRET = 'JBSWY3DPEHPK3PXP';

function totp(now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let buffer = 0; const bytes = [];
  for (const character of SECRET) {
    buffer = (buffer << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); }
  }
  const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(payload).digest(); const offset = digest.at(-1) & 15;
  return String((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000).padStart(6, '0');
}

async function setup() {
  const initialPassword = 'correct horse battery staple';
  const passwordHash = await hashPassword(initialPassword);
  const identity = new MemoryIdentityRepository([
    { id: ADMIN, email: 'admin@example.test', passwordHash, status: 'active', mfaRequired: true, totpSecret: SECRET, memberships: [{ tenantId: TENANT, tenantName: 'Empresa de prueba', roles: ['company.admin'] }] },
    { id: INVITEE, email: 'invited@example.test', passwordHash, status: 'active', mfaRequired: true, totpSecret: SECRET, memberships: [] },
    { id: OTHER, email: 'other@example.test', passwordHash, status: 'active', mfaRequired: true, totpSecret: SECRET, memberships: [] },
  ]);
  const company = new MemoryCompanyRepository({
    [TENANT]: [{ userId: ADMIN, email: 'admin@example.test', status: 'active', roles: ['company.admin'] }],
  });
  const messages = [];
  const notifications = new SmtpNotificationSink({
    host: 'smtp.example.test', port: 587, tlsMode: 'starttls', username: 'nexo@example.test',
    passwordFile: '/etc/nexo/smtp-password', from: 'noreply@example.test', publicUrl: 'https://control.example.test',
  }, {
    async sendMail(message) { messages.push(message); return { accepted: [message.to], rejected: [] }; },
  });
  const app = await createProductApplication(identity, notifications, undefined, company, notifications);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, messages, initialPassword };
}

async function getSelection(app, email, password) {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });
  assert.equal(login.statusCode, 200);
  const verified = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: totp() } });
  assert.equal(verified.statusCode, 200);
  return verified.json();
}

test('account page is served without caching and exposes invitation plus recovery flows', async () => {
  const script = /<script>([\s\S]*?)<\/script>/u.exec(accountAccessPage())?.[1];
  assert.ok(script, 'inline account client script is present');
  assert.doesNotThrow(() => new Script(script), 'inline account client script parses');
  const { app } = await setup();
  try {
    const response = await app.inject({ method: 'GET', url: '/account' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(response.body, /id="invitation_token"/u);
    assert.match(response.body, /id="recovery-request"/u);
    assert.match(response.body, /id="recovery-confirm"/u);
    assert.match(response.body, /MFA/u);
    assert.match(response.body, /nexo_pending_session/u);
    const companyPage = await app.inject({ method: 'GET', url: '/company' });
    assert.equal(companyPage.statusCode, 200);
    assert.match(companyPage.body, /sessionStorage\.removeItem\('nexo_pending_session'\)/u);
  } finally { await app.close(); }
});

test('SMTP invitation and recovery tokens complete the browser account flows end to end', async () => {
  const { app, messages, initialPassword } = await setup();
  try {
    const adminIdentity = await getSelection(app, 'admin@example.test', initialPassword);
    const adminSession = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: adminIdentity.selection, scope_kind: 'tenant', tenant_id: TENANT } });
    assert.equal(adminSession.statusCode, 200);
    const invited = await app.inject({
      method: 'POST', url: '/v1/company/invitations', headers: { authorization: `Bearer ${adminSession.json().token}` },
      payload: { email: 'invited@example.test', role: 'company.technician' },
    });
    assert.equal(invited.statusCode, 202);
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /https:\/\/control\.example\.test\/account/u);
    const invitationToken = /Token de invitación \(un solo uso\): ([A-Za-z0-9_-]{43})/u.exec(messages[0].text)?.[1];
    assert.ok(invitationToken, 'SMTP message contains the opaque invitation token');

    const noProof = await app.inject({ method: 'POST', url: '/v1/company/invitations/accept', payload: { token: invitationToken } });
    assert.equal(noProof.statusCode, 401);

    const otherIdentity = await getSelection(app, 'other@example.test', initialPassword);
    const wrongEmail = await app.inject({ method: 'POST', url: '/v1/company/invitations/accept', payload: { token: invitationToken, selection: otherIdentity.selection } });
    assert.equal(wrongEmail.statusCode, 401);

    const invitedIdentity = await getSelection(app, 'invited@example.test', initialPassword);
    assert.deepEqual(invitedIdentity.memberships, [], 'the invitee can authenticate with MFA before having a company membership');
    const accepted = await app.inject({ method: 'POST', url: '/v1/company/invitations/accept', payload: { token: invitationToken, selection: invitedIdentity.selection } });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().tenant_id, TENANT);
    assert.equal(accepted.json().role, 'company.technician');
    assert.equal(typeof accepted.json().token, 'string');
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${accepted.json().token}` } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().tenant.id, TENANT);
    assert.deepEqual(me.json().roles, ['company.technician']);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/company/summary', headers: { authorization: `Bearer ${accepted.json().token}` } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/company/invitations/accept', payload: { token: invitationToken, selection: invitedIdentity.selection } })).statusCode, 401);

    const recoveryRequested = await app.inject({ method: 'POST', url: '/v1/auth/recovery/request', payload: { email: 'invited@example.test' } });
    assert.equal(recoveryRequested.statusCode, 202);
    assert.equal(messages.length, 2);
    assert.match(messages[1].text, /https:\/\/control\.example\.test\/account/u);
    const recoveryToken = /Token de recuperación \(un solo uso\): ([A-Za-z0-9_-]{43})/u.exec(messages[1].text)?.[1];
    assert.ok(recoveryToken, 'SMTP message contains the opaque recovery token');
    const changedPassword = 'a different strong passphrase';
    const recovered = await app.inject({ method: 'POST', url: '/v1/auth/recovery/confirm', payload: { token: recoveryToken, new_password: changedPassword } });
    assert.equal(recovered.statusCode, 204);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${accepted.json().token}` } })).statusCode, 401, 'recovery revokes the invitation-created session');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/recovery/confirm', payload: { token: recoveryToken, new_password: 'another strong passphrase' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'invited@example.test', password: initialPassword } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'invited@example.test', password: changedPassword } })).statusCode, 200);
  } finally { await app.close(); }
});
