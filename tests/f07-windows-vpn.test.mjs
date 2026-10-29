import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryDeviceRepository } from '../dist/product/device-repository.js';
import { MemoryVpnEnvironmentRepository } from '../dist/product/vpn-environment-repository.js';
import { MemoryVpnCredentialRepository } from '../dist/product/vpn-credential-repository.js';
import { MemoryNodeRepository } from '../dist/product/node-repository.js';
import { hashOpaqueToken } from '../dist/product/security.js';

const TENANT = 'f7f7f7f7-f7f7-47f7-87f7-f7f7f7f7f7f7';
const NODE = '77777777-7777-4777-8777-777777777777';
const CSR = `-----BEGIN CERTIFICATE REQUEST-----
MIHMMHUCAQAwEzERMA8GA1UEAwwIZjA3LXRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARtKLO2QT6DaASlMp749pGRrhrXDtJfGzzmaMMKg2bx5Ov5HWycR5xp
fadfM9tRVMC7Mzu6cUoK/nwjWLPEKZtboAAwCgYIKoZIzj0EAwIDRwAwRAIgNqtz
WzCf1hta9Jf83IH067U5NRuIS2LqkHDXV+8eIE4CIAp8OsI5+Q6W5xrPXnewmqDN
96Pz8+oyeymYqpkpnzoO
-----END CERTIFICATE REQUEST-----
`;

async function endpointSession(app, devices) {
  const token = 'f07-endpoint-invitation-token-0000000001';
  await devices.createInvitation(TENANT, { tokenHash: hashOpaqueToken(token), deviceKind: 'endpoint', uses: 1, expiresAt: Date.now() + 60_000 }, 'actor');
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const started = await app.inject({ method: 'POST', url: '/v1/device-enrollment/start', payload: { token, name: 'F07 Windows', audience: 'endpoint', public_key_pem: publicKeyPem } });
  assert.equal(started.statusCode, 201);
  const { device_id: deviceId, challenge, claim_token: claimToken } = started.json();
  const signature = sign('sha256', Buffer.from(`nexo-enrollment-v1\n${deviceId}\n${challenge}`), pair.privateKey).toString('base64');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/device-enrollment/prove', payload: { device_id: deviceId, challenge, signature } })).statusCode, 202);
  const certificate = { serial: 'F07-ENDPOINT-1', certificatePem: 'endpoint-certificate', notBefore: new Date(Date.now() - 1_000).toISOString(), notAfter: new Date(Date.now() + 86_400_000).toISOString() };
  assert.equal(await devices.approve(TENANT, deviceId, certificate, 'actor'), true);
  const claimed = (await app.inject({ method: 'POST', url: '/v1/device-enrollment/claim', payload: { device_id: deviceId, claim_token: claimToken } })).json();
  const authChallenge = (await app.inject({ method: 'POST', url: '/v1/device-auth/challenge', payload: { device_id: deviceId, serial: claimed.serial, certificate_pem: claimed.certificate_pem } })).json().challenge;
  const authSignature = sign('sha256', Buffer.from(`nexo-auth-v1\n${deviceId}\n${claimed.serial}\n${authChallenge}`), pair.privateKey).toString('base64');
  const authenticated = await app.inject({ method: 'POST', url: '/v1/device-auth/verify', payload: { device_id: deviceId, serial: claimed.serial, challenge: authChallenge, signature: authSignature } });
  assert.equal(authenticated.statusCode, 200);
  return { deviceId, headers: { authorization: `Bearer ${authenticated.json().token}` } };
}

test('F07 endpoint receives only its typed active VPN catalog', async () => {
  const devices = new MemoryDeviceRepository({ [TENANT]: 1 });
  const vpn = new MemoryVpnEnvironmentRepository(new Set([TENANT]), new Set([NODE]));
  const app = await createProductApplication(undefined, undefined, undefined, undefined, undefined, devices, { issue: async () => { throw new Error('unused'); } }, undefined, undefined, vpn);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const endpoint = await endpointSession(app, devices);
    const environment = await vpn.create({ tenantId: TENANT, nodeId: NODE, name: 'Oficina F07', listenerPort: 21294, tunnelIpv4Cidr: '10.91.0.0/24' }, 'actor');
    await vpn.report(environment.id, NODE, { revision: 1, observedState: 'active', configDigest: 'a'.repeat(64) });

    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: endpoint.headers, payload: { url: 'https://evil.invalid' } })).statusCode, 422);
    const response = await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: endpoint.headers, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { module_state: 'enabled', items: [{ id: environment.id, name: 'Oficina F07', engine: 'openvpn', protocol: 'udp', listener_port: 21294, revision: 1 }] });
    for (const forbidden of ['nodeId', 'namespaceName', 'tunnelIpv4Cidr', 'configDigest', 'url', 'route', 'certificate']) assert.equal(response.body.includes(forbidden), false);
  } finally {
    await app.close();
  }
});

test('F07 endpoint catalog fails closed when VPN is not entitled', async () => {
  const devices = new MemoryDeviceRepository({ [TENANT]: 1 });
  const vpn = new MemoryVpnEnvironmentRepository(new Set(), new Set([NODE]));
  const app = await createProductApplication(undefined, undefined, undefined, undefined, undefined, devices, { issue: async () => { throw new Error('unused'); } }, undefined, undefined, vpn);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const endpoint = await endpointSession(app, devices);
    const response = await app.inject({ method: 'POST', url: '/v1/device/vpn/reconcile', headers: endpoint.headers, payload: {} });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { module_state: 'disabled', items: [] });
  } finally {
    await app.close();
  }
});

test('F07 queues only a typed CSR operation for the owning node', async () => {
  const devices=new MemoryDeviceRepository({[TENANT]:1}),nodes=new MemoryNodeRepository(),approvedNodes=new Set();
  await nodes.createInvitation({tokenHash:'node-token',expiresAt:Date.now()+60_000,uses:1},'actor');
  const started=await nodes.begin({tokenHash:'node-token',name:'F07 node',publicKeyPem:'fixture',fingerprint:'f07-node',claimHash:'claim',challengeHash:'proof',challengeExpiresAt:Date.now()+60_000});
  assert.ok(started);assert.equal(await nodes.markProof(started.nodeId,'proof'),true);assert.equal(await nodes.approve(started.nodeId,{serial:'node-cert',certificatePem:'fixture',notBefore:new Date().toISOString(),notAfter:new Date(Date.now()+86_400_000).toISOString()},'actor'),true);approvedNodes.add(started.nodeId);
  const vpn=new MemoryVpnEnvironmentRepository(new Set([TENANT]),approvedNodes),credentials=new MemoryVpnCredentialRepository(nodes);
  const app=await createProductApplication(undefined,undefined,undefined,undefined,undefined,devices,{issue:async()=>{throw new Error('unused');}},undefined,nodes,vpn,credentials);
  await app.init();await app.getHttpAdapter().getInstance().ready();
  try{
    const endpoint=await endpointSession(app,devices),environment=await vpn.create({tenantId:TENANT,nodeId:started.nodeId,name:'CSR F07',listenerPort:21394,tunnelIpv4Cidr:'10.93.0.0/24'},'actor');await vpn.report(environment.id,started.nodeId,{revision:1,observedState:'active',configDigest:'b'.repeat(64)});credentials.allow(environment.id,TENANT,started.nodeId);
    const invalid=await app.inject({method:'POST',url:'/v1/device/vpn/credentials',headers:endpoint.headers,payload:{environment_id:environment.id,csr_pem:'not-a-csr',idempotency_key:'f07-invalid'}});assert.equal(invalid.statusCode,422);
    const requested=await app.inject({method:'POST',url:'/v1/device/vpn/credentials',headers:endpoint.headers,payload:{environment_id:environment.id,csr_pem:CSR,idempotency_key:'f07-issue-credential'}});assert.equal(requested.statusCode,202);assert.equal(requested.json().state,'pending');assert.equal(requested.body.includes('PRIVATE KEY'),false);
     assert.equal(await nodes.dispatch('test',10),1);const operation=await nodes.next(started.nodeId);assert.equal(operation.type,'vpn.client_certificate.issue.v1');assert.equal(operation.arguments.environment_id,environment.id);assert.equal(operation.arguments.device_id,endpoint.deviceId);assert.equal(operation.arguments.csr_pem,CSR);assert.equal('command' in operation.arguments,false);assert.equal('path' in operation.arguments,false);
     const envelope=JSON.stringify({version:'v1',ephemeral_public_key:'A'.repeat(87),nonce:'A'.repeat(16),ciphertext:'A'.repeat(363)}),result={serial:'12345678',certificate_pem:'synthetic-certificate',ca_certificate_pem:'synthetic-ca',tls_crypt_key_envelope:envelope,not_before:new Date().toISOString(),not_after:new Date(Date.now()+3600000).toISOString()};
     assert.equal(await nodes.complete(started.nodeId,operation.id,'succeeded',{serial:result.serial,certificate_pem:result.certificate_pem,ca_certificate_pem:result.ca_certificate_pem,not_before:result.not_before,not_after:result.not_after},new Date().toISOString(),operation.revision),true);
     assert.equal(await credentials.complete(operation,'succeeded',result),true);
     assert.equal((await app.inject({method:'GET',url:`/v1/device/vpn/credentials/${environment.id}`})).statusCode,401);
     const delivered=await app.inject({method:'GET',url:`/v1/device/vpn/credentials/${environment.id}`,headers:endpoint.headers});assert.equal(delivered.statusCode,200);assert.equal(delivered.json().tls_crypt_key_envelope,envelope);assert.equal(delivered.body.includes('OpenVPN Static key'),false);
  }finally{await app.close();}
});

test('F07 Windows UI exposes only typed connect and disconnect actions', async () => {
  const [ui, ipc, runtime] = await Promise.all([
    readFile('product/client/src/App.tsx','utf8'),
    readFile('product/client/src/ipc.ts','utf8'),
    readFile('product/agent/cmd/nexo-agent/vpn_client_runtime.go','utf8')
  ]);
  assert.match(ui, /connect_vpn/);assert.match(ui,/disconnect_vpn/);
  assert.match(ipc, /'connect_vpn'/);assert.match(ipc,/'disconnect_vpn'/);
  assert.doesNotMatch(ui, /openvpn\.exe|client\.ovpn|remote_host|executable|config_path/);
  assert.match(runtime, /pull-filter ignore \"redirect-gateway\"/);
  assert.match(runtime, /remote-cert-tls server/);
  assert.doesNotMatch(runtime, /management 127|--remote|--route|cmd\.exe|powershell/);
});
