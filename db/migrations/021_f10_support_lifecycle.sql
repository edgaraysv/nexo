BEGIN;

-- 020 is immutable and published. Normalize its first-cut consent schema here.
ALTER TABLE support_consent RENAME COLUMN support_session_id TO session_id;
ALTER TABLE support_consent RENAME COLUMN device_identity_id TO device_id;
ALTER TABLE support_consent RENAME COLUMN decision TO status;
ALTER TABLE support_consent RENAME COLUMN responded_at TO decided_at;
ALTER TABLE support_consent RENAME COLUMN responded_by_device_id TO decided_by_device_id;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='support_consent'::regclass AND contype='c'
  LOOP
    EXECUTE format('ALTER TABLE support_consent DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;

ALTER TABLE support_sessions DROP CONSTRAINT support_sessions_status_check;
-- Run the backfill as the migration owner; RLS is restored before commit.
ALTER TABLE support_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE support_consent NO FORCE ROW LEVEL SECURITY;
ALTER TABLE support_consent ADD COLUMN operator_id uuid;
ALTER TABLE support_consent ADD COLUMN accepted_at timestamptz;
ALTER TABLE support_consent ADD COLUMN decision_origin text;
ALTER TABLE support_consent ADD COLUMN nonce_hash bytea;
ALTER TABLE support_consent ADD COLUMN nonce_issued_at timestamptz;
ALTER TABLE support_consent ADD COLUMN nonce_consumed_at timestamptz;

UPDATE support_consent c
SET operator_id=s.requested_by_user_id,
    status=CASE c.status WHEN 'expired' THEN 'rejected' WHEN 'revoked' THEN 'cancelled' ELSE c.status END,
    accepted_at=CASE WHEN c.status='accepted' THEN c.decided_at ELSE NULL END,
    decision_origin=CASE c.status WHEN 'expired' THEN 'timeout' WHEN 'revoked' THEN 'migration_021' WHEN 'accepted' THEN 'legacy_api' WHEN 'rejected' THEN 'legacy_api' ELSE NULL END,
    nonce_consumed_at=CASE WHEN c.status IN ('accepted','rejected','expired','revoked') THEN coalesce(c.decided_at,now()) ELSE NULL END
FROM support_sessions s
WHERE s.tenant_id=c.tenant_id AND s.id=c.session_id;

-- A pending 020 row has no nonce and cannot be safely accepted after upgrade.
UPDATE support_consent SET status='rejected',decision_origin='migration_021',decided_at=coalesce(decided_at,now()),nonce_consumed_at=coalesce(nonce_consumed_at,now()) WHERE status='pending';
UPDATE support_sessions s SET status='rejected',closed_at=coalesce(s.closed_at,now()),updated_at=now(),revision=s.revision+1
FROM support_consent c WHERE c.tenant_id=s.tenant_id AND c.session_id=s.id AND c.status='rejected'
  AND c.decision_origin IN('migration_021','timeout') AND s.status IN('pending_consent','expired');

ALTER TABLE support_consent ALTER COLUMN operator_id SET NOT NULL;
ALTER TABLE support_consent ADD CONSTRAINT support_consent_operator_fk
  FOREIGN KEY(tenant_id,operator_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE;
ALTER TABLE support_consent ADD CONSTRAINT support_consent_status_check
  CHECK(status IN('pending','accepted','rejected','cancelled'));
ALTER TABLE support_consent ADD CONSTRAINT support_consent_lifecycle_check CHECK(
  (status='pending' AND accepted_at IS NULL AND decided_at IS NULL AND decision_origin IS NULL AND nonce_hash IS NOT NULL AND nonce_consumed_at IS NULL)
  OR (status='accepted' AND accepted_at IS NOT NULL AND decided_at IS NOT NULL AND decision_origin IN('endpoint_api','native_prompt','legacy_api') AND nonce_consumed_at IS NOT NULL AND (nonce_hash IS NOT NULL OR decision_origin='legacy_api'))
  OR (status='rejected' AND accepted_at IS NULL AND decided_at IS NOT NULL AND decision_origin IN('endpoint_api','timeout','migration_021','legacy_api') AND nonce_consumed_at IS NOT NULL)
  OR (status='cancelled' AND accepted_at IS NULL AND decided_at IS NOT NULL AND decision_origin IN('operator_revocation','device_revocation','migration_021') AND nonce_consumed_at IS NOT NULL)
);
ALTER TABLE support_consent ADD CONSTRAINT support_consent_expiry_check CHECK(expires_at>requested_at);
CREATE UNIQUE INDEX support_consent_nonce_hash_uq ON support_consent(nonce_hash) WHERE nonce_hash IS NOT NULL;
CREATE INDEX support_consent_pending_expiry_idx ON support_consent(expires_at,tenant_id,session_id) WHERE status='pending';

ALTER TABLE support_sessions ADD COLUMN engine_provider text;
ALTER TABLE support_sessions ADD COLUMN engine_session_id text;
ALTER TABLE support_sessions ADD COLUMN open_attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE support_sessions ADD COLUMN termination_status text NOT NULL DEFAULT 'not_required';
ALTER TABLE support_sessions ADD COLUMN termination_requested_at timestamptz;
ALTER TABLE support_sessions ADD COLUMN terminated_at timestamptz;
ALTER TABLE support_sessions ADD COLUMN termination_error_code text;
ALTER TABLE support_sessions ADD CONSTRAINT support_sessions_tenant_id_uq UNIQUE(tenant_id,id);
ALTER TABLE support_sessions ADD CONSTRAINT support_sessions_status_check
  CHECK(status IN('pending_consent','consented','opening','active','open_failed','opening_unknown','rejected','expired','revoked','closed'));
ALTER TABLE support_sessions ADD CONSTRAINT support_sessions_open_attempt_count_check CHECK(open_attempt_count BETWEEN 0 AND 3);
ALTER TABLE support_sessions ADD CONSTRAINT support_sessions_termination_status_check
  CHECK(termination_status IN('not_required','pending','confirmed','failed'));
CREATE UNIQUE INDEX support_sessions_engine_session_uq ON support_sessions(engine_provider,engine_session_id)
  WHERE engine_provider IS NOT NULL AND engine_session_id IS NOT NULL;

CREATE TABLE support_session_attempts(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  attempt_number integer NOT NULL,
  operation text NOT NULL CHECK(operation IN('open','terminate')),
  provider text NOT NULL,
  idempotency_key text NOT NULL,
  outcome text NOT NULL CHECK(outcome IN('started','succeeded','failed','unknown')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(tenant_id,session_id,operation,attempt_number),
  FOREIGN KEY(tenant_id,session_id) REFERENCES support_sessions(tenant_id,id) ON DELETE CASCADE,
  CHECK(attempt_number>0 AND (operation='terminate' OR attempt_number<=3)),
  CHECK((outcome='started' AND completed_at IS NULL) OR (outcome<>'started' AND completed_at IS NOT NULL))
);

CREATE TABLE support_session_outbox(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  session_id uuid NOT NULL,
  action text NOT NULL CHECK(action='terminate'),
  idempotency_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
  lease_owner text,
  lease_until timestamptz,
  delivered_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,idempotency_key),
  FOREIGN KEY(tenant_id,session_id) REFERENCES support_sessions(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX support_session_outbox_pending_idx ON support_session_outbox(available_at,id)
  WHERE delivered_at IS NULL;

ALTER POLICY support_sessions_tenant_device ON support_sessions
  USING(tenant_id::text=current_setting('app.tenant_id',true)
    OR device_identity_id::text=current_setting('app.device_id',true)
    OR current_setting('app.worker_role',true)='support_dispatch')
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true)
    OR device_identity_id::text=current_setting('app.device_id',true)
    OR current_setting('app.worker_role',true)='support_dispatch');
ALTER POLICY support_consent_tenant_device ON support_consent
  USING(tenant_id::text=current_setting('app.tenant_id',true)
    OR device_id::text=current_setting('app.device_id',true)
    OR current_setting('app.worker_role',true)='support_dispatch')
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true)
    OR device_id::text=current_setting('app.device_id',true)
    OR current_setting('app.worker_role',true)='support_dispatch');

ALTER TABLE support_session_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_session_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY support_session_attempts_tenant_device_worker ON support_session_attempts
  USING(tenant_id::text=current_setting('app.tenant_id',true)
    OR EXISTS(SELECT 1 FROM support_sessions s WHERE s.tenant_id=support_session_attempts.tenant_id AND s.id=support_session_attempts.session_id AND s.device_identity_id::text=current_setting('app.device_id',true))
    OR current_setting('app.worker_role',true)='support_dispatch')
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true)
    OR EXISTS(SELECT 1 FROM support_sessions s WHERE s.tenant_id=support_session_attempts.tenant_id AND s.id=support_session_attempts.session_id AND s.device_identity_id::text=current_setting('app.device_id',true))
    OR current_setting('app.worker_role',true)='support_dispatch');

ALTER TABLE support_session_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_session_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY support_session_outbox_tenant_worker ON support_session_outbox
  USING(tenant_id::text=current_setting('app.tenant_id',true) OR current_setting('app.worker_role',true)='support_dispatch')
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) OR current_setting('app.worker_role',true)='support_dispatch');

ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE support_consent FORCE ROW LEVEL SECURITY;

COMMIT;
