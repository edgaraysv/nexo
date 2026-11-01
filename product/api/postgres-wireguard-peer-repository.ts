import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parsePrivateCidr } from './network.js';
import type { WireGuardClientConfig, WireGuardNodePeer, WireGuardPeerRegistration, WireGuardPeerRepository, WireGuardPeerPreview, WireGuardPeerView, WireGuardPreviewAction, WireGuardPeerState } from './wireguard-peer-repository.js';
import { validWireGuardPublicKey } from './vpn-environment-repository.js';

interface PeerRow {id:string;tenant_id:string;environment_id:string;device_id:string;tunnel_ipv4:string;persistent_keepalive_seconds:number;state:WireGuardPeerState;revision:string;public_key?:string|null}
interface PreviewRow {id:string;tenant_id:string;environment_id:string;peer_id:string;candidate_key_id:string|null;action:WireGuardPreviewAction;expected_revision:string;digest:string;summary:{allowedIps:string[];persistentKeepaliveSeconds:0|25;newKeyFingerprint?:string;oldKeyFingerprint?:string};state:string;requested_by:string;expires_at:Date}

export class PostgresWireGuardPeerRepository implements WireGuardPeerRepository {
  constructor(private readonly pool:Pool){}

  async register(input:{tenantId:string;deviceId:string;environmentId:string;publicKey:string;action:'register'|'rotate'}):Promise<WireGuardPeerRegistration>{
    if(!validWireGuardPublicKey(input.publicKey))throw Error('invalid_wireguard_public_key');
    return this.tx(async c=>{
      await this.context(c,'app.tenant_id',input.tenantId);
      await this.context(c,'app.device_id',input.deviceId);
      // Device-scoped RLS intentionally grants SELECT, not UPDATE, on the
      // environment. A transaction advisory lock serializes IP allocation
      // without turning endpoint registration into an environment mutation.
      await this.lockEnvironment(c,input.environmentId);
      const environment=(await c.query<{node_id:string;tunnel_ipv4_cidr:string;server_public_key:string|null}>(`SELECT e.node_id,host(e.tunnel_ipv4_cidr)::text||'/'||masklen(e.tunnel_ipv4_cidr)::text tunnel_ipv4_cidr,w.server_public_key FROM vpn_environments e JOIN provider_nodes n ON n.id=e.node_id AND n.status='approved' JOIN wireguard_environment_config w ON w.environment_id=e.id JOIN subscriptions s ON s.tenant_id=e.tenant_id JOIN plans p ON p.id=s.plan_id LEFT JOIN subscription_modules m ON m.tenant_id=s.tenant_id AND m.module='vpn' AND (m.valid_from IS NULL OR m.valid_from<=now()) AND (m.valid_until IS NULL OR m.valid_until>now()) JOIN device_identities d ON d.id=$2 AND d.tenant_id=e.tenant_id AND d.status='approved' WHERE e.id=$1 AND e.tenant_id=$3 AND e.engine='wireguard' AND e.desired_state='active' AND e.observed_state='active' AND e.applied_revision=e.revision AND w.server_public_key IS NOT NULL AND s.state IN ('active','grace') AND (s.valid_from IS NULL OR s.valid_from<=now()) AND (s.valid_until IS NULL OR s.valid_until>now()) AND coalesce((p.modules->>'vpn')::boolean,false)=true AND coalesce(m.state,'active')='active'`,[input.environmentId,input.deviceId,input.tenantId])).rows[0];
      if(!environment)throw Error('environment_unavailable');
      let peer=(await c.query<PeerRow>('SELECT * FROM wireguard_peers WHERE tenant_id=$1 AND environment_id=$2 AND device_id=$3',[input.tenantId,input.environmentId,input.deviceId])).rows[0];
      if(!peer){if(input.action==='rotate')throw Error('peer_unavailable');peer=await this.createPeer(c,input.tenantId,input.environmentId,input.deviceId,environment.tunnel_ipv4_cidr);}
      if(peer.state==='revoked')throw Error('peer_unavailable');
      const existing=(await c.query<{id:string;public_key:string;state:WireGuardPeerState}>('SELECT id,public_key,state FROM wireguard_peer_keys WHERE peer_id=$1 ORDER BY created_at DESC',[peer.id])).rows;
      const same=existing.find(row=>row.public_key===input.publicKey);
      if(same){if(same.state==='revoked')throw Error('peer_key_conflict');return{peerId:peer.id,state:peer.state,tunnelIpv4:hostAddress(peer.tunnel_ipv4),publicKeyFingerprint:fingerprint(input.publicKey)};}
      const active=existing.some(row=>row.state==='active'),pending=existing.some(row=>row.state==='pending');
      if(input.action==='register'&&(active||pending)||input.action==='rotate'&&(!active||pending))throw Error('peer_key_conflict');
      try{await c.query("INSERT INTO wireguard_peer_keys(tenant_id,peer_id,public_key,state) VALUES($1,$2,$3,'pending')",[input.tenantId,peer.id,input.publicKey]);}catch(error){if(isUniqueViolation(error))throw Error('peer_key_conflict');throw error;}
      return{peerId:peer.id,state:peer.state,tunnelIpv4:hostAddress(peer.tunnel_ipv4),publicKeyFingerprint:fingerprint(input.publicKey)};
    });
  }

  async preview(input:{environmentId:string;deviceId:string;action:WireGuardPreviewAction;expectedRevision:number},actorUserId:string):Promise<WireGuardPeerPreview>{
    return this.providerTx(actorUserId,async c=>{
      await this.lockEnvironment(c,input.environmentId);
      const env=(await c.query<{tenant_id:string;engine:string;revision:string;desired_state:string;tunnel_ipv4_cidr:string}>("SELECT tenant_id,engine,revision,desired_state,host(tunnel_ipv4_cidr)::text||'/'||masklen(tunnel_ipv4_cidr)::text tunnel_ipv4_cidr FROM vpn_environments WHERE id=$1 FOR UPDATE",[input.environmentId])).rows[0];
      if(!env||env.engine!=='wireguard'||env.desired_state==='retired')throw Error('environment_unavailable');
      if(Number(env.revision)!==input.expectedRevision)throw Error('revision_conflict');
      await c.query("UPDATE wireguard_change_previews SET state='expired' WHERE environment_id=$1 AND state='pending' AND expires_at<=now()",[input.environmentId]);
      const pendingPreview=(await c.query("SELECT 1 FROM wireguard_change_previews WHERE environment_id=$1 AND state='pending' AND expires_at>now() LIMIT 1",[input.environmentId])).rowCount;
      if(pendingPreview)throw Error('preview_pending');
      const peer=(await c.query<PeerRow>('SELECT * FROM wireguard_peers WHERE tenant_id=$1 AND environment_id=$2 AND device_id=$3 FOR UPDATE',[env.tenant_id,input.environmentId,input.deviceId])).rows[0];
      if(!peer)throw Error('peer_unavailable');
      const keys=(await c.query<{id:string;public_key:string;state:WireGuardPeerState}>('SELECT id,public_key,state FROM wireguard_peer_keys WHERE peer_id=$1 ORDER BY created_at DESC FOR UPDATE',[peer.id])).rows,active=keys.find(key=>key.state==='active'),candidate=keys.find(key=>key.state==='pending');
      if(input.action==='approve'&&(peer.state!=='pending'||!candidate)||input.action==='rotate'&&(peer.state!=='active'||!active||!candidate)||input.action==='revoke'&&(peer.state!=='active'||!active))throw Error('invalid_peer_transition');
      const summary={allowedIps:[`${hostAddress(peer.tunnel_ipv4)}/32`],persistentKeepaliveSeconds:peer.persistent_keepalive_seconds as 0|25,...(candidate?{newKeyFingerprint:fingerprint(candidate.public_key)}:{}),...(active?{oldKeyFingerprint:fingerprint(active.public_key)}:{})};
      const id=randomUUID(),expiresAt=new Date(Date.now()+300_000),candidateKeyId=input.action==='approve'||input.action==='rotate'?candidate!.id:null,digest=previewDigest({environmentId:input.environmentId,revision:input.expectedRevision,action:input.action,peerId:peer.id,deviceId:peer.device_id,tunnelIpv4:hostAddress(peer.tunnel_ipv4),keepalive:peer.persistent_keepalive_seconds,candidatePublicKey:candidate?.public_key??null});
      try{await c.query('INSERT INTO wireguard_change_previews(id,tenant_id,environment_id,peer_id,candidate_key_id,action,expected_revision,digest,summary,requested_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[id,env.tenant_id,input.environmentId,peer.id,candidateKeyId,input.action,input.expectedRevision,digest,summary,actorUserId,expiresAt]);}catch(error){if(isUniqueViolation(error))throw Error('preview_pending');throw error;}
      return{id,environmentId:input.environmentId,peerId:peer.id,action:input.action,expectedRevision:input.expectedRevision,digest,expiresAt:expiresAt.toISOString(),summary};
    });
  }

  async confirm(input:{previewId:string;digest:string},actorUserId:string):Promise<WireGuardPeerView>{
    return this.providerTx(actorUserId,async c=>{
      const preview=(await c.query<PreviewRow>('SELECT * FROM wireguard_change_previews WHERE id=$1 FOR UPDATE',[input.previewId])).rows[0];
      if(!preview||preview.requested_by!==actorUserId||preview.state!=='pending')throw Error('preview_unavailable');
      await this.lockEnvironment(c,preview.environment_id);
      if(preview.expires_at.getTime()<=Date.now()){await c.query("UPDATE wireguard_change_previews SET state='expired' WHERE id=$1",[preview.id]);throw Error('preview_expired');}
      if(preview.digest!==input.digest)throw Error('preview_digest_conflict');
      const env=(await c.query<{revision:string;desired_state:string;name:string;node_id:string;listener_port:number;tunnel_ipv4_cidr:string}>("SELECT revision,desired_state,name,node_id,listener_port,host(tunnel_ipv4_cidr)::text||'/'||masklen(tunnel_ipv4_cidr)::text tunnel_ipv4_cidr FROM vpn_environments WHERE id=$1 AND tenant_id=$2 FOR UPDATE",[preview.environment_id,preview.tenant_id])).rows[0];
      if(!env||Number(env.revision)!==Number(preview.expected_revision))throw Error('revision_conflict');
      const peer=(await c.query<PeerRow>('SELECT * FROM wireguard_peers WHERE id=$1 AND tenant_id=$2 FOR UPDATE',[preview.peer_id,preview.tenant_id])).rows[0];if(!peer)throw Error('peer_unavailable');
      if(preview.action==='approve'||preview.action==='rotate'){
        if(!preview.candidate_key_id)throw Error('peer_key_conflict');
        const candidate=(await c.query<{public_key:string;state:string}>('SELECT public_key,state FROM wireguard_peer_keys WHERE id=$1 AND peer_id=$2 FOR UPDATE',[preview.candidate_key_id,peer.id])).rows[0];if(!candidate||candidate.state!=='pending')throw Error('peer_key_conflict');
        await c.query("UPDATE wireguard_peer_keys SET state='revoked',revoked_at=now() WHERE peer_id=$1 AND state='active'",[peer.id]);
        await c.query("UPDATE wireguard_peer_keys SET state='active',activated_at=now() WHERE id=$1",[preview.candidate_key_id]);
        await c.query("UPDATE wireguard_peers SET state='active',revision=revision+1,updated_at=now() WHERE id=$1",[peer.id]);
      }else{
        await c.query("UPDATE wireguard_peer_keys SET state='revoked',revoked_at=now() WHERE peer_id=$1 AND state<>'revoked'",[peer.id]);
        await c.query("UPDATE wireguard_peers SET state='revoked',revision=revision+1,updated_at=now() WHERE id=$1",[peer.id]);
      }
      const revision=Number(env.revision)+1;
      await c.query("UPDATE vpn_environments SET revision=$2,observed_state='pending',error_code=NULL,updated_at=now() WHERE id=$1",[preview.environment_id,revision]);
      const activePeers=(await c.query<{device_id:string;tunnel_ipv4:string;public_key:string;persistent_keepalive_seconds:number}>('SELECT p.device_id,host(p.tunnel_ipv4) tunnel_ipv4,k.public_key,p.persistent_keepalive_seconds FROM wireguard_peers p JOIN wireguard_peer_keys k ON k.peer_id=p.id AND k.state=\'active\' WHERE p.environment_id=$1 AND p.state=\'active\' ORDER BY p.device_id',[preview.environment_id])).rows;
      const specification={engine:'wireguard',protocol:'udp',listener_port:env.listener_port,tunnel_ipv4_cidr:env.tunnel_ipv4_cidr,ipv6_enabled:false,mtu:1420,peers:activePeers.map(item=>({device_id:item.device_id,public_key:item.public_key,allowed_ips:[`${item.tunnel_ipv4}/32`],persistent_keepalive_seconds:item.persistent_keepalive_seconds}))};
      await c.query("INSERT INTO vpn_environment_revisions(environment_id,tenant_id,revision,desired_state,specification,requested_by) VALUES($1,$2,$3,$4,$5,$6)",[preview.environment_id,preview.tenant_id,revision,env.desired_state,specification,actorUserId]);
      await c.query("UPDATE wireguard_change_previews SET state='confirmed',confirmed_at=now() WHERE id=$1",[preview.id]);
      await c.query("INSERT INTO provider_audit_events(actor_user_id,actor_kind,actor_id,tenant_id,action,resource_type,resource_id,metadata) VALUES($1::uuid,'user',$1::text,$2,$3,'vpn_environment',$4,$5)",[actorUserId,preview.tenant_id,`wireguard.peer.${preview.action}`,preview.environment_id,{peer_id:peer.id,revision,allowed_ips:preview.summary.allowedIps}]);
      const result=(await c.query<PeerRow>('SELECT p.*,k.public_key FROM wireguard_peers p LEFT JOIN wireguard_peer_keys k ON k.peer_id=p.id AND k.state=\'active\' WHERE p.id=$1',[peer.id])).rows[0]!;
      return this.view(result);
    });
  }

  async desiredForNode(nodeId:string){
    const c=await this.pool.connect();try{await c.query('BEGIN');await this.context(c,'app.worker_role','operation_dispatch');await this.context(c,'app.node_id',nodeId);const rows=(await c.query<PeerRow>(`SELECT p.*,k.public_key FROM wireguard_peers p JOIN vpn_environments e ON e.id=p.environment_id AND e.node_id=$1 AND e.engine='wireguard' JOIN wireguard_peer_keys k ON k.peer_id=p.id AND k.state='active' WHERE p.state='active' AND e.desired_state='active' ORDER BY p.environment_id,p.device_id`,[nodeId])).rows;const out:Record<string,WireGuardNodePeer[]>={};for(const row of rows){(out[row.environment_id]??=[]).push({deviceId:row.device_id,publicKey:row.public_key!,allowedIps:[`${hostAddress(row.tunnel_ipv4)}/32`],persistentKeepaliveSeconds:row.persistent_keepalive_seconds as 0|25});}await c.query('COMMIT');return out;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}

  async forDevice(tenantId:string,deviceId:string){
    const c=await this.pool.connect();try{await c.query('BEGIN');await this.context(c,'app.tenant_id',tenantId);await this.context(c,'app.device_id',deviceId);const rows=(await c.query<PeerRow&{server_public_key:string;listener_port:number;tunnel_ipv4_cidr:string}>(`SELECT p.*,k.public_key,w.server_public_key,e.listener_port,host(e.tunnel_ipv4_cidr)::text||'/'||masklen(e.tunnel_ipv4_cidr)::text tunnel_ipv4_cidr FROM wireguard_peers p JOIN wireguard_peer_keys k ON k.peer_id=p.id AND k.state='active' JOIN wireguard_environment_config w ON w.environment_id=p.environment_id JOIN vpn_environments e ON e.id=p.environment_id WHERE p.tenant_id=$1 AND p.device_id=$2 AND p.state='active' AND e.engine='wireguard' AND e.desired_state='active' AND e.observed_state='active' AND e.applied_revision=e.revision AND w.server_public_key IS NOT NULL AND EXISTS (SELECT 1 FROM subscriptions s JOIN plans plan ON plan.id=s.plan_id LEFT JOIN subscription_modules m ON m.tenant_id=s.tenant_id AND m.module='vpn' AND (m.valid_from IS NULL OR m.valid_from<=now()) AND (m.valid_until IS NULL OR m.valid_until>now()) WHERE s.tenant_id=e.tenant_id AND s.state IN ('active','grace') AND (s.valid_from IS NULL OR s.valid_from<=now()) AND (s.valid_until IS NULL OR s.valid_until>now()) AND coalesce((plan.modules->>'vpn')::boolean,false)=true AND coalesce(m.state,'active')='active')`,[tenantId,deviceId])).rows;const out:Record<string,WireGuardClientConfig>={};for(const row of rows){const base=parsePrivateCidr(row.tunnel_ipv4_cidr).address,serverTunnelIpv4=addressAt(base+1n);out[row.environment_id]={peerId:row.id,tunnelIpv4:hostAddress(row.tunnel_ipv4),clientPublicKey:row.public_key!,serverTunnelIpv4,serverPublicKey:row.server_public_key,listenerPort:row.listener_port,allowedIps:[`${serverTunnelIpv4}/32`],persistentKeepaliveSeconds:row.persistent_keepalive_seconds as 0|25};}await c.query('COMMIT');return out;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}

  private async createPeer(c:PoolClient,tenantId:string,environmentId:string,deviceId:string,cidr:string):Promise<PeerRow>{const parsed=parsePrivateCidr(cidr),count=1n<<BigInt(32-parsed.prefix),last=parsed.address+count-1n,capacityEnd=parsed.address+4098n,end=last<capacityEnd?last:capacityEnd;for(let value=parsed.address+2n;value<end;value++){const address=addressAt(value),inserted=await c.query<PeerRow>("INSERT INTO wireguard_peers(tenant_id,environment_id,device_id,tunnel_ipv4,state) VALUES($1,$2,$3,$4::inet,'pending') ON CONFLICT(environment_id,tunnel_ipv4) DO NOTHING RETURNING *",[tenantId,environmentId,deviceId,`${address}/32`]);if(inserted.rows[0])return inserted.rows[0];}throw Error('peer_capacity_exceeded');}
  private view(row:PeerRow):WireGuardPeerView{return{id:row.id,environmentId:row.environment_id,deviceId:row.device_id,state:row.state,tunnelIpv4:hostAddress(row.tunnel_ipv4),persistentKeepaliveSeconds:row.persistent_keepalive_seconds as 0|25,revision:Number(row.revision),...(row.public_key?{publicKeyFingerprint:fingerprint(row.public_key)}:{})};}
  private async lockEnvironment(c:PoolClient,environmentId:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[environmentId]);}
  private async context(c:PoolClient,key:string,value:string){await c.query('SELECT set_config($1,$2,true)',[key,value]);}
  private async providerTx<T>(actor:string,work:(c:PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');await this.context(c,'app.user_id',actor);const role=(await c.query<{role:string}>("SELECT role FROM provider_users WHERE user_id=$1 AND status='active'",[actor])).rows[0]?.role;if(role!=='owner')throw Error('forbidden');await this.context(c,'app.provider_role','owner');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
  private async tx<T>(work:(c:PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');const result=await work(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
}

function previewDigest(value:Record<string,unknown>){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function fingerprint(value:string){return createHash('sha256').update(Buffer.from(value,'base64')).digest('hex').slice(0,16);}
function hostAddress(value:string){return value.split('/')[0]!;}
function addressAt(value:bigint){return[24n,16n,8n,0n].map(shift=>Number((value>>shift)&255n)).join('.');}
function isUniqueViolation(error:unknown){return error instanceof Error&&'code'in error&&(error as{code?:string}).code==='23505';}
