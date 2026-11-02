import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { administrativePage } from '../dist/product/administrative-ui.js';

test('legacy navigation routes redirect to the matching section in /admin', async () => {
  const app = await createProductApplication(new MemoryIdentityRepository([]));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const redirects = [
      ['/', '/admin'],
      ['/provider/commercial', '/admin#provider-commercial'],
      ['/provider/vpn', '/admin#provider-infra'],
      ['/provider/reports', '/admin#provider-reports'],
      ['/company', '/admin#company-summary'],
      ['/company/networks', '/admin#company-networks'],
      ['/company/reports', '/admin#company-activity'],
    ];
    for (const [url, destination] of redirects) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 302, `${url} must redirect`);
      assert.equal(response.headers.location, destination);
    }
    assert.equal((await app.inject({ method: 'GET', url: '/account' })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('integrated admin shell includes the SYSMedia shell and parses its client script', () => {
  const page = administrativePage();
  const script = /<script>([\s\S]*?)<\/script>/u.exec(page)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Script(script));
  assert.match(page, /--sys-navy:#003B6F/u);
  assert.match(page, /--nx-bg:#EFF4F9/u);
  assert.match(page, /grid-template:"tb tb" 54px "sb sc" auto "sb mn" 1fr \/ 14rem 1fr/u);
  assert.match(page, /fonts\.googleapis\.com/u);
  assert.match(page, /aria-label="Placeholder de marca, no es el logo oficial"/u);
  assert.match(page, /:focus-visible/u);
  assert.match(page, /@media\(max-width:900px\)/u);
  assert.match(page, /@media\(max-width:560px\)/u);
  assert.match(page, /prefers-reduced-motion:reduce/u);
  assert.match(page, /provider-commercial/u);
  assert.match(page, /company-networks/u);
  assert.match(page, /providerRoutes=\[\['Resumen','provider-summary'\],\['Empresas','provider-companies'\],\['Comercial','provider-commercial'\],\['Nodos y VPN','provider-infra'\],\['Reportes','provider-reports'\]\]/u);
  assert.match(page, /companyRoutes=\[\['Resumen','company-summary'\],\['Usuarios y equipos','company-people'\],\['Redes y políticas','company-networks'\],\['Operaciones y auditoría','company-activity'\]\]/u);
});
