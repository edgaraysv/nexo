-- L02 identity baseline. Apply with a migration runner as the schema owner.
-- The runtime role must be a separate NOLOGIN/NOSUPERUSER/NOBYPASSRLS role.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 320 AND email = lower(email)),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'disabled')),
  mfa_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'suspended', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS permissions (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id text NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS membership_roles (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES memberships(tenant_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('totp')),
  secret_ciphertext bytea NOT NULL,
  enabled_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 3 AND 128),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 80),
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id, status);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, revoked_at, expires_at);
CREATE INDEX IF NOT EXISTS recovery_user_idx ON recovery_tokens(user_id, expires_at);
CREATE INDEX IF NOT EXISTS audit_tenant_time_idx ON audit_events(tenant_id, created_at DESC);

-- Tenant context is set only by a trusted transaction wrapper. An absent or
-- malformed context matches no row; the browser cannot establish authority.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors FORCE ROW LEVEL SECURITY;
ALTER TABLE recovery_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE recovery_tokens FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants USING (
  id::text = current_setting('app.tenant_id', true)
  OR id IN (SELECT tenant_id FROM memberships WHERE user_id::text = current_setting('app.user_id', true))
);
DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users USING (
  id::text = current_setting('app.user_id', true)
  OR email = current_setting('app.auth_email', true)
  OR id IN (SELECT user_id FROM memberships WHERE tenant_id::text = current_setting('app.tenant_id', true))
);
DROP POLICY IF EXISTS memberships_isolation ON memberships;
CREATE POLICY memberships_isolation ON memberships USING (
  tenant_id::text = current_setting('app.tenant_id', true)
  OR user_id::text = current_setting('app.user_id', true)
);
DROP POLICY IF EXISTS roles_isolation ON roles;
CREATE POLICY roles_isolation ON roles USING (tenant_id::text = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS role_permissions_isolation ON role_permissions;
CREATE POLICY role_permissions_isolation ON role_permissions USING (role_id IN (SELECT id FROM roles));
DROP POLICY IF EXISTS membership_roles_isolation ON membership_roles;
CREATE POLICY membership_roles_isolation ON membership_roles USING (tenant_id::text = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS sessions_isolation ON sessions;
CREATE POLICY sessions_isolation ON sessions USING (
  tenant_id::text = current_setting('app.tenant_id', true)
  OR user_id::text = current_setting('app.user_id', true)
  OR encode(token_hash, 'hex') = current_setting('app.session_hash', true)
);
DROP POLICY IF EXISTS audit_isolation ON audit_events;
CREATE POLICY audit_isolation ON audit_events USING (tenant_id::text = current_setting('app.tenant_id', true));
DROP POLICY IF EXISTS mfa_isolation ON mfa_factors;
CREATE POLICY mfa_isolation ON mfa_factors USING (user_id::text = current_setting('app.user_id', true));
DROP POLICY IF EXISTS recovery_isolation ON recovery_tokens;
CREATE POLICY recovery_isolation ON recovery_tokens USING (
  user_id::text = current_setting('app.user_id', true)
  OR encode(token_hash, 'hex') = current_setting('app.recovery_hash', true)
);

COMMIT;
