import { Pool, type PoolClient } from 'pg';
import { openSecret } from './security.js';
import type { IdentityRepository, MembershipView, SessionView, UserIdentity } from './repository.js';

interface UserRow { id: string; email: string; password_hash: string; status: UserIdentity['status']; mfa_required: boolean }
interface MembershipRow { tenant_id: string; display_name: string; roles: string[] | null }

export class PostgresIdentityRepository implements IdentityRepository {
  private readonly key: Buffer;
  constructor(private readonly pool: Pool, key: Uint8Array) { if (key.length !== 32) throw new Error('L02 secret key must be 32 bytes'); this.key = Buffer.from(key); }

  async findUserByEmail(email: string): Promise<UserIdentity | undefined> {
    return this.transaction(async client => {
      await this.context(client, 'app.auth_email', email.toLowerCase());
      const row = (await client.query<UserRow>('SELECT id,email,password_hash,status,mfa_required FROM users WHERE email=$1', [email.toLowerCase()])).rows[0];
      if (!row) return undefined;
      await this.context(client, 'app.user_id', row.id);
      return this.hydrate(client, row);
    });
  }

  async findUserById(userId: string, tenantId?: string): Promise<UserIdentity | undefined> {
    return this.transaction(async client => {
      await this.context(client, 'app.user_id', userId); if (tenantId) await this.context(client, 'app.tenant_id', tenantId);
      const row = (await client.query<UserRow>('SELECT id,email,password_hash,status,mfa_required FROM users WHERE id=$1', [userId])).rows[0];
      return row ? this.hydrate(client, row) : undefined;
    });
  }

  async createSession(session: SessionView): Promise<void> {
    await this.transaction(async client => { if (await this.quarantined(client)) throw new Error('control_quarantined'); if (session.tenantId) await this.context(client, 'app.tenant_id', session.tenantId); await this.context(client, 'app.user_id', session.userId); await client.query('INSERT INTO sessions(tenant_id,user_id,token_hash,expires_at,scope_kind) VALUES($1,$2,$3,to_timestamp($4/1000.0),$5)', [session.tenantId ?? null, session.userId, Buffer.from(session.tokenHash, 'hex'), session.expiresAt, session.scopeKind ?? 'tenant']); });
  }

  async findSession(tokenHash: string): Promise<SessionView | undefined> {
    return this.transaction(async client => {
      if (await this.quarantined(client)) return undefined;
      await this.context(client, 'app.session_hash', tokenHash);
      const row = (await client.query<{ user_id: string; tenant_id: string | null; scope_kind: 'tenant' | 'provider'; expires_at_ms: string; revoked_at_ms: string | null }>('SELECT user_id,tenant_id,scope_kind,extract(epoch from expires_at)*1000 AS expires_at_ms,extract(epoch from revoked_at)*1000 AS revoked_at_ms FROM sessions WHERE token_hash=$1', [Buffer.from(tokenHash, 'hex')])).rows[0];
      return row ? { tokenHash, userId: row.user_id, scopeKind: row.scope_kind, ...(row.tenant_id ? { tenantId: row.tenant_id } : {}), expiresAt: Number(row.expires_at_ms), ...(row.revoked_at_ms ? { revokedAt: Number(row.revoked_at_ms) } : {}) } : undefined;
    });
  }

  private async quarantined(client: PoolClient): Promise<boolean> { const present=(await client.query<{present:boolean}>("SELECT to_regclass('public.control_security_state') IS NOT NULL present")).rows[0]?.present;return present?Boolean((await client.query<{quarantined:boolean}>('SELECT quarantined FROM control_security_state WHERE singleton=true')).rows[0]?.quarantined):false; }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.transaction(async client => { await this.context(client, 'app.session_hash', tokenHash); await client.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [Buffer.from(tokenHash, 'hex')]); });
  }

  async createRecoveryToken(userId: string, tokenHash: string, expiresAt: number): Promise<void> {
    await this.transaction(async client => { await this.context(client, 'app.user_id', userId); await client.query('INSERT INTO recovery_tokens(user_id,token_hash,expires_at) VALUES($1,$2,to_timestamp($3/1000.0))', [userId, Buffer.from(tokenHash, 'hex'), expiresAt]); });
  }

  async recoverPassword(tokenHash: string, passwordHash: string): Promise<boolean> {
    return this.transaction(async client => {
      await this.context(client, 'app.recovery_hash', tokenHash);
      const token = (await client.query<{ id: string; user_id: string }>('SELECT id,user_id FROM recovery_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [Buffer.from(tokenHash, 'hex')])).rows[0];
      if (!token) return false;
      await this.context(client, 'app.user_id', token.user_id);
      await client.query('UPDATE recovery_tokens SET consumed_at=now() WHERE id=$1', [token.id]);
      await client.query('UPDATE users SET password_hash=$1,updated_at=now() WHERE id=$2', [passwordHash, token.user_id]);
      await client.query('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1', [token.user_id]);
      return true;
    });
  }

  async audit(event: { tenantId?: string; actorUserId?: string; action: string; resourceType: string; resourceId?: string }): Promise<void> {
    if (!event.tenantId) return;
    await this.transaction(async client => { await this.context(client, 'app.tenant_id', event.tenantId!); if (event.actorUserId) await this.context(client, 'app.user_id', event.actorUserId); await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id) VALUES($1,$2,$3,$4,$5)', [event.tenantId, event.actorUserId ?? null, event.action, event.resourceType, event.resourceId ?? null]); });
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async hydrate(client: PoolClient, row: UserRow): Promise<UserIdentity> {
    const memberships = (await client.query<MembershipRow>(`SELECT m.tenant_id,t.display_name,coalesce(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL),'{}') roles FROM memberships m JOIN tenants t ON t.id=m.tenant_id LEFT JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id LEFT JOIN roles r ON r.id=mr.role_id WHERE m.user_id=$1 AND m.status='active' GROUP BY m.tenant_id,t.display_name ORDER BY t.display_name`, [row.id])).rows;
    const factor = (await client.query<{ secret_ciphertext: Buffer }>("SELECT secret_ciphertext FROM mfa_factors WHERE user_id=$1 AND type='totp' AND enabled_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1", [row.id])).rows[0];
    const providerTable = (await client.query<{ present: boolean }>("SELECT to_regclass('public.provider_users') IS NOT NULL present")).rows[0]?.present;
    const providerRole = providerTable ? (await client.query<{ role: UserIdentity['providerRole'] }>("SELECT role FROM provider_users WHERE user_id=$1 AND status='active'", [row.id])).rows[0]?.role : undefined;
    return { id: row.id, email: row.email, passwordHash: row.password_hash, status: row.status, mfaRequired: row.mfa_required, totpSecret: factor ? openSecret(factor.secret_ciphertext, this.key) : '', memberships: memberships.map((m): MembershipView => ({ tenantId: m.tenant_id, tenantName: m.display_name, roles: m.roles ?? [] })), ...(providerRole ? { providerRole } : {}) };
  }

  private async context(client: PoolClient, name: string, value: string): Promise<void> { await client.query('SELECT set_config($1,$2,true)', [name, value]); }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
}
