import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRecovery, RPO_TARGET_MS, RTO_TARGET_MS } from '../scripts/f12-recovery-metrics.mjs';

test('F12 recovery metrics measures RPO and RTO against approved objectives', () => {
  const result = measureRecovery({
    incidentDeclaredAt: '2026-10-31T12:00:00Z',
    recoveryPointCreatedAt: '2026-10-30T12:00:00Z',
    quarantineReadyAt: '2026-10-31T16:00:00Z',
  });
  assert.equal(result.rpoMs, RPO_TARGET_MS);
  assert.equal(result.rtoMs, RTO_TARGET_MS);
  assert.equal(result.result, 'PASS');
  assert.equal(result.scope, 'single-host-loss; service-ready-in-quarantine');
});

test('F12 recovery metrics fails objectives independently and rejects invalid chronology', () => {
  const result = measureRecovery({
    incidentDeclaredAt: '2026-10-31T12:00:00Z',
    recoveryPointCreatedAt: '2026-10-30T11:59:59Z',
    quarantineReadyAt: '2026-10-31T16:00:01Z',
  });
  assert.equal(result.rpo, 'FAIL');
  assert.equal(result.rto, 'FAIL');
  assert.equal(result.result, 'FAIL');
  assert.throws(() => measureRecovery({ incidentDeclaredAt: 'invalid', recoveryPointCreatedAt: '2026-10-30T12:00:00Z', quarantineReadyAt: '2026-10-31T16:00:00Z' }), /timestamps/);
  assert.throws(() => measureRecovery({ incidentDeclaredAt: '2026-02-30T12:00:00Z', recoveryPointCreatedAt: '2026-02-29T12:00:00Z', quarantineReadyAt: '2026-03-01T16:00:00Z' }), /timestamps/);
  assert.ok(RTO_TARGET_MS > 0);
});
