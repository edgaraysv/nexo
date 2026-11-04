import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';

test('legacy navigation routes redirect to matching React portal routes', async () => {
  const app = await createProductApplication(new MemoryIdentityRepository([]));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const redirects = [
      ['/', '/portal/admin'],
      ['/admin', '/portal/admin'],
      ['/admin/', '/portal/admin'],
      ['/admin/?from=legacy', '/portal/admin'],
      ['/provider/commercial', '/portal/admin/provider/commercial'],
      ['/provider/vpn', '/portal/admin/provider/infra'],
      ['/provider/reports', '/portal/admin/provider/reports'],
      ['/company', '/portal/admin/company/summary'],
      ['/company/networks', '/portal/admin/company/networks'],
      ['/company/reports', '/portal/admin/company/activity'],
    ];
    for (const [url, destination] of redirects) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 302, `${url} must redirect`);
      assert.equal(response.headers.location, destination);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/admin/unknown' })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/account' })).statusCode, 200);
  } finally {
    await app.close();
  }
});
