import { spawnSync } from 'node:child_process';

// npm test ejecuta pretest (compilación), también desde un checkout limpio.
for (const task of ['check', 'typecheck', 'test', 'test:spikes']) {
  console.log(`\nF01 > ${task}`);
  const result = spawnSync('npm', ['run', task], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
