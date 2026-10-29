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
  const reportBlock = source.slice(source.indexOf('const report = {'), source.indexOf('await mkdir', source.indexOf('const report = {')));
  assert.match(reportBlock, /recoveryScope: 'volume'/);
  assert.match(reportBlock, /totalHostLoss: 'NOT_RUN'/);
  assert.match(reportBlock, /keySeparation: 'PASS_SAME_HOST'/);
  assert.match(source, /elapsedMs <= 600_000/);
  for (const forbidden of ['password', 'privateMaterial', 'token', 'certificate', 'custodyDir', 'archiveDir']) assert.equal(reportBlock.includes(forbidden), false);
});
