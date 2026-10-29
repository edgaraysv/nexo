import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createProductApplication } from '../dist/product/application.js';
import { MemoryCompanyRepository } from '../dist/product/company-repository.js';
import { MemoryDeviceRepository } from '../dist/product/device-repository.js';
import { MemoryOperationRepository } from '../dist/product/operation-repository.js';
import { MemoryIdentityRepository } from '../dist/product/repository.js';
import { hashPassword } from '../dist/product/security.js';

const execute = promisify(execFile);
const ADMIN = 'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa';
const TENANT = 'bbbbbbbb-7777-4777-8777-bbbbbbbbbbbb';
const SECRET = 'JBSWY3DPEHPK3PXP';
const IPC_SCRIPT = 'C:\\laragon\\www\\nexo\\scripts\\l07-ipc-request.ps1';

function totp() {
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex')).update(payload).digest();
  const offset = digest.at(-1) & 15;
  return String(((((digest[offset] & 127) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3]) % 1_000_000)).padStart(6, '0');
}

function windowsPath(path) {
  const result = spawnSync('wslpath', ['-w', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('wslpath failed');
  return result.stdout.trim();
}

async function ipc(action, payload) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', IPC_SCRIPT, '-Action', action];
  if (payload) args.push('-PayloadBase64', Buffer.from(JSON.stringify(payload)).toString('base64'));
  const { stdout } = await execute('powershell.exe', args, { timeout: 20_000 });
  const response = JSON.parse(stdout.trim());
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function waitForPipe() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await ipc('status');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('IPC did not become ready');
}

const identity = new MemoryIdentityRepository([{
  id: ADMIN,
  email: 'windows-admin@example.test',
  passwordHash: await hashPassword('correct horse battery staple'),
  status: 'active',
  mfaRequired: true,
  totpSecret: SECRET,
  memberships: [{ tenantId: TENANT, tenantName: 'Empresa Windows', roles: ['company.admin'] }]
}]);
const company = new MemoryCompanyRepository({
  [TENANT]: [{ userId: ADMIN, email: 'windows-admin@example.test', status: 'active', roles: ['company.admin'] }]
});
const devices = new MemoryDeviceRepository({ [TENANT]: 1 });
const operations = new MemoryOperationRepository();
const issuer = {
  issue: async (input) => ({
    serial: 'WINDOWS-DEV-1',
    certificatePem: `-----BEGIN CERTIFICATE-----\n${input.audience}-fixture\n-----END CERTIFICATE-----`,
    notBefore: new Date(Date.now() - 1000).toISOString(),
    notAfter: new Date(Date.now() + 86_400_000).toISOString()
  })
};
const app = await createProductApplication(identity, undefined, undefined, company, undefined, devices, issuer, operations);
const state = await mkdtemp('/mnt/c/laragon/tmp/nexo-l07-flow-');
let agent;

try {
  const existingAgents = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '@(Get-Process nexo-agent -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });
  assert.equal(existingAgents.status, 0);
  assert.equal(existingAgents.stdout.trim(), '0', 'L07 flow requires the fixed test pipe to be free');
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const sid = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8' }).stdout.trim();
  agent = spawn('/mnt/c/laragon/www/nexo/product/agent/bin/nexo-agent.exe', ['service', base, windowsPath(state), '\\\\.\\pipe\\nexo-endpoint-v1', sid], { stdio: 'ignore' });
  await waitForPipe();

  const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: 'windows-admin@example.test', password: 'correct horse battery staple' } });
  const mfa = await app.inject({ method: 'POST', url: '/v1/auth/mfa', payload: { challenge: login.json().challenge, code: totp() } });
  const selected = await app.inject({ method: 'POST', url: '/v1/session/select', payload: { selection: mfa.json().selection, scope_kind: 'tenant', tenant_id: TENANT } });
  const headers = { authorization: `Bearer ${selected.json().token}` };
  const invitation = await app.inject({ method: 'POST', url: '/v1/company/device-invitations', headers, payload: { device_kind: 'endpoint', uses: 1 } });
  assert.equal(invitation.statusCode, 201);

  const enrolled = await ipc('enroll', { token: invitation.json().token, name: 'Windows IPC' });
  assert.equal(enrolled.enrollment, 'pending_approval');
  const approval = await app.inject({ method: 'POST', url: `/v1/company/agents/${enrolled.device_id}/approve`, headers });
  assert.equal(approval.statusCode, 204);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const claimed = await ipc('claim');
  assert.equal(claimed.enrollment, 'approved');

  const operation = await app.inject({
    method: 'POST',
    url: '/v1/company/operations',
    headers,
    payload: { target_device_id: enrolled.device_id, type: 'endpoint.runtime_info.v1', arguments: {}, idempotency_key: 'windows-ipc-runtime-001', expires_in: 300 }
  });
  assert.equal(operation.statusCode, 201);
  assert.equal(await operations.dispatch('l07-flow', 10), 1);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  const diagnosed = await ipc('run_diagnostic');
  assert.ok(diagnosed.last_diagnostic);

  const listed = (await app.inject({ method: 'GET', url: '/v1/company/operations', headers })).json().items;
  assert.equal(listed[0].status, 'succeeded');
  assert.equal(listed[0].result.os, 'windows');
  const exported = await ipc('diagnostics');
  assert.equal(exported.certificate.status, 'invalid');
  assert.equal(JSON.stringify(exported).includes('certificate_pem'), false);
  console.log(JSON.stringify({ phase: 'L07', windows_ipc_enrollment: 'PASS', approval_claim: 'PASS', typed_diagnostic: 'PASS', sanitized_diagnostics: 'PASS', result_os: listed[0].result.os }));
} finally {
  if (agent?.pid) {
    const ownedState = windowsPath(state).replaceAll("'", "''");
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$state='${ownedState}'; Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'nexo-agent.exe' -and $_.CommandLine -like ('*'+$state+'*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
    spawnSync('taskkill.exe', ['/PID', String(agent.pid), '/T', '/F'], { stdio: 'ignore' });
    agent.kill('SIGKILL');
  }
  await app.close();
  await rm(state, { recursive: true, force: true });
}
