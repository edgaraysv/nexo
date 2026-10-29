import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateContract, validateTraceability } from '../scripts/check.mjs';

const trace = JSON.parse(await readFile('docs/f01/traceability.json', 'utf8'));
const source = await readFile('Nexo_Catalogo_de_Parametros_Administrables.md', 'utf8');
const api = JSON.parse(await readFile('contracts/f01.openapi.json', 'utf8'));
test('cobertura completa sin afirmar aceptación de producto', () => {
  assert.deepEqual(validateTraceability(trace, source), { requirements: 11, acceptance: 37, catalogue: 114 });
});
test('rechaza ID de catálogo omitido', () => {
  const bad = structuredClone(trace); bad.catalogueAssignments[0].ids.pop();
  assert.throws(() => validateTraceability(bad, source));
});
test('rechaza ID duplicado', () => {
  const bad = structuredClone(trace); bad.catalogueAssignments[0].ids.push('ORG01');
  assert.throws(() => validateTraceability(bad, source), /duplicado/);
});
test('rechaza habilitar función prohibida', () => {
  const bad = structuredClone(trace); bad.catalogueAssignments[0].ids.push('VPN15');
  assert.throws(() => validateTraceability(bad, source), /exclusión/);
});
test('rechaza desplazar WireGuard P1 a evolución', () => {
  const bad = structuredClone(trace);
  bad.catalogueAssignments.find(r => r.ids.includes('VPN12')).phases = ['F15'];
  assert.throws(() => validateTraceability(bad, source), /P1 desplazado/);
});
test('rechaza fase inexistente', () => {
  const bad = structuredClone(trace); bad.requirements[0].phases = ['F99'];
  assert.throws(() => validateTraceability(bad, source), /desconocida/);
});
test('rechaza declarar producto PASS desde F01', () => {
  const bad = structuredClone(trace); bad.productEvidence = 'PASS';
  assert.throws(() => validateTraceability(bad, source));
});
test('contrato experimental resuelve referencias locales', () => {
  assert.equal(validateContract(api).operations, 4);
});
test('rechaza referencia rota', () => {
  const bad = structuredClone(api); bad.components.schemas.Ack.$ref = '#/components/schemas/Inexistente';
  assert.throws(() => validateContract(bad), /rota/);
});
test('rechaza operationId repetido', () => {
  const bad = structuredClone(api); bad.paths['/health'].get.operationId = 'labEnroll';
  assert.throws(() => validateContract(bad));
});
test('rechaza confundir ACK con conectividad observada', () => {
  const bad = structuredClone(api); bad.components.schemas.Operation.properties.observed_at.type = 'string';
  assert.throws(() => validateContract(bad));
});
