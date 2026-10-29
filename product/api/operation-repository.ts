export interface OperationView {
  id: string;
  targetDeviceId: string;
  type: 'endpoint.runtime_info.v1';
  arguments: Record<string, never>;
  status: string;
  revision: number;
  expiresAt: string;
  createdAt?: string;
  deliveryAttempts: number;
  result?: Record<string, unknown>;
  observedAt?: string;
  errorCode?: string;
}

export interface OperationPage { items: OperationView[]; total: number }
export interface OperationListOptions { limit: number; offset: number; status?: string; targetDeviceId?: string; from?: string; until?: string }
export interface HeartbeatRecord { deviceId: string; observedAt: string; receivedAt: string; agentVersion: string }
export interface HeartbeatPage { items: HeartbeatRecord[]; total: number }

export interface OperationRepository {
  create(tenantId: string, input: { targetDeviceId: string; type: 'endpoint.runtime_info.v1'; idempotencyKey: string; expiresAt: number; revision?: number }, actor: string): Promise<OperationView>;
  list(tenantId: string, options: OperationListOptions): Promise<OperationPage>;
  dispatch(worker: string, limit: number): Promise<number>;
  reconcile(limit: number): Promise<{ expired: number; repaired: number }>;
  next(deviceId: string): Promise<OperationView | undefined>;
  complete(deviceId: string, id: string, input: { status: 'succeeded' | 'failed'; result: Record<string, unknown>; observedAt: string; revision?: number }): Promise<boolean>;
  heartbeat(deviceId: string, input: { observedAt: string; agentVersion: string }): Promise<boolean>;
  heartbeats(tenantId: string, options: { limit: number; offset: number }): Promise<HeartbeatPage>;
}

export class MemoryOperationRepository implements OperationRepository {
  private readonly items: OperationView[] = [];
  private readonly tenants = new Map<string, string>();
  private readonly keys = new Map<string, string>();
  private readonly beats = new Map<string, { observedAt: string; receivedAt: string; agentVersion: string }>();

  async create(tenantId: string, input: { targetDeviceId: string; type: 'endpoint.runtime_info.v1'; idempotencyKey: string; expiresAt: number; revision?: number }): Promise<OperationView> {
    const key = `${tenantId}:${input.idempotencyKey}`;
    const existingId = this.keys.get(key);
    if (existingId) {
      const existing = this.items.find(item => item.id === existingId)!;
      if (existing.targetDeviceId !== input.targetDeviceId || input.revision !== undefined && existing.revision !== input.revision) throw new Error('idempotency_conflict');
      return existing;
    }
    const latest = this.items.filter(item => item.targetDeviceId === input.targetDeviceId).reduce((value, item) => Math.max(value, item.revision), 0);
    const revision = input.revision ?? latest + 1;
    if (revision <= latest) throw new Error('stale_revision');
    const item: OperationView = { id: crypto.randomUUID(), targetDeviceId: input.targetDeviceId, type: input.type, arguments: {}, status: 'queued', revision, expiresAt: new Date(input.expiresAt).toISOString(), createdAt:new Date().toISOString(), deliveryAttempts: 0 };
    this.items.push(item);
    this.tenants.set(item.id, tenantId);
    this.keys.set(key, item.id);
    return item;
  }

  async list(tenantId: string, options: OperationListOptions): Promise<OperationPage> {
    const filtered=this.items.filter(item=>this.tenants.get(item.id)===tenantId&&(!options.status||item.status===options.status)&&(!options.targetDeviceId||item.targetDeviceId===options.targetDeviceId)&&(!options.from||Date.parse(item.createdAt??item.expiresAt)>=Date.parse(options.from))&&(!options.until||Date.parse(item.createdAt??item.expiresAt)<Date.parse(options.until))).sort((a,b)=>(b.createdAt??b.expiresAt).localeCompare(a.createdAt??a.expiresAt)||b.id.localeCompare(a.id));
    return{items:filtered.slice(options.offset,options.offset+options.limit),total:filtered.length};
  }
  async dispatch(_worker: string, limit: number): Promise<number> {
    let count = 0;
    for (const item of this.items) if (item.status === 'queued' && count < limit) {
      item.deliveryAttempts += 1;
      item.status = Date.parse(item.expiresAt) > Date.now() ? 'ready' : 'expired';
      count += 1;
    }
    return count;
  }
  async reconcile(limit: number): Promise<{ expired: number; repaired: number }> {
    let expired = 0;
    for (const item of this.items) if (expired < limit && ['queued', 'ready'].includes(item.status) && Date.parse(item.expiresAt) <= Date.now()) { item.status = 'expired'; expired += 1; }
    return { expired, repaired: 0 };
  }
  async next(deviceId: string): Promise<OperationView | undefined> {
    await this.reconcile(Number.MAX_SAFE_INTEGER);
    return this.items.find(item => item.targetDeviceId === deviceId && item.status === 'ready');
  }
  async complete(deviceId: string, id: string, input: { status: 'succeeded' | 'failed'; result: Record<string, unknown>; observedAt: string; revision?: number }): Promise<boolean> {
    const item = this.items.find(value => value.id === id && value.targetDeviceId === deviceId);
    if (!item || item.status === 'expired' || input.revision !== undefined && input.revision !== item.revision) return false;
    if (['succeeded', 'failed'].includes(item.status)) return item.status === input.status && item.observedAt === input.observedAt && JSON.stringify(item.result) === JSON.stringify(input.result);
    if (item.status !== 'ready') return false;
    item.status = input.status;
    item.result = structuredClone(input.result);
    item.observedAt = input.observedAt;
    if (input.status === 'failed') item.errorCode = String(input.result.code);
    return true;
  }
  async heartbeat(deviceId: string, input: { observedAt: string; agentVersion: string }): Promise<boolean> {
    if (!this.items.some(item => item.targetDeviceId === deviceId)) return false;
    this.beats.set(deviceId, { ...input, receivedAt: new Date().toISOString() });
    return true;
  }
  async heartbeats(tenantId: string, options: { limit: number; offset: number }) {
    const filtered=[...this.beats].filter(([id])=>this.items.some(item=>item.targetDeviceId===id&&this.tenants.get(item.id)===tenantId)).map(([deviceId,value])=>({deviceId,...value})).sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||a.deviceId.localeCompare(b.deviceId));
    return{items:filtered.slice(options.offset,options.offset+options.limit),total:filtered.length};
  }
}
