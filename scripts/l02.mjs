import { spawnSync } from 'node:child_process';

const commands = [
  ['npm', ['run', 'typecheck']],
  ['node', ['--test', 'tests/l02.test.mjs', 'tests/l02-product.test.mjs']],
];
for (const [command, args] of commands) {
  console.log(`L02 > ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
