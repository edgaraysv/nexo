import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';

test('GET /v1/health is public, minimal, and not cacheable', async () => {
  const app = await createProductApplication(new MemoryIdentityRepository());
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.equal(response.headers['cache-control'], 'no-store');
    const head = await app.inject({ method: 'HEAD', url: '/v1/health' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');
  } finally {
    await app.close();
  }
});
