import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function validateTraceability(data, catalogue) {
  const expected = new Map();
  for (const line of catalogue.split('\n')) {
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    if (/^[A-Z]{3}\d{2}$/.test(cells[0] ?? '')) expected.set(cells[0], cells[3]);
  }
  assert.equal(expected.size, 114, 'Cambió catálogo: revisar la trazabilidad, no ignorarlo');
  const seen = new Set();
  const phases = new Set(Object.keys(data.phases));
  assert.equal(phases.size, 16);
  function validatePhases(row) {
    assert.ok(row.phases.length > 0);
    for (const phase of row.phases) assert.ok(phases.has(phase), `Fase desconocida: ${phase}`);
  }
  for (const row of data.catalogueAssignments) {
    validatePhases(row);
    for (const id of row.ids) {
      assert.ok(expected.has(id), `ID inventado: ${id}`);
      assert.ok(!seen.has(id), `ID duplicado: ${id}`);
      const originalPhase = expected.get(id);
      assert.ok(!/Prohibido|Fuera|Posterior/.test(originalPhase), `No implementar exclusión: ${id}`);
      if (originalPhase.includes('P0')) assert.ok(row.phases.some(p => Number(p.slice(1)) <= 8), `${id}: P0 desplazado`);
      if (originalPhase.includes('P1')) assert.ok(row.phases.some(p => Number(p.slice(1)) <= 12), `${id}: P1 desplazado`);
      if (originalPhase.includes('P2')) assert.ok(row.phases.some(p => Number(p.slice(1)) >= 14), `${id}: falta evolución P2`);
      seen.add(id);
    }
  }
  for (const id of data.exclusions) {
    assert.ok(expected.has(id) && /Prohibido|Fuera|Posterior/.test(expected.get(id)), `Exclusión sin fuente: ${id}`);
    assert.ok(!seen.has(id)); seen.add(id);
  }
  assert.deepEqual([...seen].sort(), [...expected.keys()].sort(), 'Parámetros sin cobertura');
  const acceptance = new Set();
  for (const row of data.acceptance) {
    validatePhases(row);
    assert.ok(!acceptance.has(row.id), `Prueba duplicada: ${row.id}`);
    assert.ok(row.condition.length > 0); acceptance.add(row.id);
  }
  const expectedTests = [...Array.from({ length: 21 }, (_, i) => `PV${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 16 }, (_, i) => `UX${String(i + 1).padStart(2, '0')}`)];
  assert.deepEqual([...acceptance].sort(), expectedTests.sort());
  const requirements = new Set();
  for (const row of data.requirements) {
    validatePhases(row); assert.ok(row.deliverable.length > 0);
    assert.ok(!requirements.has(row.id)); requirements.add(row.id);
    for (const id of row.tests) assert.ok(acceptance.has(id), `Prueba inexistente: ${id}`);
  }
  assert.deepEqual([...requirements].sort(), Array.from({ length: 11 }, (_, i) => `RF${String(i + 1).padStart(2, '0')}`));
  assert.equal(data.productEvidence, 'NOT RUN');
  return { requirements: requirements.size, acceptance: acceptance.size, catalogue: seen.size };
}

export function validateContract(contract) {
  assert.equal(contract.openapi, '3.1.0');
  const ids = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith('#/'), 'No referencias remotas durante validación');
      const target = value.$ref.slice(2).split('/').reduce((o, key) => o?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], contract);
      assert.ok(target, `Referencia rota: ${value.$ref}`);
    }
    if (value.operationId) { assert.ok(!ids.has(value.operationId)); ids.add(value.operationId); }
    for (const child of Object.values(value)) visit(child);
  }
  visit(contract);
  assert.equal(ids.size, 4);
  assert.equal(contract.components.schemas.Enrollment.additionalProperties, false);
  assert.equal(contract.components.schemas.Ack.additionalProperties, false);
  assert.equal(contract.components.schemas.Operation.properties.observed_at.type, 'null');
  return { operations: ids.size, scope: 'structural_not_full_openapi_certification' };
}

export async function check() {
  for (const directory of ['scripts', 'tests']) {
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith('.mjs')) continue;
      const result = spawnSync(process.execPath, ['--check', `${directory}/${entry}`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  const sources = JSON.parse(await readFile('docs/f01/sources.json', 'utf8'));
  for (const [file, hash] of Object.entries(sources)) {
    assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash,
      `Cambió fuente ${file}: revisar decisiones y actualizar baseline explícitamente`);
  }
  const data = JSON.parse(await readFile('docs/f01/traceability.json', 'utf8'));
  const source = await readFile('Nexo_Catalogo_de_Parametros_Administrables.md', 'utf8');
  const contract = JSON.parse(await readFile('contracts/f01.openapi.json', 'utf8'));
  console.log('Trazabilidad:', validateTraceability(data, source));
  console.log('Contrato experimental:', validateContract(contract));
  for (const file of ['docs/f01/README.md', 'docs/f01/architecture.md', 'docs/f01/decisions.md', 'docs/f01/threat-model.md', 'docs/f01/roles-and-gates.md', 'docs/f01/evidence.md', 'docs/f01/wireflows.md']) {
    assert.ok((await readFile(file, 'utf8')).length > 100, `Falta entregable ${file}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await check();
