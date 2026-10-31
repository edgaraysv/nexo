import type { Pool, PoolClient } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { createSupportNonce, supportNonceHash, SUPPORT_SESSION_TTL_SECONDS, type ConsentResponseResult, type OpenSessionResult, type SupportCapability, type SupportConsentStatus, type SupportDecisionOrigin, type SupportRepository, type SupportSessionStatus, type SupportSessionView, type SupportTerminationStatus } from './support-repository.js';
import { SupportTransport, SupportTransportError, withSupportTransportDeadline } from './support-transport.js';

interface SessionRow {
  id: string;
  tenant_id: string;
  device_identity_id: string;
  requested_by_user_id: string;
  mode: 'assisted';
  capabilities: SupportCapability[];
  status: SupportSessionStatus;
  requested_at: Date | string;
  consent_expires_at: Date | string;
  expires_at: Date | string;
  revision: string | number;
  engine_provider: string | null;
  engine_session_id: string | null;
  open_attempt_count: number | string;
  termination_status: SupportTerminationStatus;
  consent_status: SupportConsentStatus;
  consent_requested_at: Date | string;
  consent_deadline: Date | string;
  consent_accepted_at: Date | string | null;
  consent_decided_at: Date | string | null;
  consent_decision_origin: SupportDecisionOrigin | null;
  consent_revision: string | number;
}

const SESSION_SELECT = `SELECT s.id::text,s.tenant_id::text,s.device_identity_id::text,s.requested_by_user_id::text,
  s.mode,s.capabilities,s.status,s.requested_at,s.consent_expires_at,s.expires_at,s.revision,
  s.engine_provider,s.engine_session_id,s.open_attempt_count,s.termination_status,
  c.status consent_status,c.requested_at consent_requested_at,c.expires_at consent_deadline,
  c.accepted_at consent_accepted_at,c.decided_at consent_decided_at,c.decision_origin consent_decision_origin,c.revision consent_revision
  FROM support_sessions s JOIN support_consent c ON c.tenant_id=s.tenant_id AND c.session_id=s.id`;

function iso(value: Date | string): string { return new Date(value).toISOString(); }

function view(row: SessionRow): SupportSessionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    deviceId: row.device_identity_id,
    requestedByUserId: row.requested_by_user_id,
    mode: row.mode,
    capabilities: row.capabilities,
    status: row.status,
    requestedAt: iso(row.requested_at),
    consentExpiresAt: iso(row.consent_expires_at),
    expiresAt: iso(row.expires_at),
    ...(row.engine_session_id ? { engineSessionId: row.engine_session_id } : {}),
    ...(row.engine_provider ? { engineProvider: row.engine_provider } : {}),
    openAttempts: Number(row.open_attempt_count),
    terminationStatus: row.termination_status,
    revision: Number(row.revision),
    consent: {
      status: row.consent_status,
      requestedAt: iso(row.consent_requested_at),
      expiresAt: iso(row.consent_deadline),
      ...(row.consent_accepted_at ? { acceptedAt: iso(row.consent_accepted_at) } : {}),
      ...(row.consent_decided_at ? { decidedAt: iso(row.consent_decided_at) } : {}),
      ...(row.consent_decision_origin ? { decisionOrigin: row.consent_decision_origin } : {}),
      revision: Number(row.consent_revision),
    },
  };
}

type OpenClaim =
  | { kind: 'claimed'; session: SupportSessionView; attemptNumber: number }
  | { kind: 'opened' | 'opening' | 'open_failed' | 'opening_unknown'; session: SupportSessionView }
  | { kind: 'not_found' }
  | { kind: 'not_authorized' };

export class PostgresSupportRepository implements SupportRepository {
  constructor(private readonly pool: Pool, private readonly transport?: SupportTransport, options: { allowSyntheticTestTransport?: boolean } = {}) {
    if (transport?.kind === 'synthetic_test' && options.allowSyntheticTestTransport !== true) throw new Error('synthetic_support_transport_requires_test_opt_in');
  }

  async createRequest(input: { tenantId: string; deviceId: string; requesterUserId: string; capabilities: SupportCapability[]; consentTimeoutSeconds: number }): Promise<SupportSessionView | undefined> {
    return this.companyTx(input.tenantId, input.requesterUserId, async client => {
      const grant = (await client.query<{ id: string }>(`
        SELECT g.id::text AS id FROM device_identities d
        JOIN memberships m ON m.tenant_id=d.tenant_id AND m.user_id=$3 AND m.status='active'
        JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id
        JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_id='company.support.start'
        JOIN resource_grants g ON g.tenant_id=d.tenant_id AND g.user_id=m.user_id AND g.resource_type='device_identity'
          AND g.resource_id=d.id AND g.permission_id='company.support.start' AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
        JOIN subscriptions s ON s.tenant_id=d.tenant_id AND s.state IN ('active','grace')
          AND (s.valid_from IS NULL OR s.valid_from<=now()) AND (s.valid_until IS NULL OR s.valid_until>now())
        JOIN plans p ON p.id=s.plan_id AND coalesce((p.modules->>'support')::boolean,false)=true
        LEFT JOIN subscription_modules sm ON sm.tenant_id=s.tenant_id AND sm.module='support'
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.device_kind='endpoint' AND d.status='approved'
          AND coalesce(sm.state,'active')='active'
          AND (sm.valid_from IS NULL OR sm.valid_from<=now()) AND (sm.valid_until IS NULL OR sm.valid_until>now())
        LIMIT 1 FOR SHARE OF g,d,m`, [input.tenantId, input.deviceId, input.requesterUserId])).rows[0];
      if (!grant) return undefined;

      const inserted = (await client.query<{ id: string }>(`INSERT INTO support_sessions
        (tenant_id,device_identity_id,requested_by_user_id,mode,capabilities,status,consent_expires_at,expires_at)
        VALUES($1,$2,$3,'assisted',$4,'pending_consent',now()+$5*interval '1 second',now()+$6*interval '1 second')
        RETURNING id::text`, [input.tenantId, input.deviceId, input.requesterUserId, input.capabilities, input.consentTimeoutSeconds, SUPPORT_SESSION_TTL_SECONDS])).rows[0];
      if (!inserted) throw new Error('support_session_insert_failed');
      const nonceHash = Buffer.from(supportNonceHash(createSupportNonce()), 'hex');
      await client.query(`INSERT INTO support_consent(tenant_id,session_id,operator_id,device_id,status,requested_at,expires_at,nonce_hash,nonce_issued_at)
        SELECT tenant_id,id,requested_by_user_id,device_identity_id,'pending',requested_at,consent_expires_at,$3,now()
        FROM support_sessions WHERE tenant_id=$1 AND id=$2`, [input.tenantId, inserted.id, nonceHash]);
      await this.audit(client, input.tenantId, input.requesterUserId, 'support.session.requested', inserted.id, { mode: 'assisted', capabilities: input.capabilities });
      return this.readOne(client, input.tenantId, inserted.id);
    });
  }

  async listPendingForDevice(input: { tenantId: string; deviceId: string }): Promise<Awaited<ReturnType<SupportRepository['listPendingForDevice']>>> {
    return this.deviceTx(input.tenantId, input.deviceId, async client => {
      await this.expirePendingForDevice(client, input.tenantId, input.deviceId);
      const rows = (await client.query<SessionRow>(`${SESSION_SELECT} WHERE s.tenant_id=$1 AND s.device_identity_id=$2 AND s.status='pending_consent' ORDER BY s.requested_at,s.id FOR UPDATE OF s,c`, [input.tenantId, input.deviceId])).rows;
      const items = [];
      for (const row of rows) {
        const consentNonce = createSupportNonce();
        const nonceHash = Buffer.from(supportNonceHash(consentNonce), 'hex');
        const updated = await client.query(`UPDATE support_consent SET nonce_hash=$3,nonce_issued_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND status='pending' AND expires_at>clock_timestamp()`, [input.tenantId, row.id, nonceHash]);
        if (updated.rowCount) items.push({ ...view(row), consentNonce });
      }
      return items;
    });
  }

  async getForRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined> {
    return this.companyTx(input.tenantId, input.requesterUserId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      return this.readOne(client, input.tenantId, input.sessionId, input.requesterUserId);
    });
  }

  async respondToConsent(input: { tenantId: string; deviceId: string; sessionId: string; decision: 'accepted' | 'rejected'; nonce: string }): Promise<ConsentResponseResult> {
    return this.deviceTx(input.tenantId, input.deviceId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      const current = (await client.query<{ status: SupportSessionStatus; consent_status: SupportConsentStatus; decision_origin: SupportDecisionOrigin | null; nonce_hash: Buffer | null }>(`SELECT s.status,c.status consent_status,c.decision_origin,c.nonce_hash FROM support_sessions s
        JOIN support_consent c ON c.tenant_id=s.tenant_id AND c.session_id=s.id
        WHERE s.tenant_id=$1 AND s.id=$2 AND s.device_identity_id=$3
        FOR UPDATE OF s,c`, [input.tenantId, input.sessionId, input.deviceId])).rows[0];
      if (!current) return 'not_found';
      if (current.status === 'rejected' && current.decision_origin === 'timeout') return 'expired';
      if (current.status !== 'pending_consent' || current.consent_status !== 'pending') return 'already_decided';
      const suppliedHash = Buffer.from(supportNonceHash(input.nonce), 'hex');
      if (!current.nonce_hash || current.nonce_hash.length !== suppliedHash.length || !timingSafeEqual(current.nonce_hash, suppliedHash)) return 'invalid_nonce';
      const updated = await client.query(`UPDATE support_consent SET status=$4,accepted_at=CASE WHEN $4='accepted' THEN clock_timestamp() ELSE NULL END,
        decided_at=clock_timestamp(),decided_by_device_id=$3,decision_origin='endpoint_api',nonce_consumed_at=clock_timestamp(),revision=revision+1
        WHERE tenant_id=$1 AND session_id=$2 AND device_id=$3 AND status='pending' AND nonce_hash=$5 AND expires_at>clock_timestamp()`,
      [input.tenantId, input.sessionId, input.deviceId, input.decision, suppliedHash]);
      if (!updated.rowCount) {
        await this.expireOne(client, input.tenantId, input.sessionId);
        return 'expired';
      }
      await client.query('UPDATE support_sessions SET status=$3,revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND id=$2', [input.tenantId, input.sessionId, input.decision === 'accepted' ? 'consented' : 'rejected']);
      await this.audit(client, input.tenantId, undefined, `support.consent.${input.decision}`, input.sessionId, { device_id: input.deviceId });
      return 'updated';
    });
  }

  async authorizeTransport(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<SupportSessionView | undefined> {
    return this.companyTx(input.tenantId, input.requesterUserId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      const allowed = Boolean((await client.query<{ allowed: boolean }>(`SELECT EXISTS(
        SELECT 1 FROM support_sessions s
        JOIN support_consent c ON c.tenant_id=s.tenant_id AND c.session_id=s.id
        JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.requested_by_user_id AND m.status='active'
        JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id
        JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_id='company.support.start'
        JOIN resource_grants g ON g.tenant_id=s.tenant_id AND g.user_id=s.requested_by_user_id AND g.resource_type='device_identity'
          AND g.resource_id=s.device_identity_id AND g.permission_id='company.support.start' AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
        JOIN device_identities d ON d.tenant_id=s.tenant_id AND d.id=s.device_identity_id AND d.status='approved' AND d.device_kind='endpoint'
        JOIN subscriptions sub ON sub.tenant_id=s.tenant_id AND sub.state IN ('active','grace')
          AND (sub.valid_from IS NULL OR sub.valid_from<=now()) AND (sub.valid_until IS NULL OR sub.valid_until>now())
        JOIN plans p ON p.id=sub.plan_id AND coalesce((p.modules->>'support')::boolean,false)=true
        LEFT JOIN subscription_modules sm ON sm.tenant_id=sub.tenant_id AND sm.module='support'
        WHERE s.tenant_id=$1 AND s.id=$2 AND s.requested_by_user_id=$3 AND s.mode='assisted'
          AND s.status='consented' AND s.expires_at>clock_timestamp() AND c.status='accepted' AND c.accepted_at<=c.expires_at
          AND c.decision_origin='endpoint_api' AND c.nonce_hash IS NOT NULL AND c.nonce_consumed_at IS NOT NULL
          AND coalesce(sm.state,'active')='active'
          AND (sm.valid_from IS NULL OR sm.valid_from<=now()) AND (sm.valid_until IS NULL OR sm.valid_until>now())
      ) allowed`, [input.tenantId, input.sessionId, input.requesterUserId])).rows[0]?.allowed);
      if (!allowed) return undefined;
      await this.audit(client, input.tenantId, input.requesterUserId, 'support.transport_gate_passed', input.sessionId, { transport_started: false });
      return this.readOne(client, input.tenantId, input.sessionId, input.requesterUserId);
    });
  }

  async openSession(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<OpenSessionResult> {
    if (!this.transport) return { status: 'transport_disabled' };
    for (;;) {
      const claim = await this.claimOpen(input);
      if (claim.kind !== 'claimed') {
        if (claim.kind === 'not_found') return { status: 'not_found' };
        if (claim.kind === 'not_authorized') return { status: 'not_authorized' };
        return { status: claim.kind, session: claim.session };
      }
      const { session, attemptNumber } = claim;
      let outcome: 'not_opened' | 'unknown' = 'not_opened';
      try {
        const opened = await withSupportTransportDeadline(signal => this.transport!.open({
          sessionId: session.id,
          tenantId: session.tenantId,
          deviceId: session.deviceId,
          operatorId: session.requestedByUserId,
          capabilities: [...session.capabilities],
          expiresAt: session.expiresAt,
          idempotencyKey: session.id,
          signal,
        }), 2_500);
        const active = await this.completeOpen(input, attemptNumber, opened.engineSessionId);
        if (active) return { status: 'opened', session: active };
        await this.dispatchTerminationForSession(input.sessionId, 'support-open-race');
        const closed = await this.getForRequester(input);
        return closed ? { status: 'open_failed', session: closed } : { status: 'not_found' };
      } catch (error) {
        outcome = error instanceof SupportTransportError ? error.outcome : 'unknown';
        if (outcome === 'unknown') {
          try {
            const lookup = await withSupportTransportDeadline(signal => this.transport!.findByIdempotencyKey({ idempotencyKey: session.id, signal }), 1_500);
            if (lookup.status === 'opened') {
              const active = await this.completeOpen(input, attemptNumber, lookup.engineSessionId);
              if (active) return { status: 'opened', session: active };
              await this.dispatchTerminationForSession(input.sessionId, 'support-open-race');
              const closed = await this.getForRequester(input);
              return closed ? { status: 'open_failed', session: closed } : { status: 'not_found' };
            }
            if (lookup.status === 'pending') {
              await this.finishOpenAttempt(input, attemptNumber, 'unknown', 'transport_outcome_pending');
              const current = await this.getForRequester(input);
              return current ? { status: 'opening_unknown', session: current } : { status: 'not_found' };
            }
            outcome = 'not_opened';
          } catch {
            await this.finishOpenAttempt(input, attemptNumber, 'unknown', 'transport_outcome_unknown');
            const current = await this.getForRequester(input);
            return current ? { status: 'opening_unknown', session: current } : { status: 'not_found' };
          }
        }
        await this.finishOpenAttempt(input, attemptNumber, 'failed', this.errorCode(error));
        if (outcome !== 'not_opened' || attemptNumber >= 3) {
          const current = await this.getForRequester(input);
          return current ? { status: 'open_failed', session: current } : { status: 'not_found' };
        }
        await new Promise(resolve => setTimeout(resolve, attemptNumber * 25));
      }
    }
  }

  private async claimOpen(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<OpenClaim> {
    return this.companyTx(input.tenantId, input.requesterUserId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      const current = (await client.query<{ status: SupportSessionStatus; open_attempt_count: number; engine_session_id: string | null }>(`SELECT s.status,s.open_attempt_count,s.engine_session_id
        FROM support_sessions s JOIN support_consent c ON c.tenant_id=s.tenant_id AND c.session_id=s.id
        WHERE s.tenant_id=$1 AND s.id=$2 AND s.requested_by_user_id=$3 FOR UPDATE OF s,c`, [input.tenantId, input.sessionId, input.requesterUserId])).rows[0];
      if (!current) return { kind: 'not_found' };
      const existing = await this.readOne(client, input.tenantId, input.sessionId, input.requesterUserId);
      if (current.status === 'active' && current.engine_session_id && existing) return { kind: 'opened', session: existing };
      if (current.status === 'opening' && existing) return { kind: 'opening', session: existing };
      if (current.status === 'opening_unknown' && existing) return { kind: 'opening_unknown', session: existing };
      if (current.status === 'open_failed' && current.open_attempt_count >= 3 && existing) return { kind: 'open_failed', session: existing };
      if (!['consented', 'open_failed'].includes(current.status) || current.engine_session_id || current.open_attempt_count >= 3) return { kind: 'not_authorized' };
      const allowed = await this.openGate(client, input, ['consented', 'open_failed']);
      if (!allowed) return { kind: 'not_authorized' };
      const changed = (await client.query<{ open_attempt_count: number }>(`UPDATE support_sessions SET status='opening',engine_provider=$3,open_attempt_count=open_attempt_count+1,revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status IN('consented','open_failed') AND open_attempt_count<3 RETURNING open_attempt_count`, [input.tenantId, input.sessionId, this.transport?.kind])).rows[0];
      if (!changed) return { kind: 'not_authorized' };
      await client.query(`INSERT INTO support_session_attempts(tenant_id,session_id,attempt_number,operation,provider,idempotency_key,outcome)
        VALUES($1,$2,$3,'open',$4,$5,'started')`, [input.tenantId, input.sessionId, changed.open_attempt_count, this.transport?.kind ?? 'disabled', input.sessionId]);
      const session = await this.readOne(client, input.tenantId, input.sessionId, input.requesterUserId);
      return session ? { kind: 'claimed', session, attemptNumber: changed.open_attempt_count } : { kind: 'not_found' };
    });
  }

  private async openGate(client: PoolClient, input: { tenantId: string; requesterUserId: string; sessionId: string }, statuses: string[]): Promise<boolean> {
    const grant = (await client.query<{ id: string }>(`SELECT g.id::text AS id FROM support_sessions s
      JOIN support_consent c ON c.tenant_id=s.tenant_id AND c.session_id=s.id
      JOIN memberships m ON m.tenant_id=s.tenant_id AND m.user_id=s.requested_by_user_id AND m.status='active'
      JOIN membership_roles mr ON mr.tenant_id=m.tenant_id AND mr.user_id=m.user_id
      JOIN role_permissions rp ON rp.role_id=mr.role_id AND rp.permission_id='company.support.start'
      JOIN resource_grants g ON g.tenant_id=s.tenant_id AND g.user_id=s.requested_by_user_id AND g.resource_type='device_identity'
        AND g.resource_id=s.device_identity_id AND g.permission_id='company.support.start' AND g.revoked_at IS NULL
        AND g.valid_from<=clock_timestamp() AND (g.valid_until IS NULL OR g.valid_until>clock_timestamp())
      JOIN device_identities d ON d.tenant_id=s.tenant_id AND d.id=s.device_identity_id AND d.status='approved' AND d.device_kind='endpoint'
      JOIN subscriptions sub ON sub.tenant_id=s.tenant_id AND sub.state IN('active','grace')
        AND (sub.valid_from IS NULL OR sub.valid_from<=clock_timestamp()) AND (sub.valid_until IS NULL OR sub.valid_until>clock_timestamp())
      JOIN plans p ON p.id=sub.plan_id AND coalesce((p.modules->>'support')::boolean,false)=true
      LEFT JOIN subscription_modules sm ON sm.tenant_id=sub.tenant_id AND sm.module='support'
      WHERE s.tenant_id=$1 AND s.id=$2 AND s.requested_by_user_id=$3 AND s.mode='assisted'
        AND s.status=ANY($4::text[]) AND s.expires_at>clock_timestamp() AND c.status='accepted'
        AND c.decision_origin='endpoint_api' AND c.accepted_at<=c.expires_at AND c.nonce_hash IS NOT NULL AND c.nonce_consumed_at IS NOT NULL
        AND coalesce(sm.state,'active')='active'
        AND (sm.valid_from IS NULL OR sm.valid_from<=clock_timestamp()) AND (sm.valid_until IS NULL OR sm.valid_until>clock_timestamp())
      LIMIT 1 FOR SHARE OF g,d,m`, [input.tenantId, input.sessionId, input.requesterUserId, statuses])).rows[0];
    return Boolean(grant);
  }

  private async completeOpen(input: { tenantId: string; requesterUserId: string; sessionId: string }, attemptNumber: number, engineSessionId: string): Promise<SupportSessionView | undefined> {
    return this.companyTx(input.tenantId, input.requesterUserId, async client => {
      const current = (await client.query<{ status: SupportSessionStatus }>(`SELECT status FROM support_sessions WHERE tenant_id=$1 AND id=$2 AND requested_by_user_id=$3 FOR UPDATE`, [input.tenantId, input.sessionId, input.requesterUserId])).rows[0];
      if (!current) return undefined;
      const stillAllowed = current.status === 'opening' && await this.openGate(client, input, ['opening']);
      if (stillAllowed) {
        await client.query(`UPDATE support_sessions SET status='active',engine_provider=$4,engine_session_id=$5,revision=revision+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2 AND requested_by_user_id=$3 AND status='opening'`, [input.tenantId, input.sessionId, input.requesterUserId, this.transport?.kind, engineSessionId]);
        await this.finishAttemptRow(client, input.tenantId, input.sessionId, attemptNumber, 'succeeded');
        await this.audit(client, input.tenantId, input.requesterUserId, 'support.session.opened', input.sessionId, { provider: this.transport?.kind });
        return this.readOne(client, input.tenantId, input.sessionId, input.requesterUserId);
      }
      await client.query(`UPDATE support_sessions SET status=CASE WHEN status='expired' THEN 'expired' ELSE 'revoked' END,
        engine_provider=$4,engine_session_id=$5,termination_status='pending',termination_requested_at=coalesce(termination_requested_at,clock_timestamp()),
        closed_at=coalesce(closed_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND requested_by_user_id=$3`, [input.tenantId, input.sessionId, input.requesterUserId, this.transport?.kind, engineSessionId]);
      await client.query(`INSERT INTO support_session_outbox(tenant_id,session_id,action,idempotency_key)
        VALUES($1,$2,'terminate',$3) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`, [input.tenantId, input.sessionId, `terminate:${input.sessionId}`]);
      await this.finishAttemptRow(client, input.tenantId, input.sessionId, attemptNumber, 'succeeded');
      await this.audit(client, input.tenantId, input.requesterUserId, 'support.session.open_raced_with_close', input.sessionId, { provider: this.transport?.kind });
      return undefined;
    });
  }

  private async finishOpenAttempt(input: { tenantId: string; requesterUserId: string; sessionId: string }, attemptNumber: number, outcome: 'failed' | 'unknown', errorCode: string): Promise<void> {
    await this.companyTx(input.tenantId, input.requesterUserId, async client => {
      await this.finishAttemptRow(client, input.tenantId, input.sessionId, attemptNumber, outcome, errorCode);
      const nextStatus = outcome === 'unknown' ? 'opening_unknown' : 'open_failed';
      await client.query(`UPDATE support_sessions SET status=$4,revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND requested_by_user_id=$3 AND status='opening'`, [input.tenantId, input.sessionId, input.requesterUserId, nextStatus]);
      await this.audit(client, input.tenantId, input.requesterUserId, `support.session.open_${outcome}`, input.sessionId, { attempt: attemptNumber, error_code: errorCode });
    });
  }

  private async finishAttemptRow(client: PoolClient, tenantId: string, sessionId: string, attemptNumber: number, outcome: 'succeeded' | 'failed' | 'unknown', errorCode?: string): Promise<void> {
    await client.query(`UPDATE support_session_attempts SET outcome=$4,error_code=$5,completed_at=clock_timestamp()
      WHERE tenant_id=$1 AND session_id=$2 AND operation='open' AND attempt_number=$3 AND outcome='started'`, [tenantId, sessionId, attemptNumber, outcome, errorCode ?? null]);
  }

  async revokeByRequester(input: { tenantId: string; requesterUserId: string; sessionId: string }): Promise<boolean> {
    const shouldDispatch = await this.companyTx(input.tenantId, input.requesterUserId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      const row = (await client.query<{ status: SupportSessionStatus; engine_session_id: string | null }>(`SELECT status,engine_session_id FROM support_sessions
        WHERE tenant_id=$1 AND id=$2 AND requested_by_user_id=$3 FOR UPDATE`, [input.tenantId, input.sessionId, input.requesterUserId])).rows[0];
      if (!row || !['pending_consent','consented','opening','active','open_failed','opening_unknown'].includes(row.status)) return undefined;
      const queueTermination = Boolean(row.engine_session_id) || ['opening','opening_unknown'].includes(row.status);
      await client.query(`UPDATE support_sessions SET status='revoked',closed_at=clock_timestamp(),
        termination_status=CASE WHEN $3 THEN 'pending' ELSE 'not_required' END,
        termination_requested_at=CASE WHEN $3 THEN coalesce(termination_requested_at,clock_timestamp()) ELSE termination_requested_at END,
        revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [input.tenantId, input.sessionId, queueTermination]);
      await client.query(`UPDATE support_consent SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,
        decision_origin=CASE WHEN status='pending' THEN 'operator_revocation' ELSE decision_origin END,
        decided_at=CASE WHEN status='pending' THEN clock_timestamp() ELSE decided_at END,
        nonce_consumed_at=coalesce(nonce_consumed_at,clock_timestamp()),revision=revision+1 WHERE tenant_id=$1 AND session_id=$2`, [input.tenantId, input.sessionId]);
      if (queueTermination) await this.enqueueTermination(client, input.tenantId, input.sessionId);
      await this.audit(client, input.tenantId, input.requesterUserId, 'support.session.revoked', input.sessionId);
      return queueTermination;
    });
    if (shouldDispatch === undefined) return false;
    if (shouldDispatch) await this.dispatchTerminationForSession(input.sessionId, 'support-revocation');
    return true;
  }

  async revokeByDevice(input: { tenantId: string; deviceId: string; sessionId: string }): Promise<boolean> {
    const shouldDispatch = await this.deviceTx(input.tenantId, input.deviceId, async client => {
      await this.expireOne(client, input.tenantId, input.sessionId);
      const row = (await client.query<{ status: SupportSessionStatus; engine_session_id: string | null }>(`SELECT status,engine_session_id FROM support_sessions
        WHERE tenant_id=$1 AND id=$2 AND device_identity_id=$3 FOR UPDATE`, [input.tenantId, input.sessionId, input.deviceId])).rows[0];
      if (!row || !['pending_consent','consented','opening','active','open_failed','opening_unknown'].includes(row.status)) return undefined;
      const queueTermination = Boolean(row.engine_session_id) || ['opening','opening_unknown'].includes(row.status);
      await client.query(`UPDATE support_sessions SET status='revoked',closed_at=clock_timestamp(),
        termination_status=CASE WHEN $4 THEN 'pending' ELSE 'not_required' END,
        termination_requested_at=CASE WHEN $4 THEN coalesce(termination_requested_at,clock_timestamp()) ELSE termination_requested_at END,
        revision=revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND device_identity_id=$3`, [input.tenantId, input.sessionId, input.deviceId, queueTermination]);
      await client.query(`UPDATE support_consent SET status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END,
        decision_origin=CASE WHEN status='pending' THEN 'device_revocation' ELSE decision_origin END,
        decided_at=CASE WHEN status='pending' THEN clock_timestamp() ELSE decided_at END,
        nonce_consumed_at=coalesce(nonce_consumed_at,clock_timestamp()),revision=revision+1 WHERE tenant_id=$1 AND session_id=$2`, [input.tenantId, input.sessionId]);
      if (queueTermination) await this.enqueueTermination(client, input.tenantId, input.sessionId);
      await this.audit(client, input.tenantId, undefined, 'support.session.revoked_by_device', input.sessionId, { device_id: input.deviceId });
      return queueTermination;
    });
    if (shouldDispatch === undefined) return false;
    if (shouldDispatch) await this.dispatchTerminationForSession(input.sessionId, 'support-device-revocation');
    return true;
  }

  async dispatchTerminationOutbox(workerId: string, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return 0;
    const ids = await this.workerTx(async client => {
      const timedOut = (await client.query<{ tenant_id: string; session_id: string }>(`UPDATE support_consent SET status='rejected',decision_origin='timeout',
        decided_at=coalesce(decided_at,clock_timestamp()),nonce_consumed_at=coalesce(nonce_consumed_at,clock_timestamp()),revision=revision+1
        WHERE status='pending' AND expires_at<=clock_timestamp() RETURNING tenant_id::text,session_id::text`)).rows;
      if (timedOut.length) {
        const byTenant = new Map<string, string[]>();
        for (const row of timedOut) byTenant.set(row.tenant_id, [...(byTenant.get(row.tenant_id) ?? []), row.session_id]);
        for (const [tenantId, sessionIds] of byTenant) {
          await this.context(client, 'app.tenant_id', tenantId);
          await client.query(`UPDATE support_sessions SET status='rejected',closed_at=coalesce(closed_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='pending_consent'`, [tenantId, sessionIds]);
          await client.query(`INSERT INTO audit_events(tenant_id,action,resource_type,resource_id,metadata)
            SELECT $1,'support.consent.timeout_rejected','support_session',id,jsonb_build_object('source','timeout') FROM unnest($2::uuid[]) id`, [tenantId, sessionIds]);
        }
      }
      const expired = (await client.query<{ tenant_id: string; id: string }>(`UPDATE support_sessions SET status='expired',closed_at=coalesce(closed_at,clock_timestamp()),
        termination_status=CASE WHEN engine_session_id IS NOT NULL OR status IN('opening','opening_unknown') THEN 'pending' ELSE termination_status END,
        termination_requested_at=CASE WHEN engine_session_id IS NOT NULL OR status IN('opening','opening_unknown') THEN coalesce(termination_requested_at,clock_timestamp()) ELSE termination_requested_at END,
        revision=revision+1,updated_at=clock_timestamp()
        WHERE status IN('consented','opening','active','opening_unknown') AND expires_at<=clock_timestamp() RETURNING tenant_id::text,id::text`)).rows;
      for (const row of expired) {
        if (row.id) await client.query(`INSERT INTO support_session_outbox(tenant_id,session_id,action,idempotency_key)
          SELECT $1,$2,'terminate',$3 WHERE EXISTS(SELECT 1 FROM support_sessions WHERE tenant_id=$1 AND id=$2 AND termination_status='pending')
          ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`, [row.tenant_id, row.id, `terminate:${row.id}`]);
      }
      return (await client.query<{ session_id: string }>(`SELECT session_id::text FROM support_session_outbox
        WHERE delivered_at IS NULL AND available_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
        ORDER BY id LIMIT $1`, [limit])).rows.map(row => row.session_id);
    });
    if (!this.transport) return 0;
    let delivered = 0;
    for (const sessionId of ids) if (await this.dispatchTerminationForSession(sessionId, workerId)) delivered += 1;
    return delivered;
  }

  private async enqueueTermination(client: PoolClient, tenantId: string, sessionId: string): Promise<void> {
    await client.query(`INSERT INTO support_session_outbox(tenant_id,session_id,action,idempotency_key)
      VALUES($1,$2,'terminate',$3) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`, [tenantId, sessionId, `terminate:${sessionId}`]);
  }

  private async dispatchTerminationForSession(sessionId: string, workerId: string): Promise<boolean> {
    const transport = this.transport;
    if (!transport) return false;
    const job = await this.workerTx(async client => {
      const selected = (await client.query<{ id: string; tenant_id: string; session_id: string; attempts: number; engine_session_id: string | null; engine_provider: string | null }>(`SELECT o.id,o.tenant_id::text,o.session_id::text,o.attempts,s.engine_session_id,s.engine_provider
        FROM support_session_outbox o JOIN support_sessions s ON s.tenant_id=o.tenant_id AND s.id=o.session_id
        WHERE o.session_id=$1 AND o.delivered_at IS NULL AND o.available_at<=clock_timestamp()
          AND (o.lease_until IS NULL OR o.lease_until<clock_timestamp())
        ORDER BY o.id FOR UPDATE OF o SKIP LOCKED LIMIT 1`, [sessionId])).rows[0];
      if (!selected) return undefined;
      const lease = `${workerId.slice(0, 80)}:${crypto.randomUUID()}`;
      const attemptNumber = selected.attempts + 1;
      await client.query(`UPDATE support_session_outbox SET attempts=attempts+1,lease_owner=$2,lease_until=clock_timestamp()+interval '6 seconds' WHERE id=$1`, [selected.id, lease]);
      await client.query(`INSERT INTO support_session_attempts(tenant_id,session_id,attempt_number,operation,provider,idempotency_key,outcome)
        VALUES($1,$2,$3,'terminate',$4,$5,'started') ON CONFLICT(tenant_id,session_id,operation,attempt_number) DO NOTHING`, [selected.tenant_id, selected.session_id, attemptNumber, selected.engine_provider ?? transport.kind, `terminate:${selected.session_id}`]);
      await client.query(`UPDATE support_sessions SET termination_status='pending',termination_requested_at=coalesce(termination_requested_at,clock_timestamp()),termination_error_code=NULL
        WHERE tenant_id=$1 AND id=$2`, [selected.tenant_id, selected.session_id]);
      return { ...selected, lease, attemptNumber };
    });
    if (!job) return false;
    let succeeded = false;
    let resolvedEngineSessionId = job.engine_session_id;
    let errorCode: string | undefined;
    try {
      if (job.engine_provider && job.engine_provider !== transport.kind) throw new SupportTransportError('transport_provider_mismatch', 'unknown');
      if (!resolvedEngineSessionId) {
        const lookup = await withSupportTransportDeadline(signal => transport.findByIdempotencyKey({ idempotencyKey: job.session_id, signal }), 1_500);
        if (lookup.status === 'pending') throw new SupportTransportError('termination_target_pending', 'unknown');
        if (lookup.status === 'not_found') succeeded = true;
        else resolvedEngineSessionId = lookup.engineSessionId;
      }
      if (resolvedEngineSessionId) {
        await withSupportTransportDeadline(signal => transport.terminate({ engineSessionId: resolvedEngineSessionId!, idempotencyKey: `terminate:${job.session_id}`, signal }), 4_000);
        succeeded = true;
      }
    } catch (error) {
      errorCode = this.errorCode(error);
    }
    await this.workerTx(async client => {
      if (succeeded) {
        await client.query(`UPDATE support_session_outbox SET delivered_at=clock_timestamp(),lease_owner=NULL,lease_until=NULL,last_error_code=NULL WHERE id=$1 AND lease_owner=$2`, [job.id, job.lease]);
        await client.query(`UPDATE support_sessions SET termination_status='confirmed',terminated_at=clock_timestamp(),termination_error_code=NULL,
          engine_provider=coalesce(engine_provider,$3),engine_session_id=coalesce(engine_session_id,$4),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`, [job.tenant_id, job.session_id, transport.kind, resolvedEngineSessionId]);
        await client.query(`UPDATE support_session_attempts SET outcome='succeeded',completed_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND operation='terminate' AND attempt_number=$3 AND outcome='started'`, [job.tenant_id, job.session_id, job.attemptNumber]);
      } else {
        await client.query(`UPDATE support_session_outbox SET available_at=clock_timestamp()+interval '1 second',lease_owner=NULL,lease_until=NULL,last_error_code=$3 WHERE id=$1 AND lease_owner=$2`, [job.id, job.lease, errorCode ?? 'transport_termination_failed']);
        await client.query(`UPDATE support_sessions SET termination_status='failed',termination_error_code=$3,
          engine_provider=coalesce(engine_provider,$4),engine_session_id=coalesce(engine_session_id,$5),updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND id=$2`, [job.tenant_id, job.session_id, errorCode ?? 'transport_termination_failed', transport.kind, resolvedEngineSessionId]);
        await client.query(`UPDATE support_session_attempts SET outcome='failed',error_code=$4,completed_at=clock_timestamp()
          WHERE tenant_id=$1 AND session_id=$2 AND operation='terminate' AND attempt_number=$3 AND outcome='started'`, [job.tenant_id, job.session_id, job.attemptNumber, errorCode ?? 'transport_termination_failed']);
      }
    });
    return succeeded;
  }

  private async readOne(client: PoolClient, tenantId: string, sessionId: string, requesterUserId?: string): Promise<SupportSessionView | undefined> {
    const row = (await client.query<SessionRow>(`${SESSION_SELECT} WHERE s.tenant_id=$1 AND s.id=$2 AND ($3::uuid IS NULL OR s.requested_by_user_id=$3)`, [tenantId, sessionId, requesterUserId ?? null])).rows[0];
    return row ? view(row) : undefined;
  }

  private async expireOne(client: PoolClient, tenantId: string, sessionId: string): Promise<void> {
    const timeout = (await client.query(`UPDATE support_consent SET status='rejected',decision_origin='timeout',
      decided_at=coalesce(decided_at,clock_timestamp()),nonce_consumed_at=coalesce(nonce_consumed_at,clock_timestamp()),revision=revision+1
      WHERE tenant_id=$1 AND session_id=$2 AND status='pending' AND expires_at<=clock_timestamp() RETURNING session_id`, [tenantId, sessionId])).rows[0];
    if (timeout) {
      await client.query(`UPDATE support_sessions SET status='rejected',closed_at=coalesce(closed_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND status='pending_consent'`, [tenantId, sessionId]);
      await this.audit(client, tenantId, undefined, 'support.consent.timeout_rejected', sessionId, { source: 'timeout' });
      return;
    }
    const expired = (await client.query<{ status: SupportSessionStatus; engine_session_id: string | null; termination_status: SupportTerminationStatus }>(`UPDATE support_sessions SET status='expired',closed_at=coalesce(closed_at,clock_timestamp()),
      termination_status=CASE WHEN engine_session_id IS NOT NULL OR status IN('opening','opening_unknown') THEN 'pending' ELSE termination_status END,
      termination_requested_at=CASE WHEN engine_session_id IS NOT NULL OR status IN('opening','opening_unknown') THEN coalesce(termination_requested_at,clock_timestamp()) ELSE termination_requested_at END,
      revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=$2 AND status IN('consented','opening','active','opening_unknown') AND expires_at<=clock_timestamp()
      RETURNING status,engine_session_id,termination_status`, [tenantId, sessionId])).rows[0];
    if (expired) {
      if (expired.termination_status === 'pending') await this.enqueueTermination(client, tenantId, sessionId);
      await this.audit(client, tenantId, undefined, 'support.session.expired', sessionId, { termination_queued: expired.termination_status === 'pending' });
    }
  }

  private async expirePendingForDevice(client: PoolClient, tenantId: string, deviceId: string): Promise<void> {
    const rows = (await client.query<{ session_id: string }>(`UPDATE support_consent SET status='rejected',decision_origin='timeout',
      decided_at=coalesce(decided_at,clock_timestamp()),nonce_consumed_at=coalesce(nonce_consumed_at,clock_timestamp()),revision=revision+1
      WHERE tenant_id=$1 AND device_id=$2 AND status='pending' AND expires_at<=clock_timestamp() RETURNING session_id::text`, [tenantId, deviceId])).rows;
    if (!rows.length) return;
    const ids = rows.map(row => row.session_id);
    await client.query(`UPDATE support_sessions SET status='rejected',closed_at=coalesce(closed_at,clock_timestamp()),revision=revision+1,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='pending_consent'`, [tenantId, ids]);
    await client.query(`INSERT INTO audit_events(tenant_id,action,resource_type,resource_id,metadata)
      SELECT $1,'support.consent.timeout_rejected','support_session',id,jsonb_build_object('source','timeout') FROM unnest($2::uuid[]) id`, [tenantId, ids]);
  }

  private async audit(client: PoolClient, tenantId: string, actorUserId: string | undefined, action: string, sessionId: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await client.query('INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,\'support_session\',$4,$5)', [tenantId, actorUserId ?? null, action, sessionId, metadata]);
  }

  private errorCode(error: unknown): string {
    if (error instanceof SupportTransportError && /^[a-z0-9_]{1,80}$/u.test(error.code)) return error.code;
    return 'transport_error';
  }

  private async companyTx<T>(tenantId: string, userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.tx(async client => {
      await this.context(client, 'app.tenant_id', tenantId);
      await this.context(client, 'app.user_id', userId);
      return work(client);
    });
  }

  private async deviceTx<T>(tenantId: string, deviceId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.tx(async client => {
      await this.context(client, 'app.tenant_id', tenantId);
      await this.context(client, 'app.device_id', deviceId);
      return work(client);
    });
  }

  private async workerTx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.tx(async client => {
      await this.context(client, 'app.worker_role', 'support_dispatch');
      return work(client);
    });
  }

  private async context(client: PoolClient, key: string, value: string): Promise<void> {
    await client.query('SELECT set_config($1,$2,true)', [key, value]);
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
