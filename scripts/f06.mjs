import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const localGo = process.env.GO_BIN ?? (spawnSync('go', ['version']).status === 0 ? 'go' : undefined);
const cache = `nexo-f06-go-${randomUUID().slice(0, 8)}`;
const commands = [
  ['npm', ['run', 'typecheck'], {}],
  ['node', ['--test', 'tests/f06-vpn-environments.test.mjs', 'tests/f06-aws-probe.test.mjs'], {}],
];

if (localGo) {
  commands.push(
    [localGo, ['test', './...'], { cwd: 'product/agent' }],
    [localGo, ['build', '-buildvcs=false', '-o', '/tmp/nexo-f06-agent', './cmd/nexo-agent'], { cwd: 'product/agent' }],
  );
} else {
  const base = ['run', '--rm', '-e', 'GOTOOLCHAIN=auto', '-v', `${cache}:/go/pkg/mod`, '-v', `${process.cwd()}:/workspace`, '-w', '/workspace/product/agent', 'golang:1.26.3-bookworm', 'go'];
  commands.push(
    ['docker', [...base, 'test', './...'], {}],
    ['docker', [...base, 'build', '-buildvcs=false', '-o', '/tmp/nexo-f06-agent', './cmd/nexo-agent'], {}],
  );
}

let failure = 0;
try {
  for (const [command, args, options] of commands) {
    console.log(`F06 > ${command} ${args.join(' ')}`);
    const result = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (result.status !== 0) { failure = result.status ?? 1; break; }
  }
  if (!failure) console.log(JSON.stringify({ phase: 'F06', typecheck: 'PASS', api_tests: 'PASS', node_agent_tests: 'PASS', node_agent_build: 'PASS' }));
} finally {
  if (!localGo) spawnSync('docker', ['volume', 'rm', '-f', cache], { stdio: 'ignore' });
}
if (failure) process.exit(failure);
