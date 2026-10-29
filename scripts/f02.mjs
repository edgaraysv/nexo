import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertMockPlansOnly } from './f02-safety.mjs';

// Exclusivamente validacion local con mocks. No acepta comandos OpenTofu arbitrarios.
if (process.argv.length !== 2) throw new Error('F02 local no acepta argumentos ni ejecuta planes reales/apply.');
const root = resolve('.');
const project = `nexo-f02-${randomUUID().slice(0, 12)}`;
const directory = resolve('artifacts/f02', project);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { scope: 'F02_LOCAL_MOCK_PLAN_ONLY', project, started: new Date().toISOString(), steps: [], aws: 'NOT CONTACTED', realPlan: 'BLOCKED: cuenta y perfil pendientes', resourcesCreated: false };

function run(binary, args, env, cwd = root) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 900_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`);
  return result.stdout;
}

try {
  report.mockPlanRuns = assertMockPlansOnly(await readFile('infra/aws/lab/tests/foundation.tftest.hcl', 'utf8'));
  const toolchain = JSON.parse(await readFile('infra/toolchain.json', 'utf8'));
  const tool = toolchain.opentofu;
  assert.equal(`${process.platform}_${process.arch}`, tool.platform, 'Toolchain fijado solo para Linux x64; no descargar un binario diferente implicitamente.');
  const tools = resolve('artifacts/tools', `opentofu-${tool.version}`);
  await mkdir(tools, { recursive: true, mode: 0o700 });
  const archive = resolve(tools, 'tofu.tar.gz');
  let bytes;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(tool.url, { signal: AbortSignal.timeout(120_000) });
    assert.ok(response.ok, `Descarga OpenTofu: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), tool.sha256, 'Digest OpenTofu distinto; detenerse.');
  await writeFile(archive, bytes, { mode: 0o600 });
  // Extraer solo el binario de la distribucion oficial cuyo archivo ya verificamos.
  const cleanEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: resolve(directory, 'home'), TF_IN_AUTOMATION: '1', TF_INPUT: '0', AWS_EC2_METADATA_DISABLED: 'true' };
  await mkdir(cleanEnv.HOME, { mode: 0o700 });
  run('tar', ['-xzf', archive, '-C', tools, 'tofu'], cleanEnv);
  const tofu = resolve(tools, 'tofu');
  await chmod(tofu, 0o700);
  const version = JSON.parse(run(tofu, ['version', '-json'], cleanEnv));
  assert.equal(version.terraform_version, tool.version);
  report.toolchain = { ...toolchain, archiveSha256Verified: true };
  // No heredar AWS_*, TF_VAR_*, TF_CLI_ARGS*, endpoints, config ni credenciales del host.
  const work = resolve('infra/aws/lab');
  for (const args of [
    ['fmt', '-check', '-recursive'],
    ['init', '-backend=false', '-input=false', '-lockfile=readonly', '-no-color'],
    ['validate', '-no-color'],
    ['test', '-filter=tests/foundation.tftest.hcl', '-no-color'],
  ]) {
    const output = run(tofu, args, cleanEnv, work);
    await writeFile(resolve(directory, `${args[0]}.txt`), output, { mode: 0o600 });
    report.steps.push({ command: `tofu ${args.join(' ')}`, status: 'PASS' });
    console.log(`F02 local: ${args[0]} PASS`);
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL'; report.error = String(error); process.exitCode = 1;
  console.error(error);
} finally {
  report.finished = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidencia F02 local: ${directory}/report.json`);
}
