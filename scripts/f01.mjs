import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { docker } from './docker.mjs';

const project = `nexo-f01-${randomUUID().slice(0, 12)}`;
const directory = `artifacts/f01/${project}`;
await mkdir(directory, { recursive: true });
const report = { scope: 'F01_SPIKE_NOT_PRODUCT_ACCEPTANCE', project, started: new Date().toISOString(), candidates: [], cleanup: 'NOT RUN' };
let resourcesRequested = false;
function compose(args, options = {}) {
  return docker(['compose', '-p', project, '-f', 'spikes/api/compose.yaml', ...args], options);
}
function must(result, description) {
  if (result.status !== 0) throw new Error(`${description}: ${result.stderr || result.error || result.stdout}`);
  return (result.stdout ?? '').trim();
}

try {
  const npmLock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const composerLock = JSON.parse(await readFile('spikes/api/php/appstarter/composer.lock', 'utf8'));
  report.dependencies = {
    npm: Object.entries(npmLock.packages).filter(([path]) => path).map(([path, pkg]) => ({ path, version: pkg.version, declaredLicense: pkg.license ?? 'NOT VERIFIED', integrity: pkg.integrity })),
    composer: composerLock.packages.map(pkg => ({ name: pkg.name, version: pkg.version, declaredLicense: pkg.license, reference: pkg.dist?.reference })),
    go: await readFile('spikes/api/go/go.mod', 'utf8'),
    interpretation: 'Inventario de dependencias del laboratorio; declaraciones no equivalen a revisión legal ni SBOM del producto.',
  };
  const context = must(docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']), 'contexto');
  assert.match(context, /^unix:\/\//, 'Solo motor Docker local mediante socket Unix');
  report.docker = must(docker(['version', '--format', '{{json .}}']), 'versiones Docker');
  console.log(`Laboratorio desechable: ${project}`);
  resourcesRequested = true;
  must(compose(['up', '-d', '--build', '--wait', '--wait-timeout', '120'], { stdio: 'inherit' }), 'inicio Compose');
  for (const candidate of ['typescript', 'php', 'go']) {
    const entry = { candidate, status: 'FAIL', checks: [], elapsedMs: 0 };
    if (candidate === 'typescript') {
      entry.implementation = {
        framework: 'NestJS', version: npmLock.packages['node_modules/@nestjs/core'].version,
        transport: 'Fastify', transportVersion: npmLock.packages['node_modules/fastify'].version,
        adapterVersion: npmLock.packages['node_modules/@nestjs/platform-fastify'].version,
        versionSource: 'package-lock.json; imagen construida con npm ci',
      };
    }
    report.candidates.push(entry);
    const started = performance.now();
    const address = must(compose(['port', candidate, '8080']), 'puerto local');
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    let base = `http://${address}`;
    const request = async (method, path, { token, key, body, raw } = {}) => {
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (key) headers['idempotency-key'] = key;
      if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
      const r = await fetch(base + path, { method, headers,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), signal: AbortSignal.timeout(15_000) });
      return { status: r.status, body: await r.json() };
    };
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await request('GET', '/health')).status === 200) { ready = true; break; } } catch {}
      await setTimeout(500);
    }
    assert.ok(ready, `${candidate}: /health no listo`);
    const check = async (name, fn) => { await fn(); entry.checks.push({ name, status: 'PASS' }); };
    const endpoint = (suffix) => ({ endpoint_key: `fixture-device-${suffix}` });
    const enroll = (token, key = randomUUID(), body = endpoint(randomUUID())) => request('POST', '/v1/enrollments', { token, key, body });
    const sql = (query) => must(compose(['exec', '-T', 'db', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', `f01_${candidate}`, '-At'], { input: query }), 'aserción SQL');

    await check('authentication_and_roles', async () => {
      for (const token of [undefined, 'wrong', 'fixture-expired']) assert.equal((await enroll(token)).status, 401);
      assert.equal((await enroll('fixture-viewer-alpha')).status, 403);
      assert.equal((await enroll('fixture-node-alpha')).status, 403);
    });
    await check('strict_input_and_body_limit', async () => {
      for (const body of [null, [], {}, { endpoint_key: 2 }, { endpoint_key: 'short' }, { endpoint_key: "hostile'; DROP TABLE tenants;--" }, { ...endpoint('injected'), tenant_id: 'beta' }]) {
        assert.equal((await enroll('fixture-tech-alpha', randomUUID(), body)).status, 422);
      }
      assert.equal((await enroll('fixture-tech-alpha', 'not-a-uuid')).status, 400);
      assert.equal((await request('POST', '/v1/enrollments', { token: 'fixture-tech-alpha', raw: '{' })).status, 422);
      assert.equal((await request('POST', '/v1/enrollments', { token: 'fixture-tech-alpha', raw: 'x'.repeat(8193) })).status, 413);
    });
    const key = randomUUID();
    const body = endpoint('alpha-first');
    let operation;
    await check('enrollment_outbox_and_idempotency', async () => {
      const first = await enroll('fixture-tech-alpha', key, body);
      assert.equal(first.status, 202);
      assert.equal(first.body.status, 'requested');
      assert.equal(first.body.observed_at, null);
      operation = first.body.operation_id;
      assert.deepEqual(await enroll('fixture-tech-alpha', key, body), first);
      assert.equal((await enroll('fixture-tech-alpha', key, endpoint('changed-body'))).status, 409);
      assert.equal(sql("SELECT count(*) FROM outbox WHERE tenant_id='alpha';"), '1');
    });
    await check('tenant_isolation_and_resource_auth', async () => {
      assert.equal((await request('GET', `/v1/operations/${operation}`, { token: 'fixture-tech-beta' })).status, 404);
      assert.equal((await request('GET', `/v1/operations/${operation}`, { token: 'fixture-tech-alpha' })).status, 200);
      assert.equal((await enroll('fixture-tech-beta', key, body)).status, 202, 'misma clave/identidad en otra empresa no colisiona');
    });
    await check('quota_and_duplicate_endpoint', async () => {
      assert.equal((await enroll('fixture-tech-alpha', randomUUID(), body)).status, 409);
      assert.equal((await enroll('fixture-tech-alpha')).status, 202);
      assert.equal((await enroll('fixture-tech-alpha')).status, 409);
      assert.equal(sql("SELECT used FROM tenants WHERE id='alpha';"), '2');
    });
    await check('database_rejects_cross_tenant_reference', async () => {
      const denied = compose(['exec', '-T', 'db', 'psql', '-X', '-U', 'postgres', '-d', `f01_${candidate}`, '-v', 'ON_ERROR_STOP=1'], {
        input: "UPDATE operations SET endpoint_id=(SELECT id FROM endpoints WHERE tenant_id='beta' LIMIT 1) WHERE tenant_id='alpha';",
      });
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /foreign key constraint/);
    });
    await check('typed_revision_ack_and_honest_observation', async () => {
      const path = `/v1/operations/${operation}/ack`;
      const ack = { revision: 1, status: 'applied' };
      assert.equal((await request('POST', path, { token: 'fixture-tech-alpha', body: ack })).status, 403);
      assert.equal((await request('POST', path, { token: 'fixture-node-beta', body: ack })).status, 404);
      assert.equal((await request('POST', path, { token: 'fixture-node-alpha', body: { revision: 2, status: 'applied' } })).status, 409);
      assert.equal((await request('POST', path, { token: 'fixture-node-alpha', body: { ...ack, command: 'shell' } })).status, 409);
      for (let i = 0; i < 2; i++) assert.equal((await request('POST', path, { token: 'fixture-node-alpha', body: ack })).status, 200);
      const state = await request('GET', `/v1/operations/${operation}`, { token: 'fixture-tech-alpha' });
      assert.equal(state.body.status, 'applied');
      assert.equal(state.body.observed_at, null, 'ACK no prueba conectividad');
      assert.equal(sql(`SELECT delivered FROM outbox WHERE tenant_id='alpha' AND operation_id='${operation}';`), 't');
    });
    await check('last_quota_concurrency', async () => {
      const results = await Promise.all(Array.from({ length: 20 }, () => enroll('fixture-tech-race')));
      assert.equal(results.filter(r => r.status === 202).length, 1);
      assert.equal(results.filter(r => r.status === 409).length, 19);
      assert.equal(sql("SELECT used,(SELECT count(*) FROM endpoints WHERE tenant_id='race'),(SELECT count(*) FROM operations WHERE tenant_id='race'),(SELECT count(*) FROM outbox WHERE tenant_id='race') FROM tenants WHERE id='race';"), '1|1|1|1');
    });
    await check('concurrent_idempotent_replay', async () => {
      const id = randomUUID(); const b = endpoint('parallel-replay');
      const results = await Promise.all(Array.from({ length: 12 }, () => enroll('fixture-tech-replay', id, b)));
      assert.ok(results.every(r => r.status === 202));
      assert.equal(new Set(results.map(r => r.body.operation_id)).size, 1);
      assert.equal(sql("SELECT used FROM tenants WHERE id='replay';"), '1');
    });
    await check('transaction_failure_rolls_back_all_effects', async () => {
      const r = await enroll('fixture-tech-failure');
      assert.deepEqual(r, { status: 500, body: { error: 'internal_error' } });
      assert.equal(sql("SELECT used,(SELECT count(*) FROM endpoints WHERE tenant_id='failure'),(SELECT count(*) FROM operations WHERE tenant_id='failure'),(SELECT count(*) FROM outbox WHERE tenant_id='failure') FROM tenants WHERE id='failure';"), '0|0|0|0');
    });
    await check('runtime_role_cannot_bypass_function', async () => {
      const denied = compose(['exec', '-T', '-e', 'PGPASSWORD=public-f01-app-only', 'db', 'psql', '-h', '127.0.0.1', '-U', 'f01_app', '-d', `f01_${candidate}`, '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT * FROM principals;']);
      assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /permission denied/);
    });
    await check('adapter_restart_preserves_applied_state', async () => {
      must(compose(['restart', candidate]), 'reinicio del adaptador');
      // Docker puede reasignar un puerto efímero al arrancar de nuevo.
      const restartedAddress = must(compose(['port', candidate, '8080']), 'puerto tras reinicio');
      assert.match(restartedAddress, /^127\.0\.0\.1:\d+$/);
      base = `http://${restartedAddress}`;
      let state;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          state = await request('GET', `/v1/operations/${operation}`, { token: 'fixture-tech-alpha' });
          if (state.status === 200) break;
        } catch {}
        await setTimeout(300);
      }
      assert.equal(state?.status, 200);
      assert.equal(state.body.status, 'applied');
      assert.equal(state.body.observed_at, null);
    });
    entry.status = 'PASS';
    entry.elapsedMs = Math.round(performance.now() - started);
    console.log(`${candidate}: PASS (${entry.checks.length} grupos de comprobaciones)`);
  }
  report.images = must(compose(['images', '--format', 'json']), 'inventario de imágenes');
  report.status = 'PASS';
} catch (error) {
  report.status = resourcesRequested ? 'FAIL' : 'BLOCKED'; report.error = String(error);
  console.error(error);
  if (resourcesRequested) {
    try {
      const logs = compose(['logs', '--no-color', '--tail', '80']);
      await writeFile(`${directory}/compose.log`, (logs.stdout ?? '') + (logs.stderr ?? ''));
    } catch (logError) { report.logError = String(logError); }
  }
  process.exitCode = 1;
} finally {
  if (resourcesRequested) {
    try {
      const cleanup = compose(['down', '--volumes', '--timeout', '10']);
      report.cleanup = cleanup.status === 0 ? 'PASS' : 'FAIL';
      if (cleanup.status !== 0) { report.cleanupError = cleanup.stderr; process.exitCode = 1; }
    } catch (cleanupError) {
      report.cleanup = 'FAIL'; report.cleanupError = String(cleanupError); process.exitCode = 1;
    }
  } else { report.cleanup = 'NOT REQUIRED'; }
  report.finished = new Date().toISOString();
  await writeFile(`${directory}/report.json`, JSON.stringify(report, null, 2) + '\n');
  await writeFile('artifacts/f01/latest.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`Evidencia: ${directory}/report.json; limpieza: ${report.cleanup}`);
}
