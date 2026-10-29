import { spawnSync } from 'node:child_process';

for (const [command,args] of [['npm',['run','typecheck']],['node',['--test','tests/l03-provider.test.mjs']]]) {
  console.log(`L03 > ${command} ${args.join(' ')}`);
  const result=spawnSync(command,args,{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
