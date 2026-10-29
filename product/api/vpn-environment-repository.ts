export type VpnDesiredState='active'|'suspended'|'retired';
export type VpnObservedState='pending'|'provisioning'|'active'|'suspended'|'error'|'retired';
export interface VpnEnvironmentView{id:string;tenantId:string;nodeId:string;name:string;engine:'openvpn';protocol:'udp';listenerPort:number;tunnelIpv4Cidr:string;ipv6Enabled:false;namespaceName:string;desiredState:VpnDesiredState;observedState:VpnObservedState;revision:number;appliedRevision?:number;configDigest?:string;errorCode?:string}
export interface VpnEnvironmentSpec{tenantId:string;nodeId:string;name:string;listenerPort:number;tunnelIpv4Cidr:string}
export interface VpnEnvironmentRepository{
  list(actorUserId:string):Promise<VpnEnvironmentView[]>;
  desired(nodeId:string):Promise<VpnEnvironmentView[]>;
  available(tenantId:string,deviceId:string):Promise<{moduleState:'enabled'|'disabled';items:VpnEnvironmentView[]}>;
 create(input:VpnEnvironmentSpec,actorUserId:string):Promise<VpnEnvironmentView>;
 changeState(id:string,input:{desiredState:VpnDesiredState;expectedRevision:number},actorUserId:string):Promise<VpnEnvironmentView|undefined>;
 report(id:string,nodeId:string,input:{revision:number;observedState:VpnObservedState;configDigest?:string;errorCode?:string}):Promise<boolean>;
}
export class MemoryVpnEnvironmentRepository implements VpnEnvironmentRepository{
 private readonly items=new Map<string,VpnEnvironmentView>();
 constructor(private readonly entitledTenants?:Set<string>,private readonly approvedNodes?:Set<string>){}
 async list(){return[...this.items.values()].map(x=>structuredClone(x));}
  async desired(nodeId:string){return[...this.items.values()].filter(x=>x.nodeId===nodeId).map(x=>structuredClone(x));}
  async available(tenantId:string,_deviceId:string){const enabled=!this.entitledTenants||this.entitledTenants.has(tenantId),moduleState:'enabled'|'disabled'=enabled?'enabled':'disabled';return{moduleState,items:enabled?[...this.items.values()].filter(x=>x.tenantId===tenantId&&x.desiredState==='active'&&x.observedState==='active'&&x.appliedRevision===x.revision).map(x=>structuredClone(x)):[]};}
 async create(input:VpnEnvironmentSpec){if(this.entitledTenants&&!this.entitledTenants.has(input.tenantId))throw new Error('vpn_not_entitled');if(this.approvedNodes&&!this.approvedNodes.has(input.nodeId))throw new Error('invalid_node');if([...this.items.values()].some(x=>x.nodeId===input.nodeId&&x.listenerPort===input.listenerPort&&x.desiredState!=='retired'))throw new Error('port_conflict');const id=crypto.randomUUID(),value:VpnEnvironmentView={id,...input,engine:'openvpn',protocol:'udp',ipv6Enabled:false,namespaceName:`nexo-${id.replaceAll('-','').slice(0,12)}`,desiredState:'active',observedState:'pending',revision:1};this.items.set(id,value);return structuredClone(value);}
 async changeState(id:string,input:{desiredState:VpnDesiredState;expectedRevision:number}){const current=this.items.get(id);if(!current)return undefined;if(current.revision!==input.expectedRevision)throw new Error('revision_conflict');if(current.desiredState==='retired'&&input.desiredState!=='retired')throw new Error('retired_environment');current.desiredState=input.desiredState;current.observedState='pending';current.revision++;delete current.errorCode;return structuredClone(current);}
 async report(id:string,nodeId:string,input:{revision:number;observedState:VpnObservedState;configDigest?:string;errorCode?:string}){const current=this.items.get(id);if(!current||current.nodeId!==nodeId||input.revision!==current.revision||!['provisioning','error',current.desiredState].includes(input.observedState))return false;current.observedState=input.observedState;if(['active','suspended','retired'].includes(input.observedState))current.appliedRevision=input.revision;if(input.configDigest)current.configDigest=input.configDigest;else if(input.observedState!=='provisioning')delete current.configDigest;if(input.errorCode)current.errorCode=input.errorCode;else delete current.errorCode;return true;}
}
