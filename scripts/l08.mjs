import { spawnSync } from 'node:child_process';

const go = process.env.GO_BIN ?? (spawnSync('go', ['version']).status === 0 ? 'go' : '/tmp/opencode/go-toolchain/go/bin/go');
const commands = [
  ['npm', ['run', 'typecheck'], {}],
  ['node', ['--test', 'tests/l08-recovery.test.mjs', 'tests/l08-hardening.test.mjs'], {}],
  [go, ['test', './...'], { cwd: 'product/agent' }],
  [go, ['vet', './...'], { cwd: 'product/agent' }],
  ['npm', ['run', 'build'], { cwd: 'product/client' }],
  ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\laragon\\www\\nexo\\scripts\\l07-tauri-build.ps1'], {}]
];

for (const [command, args, options] of commands) {
  console.log(`L08 > ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(JSON.stringify({ phase: 'L08', typecheck: 'PASS', recovery_contract: 'PASS', hardening: 'PASS', go_test: 'PASS', go_vet: 'PASS', frontend: 'PASS', tauri_native_check: 'PASS' }));
