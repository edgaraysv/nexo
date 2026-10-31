import { createHash, randomBytes } from 'node:crypto';
import { SupportTransport, SupportTransportError, withSupportTransportDeadline } from './support-transport.js';

export const SUPPORT_CAPABILITIES = ['screen', 'terminal', 'files', 'clipboard'] as const;
export type SupportCapability = typeof SUPPORT_CAPABILITIES[number];
export type SupportSessionStatus = 'pending_consent' | 'consented' | 'opening' | 'active' | 'open_failed' | 'opening_unknown' | 'rejected' | 'expired' | 'revoked' | 'closed';
export type SupportConsentStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
export type SupportDecisionOrigin = 'endpoint_api' | 'native_prompt' | 'timeout' | 'operator_revocation' | 'device_revocation' | 'migration_021' | 'legacy_api';
export type SupportTerminationStatus = 'not_required' | 'pending' | 'confirmed' | 'failed';

export const SUPPORT_CONSENT_TIMEOUT_MAX_SECONDS = 120;
export const SUPPORT_SESSION_TTL_SECONDS = 15 * 60;

export interface SupportConsentView {
  status: SupportConsentStatus;
  requestedAt: string;
  expiresAt: string;
  acceptedAt?: string;
  decidedAt?: string;
  decisionOrigin?: SupportDecisionOrigin;
  revision: number;
}

export interface SupportSessionView {
  id: string;
  tenantId: string;
  deviceId: string;
  requestedByUserId: string;
  mode: 'assisted';
  capabilities: SupportCapability[];
  status: SupportSessionStatus;
  requestedAt: string;
  consentExpiresAt: string;
  expiresAt: string;
  engineSessionId?: string;
  engineProvider?: string;
  openAttempts: number;
  terminationStatus: SupportTerminationStatus;
  revision: number;
  consent: SupportConsentView;
}

export interface PendingSupportSessionView extends SupportSessionView { consentNonce: string }
export type ConsentResponseResult = 'updated' | 'expired' | 'not_found' | 'already_decided' | 'invalid_nonce';
export type OpenSessionResult =
  | { status: 'opened' | 'opening' | 'open_failed' | 'opening_unknown'; session: SupportSessionView }
  | { status: 'not_found' }
  | { status: 'not_authorized' }
  | { status: 'transport_disabled' };

export function supportNonceHash(nonce: string): string {
  return createHash('sha256').update(nonce, 'utf8').digest('hex');
}

export function createSupportNonce(): string { return randomBytes(32).toString('base64url'); }

export interface SupportRepository {
  createRequest(input: {
    tenantId: string;
    deviceId: string;
    requesterUserId: string;
    capabilities: SupportCapability[];
    consentTimeoutSeconds: number;
  }): Promise<SupportSessionView | undefined>;
  listPendingForDevice(input: { tenantId: string; deviceId: string }): Promise<PendingSupportSessionView[]>;
  getForRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined>;
  respondToConsent(input: {
    tenantId: string;
    deviceId: string;
    sessionId: string;
    decision: 'accepted' | 'rejected';
    nonce: string;
  }): Promise<ConsentResponseResult>;
  authorizeTransport(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined>;
  openSession(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<OpenSessionResult>;
  dispatchTerminationOutbox(workerId: string, limit: number): Promise<number>;
  revokeByRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<boolean>;
  revokeByDevice(input: { tenantId: string; deviceId: string; sessionId: string }): Promise<boolean>;
}

type StoredSession = SupportSessionView & { nonceHash?: string };

export class MemorySupportRepository implements SupportRepository {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly terminationQueue = new Set<string>();
  readonly attempts: Array<{ sessionId: string; number: number; operation: 'open' | 'terminate'; outcome: 'started' | 'succeeded' | 'failed' | 'unknown'; errorCode?: string }> = [];
  constructor(private readonly transport?: SupportTransport, options: { allowSyntheticTestTransport?: boolean } = {}) {
    if (transport?.kind === 'synthetic_test' && options.allowSyntheticTestTransport !== true) throw new Error('synthetic_support_transport_requires_test_opt_in');
  }

  async createRequest(input: {
    tenantId: string;
    deviceId: string;
    requesterUserId: string;
    capabilities: SupportCapability[];
    consentTimeoutSeconds: number;
  }): Promise<SupportSessionView> {
    const now = Date.now();
    const requestedAt = new Date(now).toISOString();
    const consentExpiresAt = new Date(now + input.consentTimeoutSeconds * 1000).toISOString();
    const expiresAt = new Date(now + SUPPORT_SESSION_TTL_SECONDS * 1000).toISOString();
    const session: StoredSession = {
      id: crypto.randomUUID(), tenantId: input.tenantId, deviceId: input.deviceId,
      requestedByUserId: input.requesterUserId, mode: 'assisted', capabilities: [...input.capabilities],
      status: 'pending_consent', requestedAt, consentExpiresAt, expiresAt, revision: 1,
      openAttempts: 0, terminationStatus: 'not_required',
      nonceHash: supportNonceHash(createSupportNonce()),
      consent: { status: 'pending', requestedAt, expiresAt: consentExpiresAt, revision: 1 },
    };
    this.sessions.set(session.id, session);
    return structuredClone(session);
  }

  async listPendingForDevice(input: { tenantId: string; deviceId: string }): Promise<PendingSupportSessionView[]> {
    const now = Date.now();
    const rows = [...this.sessions.values()].filter(session => session.tenantId === input.tenantId && session.deviceId === input.deviceId);
    for (const session of rows) this.expire(session, now);
    return rows.filter(session => session.status === 'pending_consent').map(session => {
      const consentNonce = createSupportNonce();
      session.nonceHash = supportNonceHash(consentNonce);
      return { ...structuredClone(session), consentNonce };
    });
  }

  async getForRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.requestedByUserId !== input.requesterUserId) return undefined;
    this.expire(session, Date.now());
    return structuredClone(session);
  }

  async respondToConsent(input: {
    tenantId: string;
    deviceId: string;
    sessionId: string;
    decision: 'accepted' | 'rejected';
    nonce: string;
  }): Promise<ConsentResponseResult> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.deviceId !== input.deviceId) return 'not_found';
    this.expire(session, Date.now());
    if (session.status === 'rejected' && session.consent.decisionOrigin === 'timeout') return 'expired';
    if (session.status !== 'pending_consent' || session.consent.status !== 'pending') return 'already_decided';
    if (!session.nonceHash || supportNonceHash(input.nonce) !== session.nonceHash) return 'invalid_nonce';
    const decidedAt = new Date().toISOString();
    session.consent = { ...session.consent, status: input.decision, ...(input.decision === 'accepted' ? { acceptedAt: decidedAt } : {}), decidedAt, decisionOrigin: 'endpoint_api', revision: session.consent.revision + 1 };
    session.nonceHash = undefined;
    session.status = input.decision === 'accepted' ? 'consented' : 'rejected';
    session.revision += 1;
    return 'updated';
  }

  async authorizeTransport(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.requestedByUserId !== input.requesterUserId) return undefined;
    this.expire(session, Date.now());
    if (session.status !== 'consented' || session.consent.status !== 'accepted' || !session.consent.acceptedAt) return undefined;
    return structuredClone(session);
  }

  async openSession(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<OpenSessionResult> {
    if (!this.transport) return { status: 'transport_disabled' };
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.requestedByUserId !== input.requesterUserId) return { status: 'not_found' };
    this.expire(session, Date.now());
    if (session.status === 'active' && session.engineSessionId) return { status: 'opened', session: structuredClone(session) };
    if (session.status === 'opening') return { status: 'opening', session: structuredClone(session) };
    if (session.status === 'opening_unknown') return { status: 'opening_unknown', session: structuredClone(session) };
    if (session.status === 'open_failed') {
      if (!session.consent.acceptedAt || Date.parse(session.expiresAt) <= Date.now() || session.openAttempts >= 3) return { status: 'open_failed', session: structuredClone(session) };
    } else if (session.status !== 'consented' || session.consent.status !== 'accepted' || !session.consent.acceptedAt) {
      return { status: 'not_authorized' };
    }

    for (let attempt = session.openAttempts; attempt < 3; attempt += 1) {
      if (!['consented', 'open_failed'].includes(session.status) || Date.parse(session.expiresAt) <= Date.now()) break;
      session.status = 'opening';
      session.openAttempts += 1;
      session.revision += 1;
      this.attempts.push({ sessionId: session.id, number: session.openAttempts, operation: 'open', outcome: 'started' });
      try {
        const result = await withSupportTransportDeadline(signal => this.transport!.open({ sessionId: session.id, tenantId: session.tenantId, deviceId: session.deviceId, operatorId: session.requestedByUserId, capabilities: [...session.capabilities], expiresAt: session.expiresAt, idempotencyKey: session.id, signal }), 2_500);
        if (this.sessions.get(session.id)?.status !== 'opening') {
          session.engineSessionId = result.engineSessionId;
          session.engineProvider = this.transport.kind;
          session.terminationStatus = 'pending';
          this.finishAttempt(session.id, session.openAttempts, 'open', 'succeeded');
          await this.terminate(session);
          return { status: 'open_failed', session: structuredClone(session) };
        }
        session.engineSessionId = result.engineSessionId;
        session.engineProvider = this.transport.kind;
        session.status = 'active';
        session.revision += 1;
        this.finishAttempt(session.id, session.openAttempts, 'open', 'succeeded');
        return { status: 'opened', session: structuredClone(session) };
      } catch (error) {
        let outcome: 'not_opened' | 'unknown' = error instanceof SupportTransportError ? error.outcome : 'unknown';
        if (outcome === 'unknown') {
          try {
            const lookup = await withSupportTransportDeadline(signal => this.transport!.findByIdempotencyKey({ idempotencyKey: session.id, signal }), 1_500);
            if (lookup.status === 'opened') {
              session.engineSessionId = lookup.engineSessionId;
              session.engineProvider = this.transport.kind;
              if (this.sessions.get(session.id)?.status !== 'opening') {
                session.terminationStatus = 'pending';
                this.finishAttempt(session.id, session.openAttempts, 'open', 'succeeded');
                await this.terminate(session);
                return { status: 'open_failed', session: structuredClone(session) };
              }
              session.status = 'active';
              session.revision += 1;
              this.finishAttempt(session.id, session.openAttempts, 'open', 'succeeded');
              return { status: 'opened', session: structuredClone(session) };
            }
            if (lookup.status === 'pending') {
              if (session.status !== 'opening') {
                this.finishAttempt(session.id, session.openAttempts, 'open', 'unknown', 'transport_outcome_pending_after_close');
                return { status: 'open_failed', session: structuredClone(session) };
              }
              session.status = 'opening_unknown';
              session.revision += 1;
              this.finishAttempt(session.id, session.openAttempts, 'open', 'unknown', 'transport_outcome_pending');
              return { status: 'opening_unknown', session: structuredClone(session) };
            }
            outcome = 'not_opened';
          } catch {
            if (session.status !== 'opening') {
              this.finishAttempt(session.id, session.openAttempts, 'open', 'unknown', 'transport_outcome_unknown_after_close');
              return { status: 'open_failed', session: structuredClone(session) };
            }
            session.status = 'opening_unknown';
            session.revision += 1;
            this.finishAttempt(session.id, session.openAttempts, 'open', 'unknown', 'transport_outcome_unknown');
            return { status: 'opening_unknown', session: structuredClone(session) };
          }
        }
        if (session.status !== 'opening') {
          this.finishAttempt(session.id, session.openAttempts, 'open', 'failed', error instanceof Error ? error.message : 'transport_open_failed');
          return { status: 'open_failed', session: structuredClone(session) };
        }
        session.status = 'open_failed';
        session.revision += 1;
        this.finishAttempt(session.id, session.openAttempts, 'open', 'failed', error instanceof Error ? error.message : 'transport_open_failed');
        if (outcome !== 'not_opened') break;
        if (session.openAttempts < 3 && Date.parse(session.expiresAt) > Date.now()) await new Promise(resolve => setTimeout(resolve, session.openAttempts * 10));
      }
    }
    return { status: 'open_failed', session: structuredClone(session) };
  }

  async revokeByRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.requestedByUserId !== input.requesterUserId || !['pending_consent', 'consented', 'opening', 'active', 'open_failed', 'opening_unknown'].includes(session.status)) return false;
    this.revoke(session, undefined);
    await this.terminate(session);
    return true;
  }

  async revokeByDevice(input: { tenantId: string; deviceId: string; sessionId: string }): Promise<boolean> {
    const session = this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId || session.deviceId !== input.deviceId || !['pending_consent', 'consented', 'opening', 'active', 'open_failed', 'opening_unknown'].includes(session.status)) return false;
    this.revoke(session, input.deviceId);
    await this.terminate(session);
    return true;
  }

  private async terminate(session: StoredSession): Promise<void> {
    if (!this.transport || (!session.engineSessionId && session.openAttempts === 0)) return;
    session.terminationStatus = 'pending';
    this.terminationQueue.add(session.id);
    const attemptNumber = this.attempts.filter(attempt => attempt.sessionId === session.id && attempt.operation === 'terminate').length + 1;
    this.attempts.push({ sessionId: session.id, number: attemptNumber, operation: 'terminate', outcome: 'started' });
    try {
      let engineSessionId = session.engineSessionId;
      if (!engineSessionId) {
        const lookup = await withSupportTransportDeadline(signal => this.transport!.findByIdempotencyKey({ idempotencyKey: session.id, signal }), 1_500);
        if (lookup.status === 'pending') throw new SupportTransportError('termination_target_pending', 'unknown');
        if (lookup.status === 'opened') engineSessionId = lookup.engineSessionId;
      }
      if (engineSessionId) await withSupportTransportDeadline(signal => this.transport!.terminate({ engineSessionId, idempotencyKey: `terminate:${session.id}`, signal }), 4_000);
      session.terminationStatus = 'confirmed';
      if (session.status !== 'expired') session.status = 'revoked';
      session.revision += 1;
      this.terminationQueue.delete(session.id);
      this.finishAttempt(session.id, attemptNumber, 'terminate', 'succeeded');
    } catch {
      session.terminationStatus = 'failed';
      this.finishAttempt(session.id, attemptNumber, 'terminate', 'failed', 'transport_termination_failed');
    }
  }

  async dispatchTerminationOutbox(_workerId: string, limit: number): Promise<number> {
    if (!this.transport || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) return 0;
    const pending = [...this.terminationQueue].slice(0, limit);
    for (const sessionId of pending) {
      const session = this.sessions.get(sessionId);
      if (session) await this.terminate(session);
    }
    return pending.filter(sessionId => !this.terminationQueue.has(sessionId)).length;
  }

  private finishAttempt(sessionId: string, number: number, operation: 'open' | 'terminate', outcome: 'succeeded' | 'failed' | 'unknown', errorCode?: string): void {
    const attempt = [...this.attempts].reverse().find(value => value.sessionId === sessionId && value.number === number && value.operation === operation);
    if (attempt) Object.assign(attempt, { outcome, ...(errorCode ? { errorCode } : {}) });
  }

  private expire(session: StoredSession, now: number): void {
    if (!['pending_consent', 'consented', 'opening', 'active', 'opening_unknown'].includes(session.status)) return;
    const consentTimedOut = session.status === 'pending_consent' && Date.parse(session.consentExpiresAt) <= now;
    const sessionTimedOut = Date.parse(session.expiresAt) <= now;
    if (!consentTimedOut && !sessionTimedOut) return;
    session.status = consentTimedOut ? 'rejected' : 'expired';
    session.revision += 1;
    if (session.consent.status === 'pending') {
      session.consent = { ...session.consent, status: 'rejected', decidedAt: new Date(now).toISOString(), decisionOrigin: 'timeout', revision: session.consent.revision + 1 };
    }
    if (session.engineSessionId || session.openAttempts > 0) {
      session.terminationStatus = 'pending';
      this.terminationQueue.add(session.id);
    }
  }

  private revoke(session: StoredSession, deviceId: string | undefined): void {
    const now = new Date().toISOString();
    session.status = 'revoked';
    session.revision += 1;
    if (session.consent.status === 'pending') session.consent = { ...session.consent, status: 'cancelled', decidedAt: now, decisionOrigin: deviceId ? 'device_revocation' : 'operator_revocation', revision: session.consent.revision + 1 };
    if (session.engineSessionId) session.terminationStatus = 'pending';
    session.nonceHash = undefined;
  }
}
