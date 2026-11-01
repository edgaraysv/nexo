import { createHash, randomUUID } from 'node:crypto';
import { parsePrivateCidr } from './network.js';
import type { VpnEnvironmentRepository } from './vpn-environment-repository.js';
import { validWireGuardPublicKey } from './vpn-environment-repository.js';

export type WireGuardPeerState='pending'|'active'|'revoked';
export type WireGuardPreviewAction='approve'|'rotate'|'revoke';
export interface WireGuardPeerView {id:string;environmentId:string;deviceId:string;state:WireGuardPeerState;tunnelIpv4:string;persistentKeepaliveSeconds:0|25;revision:number;publicKeyFingerprint?:string}
export interface WireGuardPeerRegistration {peerId:string;state:WireGuardPeerState;tunnelIpv4:string;publicKeyFingerprint:string}
export interface WireGuardPeerPreview {id:string;environmentId:string;peerId:string;action:WireGuardPreviewAction;expectedRevision:number;digest:string;expiresAt:string;summary:{allowedIps:string[];persistentKeepaliveSeconds:0|25;newKeyFingerprint?:string;oldKeyFingerprint?:string}}
export interface WireGuardNodePeer {deviceId:string;publicKey:string;allowedIps:string[];persistentKeepaliveSeconds:0|25}
export interface WireGuardClientConfig {peerId:string;tunnelIpv4:string;clientPublicKey:string;serverTunnelIpv4:string;serverPublicKey:string;listenerPort:number;allowedIps:string[];persistentKeepaliveSeconds:0|25}

export interface WireGuardPeerRepository {
  register(input:{tenantId:string;deviceId:string;environmentId:string;publicKey:string;action:'register'|'rotate'}):Promise<WireGuardPeerRegistration>;
  preview(input:{environmentId:string;deviceId:string;action:WireGuardPreviewAction;expectedRevision:number},actorUserId:string):Promise<WireGuardPeerPreview>;
  confirm(input:{previewId:string;digest:string},actorUserId:string):Promise<WireGuardPeerView>;
  desiredForNode(nodeId:string):Promise<Record<string,WireGuardNodePeer[]>>;
  forDevice(tenantId:string,deviceId:string):Promise<Record<string,WireGuardClientConfig>>;
}

interface MemoryPeer extends WireGuardPeerView {tenantId:string;keys:Array<{publicKey:string;state:WireGuardPeerState}>}
interface MemoryPreview extends WireGuardPeerPreview {actorUserId:string;deviceId:string;candidatePublicKey?:string;state:'pending'|'confirmed'|'expired'}

export class MemoryWireGuardPeerRepository implements WireGuardPeerRepository {
  private peers=new Map<string,MemoryPeer>();
  private previews=new Map<string,MemoryPreview>();
  constructor(private readonly environments:VpnEnvironmentRepository){}

  async register(input:{tenantId:string;deviceId:string;environmentId:string;publicKey:string;action:'register'|'rotate'}){
    if(!validWireGuardPublicKey(input.publicKey))throw Error('invalid_wireguard_public_key');
    const environment=(await this.environments.list('')).find(item=>item.id===input.environmentId&&item.tenantId===input.tenantId);
    if(!environment||environment.engine!=='wireguard'||environment.desiredState!=='active'||environment.observedState!=='active'||environment.appliedRevision!==environment.revision||!environment.wireguardServerPublicKey)throw Error('environment_unavailable');
    const key=`${input.environmentId}:${input.deviceId}`;
    let peer=this.peers.get(key);
    if(!peer){if(input.action==='rotate')throw Error('peer_unavailable');peer={id:randomUUID(),tenantId:input.tenantId,environmentId:input.environmentId,deviceId:input.deviceId,state:'pending',tunnelIpv4:this.allocate(environment.tunnelIpv4Cidr,input.environmentId),persistentKeepaliveSeconds:0,revision:1,keys:[]};this.peers.set(key,peer);}
    if(peer.tenantId!==input.tenantId||peer.state==='revoked')throw Error('peer_unavailable');
    const same=peer.keys.find(item=>item.publicKey===input.publicKey);
    if(same){if(same.state==='revoked')throw Error('peer_key_conflict');return{peerId:peer.id,state:peer.state,tunnelIpv4:peer.tunnelIpv4,publicKeyFingerprint:fingerprint(input.publicKey)};}
    if(input.action==='register'&&peer.keys.some(item=>item.state==='active'))throw Error('peer_key_conflict');
    if(input.action==='rotate'&&(peer.state!=='active'||peer.keys.some(item=>item.state==='pending')))throw Error('peer_key_conflict');
    if(input.action==='register'&&peer.keys.some(item=>item.state==='pending'))throw Error('peer_key_conflict');
    peer.keys.push({publicKey:input.publicKey,state:'pending'});
    return{peerId:peer.id,state:peer.state,tunnelIpv4:peer.tunnelIpv4,publicKeyFingerprint:fingerprint(input.publicKey)};
  }

  async preview(input:{environmentId:string;deviceId:string;action:WireGuardPreviewAction;expectedRevision:number},actorUserId:string){
    const environment=(await this.environments.list(actorUserId)).find(item=>item.id===input.environmentId);
    if(!environment||environment.engine!=='wireguard')throw Error('environment_unavailable');
    if(environment.revision!==input.expectedRevision)throw Error('revision_conflict');
    for(const existing of this.previews.values())if(existing.environmentId===input.environmentId&&existing.state==='pending'){
      if(Date.parse(existing.expiresAt)<=Date.now())existing.state='expired';
      else throw Error('preview_pending');
    }
    const peer=this.peers.get(`${input.environmentId}:${input.deviceId}`);
    if(!peer)throw Error('peer_unavailable');
    const active=peer.keys.find(item=>item.state==='active'),candidate=peer.keys.find(item=>item.state==='pending');
    if(input.action==='approve'&&(peer.state!=='pending'||!candidate)||input.action==='rotate'&&(peer.state!=='active'||!active||!candidate)||input.action==='revoke'&&(peer.state!=='active'||!active))throw Error('invalid_peer_transition');
    const summary={allowedIps:[`${peer.tunnelIpv4}/32`],persistentKeepaliveSeconds:peer.persistentKeepaliveSeconds,...(candidate?{newKeyFingerprint:fingerprint(candidate.publicKey)}:{}),...(active?{oldKeyFingerprint:fingerprint(active.publicKey)}:{})};
    const expiresAt=new Date(Date.now()+5*60_000).toISOString(),id=randomUUID(),candidatePublicKey=input.action==='approve'||input.action==='rotate'?candidate!.publicKey:undefined,digest=previewDigest({environmentId:environment.id,revision:environment.revision,action:input.action,peerId:peer.id,deviceId:peer.deviceId,tunnelIpv4:peer.tunnelIpv4,keepalive:peer.persistentKeepaliveSeconds,candidatePublicKey});
    const preview:MemoryPreview={id,environmentId:environment.id,peerId:peer.id,action:input.action,expectedRevision:environment.revision,digest,expiresAt,summary,actorUserId,deviceId:peer.deviceId,...(candidatePublicKey?{candidatePublicKey}:{}),state:'pending'};
    this.previews.set(id,preview);
    return publicPreview(preview);
  }

  async confirm(input:{previewId:string;digest:string},actorUserId:string){
    const preview=this.previews.get(input.previewId);
    if(!preview||preview.actorUserId!==actorUserId||preview.state!=='pending')throw Error('preview_unavailable');
    if(Date.parse(preview.expiresAt)<=Date.now()){preview.state='expired';throw Error('preview_expired');}
    if(preview.digest!==input.digest)throw Error('preview_digest_conflict');
    const environment=(await this.environments.list(actorUserId)).find(item=>item.id===preview.environmentId);
    if(!environment||environment.revision!==preview.expectedRevision)throw Error('revision_conflict');
    const peer=this.peers.get(`${preview.environmentId}:${preview.deviceId}`);
    if(!peer||peer.id!==preview.peerId)throw Error('peer_unavailable');
    const candidate=preview.action==='approve'||preview.action==='rotate'?peer.keys.find(key=>key.publicKey===preview.candidatePublicKey&&key.state==='pending'):undefined;
    if((preview.action==='approve'||preview.action==='rotate')&&!candidate)throw Error('peer_key_conflict');
    const changed=await this.environments.changeState(environment.id,{desiredState:environment.desiredState,expectedRevision:environment.revision},actorUserId);
    if(!changed)throw Error('environment_unavailable');
    if(preview.action==='approve'||preview.action==='rotate'){
      for(const key of peer.keys)if(key.state==='active')key.state='revoked';
      candidate!.state='active';peer.state='active';
    }else{
      peer.state='revoked';for(const key of peer.keys)key.state='revoked';
    }
    peer.revision++;
    preview.state='confirmed';
    return this.view(peer);
  }

  async desiredForNode(nodeId:string){
    const environments=(await this.environments.desired(nodeId)).filter(item=>item.engine==='wireguard'&&item.desiredState==='active'),out:Record<string,WireGuardNodePeer[]>={};
    for(const environment of environments){out[environment.id]=[...this.peers.values()].filter(peer=>peer.environmentId===environment.id&&peer.state==='active').flatMap(peer=>{const key=peer.keys.find(item=>item.state==='active');return key?[{deviceId:peer.deviceId,publicKey:key.publicKey,allowedIps:[`${peer.tunnelIpv4}/32`],persistentKeepaliveSeconds:peer.persistentKeepaliveSeconds}]:[];});}
    return out;
  }

  async forDevice(tenantId:string,deviceId:string){
    const environments=(await this.environments.available(tenantId,deviceId)).items,out:Record<string,WireGuardClientConfig>={};
    for(const environment of environments){if(environment.engine!=='wireguard'||!environment.wireguardServerPublicKey)continue;const peer=this.peers.get(`${environment.id}:${deviceId}`),key=peer?.keys.find(item=>item.state==='active');if(!peer||peer.state!=='active'||!key)continue;const serverTunnelIpv4=addressAt(parsePrivateCidr(environment.tunnelIpv4Cidr).address+1n);out[environment.id]={peerId:peer.id,tunnelIpv4:peer.tunnelIpv4,clientPublicKey:key.publicKey,serverTunnelIpv4,serverPublicKey:environment.wireguardServerPublicKey,listenerPort:environment.listenerPort,allowedIps:[`${serverTunnelIpv4}/32`],persistentKeepaliveSeconds:peer.persistentKeepaliveSeconds};}
    return out;
  }

  private allocate(cidr:string,environmentId:string){const prefix=parsePrivateCidr(cidr),used=new Set([...this.peers.values()].filter(peer=>peer.environmentId===environmentId).map(peer=>peer.tunnelIpv4)),hostCount=1n<<BigInt(32-prefix.prefix),last=prefix.address+hostCount-1n,capacityEnd=prefix.address+4098n,end=last<capacityEnd?last:capacityEnd;for(let address=prefix.address+2n;address<end;address++){const value=addressAt(address);if(!used.has(value))return value;}throw Error('peer_capacity_exceeded');}
  private view(peer:MemoryPeer):WireGuardPeerView{const key=peer.keys.find(item=>item.state==='active');return{id:peer.id,environmentId:peer.environmentId,deviceId:peer.deviceId,state:peer.state,tunnelIpv4:peer.tunnelIpv4,persistentKeepaliveSeconds:peer.persistentKeepaliveSeconds,revision:peer.revision,...(key?{publicKeyFingerprint:fingerprint(key.publicKey)}:{})};}
}

function previewDigest(input:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(input)).digest('hex');}
function fingerprint(key:string){return createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,16);}
function addressAt(value:bigint){return[24n,16n,8n,0n].map(shift=>Number((value>>shift)&255n)).join('.');}
function publicPreview(preview:MemoryPreview):WireGuardPeerPreview{return{id:preview.id,environmentId:preview.environmentId,peerId:preview.peerId,action:preview.action,expectedRevision:preview.expectedRevision,digest:preview.digest,expiresAt:preview.expiresAt,summary:structuredClone(preview.summary)};}
