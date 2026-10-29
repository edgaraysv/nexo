import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

test('F07 deploys a persistent least-privilege operation worker', async () => {
  const unit = await readFile(new URL('../infra/aws/lab/nexo-worker.service', import.meta.url), 'utf8');
  assert.match(unit, /^User=nexo_runtime$/mu);
  assert.match(unit, /^Group=nexo_runtime$/mu);
  assert.match(unit, /^EnvironmentFile=\/etc\/nexo\/nexo\.env$/mu);
  assert.match(unit, /^ExecStart=\/usr\/local\/lib\/nexo\/node \/opt\/nexo\/dist\/product\/operation-worker\.js$/mu);
  assert.match(unit, /^Restart=on-failure$/mu);
  assert.match(unit, /^NoNewPrivileges=yes$/mu);
  assert.match(unit, /^ProtectSystem=strict$/mu);
  assert.match(unit, /^CapabilityBoundingSet=$/mu);
  assert.match(unit, /^WantedBy=multi-user\.target$/mu);
  assert.doesNotMatch(unit, /^User=root$/mu);
});
