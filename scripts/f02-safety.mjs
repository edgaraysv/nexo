import assert from 'node:assert/strict';

// Guardia adicional para ESTA suite controlada, no parser HCL general.
// OpenTofu sigue siendo quien valida la sintaxis y ejecuta los assert.
export function assertMockPlansOnly(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:#|\/\/).*$/gm, '');
  assert.match(text, /^mock_provider "aws"\s*\{/m, 'Se requiere provider AWS simulado.');
  assert.doesNotMatch(text, /^\s*provider\s+"|\bproviders\s*=|\bmodule\s*\{/m, 'No introducir providers reales o modulos en la suite local.');
  const runs = text.split(/^run\s+"[a-z_]+"\s*\{/m).slice(1);
  assert.ok(runs.length > 0, 'Se requiere al menos un run.');
  assert.equal((text.match(/\brun\s+"/g) ?? []).length, runs.length, 'Formato de run no revisado.');
  for (const run of runs) {
    assert.equal((run.match(/\bcommand\s*=/g) ?? []).length, 1, 'Cada run debe declarar un solo comando.');
    assert.match(run, /^\s*command\s*=\s*plan\s*$/m, 'Solo command = plan; nunca apply implicito o explicito.');
  }
  return runs.length;
}
