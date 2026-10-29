BEGIN;

ALTER TABLE sessions ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope_kind text NOT NULL DEFAULT 'tenant' CHECK (scope_kind IN ('tenant','provider'));
ALTER TABLE sessions ADD CONSTRAINT sessions_scope_check CHECK (
  (scope_kind='tenant' AND tenant_id IS NOT NULL) OR (scope_kind='provider' AND tenant_id IS NULL)
);

CREATE TABLE provider_users (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','operator','auditor')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','revoked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE provider_company_assignments (
  user_id uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,tenant_id)
);

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  modules jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(modules)='object'),
  quotas jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quotas)='object'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('pending','active','grace','suspended','cancelled')),
  module_states jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(module_states)='object'),
  quota_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quota_overrides)='object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quota_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  resource text NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  limit_value integer NOT NULL CHECK (limit_value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,resource)
);

CREATE TABLE provider_settings (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{2,127}$'),
  value jsonb,
  secret_ref text,
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal','secret_ref')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sensitivity='normal' AND value IS NOT NULL AND secret_ref IS NULL) OR (sensitivity='secret_ref' AND value IS NULL AND secret_ref IS NOT NULL))
);

CREATE TABLE provider_audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  tenant_id uuid REFERENCES tenants(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(action) BETWEEN 3 AND 128),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 80),
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DROP POLICY tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants USING (
  id::text = current_setting('app.tenant_id', true)
  OR id IN (SELECT tenant_id FROM memberships WHERE user_id::text = current_setting('app.user_id', true))
  OR current_setting('app.provider_role',true)='owner'
  OR id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);

ALTER TABLE provider_users ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_users FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_company_assignments ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_company_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY; ALTER TABLE plans FORCE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY; ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE quota_counters ENABLE ROW LEVEL SECURITY; ALTER TABLE quota_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_settings ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE provider_audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_audit_events FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_self ON provider_users USING (user_id::text=current_setting('app.user_id',true) OR current_setting('app.provider_role',true)='owner');
CREATE POLICY provider_assignments ON provider_company_assignments USING (
  user_id::text=current_setting('app.user_id',true)
  OR current_setting('app.provider_role',true)='owner'
);
CREATE POLICY provider_plans ON plans USING (
  current_setting('app.provider_role',true) IN ('owner','operator','auditor')
);
CREATE POLICY provider_subscriptions ON subscriptions USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_quotas ON quota_counters USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_settings_owner ON provider_settings USING (
  current_setting('app.provider_role',true)='owner'
);
CREATE POLICY provider_audit_visible ON provider_audit_events USING (
  actor_user_id::text=current_setting('app.user_id',true)
  OR current_setting('app.provider_role',true) IN ('owner','auditor')
);

COMMIT;
