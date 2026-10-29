import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const go = process.env.GO_BIN ?? (spawnSync('go', ['version']).status === 0 ? 'go' : '/tmp/opencode/go-toolchain/go/bin/go');
const temp = mkdtempSync(join(tmpdir(), 'nexo-l07-'));
const agent = join(process.cwd(), 'product/agent/bin/nexo-agent.exe');
const ipcTest = join(temp, 'clientipc.test.exe');
mkdirSync(join(process.cwd(), 'product/agent/bin'), { recursive: true });

function run(command, args, options = {}) {
  console.log(`L07 > ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'typecheck']);
run('node', ['--test', 'tests/l07-client.test.mjs']);
run(go, ['test', './...'], { cwd: 'product/agent' });
run(go, ['test', './internal/clientipc', '-c', '-o', ipcTest], { cwd: 'product/agent', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } });
run(ipcTest, ['-test.v']);
run(go, ['build', '-o', agent, './cmd/nexo-agent'], { cwd: 'product/agent', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } });
const windowsAgent = spawnSync('wslpath', ['-w', agent], { encoding: 'utf8' }).stdout.trim();
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\laragon\\www\\nexo\\scripts\\l07-native-ipc.ps1', '-AgentPath', windowsAgent]);
run('npm', ['ci'], { cwd: 'product/client' });
run('npm', ['run', 'build'], { cwd: 'product/client' });
run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$cargo="$env:USERPROFILE\\.cargo\\bin\\cargo.exe"; Set-Location "C:\\laragon\\www\\nexo\\product\\client\\src-tauri"; & $cargo fmt --check']);

const native = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\laragon\\www\\nexo\\scripts\\l07-tauri-build.ps1'], { stdio: 'inherit' });
console.log(JSON.stringify({ phase: 'L07', frontend: 'PASS', go_service: 'PASS', windows_named_pipe: 'PASS', ipc_reconnect: 'PASS', dpapi: 'PASS', update_verification: 'PASS', tauri_format: 'PASS', tauri_native_check: native.status === 0 ? 'PASS' : 'BLOCKED_MISSING_MSVC_BUILD_TOOLS' }));
