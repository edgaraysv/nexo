import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryDeviceRepository } from '../dist/product/device-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { MemoryNodeRepository } from '../dist/product/node-repository.js';
import { MemoryProviderRepository } from '../dist/product/provider-repository.js';
import { MemoryVpnEnvironmentRepository } from '../dist/product/vpn-environment-repository.js';
import { MemoryWireGuardPeerRepository } from '../dist/product/wireguard-peer-repository.js';
import { hashPassword } from '../dist/product/security.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

function totp() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex')).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000).padStart(6, '0');
}

function signingKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function signature(privateKey, payload) {
  return sign('sha256', Buffer.from(payload), privateKey).toString('base64');
}

function wireGuardPublicKey() {
  return generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

async function sessionToken(app, scopeKind) {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'f11-owner@example.test', password: 'correct horse battery staple' } });
  assert.equal(login.statusCode, 200);
  const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: totp() } });
  assert.equal(mfa.statusCode, 200);
  const selection = { selection: mfa.json().selection, scope_kind: scopeKind };
  if (scopeKind === 'tenant') selection.tenant_id = TENANT;
  const selected = await app.inject({ method: 'POST', url: '/v1/session/select', payload: selection });
  assert.equal(selected.statusCode, 200);
  return { authorization: `Bearer ${selected.json().token}` };
}

async function enrollNode(app, providerHeaders) {
  const key = signingKey();
  const invitation = await app.inject({ method: 'POST', url: '/v1/provider/node-invitations', headers: providerHeaders, payload: {} });
  assert.equal(invitation.statusCode, 201);
  const started = await app.inject({ method: 'POST', url: '/v1/node-enrollment/start', payload: { token: invitation.json().token, name: 'F11 Node', audience: 'node', public_key_pem: key.publicKeyPem } });
  assert.equal(started.statusCode, 201);
  const { node_id: nodeId, challenge, claim_token: claimToken } = started.json();
  const proof = signature(key.privateKey, `nexo-node-enrollment-v1\n${nodeId}\n${challenge}`);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/node-enrollment/prove', payload: { node_id: nodeId, challenge, signature: proof } })).statusCode, 202);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/provider/nodes/${nodeId}/approve`, headers: providerHeaders })).statusCode, 204);
  const claimed = await app.inject({ method: 'POST', url: '/v1/node-enrollment/claim', payload: { node_id: nodeId, claim_token: claimToken } });
  assert.equal(claimed.statusCode, 200);
  const challengeResponse = await app.inject({ method: 'POST', url: '/v1/node-auth/challenge', payload: { node_id: nodeId, serial: claimed.json().serial, certificate_pem: claimed.json().certificate_pem } });
  assert.equal(challengeResponse.statusCode, 200);
  const authChallenge = challengeResponse.json().challenge;
  const authSignature = signature(key.privateKey, `nexo-node-auth-v1\n${nodeId}\n${claimed.json().serial}\n${authChallenge}`);
  const authenticated = await app.inject({ method: 'POST', url: '/v1/node-auth/verify', payload: { node_id: nodeId, serial: claimed.json().serial, challenge: authChallenge, signature: authSignature } });
  assert.equal(authenticated.statusCode, 200);
  return { nodeId, nodeHeaders: { authorization: `Bearer ${authenticated.json().token}` } };
}

async function enrollEndpoint(app, companyHeaders) {
  const key = signingKey();
  const invitation = await app.inject({ method: 'POST', url: '/v1/company/device-invitations', headers: companyHeaders, payload: { device_kind: 'endpoint', uses: 1 } });
  assert.equal(invitation.statusCode, 201);
  const started = await app.inject({ method: 'POST', url: '/v1/device-enrollment/start', payload: { token: invitation.json().token, name: 'F11 Endpoint', audience: 'endpoint', public_key_pem: key.publicKeyPem } });
  assert.equal(started.statusCode, 201);
  const { device_id: deviceId, challenge, claim_token: claimToken } = started.json();
  const proof = signature(key.privateKey, `nexo-enrollment-v1\n${deviceId}\n${challenge}`);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/device-enrollment/prove', payload: { device_id: deviceId, challenge, signature: proof } })).statusCode, 202);
  for (const permission of ['company.agent.read', 'company.agent.approve', 'company.agent.revoke']) {
    const grant = await app.inject({ method: 'POST', url: '/v1/company/resource-grants', headers: companyHeaders, payload: { user_id: OWNER, resource_type: 'device_identity', resource_id: deviceId, permission } });
    assert.equal(grant.statusCode, 201, grant.body);
  }
  assert.equal((await app.inject({ method: 'POST', url: `/v1/company/agents/${deviceId}/approve`, headers: companyHeaders })).statusCode, 204);
  const claimed = await app.inject({ method: 'POST', url: '/v1/device-enrollment/claim', payload: { device_id: deviceId, claim_token: claimToken } });
  assert.equal(claimed.statusCode, 200);
  const challengeResponse = await app.inject({ method: 'POST', url: '/v1/device-auth/challenge', payload: { device_id: deviceId, serial: claimed.json().serial, certificate_pem: claimed.json().certificate_pem } });
  assert.equal(challengeResponse.statusCode, 201);
  const authChallenge = challengeResponse.json().challenge;
  const authSignature = signature(key.privateKey, `nexo-auth-v1\n${deviceId}\n${claimed.json().serial}\n${authChallenge}`);
  const authenticated = await app.inject({ method: 'POST', url: '/v1/device-auth/verify', payload: { device_id: deviceId, serial: claimed.json().serial, challenge: authChallenge, signature: authSignature } });
  assert.equal(authenticated.statusCode, 200);
  return { deviceId, deviceHeaders: { authorization: `Bearer ${authenticated.json().token}` } };
}

test('F11 HTTP lifecycle registers, approves, rotates and revokes a WireGuard peer with public keys only', async () => {
  const identity = new MemoryIdentityRepository([{
    id: OWNER,
    email: 'f11-owner@example.test',
    passwordHash: await hashPassword('correct horse battery staple'),
    status: 'active',
    mfaRequired: true,
    totpSecret: TOTP_SECRET,
    providerRole: 'owner',
    memberships: [{ tenantId: TENANT, tenantName: 'F11 Company', roles: ['company.admin'] }],
  }]);
  const provider = new MemoryProviderRepository(new Map([[OWNER, 'owner']]), [{ id: TENANT, slug: 'f11-test', name: 'F11 Company', status: 'active' }]);
  const company = new MemoryCompanyRepository({ [TENANT]: [{ userId: OWNER, email: 'f11-owner@example.test', status: 'active', roles: ['company.admin'] }] });
  const devices = new MemoryDeviceRepository({ [TENANT]: 2 });
  const nodes = new MemoryNodeRepository();
  const environments = new MemoryVpnEnvironmentRepository(new Set([TENANT]));
  const peers = new MemoryWireGuardPeerRepository(environments);
  let serial = 0;
  const issuer = { issue: async () => ({ serial: `F11-${++serial}`, certificatePem: `-----BEGIN CERTIFICATE-----\nfixture-${serial}\n-----END CERTIFICATE-----`, notBefore: new Date(Date.now() - 1000).toISOString(), notAfter: new Date(Date.now() + 86_400_000).toISOString() }) };
  const app = await createProductApplication(identity, undefined, provider, company, undefined, devices, issuer, undefined, nodes, environments, undefined, undefined, undefined, undefined, peers);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  try {
    const providerHeaders = await sessionToken(app, 'provider');
    const companyHeaders = await sessionToken(app, 'tenant');
    const { nodeId, nodeHeaders } = await enrollNode(app, providerHeaders);
    const { deviceId, deviceHeaders } = await enrollEndpoint(app, companyHeaders);
    const created = await app.inject({
      method: 'POST', url: '/v1/provider/vpn-environments', headers: providerHeaders,
      payload: { tenant_id: TENANT, node_id: nodeId, name: 'F11 WireGuard', engine: 'wireguard', protocol: 'udp', listener_port: 51820, tunnel_ipv4_cidr: '10.81.0.0/24' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const environmentId = created.json().id;
    const serverPublicKey = wireGuardPublicKey();
    assert.equal((await app.inject({ method: 'POST', url: `/v1/node/vpn-environments/${environmentId}/report`, headers: nodeHeaders, payload: { revision: 1, observed_state: 'active', config_digest: 'a'.repeat(64), wireguard_server_public_key: serverPublicKey } })).statusCode, 204);

    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/vpn/wireguard/peers', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/vpn/wireguard/peers', headers: deviceHeaders, payload: { environment_id: environmentId, public_key: 'invalid', action: 'register' } })).statusCode, 422);
    const clientPublicKey = wireGuardPublicKey();
    const registration = await app.inject({ method: 'POST', url: '/v1/device/vpn/wireguard/peers', headers: deviceHeaders, payload: { environment_id: environmentId, public_key: clientPublicKey, action: 'register' } });
    assert.equal(registration.statusCode, 202, registration.body);
    assert.equal(registration.json().state, 'pending');
    assert.equal(JSON.stringify(registration.json()).includes('PRIVATE KEY'), false);

    async function preview(action, expectedRevision) {
      const result = await app.inject({ method: 'POST', url: `/v1/provider/vpn-environments/${environmentId}/wireguard/previews`, headers: providerHeaders, payload: { device_id: deviceId, action, expected_revision: expectedRevision } });
      assert.equal(result.statusCode, 201, result.body);
      return result.json();
    }
    async function confirm(change) {
      const result = await app.inject({ method: 'POST', url: `/v1/provider/wireguard-previews/${change.id}/confirm`, headers: providerHeaders, payload: { digest: change.digest } });
      assert.equal(result.statusCode, 201, result.body);
      return result.json();
    }
    async function applyRevision(revision, digest) {
      const desired = await app.inject({ method: 'POST', url: '/v1/node/vpn-environments/reconcile', headers: nodeHeaders, payload: {} });
      assert.equal(desired.statusCode, 200);
      const item = desired.json().items.find(entry => entry.id === environmentId);
      assert.equal(item.revision, revision);
      assert.equal(item.wireguard.mtu, 1420);
      assert.equal((await app.inject({ method: 'POST', url: `/v1/node/vpn-environments/${environmentId}/report`, headers: nodeHeaders, payload: { revision, observed_state: 'active', config_digest: digest } })).statusCode, 204);
      return item;
    }

    const approve = await preview('approve', 1);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/provider/wireguard-previews/${approve.id}/confirm`, headers: providerHeaders, payload: { digest: '0'.repeat(64) } })).statusCode, 409);
    const approved = await confirm(approve);
    assert.equal(approved.state, 'active');
    assert.equal(JSON.stringify(approved).includes(clientPublicKey), false);
    const appliedFirst = await applyRevision(2, 'b'.repeat(64));
    assert.equal(appliedFirst.wireguard.peers[0].publicKey, clientPublicKey);

    const catalog = await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: deviceHeaders, payload: {} });
    assert.equal(catalog.statusCode, 200);
    const firstConfig = catalog.json().items.find(item => item.id === environmentId);
    assert.equal(firstConfig.wireguard_peer.clientPublicKey, clientPublicKey);
    assert.equal(firstConfig.wireguard_peer.serverPublicKey, serverPublicKey);
    assert.equal(JSON.stringify(firstConfig).includes('PRIVATE KEY'), false);

    const rotatedPublicKey = wireGuardPublicKey();
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/vpn/wireguard/peers', headers: deviceHeaders, payload: { environment_id: environmentId, public_key: rotatedPublicKey, action: 'rotate' } })).statusCode, 202);
    const rotation = await preview('rotate', 2);
    assert.ok(rotation.summary.oldKeyFingerprint);
    assert.ok(rotation.summary.newKeyFingerprint);
    await confirm(rotation);
    const appliedRotation = await applyRevision(3, 'c'.repeat(64));
    assert.equal(appliedRotation.wireguard.peers[0].publicKey, rotatedPublicKey);
    const rotatedCatalog = await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: deviceHeaders, payload: {} });
    assert.equal(rotatedCatalog.json().items.find(item => item.id === environmentId).wireguard_peer.clientPublicKey, rotatedPublicKey);

    const revoke = await preview('revoke', 3);
    await confirm(revoke);
    const appliedRevocation = await applyRevision(4, 'd'.repeat(64));
    assert.deepEqual(appliedRevocation.wireguard.peers, []);
    const revokedCatalog = await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: deviceHeaders, payload: {} });
    assert.equal(revokedCatalog.json().items.find(item => item.id === environmentId).wireguard_peer, undefined);
  } finally {
    await app.close();
  }
});
