import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { MemoryProviderRepository } from '../dist/product/provider-repository.js';
import { hashPassword } from '../dist/product/security.js';

const PASSWORD = 'correct horse battery staple';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

function currentTotp() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex')).update(counter).digest();
  const offset = digest.at(-1) & 0x0f;
  const code = (((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}

async function user({ id, email, memberships = [], providerRole }) {
  return {
    id,
    email,
    passwordHash: await hashPassword(PASSWORD),
    status: 'active',
    mfaRequired: true,
    totpSecret: TOTP_SECRET,
    memberships,
    ...(providerRole ? { providerRole } : {}),
  };
}

async function startApp(users, { provider, company } = {}) {
  const app = await createProductApplication(
    new MemoryIdentityRepository(users),
    undefined,
    provider,
    company,
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function sessionToken(app, email, { scopeKind = 'tenant', tenantId } = {}) {
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  assert.equal(login.statusCode, 200, login.body);

  const mfa = await app.inject({
    method: 'POST',
    url: '/v1/auth/mfa',
    payload: { challenge: login.json().challenge, code: currentTotp() },
  });
  assert.equal(mfa.statusCode, 200, mfa.body);

  const selection = await app.inject({
    method: 'POST',
    url: '/v1/session/select',
    payload: {
      selection: mfa.json().selection,
      scope_kind: scopeKind,
      ...(scopeKind === 'tenant' ? { tenant_id: tenantId } : {}),
    },
  });
  assert.equal(selection.statusCode, 200, selection.body);
  return selection.json().token;
}

test('E5-1: provider operator cannot create a company (owner-only endpoint)', async () => {
  const operatorId = '55555555-5555-4555-8555-555555555555';
  const operator = await user({
    id: operatorId,
    email: 'operator@example.test',
    providerRole: 'operator',
  });
  const provider = new MemoryProviderRepository(new Map([[operatorId, 'operator']]));
  const app = await startApp([operator], { provider });

  try {
    const token = await sessionToken(app, operator.email, { scopeKind: 'provider' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider/companies',
      headers: { authorization: `Bearer ${token}` },
      payload: { slug: 'empresa-nueva', name: 'Empresa Nueva' },
    });

    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
  }
});

test('E5-2: tenant A session cannot read tenant B users', async () => {
  const member = await user({
    id: '66666666-6666-4666-8666-666666666666',
    email: 'member-a@example.test',
    memberships: [{ tenantId: TENANT_A, tenantName: 'Tenant A', roles: ['company.admin'] }],
  });
  const company = new MemoryCompanyRepository({
    [TENANT_A]: [{ userId: member.id, email: member.email, status: 'active', roles: ['company.admin'] }],
    [TENANT_B]: [{ userId: '77777777-7777-4777-8777-777777777777', email: 'member-b@example.test', status: 'active', roles: ['company.admin'] }],
  });
  const app = await startApp([member], { company });

  try {
    const token = await sessionToken(app, member.email, { tenantId: TENANT_A });
    // The endpoint has no tenant path parameter; attempt to override the scope via query string.
    const response = await app.inject({
      method: 'GET',
      url: `/v1/company/users?tenant_id=${TENANT_B}`,
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().items.map(item => item.email), ['member-a@example.test']);
    assert.equal(response.body.includes('member-b@example.test'), false);
  } finally {
    await app.close();
  }
});

test('E5-3: revoking a session invalidates its token', async () => {
  const member = await user({
    id: '88888888-8888-4888-8888-888888888888',
    email: 'session-user@example.test',
    memberships: [{ tenantId: TENANT_A, tenantName: 'Tenant A', roles: ['company.admin'] }],
  });
  const app = await startApp([member]);

  try {
    const token = await sessionToken(app, member.email, { tenantId: TENANT_A });
    const headers = { authorization: `Bearer ${token}` };

    assert.equal((await app.inject({ method: 'GET', url: '/v1/me', headers })).statusCode, 200);
    const revoked = await app.inject({ method: 'POST', url: '/v1/session/revoke', headers });
    assert.equal(revoked.statusCode, 204);

    const afterRevocation = await app.inject({ method: 'GET', url: '/v1/me', headers });
    assert.ok([401, 403].includes(afterRevocation.statusCode), afterRevocation.body);
  } finally {
    await app.close();
  }
});

// MemoryDeviceRepository only has a separately configured per-tenant capacity limit. The in-memory
// enrollment flow does not reserve the plan quota from MemoryProviderRepository; the real coupling
// is implemented in PostgresDeviceRepository, so these fixtures cannot prove a plan-quota bypass.
test.skip('E5-4: plan endpoint quota rejects a third device enrollment', () => {});
