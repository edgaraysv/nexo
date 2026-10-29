import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('el gate de tipos rechaza un defecto introducido deliberadamente', () => {
  const r = spawnSync(process.execPath, [
    'node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--skipLibCheck', 'tests/fixtures/invalid.ts',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /TS2322/, 'Debe fallar por el defecto, no por herramienta ausente');
});
