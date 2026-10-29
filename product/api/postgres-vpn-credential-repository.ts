import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { NodeOperation } from './node-repository.js';
import type { VpnCredentialRepository, VpnCredentialView, VpnCredentialState } from './vpn-credential-repository.js';

export class PostgresVpnCredentialRepository implements VpnCredentialRepository {
  constructor(private readonly pool:Pool){}

  async request(input:{tenantId:string;deviceId:string;environmentId:string;csrPem:string;idempotencyKey:string;expiresAt:number}){
    return this.tx(async c=>{
      await this.context(c,input.tenantId,input.deviceId);
      const target=(await c.query<{node_id:string}>(`SELECT e.node_id FROM vpn_environments e JOIN provider_nodes n ON n.id=e.node_id AND n.status='approved' JOIN subscriptions s ON s.tenant_id=e.tenant_id JOIN plans p ON p.id=s.plan_id LEFT JOIN subscription_modules m ON m.tenant_id=s.tenant_id AND m.module='vpn' AND (m.valid_from IS NULL OR m.valid_from<=now()) AND (m.valid_until IS NULL OR m.valid_until>now()) WHERE e.id=$1 AND e.tenant_id=$2 AND e.desired_state='active' AND e.observed_state='active' AND e.applied_revision=e.revision AND s.state IN ('active','grace') AND (s.valid_from IS NULL OR s.valid_from<=now()) AND (s.valid_until IS NULL OR s.valid_until>now()) AND coalesce((p.modules->>'vpn')::boolean,false)=true AND coalesce(m.state,'active')='active'`,[input.environmentId,input.tenantId])).rows[0];
      if(!target)throw Error('environment_unavailable');
      const hash=createHash('sha256').update(input.csrPem).digest();
      const current=await this.active(c,input.tenantId,input.deviceId,input.environmentId);
      if(current){if(!current.csr_sha256.equals(hash))throw Error('credential_conflict');return this.view(current);}
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[target.node_id]);
      // Re-check after the per-node lock: two simultaneous first/reissue
      // requests must not both try to create an active row.
      const concurrent=await this.active(c,input.tenantId,input.deviceId,input.environmentId);
      if(concurrent){if(!concurrent.csr_sha256.equals(hash))throw Error('credential_conflict');return this.view(concurrent);}
      const id=randomUUID(),operationId=randomUUID(),latest=Number((await c.query<{r:string}>('SELECT nexo_node_latest_revision($1) AS r',[target.node_id])).rows[0]!.r)+1;
      const args={request_id:id,environment_id:input.environmentId,tenant_id:input.tenantId,device_id:input.deviceId,csr_pem:input.csrPem};
      try{await c.query(`INSERT INTO node_operations(id,target_node_id,type,arguments,idempotency_key,expires_at,requested_device_id,revision) VALUES($1,$2,'vpn.client_certificate.issue.v1',$3,$4,to_timestamp($5/1000.0),$6,$7)`,[operationId,target.node_id,args,input.idempotencyKey,input.expiresAt,input.deviceId,latest]);}catch(error){if(error instanceof Error&&String((error as {code?:string}).code)==='23505')throw Error('idempotency_conflict');throw error;}
      await c.query('INSERT INTO node_operation_outbox(operation_id) VALUES($1)',[operationId]);
      const row=(await c.query<Row>('INSERT INTO vpn_client_credentials(id,tenant_id,device_id,environment_id,issue_operation_id,csr_sha256) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,input.tenantId,input.deviceId,input.environmentId,operationId,hash])).rows[0]!;
      return this.view(row);
    });
  }

  async get(tenantId:string,deviceId:string,environmentId:string){return this.tx(async c=>{await this.context(c,tenantId,deviceId);const row=(await c.query<Row>(`SELECT * FROM vpn_client_credentials WHERE tenant_id=$1 AND device_id=$2 AND environment_id=$3 ORDER BY CASE WHEN state IN ('pending','issued','revocation_pending') THEN 0 ELSE 1 END,created_at DESC,id DESC LIMIT 1`,[tenantId,deviceId,environmentId])).rows[0];return row?this.view(row):undefined;});}

  async revoke(input:{tenantId:string;deviceId:string;environmentId:string;serial:string;idempotencyKey:string;expiresAt:number}){
    return this.tx(async c=>{
      await this.context(c,input.tenantId,input.deviceId);
      const row=(await c.query<Row&{node_id:string}>(`SELECT cr.*,e.node_id FROM vpn_client_credentials cr JOIN vpn_environments e ON e.id=cr.environment_id AND e.tenant_id=cr.tenant_id WHERE cr.tenant_id=$1 AND cr.device_id=$2 AND cr.environment_id=$3 AND cr.serial=$4 FOR UPDATE OF cr`,[input.tenantId,input.deviceId,input.environmentId,input.serial])).rows[0];
      if(!row||!['issued','revocation_pending','revoked'].includes(row.state))return undefined;
      if(row.state!=='issued')return this.view(row);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[row.node_id]);
      const operationId=randomUUID(),latest=Number((await c.query<{r:string}>('SELECT nexo_node_latest_revision($1) AS r',[row.node_id])).rows[0]!.r)+1,args={request_id:row.id,environment_id:row.environment_id,tenant_id:input.tenantId,device_id:input.deviceId,serial:input.serial};
      try{await c.query(`INSERT INTO node_operations(id,target_node_id,type,arguments,idempotency_key,expires_at,requested_device_id,revision) VALUES($1,$2,'vpn.client_certificate.revoke.v1',$3,$4,to_timestamp($5/1000.0),$6,$7)`,[operationId,row.node_id,args,input.idempotencyKey,input.expiresAt,input.deviceId,latest]);}catch(error){if(error instanceof Error&&String((error as {code?:string}).code)==='23505')throw Error('idempotency_conflict');throw error;}
      await c.query('INSERT INTO node_operation_outbox(operation_id) VALUES($1)',[operationId]);
      const updated=(await c.query<Row>("UPDATE vpn_client_credentials SET state='revocation_pending',revoke_operation_id=$2,updated_at=now() WHERE id=$1 RETURNING *",[row.id,operationId])).rows[0]!;
      return this.view(updated);
    });
  }

  async revokeAllForDevice(tenantId:string,deviceId:string,expiresAt:number){return this.tx(async c=>{
    await this.context(c,tenantId,deviceId);
    const rows=(await c.query<Row&{node_id:string}>(`SELECT cr.*,e.node_id FROM vpn_client_credentials cr JOIN vpn_environments e ON e.id=cr.environment_id AND e.tenant_id=cr.tenant_id WHERE cr.tenant_id=$1 AND cr.device_id=$2 AND cr.state='issued' FOR UPDATE OF cr`,[tenantId,deviceId])).rows;
    for(const row of rows){
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[row.node_id]);
      const operationId=randomUUID(),revision=Number((await c.query<{r:string}>('SELECT nexo_node_latest_revision($1) AS r',[row.node_id])).rows[0]!.r)+1,args={request_id:row.id,environment_id:row.environment_id,tenant_id:tenantId,device_id:deviceId,serial:row.serial};
      await c.query(`INSERT INTO node_operations(id,target_node_id,type,arguments,idempotency_key,expires_at,requested_device_id,revision) VALUES($1,$2,'vpn.client_certificate.revoke.v1',$3,$4,to_timestamp($5/1000.0),$6,$7)`,[operationId,row.node_id,args,`device-revoke-${row.id}`,expiresAt,deviceId,revision]);
      await c.query('INSERT INTO node_operation_outbox(operation_id) VALUES($1)',[operationId]);
      await c.query("UPDATE vpn_client_credentials SET state='revocation_pending',revoke_operation_id=$2,updated_at=now() WHERE id=$1",[row.id,operationId]);
    }
    return rows.length;
  });}

  async complete(operation:NodeOperation,status:'succeeded'|'failed',result:Record<string,unknown>){return this.tx(async c=>{
    await c.query('SELECT set_config($1,$2,true)',['app.node_id',operation.targetNodeId]);
    const row=(await c.query<Row>(`SELECT cr.* FROM vpn_client_credentials cr WHERE cr.issue_operation_id=$1 OR cr.revoke_operation_id=$1 FOR UPDATE`,[operation.id])).rows[0];if(!row)return false;
    if(status==='failed'){await c.query("UPDATE vpn_client_credentials SET state=$2,error_code=$3,updated_at=now() WHERE id=$1",[row.id,operation.type==='vpn.client_certificate.revoke.v1'?'issued':'failed',String(result.code)]);return true;}
    if(operation.type==='vpn.client_certificate.issue.v1'){await c.query("UPDATE vpn_client_credentials SET state='issued',serial=$2,certificate_pem=$3,ca_certificate_pem=$4,tls_crypt_key_envelope=$5,not_before=$6,not_after=$7,error_code=NULL,updated_at=now() WHERE id=$1 AND state='pending'",[row.id,result.serial,result.certificate_pem,result.ca_certificate_pem,result.tls_crypt_key_envelope,result.not_before,result.not_after]);return true;}
    if(operation.type==='vpn.client_certificate.revoke.v1'){await c.query("UPDATE vpn_client_credentials SET state='revoked',revoked_at=now(),error_code=NULL,updated_at=now() WHERE id=$1 AND state='revocation_pending'",[row.id]);return true;}
    return false;
  });}

  private async active(c:PoolClient,tenantId:string,deviceId:string,environmentId:string){return (await c.query<Row>("SELECT * FROM vpn_client_credentials WHERE tenant_id=$1 AND device_id=$2 AND environment_id=$3 AND state IN ('pending','issued','revocation_pending') ORDER BY created_at DESC,id DESC FOR UPDATE",[tenantId,deviceId,environmentId])).rows[0];}
  private async context(c:PoolClient,tenantId:string,deviceId:string){await c.query('SELECT set_config($1,$2,true)',['app.tenant_id',tenantId]);await c.query('SELECT set_config($1,$2,true)',['app.device_id',deviceId]);}
  private view(row:Row):VpnCredentialView{return{id:row.id,environmentId:row.environment_id,state:row.state,...(row.serial?{serial:row.serial}:{}),...(row.certificate_pem?{certificatePem:row.certificate_pem}:{}),...(row.ca_certificate_pem?{caCertificatePem:row.ca_certificate_pem}:{}),...(row.state==='issued'&&row.tls_crypt_key_envelope?{tlsCryptKeyEnvelope:row.tls_crypt_key_envelope}:{}),...(row.not_before?{notBefore:new Date(row.not_before).toISOString()}:{}),...(row.not_after?{notAfter:new Date(row.not_after).toISOString()}:{}),...(row.error_code?{errorCode:row.error_code}:{})};}
  private async tx<T>(f:(c:PoolClient)=>Promise<T>){const c=await this.pool.connect();try{await c.query('BEGIN');const value=await f(c);await c.query('COMMIT');return value;}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
}

interface Row{id:string;environment_id:string;state:VpnCredentialState;serial:string|null;certificate_pem:string|null;ca_certificate_pem:string|null;tls_crypt_key_envelope:string|null;not_before:string|null;not_after:string|null;error_code:string|null;csr_sha256:Buffer}
