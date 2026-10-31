import type { Pool, PoolClient } from 'pg';
import type { OperationListOptions, OperationPage, OperationRepository, OperationView } from './operation-repository.js';

export class PostgresOperationRepository implements OperationRepository {
  constructor(private readonly pool: Pool) {}

  async create(tenantId: string, input: { targetDeviceId: string; type: 'endpoint.runtime_info.v1'; idempotencyKey: string; expiresAt: number; revision?: number }, actor: string): Promise<OperationView> {
    return this.tx(async client => {
      await this.ctx(client, 'app.tenant_id', tenantId);
      await this.ctx(client, 'app.user_id', actor);
      const target = await client.query("SELECT id FROM device_identities WHERE tenant_id=$1 AND id=$2 AND status='approved' FOR UPDATE", [tenantId, input.targetDeviceId]);
      if (!target.rowCount) throw new Error('invalid_target');
      const existing = (await client.query<{ id: string; target_device_id: string; revision: string }>('SELECT id,target_device_id,revision FROM operations WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, input.idempotencyKey])).rows[0];
      if (existing) {
        if (existing.target_device_id !== input.targetDeviceId || input.revision !== undefined && Number(existing.revision) !== input.revision) throw new Error('idempotency_conflict');
        return (await this.listWith(client, tenantId, existing.id))[0]!;
      }
      const latest = Number((await client.query<{ revision: string }>('SELECT revision FROM operations WHERE target_device_id=$1 ORDER BY revision DESC LIMIT 1', [input.targetDeviceId])).rows[0]?.revision ?? 0);
      const revision = input.revision ?? latest + 1;
      if (revision <= latest) throw new Error('stale_revision');
      const row = (await client.query<{ id: string }>('INSERT INTO operations(tenant_id,target_device_id,type,idempotency_key,expires_at,created_by,revision) VALUES($1,$2,$3,$4,to_timestamp($5/1000.0),$6,$7) RETURNING id', [tenantId, input.targetDeviceId, input.type, input.idempotencyKey, input.expiresAt, actor, revision])).rows[0]!;
      await client.query('INSERT INTO operation_outbox(tenant_id,operation_id) VALUES($1,$2)', [tenantId, row.id]);
      await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,$4,$5,$6)', [tenantId, actor, 'operation.created', 'operation', row.id, { revision }]);
      return (await this.listWith(client, tenantId, row.id))[0]!;
    });
  }

  async list(tenantId: string, options:OperationListOptions): Promise<OperationPage> { return this.tx(async client => { await this.ctx(client, 'app.tenant_id', tenantId);const filters=[tenantId,options.status??null,options.targetDeviceId??null,options.from??null,options.until??null,options.targetDeviceIds??null],where='o.tenant_id=$1 AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.target_device_id::text=$3) AND ($4::timestamptz IS NULL OR o.created_at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR o.created_at < $5::timestamptz) AND ($6::uuid[] IS NULL OR o.target_device_id=ANY($6::uuid[]))',total=Number((await client.query<{count:string}>(`SELECT count(*)::text count FROM operations o WHERE ${where}`,filters)).rows[0]?.count??0);const items=await this.listWith(client,tenantId,undefined,options);return{items,total}; }); }
  async dispatch(worker: string, limit: number): Promise<number> {
    return this.tx(async client => {
      await this.ctx(client, 'app.worker_role', 'operation_dispatch');
      const rows = (await client.query<{ id: string; operation_id: string }>("SELECT id,operation_id FROM operation_outbox WHERE delivered_at IS NULL AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1", [limit])).rows;
      for (const row of rows) {
        await client.query("UPDATE operation_outbox SET attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '30 seconds' WHERE id=$1", [row.id, worker]);
        await client.query("UPDATE operations SET status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'ready' END WHERE id=$1 AND status='queued'", [row.operation_id]);
        await client.query('UPDATE operation_outbox SET delivered_at=now(),lease_until=NULL WHERE id=$1', [row.id]);
      }
      return rows.length;
    });
  }
  async reconcile(limit: number): Promise<{ expired: number; repaired: number }> {
    return this.tx(async client => {
      await this.ctx(client, 'app.worker_role', 'operation_dispatch');
      const expired = await client.query("WITH candidates AS (SELECT id FROM operations WHERE status IN ('queued','ready') AND expires_at<=now() ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE operations o SET status='expired',completed_at=now() FROM candidates c WHERE o.id=c.id", [limit]);
      const repaired = await client.query("WITH candidates AS (SELECT o.id,o.tenant_id FROM operations o LEFT JOIN operation_outbox x ON x.operation_id=o.id WHERE o.status='queued' AND x.id IS NULL ORDER BY o.created_at LIMIT $1) INSERT INTO operation_outbox(tenant_id,operation_id) SELECT tenant_id,id FROM candidates ON CONFLICT(operation_id) DO NOTHING", [limit]);
      return { expired: expired.rowCount ?? 0, repaired: repaired.rowCount ?? 0 };
    });
  }
  async next(deviceId: string): Promise<OperationView | undefined> {
    return this.tx(async client => {
      await this.ctx(client, 'app.device_id', deviceId);
      await client.query("UPDATE operations SET status='expired',completed_at=now() WHERE target_device_id=$1 AND status='ready' AND expires_at<=now()", [deviceId]);
      const row = (await client.query<{ id: string; target_device_id: string; type: 'endpoint.runtime_info.v1'; status: string; revision: string; expires_at: string; attempts: number }>("SELECT o.id,o.target_device_id,o.type,o.status,o.revision,o.expires_at,x.attempts FROM operations o JOIN operation_outbox x ON x.operation_id=o.id WHERE o.target_device_id=$1 AND o.status='ready' AND o.expires_at>now() ORDER BY o.revision LIMIT 1", [deviceId])).rows[0];
      return row ? this.map(row) : undefined;
    });
  }
  async complete(deviceId: string, id: string, input: { status: 'succeeded' | 'failed'; result: Record<string, unknown>; observedAt: string; revision?: number }): Promise<boolean> {
    return this.tx(async client => {
      await this.ctx(client, 'app.device_id', deviceId);
      const operation = (await client.query<{ tenant_id: string; status: string; revision: string }>('SELECT tenant_id,status,revision FROM operations WHERE id=$1 AND target_device_id=$2 FOR UPDATE', [id, deviceId])).rows[0];
      if (!operation || operation.status === 'expired' || input.revision !== undefined && Number(operation.revision) !== input.revision) return false;
      await this.ctx(client, 'app.tenant_id', operation.tenant_id);
      if (operation.status === 'succeeded' || operation.status === 'failed') {
        const stored = (await client.query<{ same_result: boolean; same_observed: boolean }>('SELECT result=$2::jsonb AS same_result,observed_at=$3::timestamptz AS same_observed FROM operation_results WHERE operation_id=$1', [id, input.result, input.observedAt])).rows[0];
        if (!stored) return false;
        return operation.status === input.status && stored.same_result && stored.same_observed;
      }
      if (operation.status !== 'ready') return false;
      await client.query('INSERT INTO operation_results(operation_id,tenant_id,device_id,result,observed_at) VALUES($1,$2,$3,$4,$5)', [id, operation.tenant_id, deviceId, input.result, input.observedAt]);
      await client.query('UPDATE operations SET status=$2,completed_at=now() WHERE id=$1', [id, input.status]);
      await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,NULL,$2,$3,$4,$5)',[operation.tenant_id,'operation.completed','operation',id,{actor_kind:'device',actor_id:deviceId,status:input.status,revision:Number(operation.revision)}]);
      return true;
    });
  }
  async heartbeat(deviceId: string, input: { observedAt: string; agentVersion: string }): Promise<boolean> {
    return this.tx(async client => {
      await this.ctx(client, 'app.device_id', deviceId);
      const device = (await client.query<{ tenant_id: string }>("SELECT tenant_id FROM device_identities WHERE id=$1 AND status='approved'", [deviceId])).rows[0];
      if (!device) return false;
      await this.ctx(client, 'app.tenant_id', device.tenant_id);
      const changed=await client.query('INSERT INTO device_heartbeats(device_id,tenant_id,observed_at,agent_version) VALUES($1,$2,$3,$4) ON CONFLICT(device_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=now(),agent_version=excluded.agent_version WHERE device_heartbeats.observed_at IS DISTINCT FROM excluded.observed_at OR device_heartbeats.agent_version IS DISTINCT FROM excluded.agent_version RETURNING device_id', [deviceId, device.tenant_id, input.observedAt, input.agentVersion]);
      if(changed.rowCount)await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,NULL,$2,$3,$4,$5)',[device.tenant_id,'device.heartbeat.received','device',deviceId,{actor_kind:'device',actor_id:deviceId,observed_at:input.observedAt,agent_version:input.agentVersion}]);
      return true;
    });
  }
  async heartbeats(tenantId: string,options:{limit:number;offset:number;deviceIds?:string[]}) {
    return this.tx(async client => {
      await this.ctx(client, 'app.tenant_id', tenantId);
      const filters=[tenantId,options.deviceIds??null],where='tenant_id=$1 AND ($2::uuid[] IS NULL OR device_id=ANY($2::uuid[]))',total=Number((await client.query<{count:string}>(`SELECT count(*)::text count FROM device_heartbeats WHERE ${where}`,filters)).rows[0]?.count??0),rows=(await client.query<{device_id:string;observed_at:string;received_at:string;agent_version:string}>(`SELECT device_id,observed_at,received_at,agent_version FROM device_heartbeats WHERE ${where} ORDER BY received_at DESC,device_id LIMIT $3 OFFSET $4`,[...filters,options.limit,options.offset])).rows;
      return{items:rows.map(value=>({deviceId:value.device_id,observedAt:new Date(value.observed_at).toISOString(),receivedAt:new Date(value.received_at).toISOString(),agentVersion:value.agent_version})),total};
    });
  }
  private async listWith(client: PoolClient, tenantId: string, id?: string, options?:OperationListOptions): Promise<OperationView[]> {
    const rows = (await client.query<{ id: string; target_device_id: string; type: 'endpoint.runtime_info.v1'; status: string; revision: string; expires_at: string; created_at:string; attempts: number; result: Record<string, unknown> | null; observed_at: string | null }>('SELECT o.id,o.target_device_id,o.type,o.status,o.revision,o.expires_at,o.created_at,x.attempts,r.result,r.observed_at FROM operations o JOIN operation_outbox x ON x.operation_id=o.id LEFT JOIN operation_results r ON r.operation_id=o.id WHERE o.tenant_id=$1 AND ($2::uuid IS NULL OR o.id=$2) AND ($3::text IS NULL OR o.status=$3) AND ($4::text IS NULL OR o.target_device_id::text=$4) AND ($5::timestamptz IS NULL OR o.created_at >= $5::timestamptz) AND ($6::timestamptz IS NULL OR o.created_at < $6::timestamptz) AND ($7::uuid[] IS NULL OR o.target_device_id=ANY($7::uuid[])) ORDER BY o.created_at DESC,o.id DESC LIMIT $8 OFFSET $9', [tenantId, id ?? null,options?.status??null,options?.targetDeviceId??null,options?.from??null,options?.until??null,options?.targetDeviceIds??null,options?.limit??100,options?.offset??0])).rows;
    return rows.map(this.map);
  }
  private map = (row: { id: string; target_device_id: string; type: 'endpoint.runtime_info.v1'; status: string; revision: string; expires_at: string; created_at?:string; attempts?: number; result?: Record<string, unknown> | null; observed_at?: string | null }): OperationView => ({ id: row.id, targetDeviceId: row.target_device_id, type: row.type, arguments: {}, status: row.status, revision: Number(row.revision), expiresAt: new Date(row.expires_at).toISOString(),...(row.created_at?{createdAt:new Date(row.created_at).toISOString()}:{}), deliveryAttempts: row.attempts ?? 0, ...(row.result ? { result: row.result } : {}), ...(row.observed_at ? { observedAt: new Date(row.observed_at).toISOString() } : {}), ...(row.status === 'failed' && typeof row.result?.code === 'string' ? { errorCode: row.result.code } : {}) });
  private async ctx(client: PoolClient, key: string, value: string): Promise<void> { await client.query('SELECT set_config($1,$2,true)', [key, value]); }
  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> { const client = await this.pool.connect(); try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); } }
}
