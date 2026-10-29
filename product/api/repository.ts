export interface MembershipView { tenantId: string; tenantName: string; roles: string[] }
export interface UserIdentity { id: string; email: string; passwordHash: string; status: 'active' | 'locked' | 'disabled'; mfaRequired: boolean; totpSecret: string; memberships: MembershipView[]; providerRole?: 'owner' | 'operator' | 'auditor' }
export interface SessionView { tokenHash: string; userId: string; scopeKind?: 'tenant' | 'provider'; tenantId?: string; expiresAt: number; revokedAt?: number }

export interface IdentityRepository {
  findUserByEmail(email: string): Promise<UserIdentity | undefined>;
  findUserById(userId: string, tenantId?: string): Promise<UserIdentity | undefined>;
  createSession(session: SessionView): Promise<void>;
  findSession(tokenHash: string): Promise<SessionView | undefined>;
  revokeSession(tokenHash: string): Promise<void>;
  createRecoveryToken(userId: string, tokenHash: string, expiresAt: number): Promise<void>;
  recoverPassword(tokenHash: string, passwordHash: string): Promise<boolean>;
  audit(event: { tenantId?: string; actorUserId?: string; action: string; resourceType: string; resourceId?: string }): Promise<void>;
}

export class MemoryIdentityRepository implements IdentityRepository {
  private readonly sessions = new Map<string, SessionView>();
  private readonly recovery = new Map<string, { userId: string; expiresAt: number; consumed: boolean }>();
  readonly events: Array<{ tenantId?: string; actorUserId?: string; action: string; resourceType: string; resourceId?: string }> = [];
  constructor(private readonly users: UserIdentity[]) {}
  async findUserByEmail(email: string): Promise<UserIdentity | undefined> { return this.users.find(user => user.email === email.toLowerCase()); }
  async findUserById(userId: string, _tenantId?: string): Promise<UserIdentity | undefined> { return this.users.find(user => user.id === userId); }
  async createSession(session: SessionView): Promise<void> { this.sessions.set(session.tokenHash, session); }
  async findSession(tokenHash: string): Promise<SessionView | undefined> { return this.sessions.get(tokenHash); }
  async revokeSession(tokenHash: string): Promise<void> { const session = this.sessions.get(tokenHash); if (session) session.revokedAt = Date.now(); }
  async createRecoveryToken(userId: string, tokenHash: string, expiresAt: number): Promise<void> { this.recovery.set(tokenHash, { userId, expiresAt, consumed: false }); }
  async recoverPassword(tokenHash: string, passwordHash: string): Promise<boolean> { const token = this.recovery.get(tokenHash); if (!token || token.consumed || token.expiresAt <= Date.now()) return false; const user = this.users.find(item => item.id === token.userId); if (!user) return false; token.consumed = true; user.passwordHash = passwordHash; for (const session of this.sessions.values()) if (session.userId === user.id) session.revokedAt = Date.now(); return true; }
  async audit(event: { tenantId?: string; actorUserId?: string; action: string; resourceType: string; resourceId?: string }): Promise<void> { this.events.push(event); }
}
