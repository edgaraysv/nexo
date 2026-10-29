import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLabApplication } from '../dist/typescript/application.js';

async function withApplication(run, execute = async () => ({ http_status: 200, payload: { status: 'ok' } })) {
  const calls = [];
  let closed = 0;
  const app = await createLabApplication({
    execute: async request => { calls.push(request); return execute(request); },
    onApplicationShutdown: async () => { closed++; },
  });
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await run(app, calls);
  } finally {
    await app.close();
    assert.equal(closed, 1, 'Nest debe cerrar el proveedor de BD exactamente una vez');
  }
}

test('Nest arranca con Fastify y la ruta health usa el proveedor de BD', async () => {
  await withApplication(async (app, calls) => {
    assert.equal(app.getHttpAdapter().getType(), 'fastify');
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/health');
  });
});

test('conserva 202, cuerpo y headers; quita query sin derivar tenant del navegador', async () => {
  await withApplication(async (app, calls) => {
    const body = { endpoint_key: 'fixture-device-example', tenant_id: 'untrusted' };
    const r = await app.inject({ method: 'POST', url: '/v1/enrollments?tenant_id=untrusted',
      headers: { authorization: 'Bearer fixture-tech-alpha', 'idempotency-key': 'fixture-key' }, payload: body });
    assert.equal(r.statusCode, 202, 'No usar el 201 por defecto de Nest');
    assert.deepEqual(calls[0], { method: 'POST', path: '/v1/enrollments',
      authorization: 'Bearer fixture-tech-alpha', idempotencyKey: 'fixture-key', body });
  }, async () => ({ http_status: 202, payload: { status: 'requested', observed_at: null } }));
});

test('no transforma JSON null/array ni elimina campos desconocidos antes de validar en BD', async () => {
  await withApplication(async (app, calls) => {
    for (const payload of ['null', '[]', '{"tenant_id":"untrusted"}']) {
      await app.inject({ method: 'POST', url: '/v1/enrollments', headers: { 'content-type': 'application/json' }, payload });
    }
    assert.deepEqual(calls.map(c => c.body), [null, [], { tenant_id: 'untrusted' }]);
  });
});

test('cuerpo vacío se normaliza sin error de parsing previo al dominio', async () => {
  await withApplication(async (app, calls) => {
    await app.inject({ method: 'POST', url: '/v1/enrollments' });
    await app.inject({ method: 'POST', url: '/v1/enrollments', headers: { 'content-type': 'application/json' }, payload: '' });
    assert.deepEqual(calls.map(c => c.body), [{}, {}]);
  });
});

test('JSON malformado conserva 422 seguro y no llega a la BD', async () => {
  await withApplication(async (app, calls) => {
    const r = await app.inject({ method: 'POST', url: '/v1/enrollments', headers: { 'content-type': 'application/json' }, payload: '{secret' });
    assert.equal(r.statusCode, 422);
    assert.deepEqual(r.json(), { error: 'invalid_json' });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 0);
  });
});

test('el parser rechaza claves de prototipo sin ejecutar consultas', async () => {
  await withApplication(async (app, calls) => {
    for (const payload of ['{"__proto__":{"polluted":true}}', '{"constructor":{"prototype":{"polluted":true}}}']) {
      const r = await app.inject({ method: 'POST', url: '/v1/enrollments', headers: { 'content-type': 'application/json' }, payload });
      assert.equal(r.statusCode, 422);
      assert.deepEqual(r.json(), { error: 'invalid_json' });
    }
    assert.equal(calls.length, 0);
    assert.equal({}.polluted, undefined);
  });
});

test('el límite de 8192 bytes devuelve 413 sin consulta ni payload filtrado', async () => {
  await withApplication(async (app, calls) => {
    const r = await app.inject({ method: 'POST', url: '/v1/enrollments', headers: { 'content-type': 'application/json' }, payload: 'x'.repeat(8193) });
    assert.equal(r.statusCode, 413);
    assert.deepEqual(r.json(), { error: 'body_too_large' });
    assert.equal(calls.length, 0);
  });
});

test('registra operación y ACK con rutas explícitas', async () => {
  await withApplication(async (app, calls) => {
    const path = '/v1/operations/11111111-1111-4111-8111-111111111111';
    await app.inject({ method: 'GET', url: path });
    await app.inject({ method: 'POST', url: path + '/ack', payload: { revision: 1, status: 'applied' } });
    assert.deepEqual(calls.map(c => [c.method, c.path]), [['GET', path], ['POST', path + '/ack']]);
  });
});

test('tipo de contenido no admitido devuelve 415 seguro sin consultar la BD', async () => {
  await withApplication(async (app, calls) => {
    const r = await app.inject({ method: 'POST', url: '/v1/enrollments',
      headers: { 'content-type': 'application/xml' }, payload: '<secret>must-not-leak</secret>' });
    assert.equal(r.statusCode, 415);
    assert.deepEqual(r.json(), { error: 'unsupported_media_type' });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 0);
  });
});

test('rutas desconocidas no llegan a la BD ni exponen la respuesta interna de Nest', async () => {
  await withApplication(async (app, calls) => {
    const r = await app.inject({ method: 'GET', url: '/unknown?secret=must-not-leak' });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.json(), { error: 'not_found' });
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 0);
  });
});

test('excepciones del proveedor no filtran mensajes SQL ni credenciales', async () => {
  await withApplication(async app => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.statusCode, 500);
    assert.deepEqual(r.json(), { error: 'internal_error' });
    assert.equal(r.headers['cache-control'], 'no-store');
  }, async () => { throw new Error('secret-fixture SQL connection password=must-not-leak'); });
});

test('sin DATABASE_URL el arranque real falla, no usa una conexión implícita', async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(createLabApplication(), /DATABASE_URL is required/);
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
});
