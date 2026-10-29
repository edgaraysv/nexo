import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';

test('F07-only server build hides every F08 HTTP surface', async () => {
  const app = await createProductApplication(new MemoryIdentityRepository(), ...Array(11).fill(undefined), { privateNetworksEnabled: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    for (const request of [
      { method: 'GET', url: '/company/networks' },
      { method: 'GET', url: '/v1/company/network-profiles' },
      { method: 'GET', url: '/v1/company/private-resources' },
      { method: 'POST', url: '/v1/device/private-network/reconcile', payload: {} },
      { method: 'POST', url: '/v1/device/private-network/profile/report', payload: {} }
    ]) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 404, `${request.method} ${request.url} must be hidden`);
    }
  } finally {
    await app.close();
  }
});
