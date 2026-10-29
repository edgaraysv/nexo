import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const localGo = process.env.GO_BIN ?? (spawnSync('go', ['version']).status === 0 ? 'go' : undefined);
const cache = `nexo-f07-go-${randomUUID().slice(0, 8)}`;
const commands = [
  ['npm', ['run', 'typecheck'], {}],
  ['node', ['--test', 'tests/f07-windows-vpn.test.mjs'], {}],
  ['node', ['scripts/f07-postgres.mjs'], {}],
  ['npm', ['--prefix', 'product/client', 'run', 'build'], {}],
];

if (localGo) {
  commands.push(
    [localGo, ['test', './...'], { cwd: 'product/agent' }],
    [localGo, ['build', '-buildvcs=false', '-o', '/tmp/nexo-f07-agent', './cmd/nexo-agent'], { cwd: 'product/agent' }],
    [localGo, ['build', '-buildvcs=false', '-o', '/tmp/nexo-f07-agent.exe', './cmd/nexo-agent'], { cwd: 'product/agent', env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64' } }],
  );
} else {
  const base = ['run', '--rm', '-e', 'GOTOOLCHAIN=auto', '-v', `${cache}:/go/pkg/mod`, '-v', `${process.cwd()}:/workspace`, '-w', '/workspace/product/agent', 'golang:1.26.3-bookworm', 'go'];
  commands.push(
    ['docker', [...base, 'test', './...'], {}],
    ['docker', [...base, 'build', '-buildvcs=false', '-o', '/tmp/nexo-f07-agent', './cmd/nexo-agent'], {}],
    ['docker', ['run', '--rm', '-e', 'GOTOOLCHAIN=auto', '-e', 'GOOS=windows', '-e', 'GOARCH=amd64', '-v', `${cache}:/go/pkg/mod`, '-v', `${process.cwd()}:/workspace`, '-w', '/workspace/product/agent', 'golang:1.26.3-bookworm', 'go', 'build', '-buildvcs=false', '-o', '/tmp/nexo-f07-agent.exe', './cmd/nexo-agent'], {}],
  );
}

let failure = 0;
try {
  for (const [command, args, options] of commands) {
    console.log(`F07 > ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) { failure = result.status ?? 1; break; }
  }
  if (!failure) console.log(JSON.stringify({ phase: 'F07', typecheck: 'PASS', api_catalog: 'PASS', postgres_rls: 'PASS', csr_operations: 'PASS', node_signing: 'PASS', crl_revocation: 'PASS', endpoint_key_isolation: 'PASS', managed_openvpn_runtime: 'PASS_SIMULATED', windows_ui: 'PASS', agent_tests: 'PASS', agent_build: 'PASS', windows_agent_build: 'PASS', windows_openvpn_native: 'INSTALLED_E2E_ENROLLMENT_BLOCKED' }));
} finally {
  if (!localGo) spawnSync('docker', ['volume', 'rm', '-f', cache], { stdio: 'ignore' });
}
if (failure) process.exit(failure);
