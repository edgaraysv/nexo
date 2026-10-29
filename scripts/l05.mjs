import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const go=process.env.GO_BIN??(spawnSync('go',['version']).status===0?'go':'/tmp/opencode/go-toolchain/go/bin/go');
const commands=[['npm',['run','typecheck'],{}],['node',['--test','tests/l05-device-identity.test.mjs'],{}],[go,['test','./...'],{cwd:'product/agent'}],[go,['build','-o',join(mkdtempSync(join(tmpdir(),'nexo-go-windows-')),'nexo-agent.exe'),'./cmd/nexo-agent'],{cwd:'product/agent',env:{...process.env,GOOS:'windows',GOARCH:'amd64'}}]];
for(const[command,args,options]of commands){console.log(`L05 > ${command} ${args.join(' ')}`);const result=spawnSync(command,args,{stdio:'inherit',...options});if(result.status!==0)process.exit(result.status??1);}
if(existsSync('/mnt/c/WINDOWS/System32/cmd.exe')){mkdirSync('/mnt/c/laragon/tmp',{recursive:true});const directory=mkdtempSync('/mnt/c/laragon/tmp/nexo-l05-'),binary=join(directory,'keystore.test.exe');try{console.log('L05 > Windows native DPAPI keystore test');let result=spawnSync(go,['test','-c','-o',binary,'./internal/keystore'],{cwd:'product/agent',stdio:'inherit',env:{...process.env,GOOS:'windows',GOARCH:'amd64'}});if(result.status!==0)process.exit(result.status??1);result=spawnSync(binary,['-test.v'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}finally{rmSync(directory,{recursive:true,force:true});}}
