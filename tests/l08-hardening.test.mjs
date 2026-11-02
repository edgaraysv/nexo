import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('L08 recovery has no plaintext or unauthenticated fallback', async () => {
  const source = await readFile('product/api/recovery.ts', 'utf8');
  assert.match(source, /AES-256-GCM/);
  assert.match(source, /setAAD/);
  assert.match(source, /timingSafeEqual/);
  assert.doesNotMatch(source, /fallback|createCipheriv\(['"]aes-256-cbc/);
});

test('L08 runbooks preserve quarantine, revocations and endpoint private keys', async () => {
  const [backup, restore, incident, update] = await Promise.all([
    readFile('docs/l08/runbooks/backup.md', 'utf8'),
    readFile('docs/l08/runbooks/restore.md', 'utf8'),
    readFile('docs/l08/runbooks/incident.md', 'utf8'),
    readFile('docs/l08/runbooks/update.md', 'utf8')
  ]);
  assert.match(backup, /No incluir claves privadas de endpoints/);
  assert.match(restore, /quarantined=true/);
  assert.match(restore, /reaplicar revocaciones/);
  assert.match(incident, /no pudo reconstruirse/);
  assert.match(update, /versión compatible y no bloqueada/);
});

test('L08 recovery report contract is sanitized and honest about host loss', async () => {
  const source = await readFile('scripts/l08-recovery.mjs', 'utf8');
  const reportStart = source.indexOf('const report = {');
  const reportEnd = source.indexOf('\n};', reportStart);
  const reportBlock = source.slice(reportStart, reportEnd);
  assert.match(reportBlock, /recoveryScope: 'volume'/);
  assert.match(reportBlock, /totalHostLoss: 'NOT_RUN'/);
  assert.match(source, /report\.keySeparation = 'PASS_SAME_HOST'/);
  assert.match(source, /restoreElapsedMs <= report\.objectiveMs/);
  assert.match(reportBlock, /objectiveMs: 600_000/);
  assert.match(reportBlock, /aws: 'NOT CONTACTED'/);
  assert.match(reportBlock, /migrationCoverage: 'local-synthetic-001-018'/);
  assert.match(source, /com\.nexo\.recovery\.run/);
  assert.match(source, /volume', 'rm'/);
  assert.match(source, /flag: 'wx'/);
  assert.match(source, /recovery-runs/);
  for (const forbidden of ['password', 'privateMaterial', 'token', 'certificate', 'custodyDir', 'archiveDir']) assert.equal(reportBlock.includes(forbidden), false);
});
