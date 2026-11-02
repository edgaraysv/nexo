import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const EMAIL = 'f12-load@example.test';
const PASSWORD = 'synthetic-load-password';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const BASELINE_WARMUP_MS = 15_000;
const BASELINE_MEASURE_MS = 60_000;
const LOAD_WARMUP_MS = 60_000;
const LOAD_MEASURE_MS = 9 * 60_000;
const THINK_TIME_MS = 100;
const MAX_ERROR_RATE = 0.01;
const MAX_P95_MS = 1_000;
const MAX_P95_MULTIPLIER = 2;

function currentTotp(secret, now = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest.at(-1) & 15;
  const number = ((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(number % 1_000_000).padStart(6, '0');
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return Number(ordered[Math.ceil(fraction * ordered.length) - 1].toFixed(2));
}

async function authenticate(app) {
  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: EMAIL, password: PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`synthetic_login_failed_${login.statusCode}`);
  const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: currentTotp(TOTP_SECRET) } });
  if (mfa.statusCode !== 200) throw new Error(`synthetic_mfa_failed_${mfa.statusCode}`);
  const selected = await app.inject({
    method: 'POST', url: '/v1/session/select',
    payload: { selection: mfa.json().selection, scope_kind: 'tenant', tenant_id: TENANT_ID }
  });
  if (selected.statusCode !== 200) throw new Error(`synthetic_session_failed_${selected.statusCode}`);
  return selected.json().token;
}

async function runPhase({ name, concurrency, warmupMs, measureMs, url, token }) {
  const start = performance.now();
  const measureStart = start + warmupMs;
  const end = measureStart + measureMs;
  const latencies = [];
  let measuredRequests = 0;
  let measuredErrors = 0;
  let consecutive5xx = 0;
  let stopReason;

  console.log(`F12 local load: ${name} starts (${concurrency} virtual user(s)); warmup ${Math.round(warmupMs / 1000)}s, measurement ${Math.round(measureMs / 1000)}s.`);

  const worker = async () => {
    while (!stopReason && performance.now() < end) {
      const started = performance.now();
      let status;
      let failed = false;
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
          signal: AbortSignal.timeout(10_000)
        });
        status = response.status;
        await response.arrayBuffer();
      } catch {
        failed = true;
      }
      const finished = performance.now();
      if (started >= measureStart) {
        measuredRequests += 1;
        latencies.push(finished - started);
        if (failed || status < 200 || status >= 300) measuredErrors += 1;
      }

      if (status !== undefined && status >= 500) consecutive5xx += 1;
      else consecutive5xx = 0;
      if (consecutive5xx >= 5) stopReason = 'five_consecutive_5xx';
      if (measuredRequests >= 100 && measuredErrors / measuredRequests > MAX_ERROR_RATE) stopReason = 'error_rate_over_1_percent';

      if (!stopReason && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, THINK_TIME_MS));
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = Math.max(0, Math.min(performance.now(), end) - measureStart);
  return {
    name,
    concurrency,
    warmupMs,
    measurementMs: Math.round(elapsedMs),
    requests: measuredRequests,
    errors: measuredErrors,
    errorRatePercent: measuredRequests === 0 ? null : Number((100 * measuredErrors / measuredRequests).toFixed(4)),
    p95Ms: percentile(latencies, 0.95),
    stopReason: stopReason ?? null,
    completed: !stopReason && performance.now() >= end
  };
}

const passwordHash = await hashPassword(PASSWORD);
const identity = new MemoryIdentityRepository([{
  id: USER_ID,
  email: EMAIL,
  passwordHash,
  status: 'active',
  mfaRequired: true,
  totpSecret: TOTP_SECRET,
  memberships: [{ tenantId: TENANT_ID, tenantName: 'Empresa sintética', roles: ['company.admin'] }]
}]);
const company = new MemoryCompanyRepository({ [TENANT_ID]: [{ userId: USER_ID, email: EMAIL, status: 'active', roles: ['company.admin'] }] });
const app = await createProductApplication(identity, undefined, undefined, company);

let baseline;
let load;
try {
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('local_listener_unavailable');
  const token = await authenticate(app);
  const url = `http://127.0.0.1:${address.port}/v1/company/summary`;

  baseline = await runPhase({ name: 'baseline', concurrency: 1, warmupMs: BASELINE_WARMUP_MS, measureMs: BASELINE_MEASURE_MS, url, token });
  if (!baseline.completed || baseline.errors / Math.max(1, baseline.requests) > MAX_ERROR_RATE || baseline.p95Ms === null) {
    throw new Error(`baseline_gate_failed:${baseline.stopReason ?? 'no-valid-baseline'}`);
  }

  load = await runPhase({ name: 'sustained', concurrency: 10, warmupMs: LOAD_WARMUP_MS, measureMs: LOAD_MEASURE_MS, url, token });
} finally {
  await app.close();
}

const errorRatePass = load.errorRatePercent !== null && load.errorRatePercent <= MAX_ERROR_RATE * 100;
const absoluteP95Pass = load.p95Ms !== null && load.p95Ms <= MAX_P95_MS;
const relativeP95LimitMs = baseline.p95Ms * MAX_P95_MULTIPLIER;
const relativeP95Pass = load.p95Ms !== null && load.p95Ms <= relativeP95LimitMs;
const verdict = load.completed && !load.stopReason && errorRatePass && absoluteP95Pass && relativeP95Pass ? 'PASS' : 'FAIL';
const report = {
  schema: 'nexo.f12.local-load.v1',
  verdict,
  scope: 'single local API process, loopback HTTP, synthetic identity/company data and in-memory repositories; GET /v1/company/summary',
  profile: {
    baseline: { virtualUsers: 1, warmupSeconds: BASELINE_WARMUP_MS / 1000, measurementSeconds: BASELINE_MEASURE_MS / 1000 },
    sustained: { virtualUsers: 10, warmupSeconds: LOAD_WARMUP_MS / 1000, measurementSeconds: LOAD_MEASURE_MS / 1000 },
    thinkTimeMs: THINK_TIME_MS,
    stopConditions: { fiveConsecutive5xx: true, errorRateOverPercent: 1 }
  },
  criteria: {
    errorRateAtMostPercent: 1,
    p95AtMostMs: MAX_P95_MS,
    p95AtMostBaselineMultiple: MAX_P95_MULTIPLIER,
    relativeP95LimitMs: Number(relativeP95LimitMs.toFixed(2)),
    errorRatePass,
    absoluteP95Pass,
    relativeP95Pass
  },
  phases: { baseline, sustained: load },
  limitations: 'This synthetic in-memory test does not measure PostgreSQL, SMTP delivery, AWS, Windows, VPN dataplane, production networking or recovery. It is not a production capacity certification.'
};

console.log(JSON.stringify(report, null, 2));
if (verdict !== 'PASS') process.exitCode = 1;
