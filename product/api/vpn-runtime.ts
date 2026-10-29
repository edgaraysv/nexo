import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePrivateCidr } from './network.js';
import type { VpnDesiredState, VpnEnvironmentView } from './vpn-environment-repository.js';

export interface VpnRuntimeBundle { openvpnConfig:string; firewallConfig:string; manifest:string; digest:string }

function ipv4Netmask(prefix:number):string{const value=prefix===0?0:(0xffffffff<<(32-prefix))>>>0;return[24,16,8,0].map(shift=>(value>>>shift)&255).join('.');}
export function renderVpnRuntime(environment:VpnEnvironmentView):VpnRuntimeBundle{
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(environment.id))throw new Error('invalid_environment_id');
 const parsed=parsePrivateCidr(environment.tunnelIpv4Cidr);
 if(parsed.family!==4||parsed.prefix<16||parsed.prefix>30||environment.engine!=='openvpn'||environment.protocol!=='udp'||environment.ipv6Enabled||environment.listenerPort<1024||environment.listenerPort>65535||!/^nexo-[a-f0-9]{12}$/u.test(environment.namespaceName))throw new Error('invalid_environment_spec');
 const network=environment.tunnelIpv4Cidr.split('/')[0]!,root=`/var/lib/nexo/environments/${environment.id}`;
 const openvpnConfig=[`port ${environment.listenerPort}`,'proto udp','dev tun','topology subnet',`server ${network} ${ipv4Netmask(parsed.prefix)}`,'user nobody','group nogroup','persist-key','persist-tun','keepalive 10 60','tls-version-min 1.2','tls-cert-profile preferred','data-ciphers AES-256-GCM:AES-128-GCM','auth SHA256',`ca ${root}/pki/ca.crt`,`cert ${root}/pki/server.crt`,`key ${root}/pki/server.key`,`tls-crypt ${root}/pki/tls-crypt.key`,'dh none','script-security 1','verb 3','explicit-exit-notify 1'].join('\n')+'\n';
 const firewallConfig=`table inet nexo_env {\n chain input { type filter hook input priority 0; policy drop; iifname "lo" accept; ct state established,related accept; udp dport ${environment.listenerPort} accept; }\n chain forward { type filter hook forward priority 0; policy drop; }\n chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; ct state established,related accept; ip daddr 169.254.169.254 drop; udp sport ${environment.listenerPort} accept; }\n}\n`;
 const manifest=JSON.stringify({schema:'nexo.vpn-runtime.v1',environment_id:environment.id,tenant_id:environment.tenantId,node_id:environment.nodeId,namespace:environment.namespaceName,revision:environment.revision,desired_state:environment.desiredState,engine:'openvpn',protocol:'udp',listener_port:environment.listenerPort,tunnel_ipv4_cidr:environment.tunnelIpv4Cidr,ipv6_enabled:false,limits:{cpus:0.25,memory_mb:96,pids:64},metadata_access:false},null,2)+'\n';
 const digest=createHash('sha256').update(openvpnConfig).update('\0').update(firewallConfig).update('\0').update(manifest).digest('hex');
 return{openvpnConfig,firewallConfig,manifest,digest};
}

export class LocalVpnRuntime{
 constructor(private readonly root:string){}
 async apply(environment:VpnEnvironmentView):Promise<{digest:string;credentialCreated:boolean}>{if(!this.root.startsWith('/'))throw new Error('invalid_runtime_root');const directory=join(this.root,environment.id),pki=join(directory,'pki');await mkdir(pki,{recursive:true,mode:0o700});let credentialCreated=false;const credential=join(pki,'bootstrap.secret');try{await stat(credential);}catch{await writeFile(credential,randomBytes(32),{mode:0o600,flag:'wx'});credentialCreated=true;}const bundle=renderVpnRuntime(environment);await this.atomic(directory,'openvpn.conf',bundle.openvpnConfig,0o600);await this.atomic(directory,'firewall.nft',bundle.firewallConfig,0o600);await this.atomic(directory,'manifest.json',bundle.manifest,0o600);await this.atomic(directory,'digest',bundle.digest+'\n',0o600);return{digest:bundle.digest,credentialCreated};}
 async desiredState(id:string):Promise<VpnDesiredState>{const value=JSON.parse(await readFile(join(this.root,id,'manifest.json'),'utf8')) as{desired_state:VpnDesiredState};return value.desired_state;}
 private async atomic(directory:string,name:string,value:string,mode:number){const temporary=join(directory,`.${name}.${process.pid}.tmp`),target=join(directory,name);await writeFile(temporary,value,{mode,flag:'wx'});await rename(temporary,target);}
}
