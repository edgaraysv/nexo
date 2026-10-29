import { cidrContains, parsePrivateCidr } from './network.js';

export type NetworkObservedState='pending'|'applying'|'active'|'error'|'suspended'|'retired';
export type NetworkDesiredState='active'|'suspended'|'retired';
export interface NetworkProfileView {
  id:string;tenantId:string;siteId:string;vpnEnvironmentId:string;name:string;siteNetworks:string[];
  pathMode:'direct'|'gateway';gatewayDeviceId?:string;returnMode:'routed'|'snat';
  dnsMode:'local'|'split';dnsServers:string[];dnsSuffixes:string[];
  desiredState:NetworkDesiredState;observedState:NetworkObservedState;
  revision:number;appliedRevision?:number;configDigest?:string;errorCode?:string;
}
export interface PrivateResourceView {id:string;profileId:string;name:string;kind:'ipv4'|'hostname';address:string;status:'active'|'retired';revision:number}
export interface NetworkPolicyView {id:string;profileId:string;name:string;effect:'allow'|'deny';sourceKind:'any_endpoint'|'device';sourceDeviceId?:string;resourceId:string;protocol:'tcp'|'udp';portStart:number;portEnd:number;status:'draft'|'active'|'retired';revision:number}
export interface NetworkDiagnostic {decision:'deny'|'allow';reason:'default_deny'|'explicit_deny'|'configuration_pending'|'policy_allows';connectivity:'not_tested';profileRevision:number;appliedRevision?:number;pathMode:'direct'|'gateway';returnMode:'routed'|'snat';dnsMode:'local'|'split'}
export interface NetworkRuntimeRule {address:string;protocol:'tcp'|'udp';portStart:number;portEnd:number}
export interface NetworkProfileSpec {tenantId:string;siteId:string;vpnEnvironmentId:string;name:string;pathMode:'direct'|'gateway';gatewayDeviceId?:string;returnMode:'routed'|'snat';dnsMode:'local'|'split';dnsServers:string[];dnsSuffixes:string[];siteNetworks:string[]}
export interface PrivateNetworkRepository {
  listProfiles(tenantId:string):Promise<NetworkProfileView[]>;
  createProfile(input:NetworkProfileSpec,actor:string):Promise<NetworkProfileView>;
  listResources(tenantId:string):Promise<PrivateResourceView[]>;
  createResource(tenantId:string,input:{profileId:string;name:string;kind:'ipv4'|'hostname';address:string},actor:string):Promise<PrivateResourceView>;
  listPolicies(tenantId:string):Promise<NetworkPolicyView[]>;
  createPolicy(tenantId:string,input:Omit<NetworkPolicyView,'id'|'revision'>,actor:string):Promise<NetworkPolicyView>;
  diagnose(tenantId:string,input:{sourceDeviceId:string;resourceId:string;protocol:'tcp'|'udp';port:number}):Promise<NetworkDiagnostic|undefined>;
  desired(tenantId:string,deviceId:string,kind:'endpoint'|'gateway'):Promise<{profiles:NetworkProfileView[];resources:PrivateResourceView[];policies:NetworkPolicyView[]}>;
  desiredForNode(nodeId:string):Promise<Record<string,NetworkRuntimeRule[]>>;
  report(profileId:string,tenantId:string,deviceId:string,deviceKind:'endpoint'|'gateway',input:{revision:number;observedState:NetworkObservedState;configDigest?:string;errorCode?:string}):Promise<boolean>;
}

function clone<T>(value:T):T{return structuredClone(value);}
function validProfile(input:NetworkProfileSpec):void{
  if(input.pathMode==='direct'&&(input.gatewayDeviceId||input.returnMode!=='routed'))throw Error('invalid_profile');
  if(input.pathMode==='gateway'&&!input.gatewayDeviceId)throw Error('invalid_gateway');
  if(input.dnsMode==='local'&&(input.dnsServers.length||input.dnsSuffixes.length))throw Error('invalid_dns');
  if(input.dnsMode==='split'&&(!input.dnsServers.length||!input.dnsSuffixes.length))throw Error('invalid_dns');
  for(const network of input.siteNetworks){const parsed=parsePrivateCidr(network);if(parsed.family===4&&parsed.prefix<16||parsed.family===6&&parsed.prefix<48)throw Error('unsafe_route');}
}
function hostname(value:string):boolean{return value.length<=253&&/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value);}

export class MemoryPrivateNetworkRepository implements PrivateNetworkRepository {
  private profiles=new Map<string,NetworkProfileView>();private profileNetworks=new Map<string,string[]>();private resources=new Map<string,PrivateResourceView>();private policies=new Map<string,NetworkPolicyView>();private observations=new Map<string,{revision:number;observedState:NetworkObservedState}>();
  constructor(private readonly approvedGateways?:Set<string>){}
  async listProfiles(t:string){return[...this.profiles.values()].filter(x=>x.tenantId===t).map(clone);}
  async createProfile(input:NetworkProfileSpec){validProfile(input);if(input.gatewayDeviceId&&this.approvedGateways&&!this.approvedGateways.has(input.gatewayDeviceId))throw Error('invalid_gateway');if([...this.profiles.values()].some(x=>x.tenantId===input.tenantId&&x.siteId===input.siteId&&x.desiredState!=='retired'))throw Error('profile_conflict');const value:NetworkProfileView={id:crypto.randomUUID(),tenantId:input.tenantId,siteId:input.siteId,vpnEnvironmentId:input.vpnEnvironmentId,name:input.name,siteNetworks:[...input.siteNetworks],pathMode:input.pathMode,...(input.gatewayDeviceId?{gatewayDeviceId:input.gatewayDeviceId}:{}),returnMode:input.returnMode,dnsMode:input.dnsMode,dnsServers:[...input.dnsServers],dnsSuffixes:[...input.dnsSuffixes],desiredState:'active',observedState:'pending',revision:1};this.profiles.set(value.id,value);this.profileNetworks.set(value.id,[...input.siteNetworks]);return clone(value);}
  async listResources(t:string){const ids=new Set((await this.listProfiles(t)).map(x=>x.id));return[...this.resources.values()].filter(x=>ids.has(x.profileId)).map(clone);}
  async createResource(t:string,input:{profileId:string;name:string;kind:'ipv4'|'hostname';address:string}){const profile=this.profiles.get(input.profileId);if(!profile||profile.tenantId!==t)throw Error('not_found');if(input.kind==='ipv4'){const target=parsePrivateCidr(`${input.address}/32`),networks=this.profileNetworks.get(profile.id)??[];if(!networks.some(x=>cidrContains(parsePrivateCidr(x),target)))throw Error('outside_branch');}else if(!hostname(input.address)||profile.dnsMode!=='split'||!profile.dnsSuffixes.some(x=>input.address===x||input.address.endsWith(`.${x}`)))throw Error('invalid_hostname');const value:PrivateResourceView={id:crypto.randomUUID(),...input,status:'active',revision:1};this.resources.set(value.id,value);profile.revision++;profile.observedState='pending';return clone(value);}
  async listPolicies(t:string){const ids=new Set((await this.listProfiles(t)).map(x=>x.id));return[...this.policies.values()].filter(x=>ids.has(x.profileId)).map(clone);}
  async createPolicy(t:string,input:Omit<NetworkPolicyView,'id'|'revision'>){const profile=this.profiles.get(input.profileId),resource=this.resources.get(input.resourceId);if(!profile||profile.tenantId!==t||!resource||resource.profileId!==profile.id)throw Error('not_found');if(input.sourceKind==='any_endpoint'&&input.sourceDeviceId||input.sourceKind==='device'&&!input.sourceDeviceId)throw Error('invalid_source');const value:NetworkPolicyView={...input,id:crypto.randomUUID(),revision:1};this.policies.set(value.id,value);profile.revision++;profile.observedState='pending';return clone(value);}
  async diagnose(t:string,input:{sourceDeviceId:string;resourceId:string;protocol:'tcp'|'udp';port:number}):Promise<NetworkDiagnostic|undefined>{const resource=this.resources.get(input.resourceId),profile=resource&&this.profiles.get(resource.profileId);if(!resource||!profile||profile.tenantId!==t||resource.status!=='active')return undefined;const matches=[...this.policies.values()].filter(x=>x.profileId===profile.id&&x.resourceId===resource.id&&x.status==='active'&&x.protocol===input.protocol&&x.portStart<=input.port&&x.portEnd>=input.port&&(x.sourceKind==='any_endpoint'||x.sourceDeviceId===input.sourceDeviceId));const denied=matches.some(x=>x.effect==='deny'),allowed=matches.some(x=>x.effect==='allow'),observedDevice=profile.pathMode==='direct'?input.sourceDeviceId:profile.gatewayDeviceId!,observation=this.observations.get(`${profile.id}:${observedDevice}`),ready=observation?.observedState==='active'&&observation.revision===profile.revision;const decision:'deny'|'allow'=denied||!allowed?'deny':'allow',reason:NetworkDiagnostic['reason']=denied?'explicit_deny':!allowed?'default_deny':!ready?'configuration_pending':'policy_allows';return{decision,reason,connectivity:'not_tested',profileRevision:profile.revision,...(ready?{appliedRevision:observation.revision}:{}),pathMode:profile.pathMode,returnMode:profile.returnMode,dnsMode:profile.dnsMode};}
  async desired(t:string,deviceId:string,kind:'endpoint'|'gateway'){const profiles=[...this.profiles.values()].filter(x=>x.tenantId===t&&x.desiredState==='active'&&(kind==='endpoint'?x.pathMode==='direct':x.pathMode==='gateway'&&x.gatewayDeviceId===deviceId)).map(clone),ids=new Set(profiles.map(x=>x.id));return{profiles,resources:[...this.resources.values()].filter(x=>ids.has(x.profileId)&&x.status==='active').map(clone),policies:[...this.policies.values()].filter(x=>ids.has(x.profileId)&&x.status==='active'&&(kind==='gateway'||x.sourceKind==='any_endpoint'||x.sourceDeviceId===deviceId)).map(clone)};}
  async desiredForNode(_nodeId:string){return {};}
  async report(id:string,t:string,deviceId:string,kind:'endpoint'|'gateway',input:{revision:number;observedState:NetworkObservedState;configDigest?:string;errorCode?:string}){const p=this.profiles.get(id),eligible=p&&(p.pathMode==='direct'?kind==='endpoint':kind==='gateway'&&p.gatewayDeviceId===deviceId);if(!p||p.tenantId!==t||!eligible||p.revision!==input.revision)return false;this.observations.set(`${id}:${deviceId}`,{revision:input.revision,observedState:input.observedState});p.observedState=input.observedState;if(['active','suspended','retired'].includes(input.observedState))p.appliedRevision=input.revision;if(input.configDigest)p.configDigest=input.configDigest;else if(input.observedState!=='applying')delete p.configDigest;if(input.errorCode)p.errorCode=input.errorCode;else delete p.errorCode;return true;}
}
