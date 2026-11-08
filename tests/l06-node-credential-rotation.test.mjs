import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryNodeRepository } from '../dist/product/node-repository.js';
import { MemoryProviderRepository } from '../dist/product/provider-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const USER = '60606060-6060-4060-8060-606060606060';
const SECRET = 'JBSWY3DPEHPK3PXP';
const DAY = 24 * 60 * 60 * 1000;

function totp() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex')).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000).padStart(6, '0');
}

function certificate(serial, notBefore, notAfter) {
  return { serial, certificatePem: `certificate:${serial}`, notBefore: new Date(notBefore).toISOString(), notAfter: new Date(notAfter).toISOString() };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(issuer) {
  const identity = new MemoryIdentityRepository([{
    id: USER,
    email: 'node-owner@example.test',
    passwordHash: await hashPassword('correct horse battery staple'),
    status: 'active',
    mfaRequired: true,
    totpSecret: SECRET,
    providerRole: 'owner',
    memberships: [],
  }]);
  const provider = new MemoryProviderRepository(new Map([[USER, 'owner']]));
  const nodes = new MemoryNodeRepository();
  const app = await createProductApplication(identity, undefined, provider, undefined, undefined, undefined, issuer, undefined, nodes);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'node-owner@example.test', password: 'correct horse battery staple' } });
  const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: totp() } });
  const selected = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: mfa.json().selection, scope_kind: 'provider' } });
  return { app, nodes, headers: { authorization: `Bearer ${selected.json().token}` } };
}

async function enroll(runtime, { approve = true } = {}) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeyPEM = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const invitation = await runtime.app.inject({ method: 'POST', url: '/v1/provider/node-invitations', headers: runtime.headers, payload: {} });
  const started = await runtime.app.inject({ method: 'POST', url: '/v1/node-enrollment/start', payload: { token: invitation.json().token, name: 'Rotation node', audience: 'node', public_key_pem: publicKeyPEM } });
  const nodeId = started.json().node_id;
  const challenge = started.json().challenge;
  const enrollmentSignature = sign('sha256', Buffer.from(`nexo-node-enrollment-v1\n${nodeId}\n${challenge}`), pair.privateKey).toString('base64');
  assert.equal((await runtime.app.inject({ method: 'POST', url: '/v1/node-enrollment/prove', payload: { node_id: nodeId, challenge, signature: enrollmentSignature } })).statusCode, 202);
  if (approve) assert.equal((await runtime.app.inject({ method: 'POST', url: `/v1/provider/nodes/${nodeId}/approve`, headers: runtime.headers })).statusCode, 204);
  return { nodeId, pair };
}

function requestRotation(app, headers, nodeId, idempotencyKey) {
  return app.inject({ method: 'POST', url: `/v1/provider/nodes/${nodeId}/credential-rotations`, headers, payload: { idempotency_key: idempotencyKey } });
}

function completeRotation(app, nodeId, pair, rotationId) {
  const signature = sign('sha256', Buffer.from(`nexo-node-credential-rotation-v1\n${nodeId}\n${rotationId}`), pair.privateKey).toString('base64');
  return app.inject({ method: 'POST', url: `/v1/node-credential-rotations/${rotationId}/complete`, payload: { node_id: nodeId, signature } });
}

test('approved node rotates once with a 30-day credential and safely replays concurrent completion', async () => {
  const issuanceStarted = deferred();
  const releaseIssuance = deferred();
  const issuedCalls = [];
  const issuer = {
    async issue(input) {
      issuedCalls.push(input);
      if (issuedCalls.length === 1) return certificate('NODE-OLD', Date.now() - DAY, Date.now() - 1_000);
      issuanceStarted.resolve();
      await releaseIssuance.promise;
      return certificate('NODE-NEW', Date.now() - 1_000, Date.now() + 30 * DAY + 60_000);
    },
  };
  const runtime = await setup(issuer);
  try {
    const { nodeId, pair } = await enroll(runtime);
    const [created, repeated] = await Promise.all([
      requestRotation(runtime.app, runtime.headers, nodeId, 'node-rotation-idempotent-01'),
      requestRotation(runtime.app, runtime.headers, nodeId, 'node-rotation-idempotent-01'),
    ]);
    assert.deepEqual([created.statusCode, repeated.statusCode].sort(), [200, 201]);
    assert.equal(created.json().rotation_id, repeated.json().rotation_id);
    const rotationId = created.json().rotation_id;
    assert.equal((await requestRotation(runtime.app, runtime.headers, nodeId, 'node-rotation-other-0001')).statusCode, 409);
    assert.equal(issuedCalls.length, 1, 'request replays must not issue a certificate');

    const firstCompletion = completeRotation(runtime.app, nodeId, pair, rotationId);
    await issuanceStarted.promise;
    const concurrentCompletion = await completeRotation(runtime.app, nodeId, pair, rotationId);
    assert.equal(concurrentCompletion.statusCode, 409, 'an in-flight rotation cannot start a second issuance');
    assert.equal(issuedCalls.length, 2, 'only approval and one rotation reached the issuer');
    releaseIssuance.resolve();

    const completed = await firstCompletion;
    assert.equal(completed.statusCode, 200);
    const newCertificate = completed.json();
    assert.equal(newCertificate.serial, 'NODE-NEW');
    assert.ok(Date.parse(newCertificate.not_after) - Date.parse(newCertificate.not_before) >= 30 * DAY);
    assert.equal(await runtime.nodes.credentialStatus(nodeId, 'NODE-OLD'), 'rotated');
    assert.equal(await runtime.nodes.credentialStatus(nodeId, 'NODE-NEW'), 'active');

    const replay = await completeRotation(runtime.app, nodeId, pair, rotationId);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().serial, 'NODE-NEW');
    assert.equal(issuedCalls.length, 2, 'completed replay returns the same certificate without reissuing');
  } finally {
    releaseIssuance.resolve();
    await runtime.app.close();
  }
});

test('credential rotation is rejected for a node that is not approved', async () => {
  const issuer = { async issue() { return certificate('NODE-OLD', Date.now() - DAY, Date.now() - 1_000); } };
  const runtime = await setup(issuer);
  try {
    const { nodeId } = await enroll(runtime, { approve: false });
    const response = await requestRotation(runtime.app, runtime.headers, nodeId, 'node-rotation-pending-01');
    assert.equal(response.statusCode, 409);
  } finally {
    await runtime.app.close();
  }
});
