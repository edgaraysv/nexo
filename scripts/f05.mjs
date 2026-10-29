import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const localGo=process.env.GO_BIN??(spawnSync('go',['version']).status===0?'go':undefined);
const goCommands=localGo?
  [[localGo,['test','./...'],{cwd:'product/agent'}],[localGo,['build','-o',join(mkdtempSync(join(tmpdir(),'nexo-f05-')),'nexo-agent'),'./cmd/nexo-agent'],{cwd:'product/agent'}]]:
  [['docker',['run','--rm','-e','GOTOOLCHAIN=auto','-v',`${process.cwd()}:/workspace`,'-w','/workspace/product/agent','golang:1.26.3-bookworm','go','test','./...'],{}],['docker',['run','--rm','-e','GOTOOLCHAIN=auto','-v',`${process.cwd()}:/workspace`,'-w','/workspace/product/agent','golang:1.26.3-bookworm','go','build','-buildvcs=false','-o','/tmp/nexo-agent','./cmd/nexo-agent'],{}]];
const commands=[
  ['npm',['run','typecheck'],{}],
  ['node',['--test','tests/f05-operation-reliability.test.mjs','tests/l06-operations.test.mjs','tests/l06-node.test.mjs'],{}],
  ...goCommands
];
for(const[command,args,options]of commands){console.log(`F05 > ${command} ${args.join(' ')}`);const result=spawnSync(command,args,{stdio:'inherit',...options});if(result.status!==0)process.exit(result.status??1);}
