import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryVpnEnvironmentRepository } from '../dist/product/vpn-environment-repository.js';
import { MemoryNodeRepository } from '../dist/product/node-repository.js';
import { MemoryProviderRepository } from '../dist/product/provider-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const OWNER='f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6', TENANT='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', S='JBSWY3DPEHPK3PXP';
function totp(){const p=Buffer.alloc(8);p.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));const d=createHmac('sha1',Buffer.from('48656c6c6f21deadbeef','hex')).update(p).digest(),o=d.at(-1)&15;return String((((d[o]&127)<<24)|(d[o+1]<<16)|(d[o+2]<<8)|d[o+3])%1e6).padStart(6,'0');}

async function setup(vpnEnvironments) {
  const identity = new MemoryIdentityRepository([{
    id: OWNER, email: 'f06-owner@example.test',
    passwordHash: await hashPassword('correct horse battery staple'),
    status: 'active', mfaRequired: true, totpSecret: S,
    providerRole: 'owner', memberships: [],
  }]);
  const provider = new MemoryProviderRepository(new Map([[OWNER, 'owner']]), [
    { id: TENANT, slug: 'f06-test', name: 'F06 Company', status: 'active' },
  ]);
  const issuer = { issue: async i => ({ serial: 'F06-1', certificatePem: `${i.audience}-cert`, notBefore: new Date(Date.now()-1e3).toISOString(), notAfter: new Date(Date.now()+864e5).toISOString() }) };
  const nodes = new MemoryNodeRepository();
  const app = await createProductApplication(identity, undefined, provider, undefined, undefined, undefined, issuer, undefined, nodes, vpnEnvironments);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'f06-owner@example.test', password: 'correct horse battery staple' } });
  const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: totp() } });
  const session = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: mfa.json().selection, scope_kind: 'provider' } });
  const headers = { authorization: `Bearer ${session.json().token}` };
  return { app, headers, nodes };
}

async function enrollNode(app, providerHeaders) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const invite = await app.inject({ method: 'POST', url: '/v1/provider/node-invitations', headers: providerHeaders, payload: {} });
  const started = await app.inject({ method: 'POST', url: '/v1/node-enrollment/start', payload: { token: invite.json().token, name: 'F06 Node', audience: 'node', public_key_pem: pem } });
  const { node_id: nodeId, challenge, claim_token } = started.json();
  const sig = sign('sha256', Buffer.from(`nexo-node-enrollment-v1\n${nodeId}\n${challenge}`), pair.privateKey).toString('base64');
  await app.inject({ method: 'POST', url: '/v1/node-enrollment/prove', payload: { node_id: nodeId, challenge, signature: sig } });
  await app.inject({ method: 'POST', url: `/v1/provider/nodes/${nodeId}/approve`, headers: providerHeaders });
  const cert = (await app.inject({ method: 'POST', url: '/v1/node-enrollment/claim', payload: { node_id: nodeId, claim_token } })).json();
  const authCh = (await app.inject({ method: 'POST', url: '/v1/node-auth/challenge', payload: { node_id: nodeId, serial: cert.serial, certificate_pem: cert.certificate_pem } })).json().challenge;
  const authSig = sign('sha256', Buffer.from(`nexo-node-auth-v1\n${nodeId}\n${cert.serial}\n${authCh}`), pair.privateKey).toString('base64');
  const auth = await app.inject({ method: 'POST', url: '/v1/node-auth/verify', payload: { node_id: nodeId, serial: cert.serial, challenge: authCh, signature: authSig } });
  return { nodeId, nodeHeaders: { authorization: `Bearer ${auth.json().token}` } };
}

test('F06 creates a VPN environment with openvpn/udp and namespace pattern', async () => {
  const vpnRepo = new MemoryVpnEnvironmentRepository(new Set([TENANT]));
  const { app, headers } = await setup(vpnRepo);
  try {
    const { nodeId, nodeHeaders } = await enrollNode(app, headers);
    const r = await app.inject({
      method: 'POST', url: '/v1/provider/vpn-environments', headers,
      payload: { tenant_id: TENANT, node_id: nodeId, name: 'Oficina', engine: 'openvpn', protocol: 'udp', listener_port: 1194, tunnel_ipv4_cidr: '10.8.0.0/24' },
    });
    assert.equal(r.statusCode, 201);
    const env = r.json();
    assert.equal(env.engine, 'openvpn');
    assert.equal(env.protocol, 'udp');
    assert.equal(env.desiredState, 'active');
    assert.equal(env.observedState, 'pending');
    assert.equal(env.revision, 1);
    assert.ok(/^nexo-[a-f0-9]{12}$/.test(env.namespace_name ?? env.namespaceName), `Bad namespace: ${JSON.stringify(env)}`);

    const list = await app.inject({ method: 'GET', url: '/v1/provider/vpn-environments', headers });
    assert.equal(list.json().items.length, 1);
  } finally { await app.close(); }
});

test('F06 validates protocols and CIDR while F11 adds WireGuard', async () => {
  const vpnRepo = new MemoryVpnEnvironmentRepository(new Set([TENANT]));
  const { app, headers } = await setup(vpnRepo);
  try {
    const { nodeId } = await enrollNode(app, headers);
    const base = { tenant_id: TENANT, node_id: nodeId, name: 'X', engine: 'openvpn', protocol: 'udp', listener_port: 1194 };
    // Rutas por defecto o CIDR demasiado amplio rechazados
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '0.0.0.0/0' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.0.0.0/15' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.8.0.0/31' } })).statusCode, 422);
    const wireguard = await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.8.0.0/24', engine: 'wireguard', listener_port: 1195 } });
    assert.equal(wireguard.statusCode, 201);
    assert.equal(wireguard.json().engine, 'wireguard');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.8.0.0/24', protocol: 'tcp' } })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.8.0.0/24', listener_port: 80 } })).statusCode, 422);
    // Campo extra rechazado
    assert.equal((await app.inject({ method: 'POST', url: '/v1/provider/vpn-environments', headers, payload: { ...base, tunnel_ipv4_cidr: '10.8.0.0/24', shell: 'bash' } })).statusCode, 422);
  } finally { await app.close(); }
});

test('F06 node reports observed state and nodeId mismatch is rejected', async () => {
  const vpnRepo = new MemoryVpnEnvironmentRepository(new Set([TENANT]));
  const { app, headers } = await setup(vpnRepo);
  try {
    const { nodeId, nodeHeaders } = await enrollNode(app, headers);
    const { nodeHeaders: otherNodeHeaders } = await enrollNode(app, headers);
    const env = (await app.inject({
      method: 'POST', url: '/v1/provider/vpn-environments', headers,
      payload: { tenant_id: TENANT, node_id: nodeId, name: 'Test', engine: 'openvpn', protocol: 'udp', listener_port: 1194, tunnel_ipv4_cidr: '10.8.0.0/24' },
    })).json();

    const desired = await app.inject({ method: 'POST', url: '/v1/node/vpn-environments/reconcile', headers: nodeHeaders, payload: {} });
    assert.equal(desired.statusCode, 200);
    assert.deepEqual(desired.json().items.map(item => item.id), [env.id]);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/node/vpn-environments/reconcile', headers: nodeHeaders, payload: { path: '/tmp' } })).statusCode, 422);
    assert.deepEqual((await app.inject({ method: 'POST', url: '/v1/node/vpn-environments/reconcile', headers: otherNodeHeaders, payload: {} })).json().items, []);

    // Nodo correcto puede reportar
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders,
      payload: { revision: 1, observed_state: 'provisioning' },
    })).statusCode, 204);
    const afterProvisioning = await app.inject({ method: 'GET', url: '/v1/provider/vpn-environments', headers });
    assert.equal(afterProvisioning.json().items[0].observedState, 'provisioning');
    assert.equal(afterProvisioning.json().items[0].appliedRevision, undefined);

    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders,
      payload: { revision: 1, observed_state: 'active', config_digest: 'a'.repeat(64) },
    })).statusCode, 204);
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders,
      payload: { revision: 1, observed_state: 'active' },
    })).statusCode, 422);

    // Nodo incorrecto (otro nodo enrollado) no puede reportar sobre este entorno
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: otherNodeHeaders,
      payload: { revision: 1, observed_state: 'active', config_digest: 'a'.repeat(64) },
    })).statusCode, 409);

    // error_code obligatorio cuando state=error
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders,
      payload: { revision: 1, observed_state: 'error' },
    })).statusCode, 422);

    // error_code con state≠error rechazado
    assert.equal((await app.inject({
      method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders,
      payload: { revision: 1, observed_state: 'active', error_code: 'namespace_failed' },
    })).statusCode, 422);
  } finally { await app.close(); }
});

test('F06 state change requires expected revision and blocks retired re-activation', async () => {
  const vpnRepo = new MemoryVpnEnvironmentRepository(new Set([TENANT]));
  const { app, headers } = await setup(vpnRepo);
  try {
    const { nodeId, nodeHeaders } = await enrollNode(app, headers);
    const env = (await app.inject({
      method: 'POST', url: '/v1/provider/vpn-environments', headers,
      payload: { tenant_id: TENANT, node_id: nodeId, name: 'Rev test', engine: 'openvpn', protocol: 'udp', listener_port: 1194, tunnel_ipv4_cidr: '10.8.0.0/24' },
    })).json();

    // Revisión incorrecta
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/provider/vpn-environments/${env.id}/state`, headers, payload: { desired_state: 'suspended', expected_revision: 99 } })).statusCode, 409);

    // Revisión correcta
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/provider/vpn-environments/${env.id}/state`, headers, payload: { desired_state: 'retired', expected_revision: 1 } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/v1/node/vpn-environments/${env.id}/report`, headers: nodeHeaders, payload: { revision: 2, observed_state: 'active', config_digest: 'a'.repeat(64) } })).statusCode, 409);

    // Retirado no puede reactivarse
    assert.equal((await app.inject({ method: 'PUT', url: `/v1/provider/vpn-environments/${env.id}/state`, headers, payload: { desired_state: 'active', expected_revision: 2 } })).statusCode, 409);
  } finally { await app.close(); }
});

test('F06 exposes the minimal provider VPN administration interface', async () => {
  const { app } = await setup(new MemoryVpnEnvironmentRepository(new Set([TENANT])));
  try {
    const page = await app.inject({ method: 'GET', url: '/provider/vpn' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Entornos OpenVPN/u);
    assert.match(page.body, /name="tenant_id"/u);
    assert.match(page.body, /name="node_id"/u);
    assert.match(page.body, /name="tunnel_ipv4_cidr"/u);
    assert.match(page.body, /Solicitado|solicitado/u);
    assert.match(page.body, /Observado|observado/u);
  } finally { await app.close(); }
});
