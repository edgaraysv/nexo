import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RPO_TARGET_MS = 24 * 60 * 60 * 1000;
export const RTO_TARGET_MS = 4 * 60 * 60 * 1000;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;

function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = timestampPattern.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate()
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  return Date.parse(value);
}

export function measureRecovery({ incidentDeclaredAt, recoveryPointCreatedAt, quarantineReadyAt }) {
  const incident = timestamp(incidentDeclaredAt);
  const recoveryPoint = timestamp(recoveryPointCreatedAt);
  const ready = timestamp(quarantineReadyAt);
  if (![incident, recoveryPoint, ready].every(Number.isFinite) || recoveryPoint > incident || ready < incident) {
    throw new Error('recovery timestamps must be valid and ordered');
  }
  const rpoMs = incident - recoveryPoint;
  const rtoMs = ready - incident;
  return {
    scope: 'single-host-loss; service-ready-in-quarantine',
    measuredAt: new Date().toISOString(),
    incidentDeclaredAt: new Date(incident).toISOString(),
    recoveryPointCreatedAt: new Date(recoveryPoint).toISOString(),
    quarantineReadyAt: new Date(ready).toISOString(),
    rpoMs,
    rpoTargetMs: RPO_TARGET_MS,
    rpo: rpoMs <= RPO_TARGET_MS ? 'PASS' : 'FAIL',
    rtoMs,
    rtoTargetMs: RTO_TARGET_MS,
    rto: rtoMs <= RTO_TARGET_MS ? 'PASS' : 'FAIL',
    result: rpoMs <= RPO_TARGET_MS && rtoMs <= RTO_TARGET_MS ? 'PASS' : 'FAIL',
  };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/f12-recovery-metrics.mjs <exercise-timestamps.json>');
    process.exitCode = 2;
  } else {
    try {
      const input = JSON.parse(await readFile(resolve(path), 'utf8'));
      const result = measureRecovery(input);
      console.log(JSON.stringify(result, null, 2));
      if (result.result !== 'PASS') process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'recovery measurement failed');
      process.exitCode = 1;
    }
  }
}
