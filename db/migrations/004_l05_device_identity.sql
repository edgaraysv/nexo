BEGIN;

CREATE POLICY quota_tenant_registration ON quota_counters USING (
  tenant_id::text=current_setting('app.tenant_id',true)
);

CREATE TABLE device_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  token_hash bytea NOT NULL UNIQUE,
  device_kind text NOT NULL CHECK (device_kind IN ('endpoint','gateway')),
  audience text NOT NULL DEFAULT 'endpoint' CHECK (audience='endpoint'),
  uses_remaining integer NOT NULL CHECK (uses_remaining BETWEEN 0 AND 100),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE RESTRICT,
  CHECK(expires_at>created_at)
);

CREATE TABLE device_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  invitation_id uuid NOT NULL REFERENCES device_invitations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  device_kind text NOT NULL CHECK(device_kind IN ('endpoint','gateway')),
  audience text NOT NULL CHECK(audience='endpoint'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','revoked')),
  public_key_pem text NOT NULL,
  key_fingerprint text NOT NULL,
  claim_token_hash bytea NOT NULL UNIQUE,
  proof_verified_at timestamptz,
  approved_at timestamptz,
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,key_fingerprint),
  UNIQUE(tenant_id,id),
  FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE device_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK(purpose IN ('enrollment','authentication')),
  nonce_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at>created_at)
);

CREATE TABLE device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  serial text NOT NULL UNIQUE,
  certificate_pem text NOT NULL,
  not_before timestamptz NOT NULL,
  not_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','rotated','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,device_id) REFERENCES device_identities(tenant_id,id) ON DELETE CASCADE,
  CHECK(not_after>not_before)
);

CREATE TABLE device_sessions (
  token_hash bytea PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,device_id) REFERENCES device_identities(tenant_id,id) ON DELETE CASCADE,
  CHECK(expires_at>created_at)
);

ALTER TABLE device_invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE device_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE device_identities ENABLE ROW LEVEL SECURITY; ALTER TABLE device_identities FORCE ROW LEVEL SECURITY;
ALTER TABLE device_challenges ENABLE ROW LEVEL SECURITY; ALTER TABLE device_challenges FORCE ROW LEVEL SECURITY;
ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE device_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY device_invitation_scope ON device_invitations USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  OR encode(token_hash,'hex')=current_setting('app.device_invitation_hash',true)
);
CREATE POLICY device_identity_scope ON device_identities USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  OR id::text=current_setting('app.device_id',true)
);
CREATE POLICY device_challenge_scope ON device_challenges USING (
  device_id::text=current_setting('app.device_id',true)
);
CREATE POLICY device_credential_scope ON device_credentials USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  OR device_id::text=current_setting('app.device_id',true)
);
CREATE POLICY device_session_scope ON device_sessions USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  OR device_id::text=current_setting('app.device_id',true)
  OR encode(token_hash,'hex')=current_setting('app.device_session_hash',true)
);

CREATE INDEX device_identity_tenant_status_idx ON device_identities(tenant_id,status);
CREATE INDEX device_challenge_device_idx ON device_challenges(device_id,purpose,expires_at);
CREATE INDEX device_credential_device_idx ON device_credentials(device_id,status,not_after);

COMMIT;
