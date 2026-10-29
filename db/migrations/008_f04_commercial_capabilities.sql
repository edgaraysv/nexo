BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN valid_from timestamptz,
  ADD COLUMN valid_until timestamptz,
  ADD CONSTRAINT subscriptions_validity_check CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from);

CREATE TABLE subscription_modules (
  tenant_id uuid NOT NULL REFERENCES subscriptions(tenant_id) ON DELETE CASCADE,
  module text NOT NULL CHECK (module ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  state text NOT NULL CHECK (state IN ('active','suspended')),
  valid_from timestamptz,
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,module),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE quota_exceptions (
  tenant_id uuid NOT NULL REFERENCES subscriptions(tenant_id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  limit_value integer NOT NULL CHECK (limit_value >= 0),
  valid_from timestamptz,
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,resource),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from)
);

CREATE TABLE quota_reservations (
  tenant_id uuid NOT NULL REFERENCES subscriptions(tenant_id) ON DELETE CASCADE,
  resource text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  amount integer NOT NULL CHECK (amount > 0),
  resulting_used integer NOT NULL CHECK (resulting_used >= 0),
  resulting_limit integer NOT NULL CHECK (resulting_limit >= 0),
  actor_user_id uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,resource,idempotency_key)
);

CREATE TABLE manual_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES subscriptions(tenant_id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 160),
  paid_at timestamptz NOT NULL,
  recorded_by uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,idempotency_key)
);

ALTER TABLE subscription_modules ENABLE ROW LEVEL SECURITY; ALTER TABLE subscription_modules FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_exceptions ENABLE ROW LEVEL SECURITY; ALTER TABLE quota_exceptions FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE quota_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE manual_payments ENABLE ROW LEVEL SECURITY; ALTER TABLE manual_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_subscription_modules ON subscription_modules USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_quota_exceptions ON quota_exceptions USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_quota_reservations ON quota_reservations USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_manual_payments ON manual_payments USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);

COMMIT;
