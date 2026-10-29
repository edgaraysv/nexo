BEGIN;

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,code),
  UNIQUE(tenant_id,id)
);

CREATE TABLE site_networks (
  tenant_id uuid NOT NULL,
  site_id uuid NOT NULL,
  network cidr NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,site_id,network),
  FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE CASCADE,
  CHECK (
    network <<= '10.0.0.0/8'::cidr
    OR network <<= '172.16.0.0/12'::cidr
    OR network <<= '192.168.0.0/16'::cidr
    OR network <<= 'fc00::/7'::cidr
  )
);

CREATE TABLE declared_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  platform text NOT NULL CHECK (platform IN ('windows','linux','macos','gateway','unknown')),
  status text NOT NULL DEFAULT 'declared' CHECK (status IN ('declared','pending','approved','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE company_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email=lower(email)),
  role_name text NOT NULL CHECK (role_name IN ('company.admin','company.technician','company.viewer')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  invited_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at>created_at)
);

CREATE TABLE access_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  effect text NOT NULL CHECK (effect IN ('allow','deny')),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.:-]{2,127}$'),
  resource_type text NOT NULL CHECK (resource_type ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  valid_from timestamptz,
  valid_until timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until>valid_from)
);

ALTER TABLE sites ENABLE ROW LEVEL SECURITY; ALTER TABLE sites FORCE ROW LEVEL SECURITY;
ALTER TABLE site_networks ENABLE ROW LEVEL SECURITY; ALTER TABLE site_networks FORCE ROW LEVEL SECURITY;
ALTER TABLE declared_devices ENABLE ROW LEVEL SECURITY; ALTER TABLE declared_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE company_invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE company_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE access_policies ENABLE ROW LEVEL SECURITY; ALTER TABLE access_policies FORCE ROW LEVEL SECURITY;

CREATE POLICY sites_tenant ON sites USING (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY site_networks_tenant ON site_networks USING (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY devices_tenant ON declared_devices USING (tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY invitations_tenant ON company_invitations USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  OR encode(token_hash,'hex')=current_setting('app.invitation_hash',true)
);
CREATE POLICY policies_tenant ON access_policies USING (tenant_id::text=current_setting('app.tenant_id',true));

CREATE INDEX company_invitations_tenant_email_idx ON company_invitations(tenant_id,email,expires_at);
CREATE INDEX declared_devices_tenant_site_idx ON declared_devices(tenant_id,site_id);
CREATE INDEX access_policies_tenant_status_idx ON access_policies(tenant_id,status);

COMMIT;
