import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { MemoryVpnEnvironmentRepository } from '../dist/product/vpn-environment-repository.js';
import { MemoryWireGuardPeerRepository } from '../dist/product/wireguard-peer-repository.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NODE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ENVIRONMENT = { tenantId: TENANT, nodeId: NODE, name: 'F11 WireGuard', engine: 'wireguard', listenerPort: 51820, tunnelIpv4Cidr: '10.81.0.0/24' };

function publicKey() {
  return generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
}

async function readyEnvironment() {
  const environments = new MemoryVpnEnvironmentRepository(new Set([TENANT]), new Set([NODE]));
  const environment = await environments.create(ENVIRONMENT, OWNER);
  const serverPublicKey = publicKey();
  assert.equal(await environments.report(environment.id, NODE, { revision: 1, observedState: 'active', configDigest: 'a'.repeat(64), wireguardServerPublicKey: serverPublicKey }), true);
  return { environments, environment, serverPublicKey, peers: new MemoryWireGuardPeerRepository(environments) };
}

test('F11 peer registration exposes only public material and requires preview confirmation', async () => {
  const { environments, peers, environment, serverPublicKey } = await readyEnvironment();
  const clientPublicKey = publicKey();
  const registered = await peers.register({ tenantId: TENANT, deviceId: DEVICE, environmentId: environment.id, publicKey: clientPublicKey, action: 'register' });
  assert.equal(registered.state, 'pending');
  assert.equal(registered.tunnelIpv4, '10.81.0.2');
  assert.equal(Object.hasOwn(registered, 'privateKey'), false);

  const preview = await peers.preview({ environmentId: environment.id, deviceId: DEVICE, action: 'approve', expectedRevision: 1 }, OWNER);
  assert.deepEqual(preview.summary.allowedIps, ['10.81.0.2/32']);
  await assert.rejects(() => peers.preview({ environmentId: environment.id, deviceId: DEVICE, action: 'approve', expectedRevision: 1 }, OWNER), /preview_pending/);
  await assert.rejects(() => peers.confirm({ previewId: preview.id, digest: '0'.repeat(64) }, OWNER), /preview_digest_conflict/);
  assert.equal((await peers.confirm({ previewId: preview.id, digest: preview.digest }, OWNER)).state, 'active');
  assert.equal(await environments.report(environment.id, NODE, { revision: 2, observedState: 'active', configDigest: 'b'.repeat(64), wireguardServerPublicKey: serverPublicKey }), true);

  const deviceConfig = await peers.forDevice(TENANT, DEVICE);
  assert.equal(deviceConfig[environment.id].clientPublicKey, clientPublicKey);
  assert.equal(deviceConfig[environment.id].serverPublicKey, serverPublicKey);
  assert.deepEqual(deviceConfig[environment.id].allowedIps, ['10.81.0.1/32']);
  assert.equal(Object.values(deviceConfig).some(value => Object.hasOwn(value, 'privateKey')), false);

  const nodeDesired = await peers.desiredForNode(NODE);
  assert.deepEqual(nodeDesired[environment.id][0].allowedIps, ['10.81.0.2/32']);
  assert.equal(nodeDesired[environment.id][0].publicKey, clientPublicKey);
});

test('F11 rotation activates a candidate only after confirmation; revoke removes it from desired state', async () => {
  const { environments, peers, environment } = await readyEnvironment();
  const firstKey = publicKey();
  const registration = await peers.register({ tenantId: TENANT, deviceId: DEVICE, environmentId: environment.id, publicKey: firstKey, action: 'register' });
  const approval = await peers.preview({ environmentId: environment.id, deviceId: DEVICE, action: 'approve', expectedRevision: 1 }, OWNER);
  await peers.confirm({ previewId: approval.id, digest: approval.digest }, OWNER);
  assert.equal(await environments.report(environment.id, NODE, { revision: 2, observedState: 'active', configDigest: 'b'.repeat(64) }), true);

  const nextKey = publicKey();
  await peers.register({ tenantId: TENANT, deviceId: DEVICE, environmentId: environment.id, publicKey: nextKey, action: 'rotate' });
  const rotation = await peers.preview({ environmentId: environment.id, deviceId: DEVICE, action: 'rotate', expectedRevision: 2 }, OWNER);
  await assert.rejects(() => peers.confirm({ previewId: rotation.id, digest: 'f'.repeat(64) }, OWNER), /preview_digest_conflict/);
  const rotated = await peers.confirm({ previewId: rotation.id, digest: rotation.digest }, OWNER);
  assert.equal(await environments.report(environment.id, NODE, { revision: 3, observedState: 'active', configDigest: 'c'.repeat(64) }), true);
  assert.equal(rotated.publicKeyFingerprint, (await peers.register({ tenantId: TENANT, deviceId: DEVICE, environmentId: environment.id, publicKey: nextKey, action: 'register' })).publicKeyFingerprint);
  assert.notEqual(rotated.publicKeyFingerprint, registration.publicKeyFingerprint);

  const revoke = await peers.preview({ environmentId: environment.id, deviceId: DEVICE, action: 'revoke', expectedRevision: 3 }, OWNER);
  await peers.confirm({ previewId: revoke.id, digest: revoke.digest }, OWNER);
  assert.deepEqual((await peers.desiredForNode(NODE))[environment.id], []);
  assert.deepEqual(await peers.forDevice(TENANT, DEVICE), {});
});
