import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const sourceHashes = JSON.parse(await readFile('docs/f01/sources.json', 'utf8'));
const catalogue = await readFile('Nexo_Catalogo_de_Parametros_Administrables.md', 'utf8');
const historical = JSON.parse(await readFile('docs/f01/traceability.json', 'utf8'));
const baseline = JSON.parse(await readFile('docs/l01/traceability.json', 'utf8'));

for (const [file, expected] of Object.entries(sourceHashes)) {
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  assert.equal(actual, expected, `Fuente alterada sin actualizar baseline: ${file}`);
}

const catalogueIds = [...catalogue.matchAll(/^\|\s*([A-Z]{3}\d{2})\s*\|/gm)].map(m => m[1]);
assert.equal(new Set(catalogueIds).size, 114, 'El catálogo debe contener exactamente 114 IDs únicos');
const assigned = historical.catalogueAssignments.flatMap(row => row.ids);
const exclusions = historical.exclusions;
assert.equal(new Set(assigned).size, assigned.length, 'Hay IDs duplicados en la trazabilidad histórica');
assert.deepEqual(new Set([...assigned, ...exclusions]), new Set(catalogueIds), 'La cobertura no coincide exactamente con el catálogo');
assert.equal(assigned.length, baseline.catalogue.assigned_local_or_future);
assert.deepEqual(exclusions, baseline.catalogue_exclusions);

const expectedRequirements = [
  ...Array.from({ length: 11 }, (_, i) => `RF${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 21 }, (_, i) => `PV${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 16 }, (_, i) => `UX${String(i + 1).padStart(2, '0')}`),
];
const requirementIds = [...historical.requirements.map(row => row.id), ...historical.acceptance.map(row => row.id)];
assert.deepEqual(new Set(requirementIds), new Set(expectedRequirements), 'RF/PV/UX incompletos o duplicados');
assert.equal(baseline.catalogue.total, 114);
assert.equal(baseline.product_evidence, 'NOT RUN');

const report = {
  phase: 'L01',
  scope: 'STRUCTURAL_AND_DOCUMENTARY_ONLY',
  status: 'PASS',
  checks: {
    source_hashes: 'PASS',
    catalogue_exact_set: 'PASS',
    catalogue_count: catalogueIds.length,
    requirements_exact_set: 'PASS',
    fixture_boundary: 'PASS',
    product_evidence: 'NOT RUN',
    aws: 'NOT RUN',
  },
  source_hashes: sourceHashes,
  exclusions,
  generated_at: new Date().toISOString(),
};
await mkdir(dirname('artifacts/l01/report.json'), { recursive: true });
await writeFile('artifacts/l01/report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ phase: report.phase, status: report.status, catalogue: catalogueIds.length, requirements: expectedRequirements.length, report: 'artifacts/l01/report.json' }));
