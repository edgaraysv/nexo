BEGIN;

INSERT INTO permissions(id,description) VALUES
  ('company.network.read','Consultar sucursales, recursos y políticas de red'),
  ('company.network.manage','Administrar sucursales, recursos y políticas de red'),
  ('company.network.diagnose','Evaluar el recorrido configurado hacia un recurso privado')
ON CONFLICT(id) DO UPDATE SET description=excluded.description;

WITH defaults(role_name,permission_id) AS (VALUES
  ('company.admin','company.network.read'),('company.admin','company.network.manage'),('company.admin','company.network.diagnose'),
  ('company.technician','company.network.read'),('company.technician','company.network.manage'),('company.technician','company.network.diagnose'),
  ('company.auditor','company.network.read'),
  ('company.viewer','company.network.read')
)
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,d.permission_id FROM roles r JOIN defaults d ON d.role_name=r.name
ON CONFLICT DO NOTHING;

CREATE POLICY company_vpn_environment_reference ON vpn_environments FOR SELECT USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  AND EXISTS(SELECT 1 FROM memberships m WHERE m.tenant_id=vpn_environments.tenant_id AND m.user_id::text=current_setting('app.user_id',true) AND m.status='active')
);

CREATE TABLE private_network_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  site_id uuid NOT NULL,
  vpn_environment_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  path_mode text NOT NULL CHECK(path_mode IN('direct','gateway')),
  gateway_device_id uuid,
  return_mode text NOT NULL CHECK(return_mode IN('routed','snat')),
  dns_mode text NOT NULL CHECK(dns_mode IN('local','split')),
  dns_servers inet[] NOT NULL DEFAULT '{}',
  dns_suffixes text[] NOT NULL DEFAULT '{}',
  desired_state text NOT NULL DEFAULT 'active' CHECK(desired_state IN('active','suspended','retired')),
  observed_state text NOT NULL DEFAULT 'pending' CHECK(observed_state IN('pending','applying','active','error','suspended','retired')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  applied_revision bigint CHECK(applied_revision IS NULL OR applied_revision>0 AND applied_revision<=revision),
  config_digest text CHECK(config_digest IS NULL OR config_digest ~ '^[a-f0-9]{64}$'),
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,site_id) REFERENCES sites(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,vpn_environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,gateway_device_id) REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK((path_mode='direct' AND gateway_device_id IS NULL AND return_mode='routed') OR (path_mode='gateway' AND gateway_device_id IS NOT NULL)),
  CHECK((dns_mode='local' AND cardinality(dns_servers)=0 AND cardinality(dns_suffixes)=0) OR (dns_mode='split' AND cardinality(dns_servers) BETWEEN 1 AND 4 AND cardinality(dns_suffixes) BETWEEN 1 AND 8)),
  UNIQUE(tenant_id,id)
);
CREATE UNIQUE INDEX private_network_profiles_site_active_uidx ON private_network_profiles(tenant_id,site_id) WHERE desired_state<>'retired';

CREATE TABLE private_network_device_observations (
  tenant_id uuid NOT NULL,profile_id uuid NOT NULL,device_id uuid NOT NULL,
  revision bigint NOT NULL CHECK(revision>0),observed_state text NOT NULL CHECK(observed_state IN('applying','active','error','suspended','retired')),
  config_digest text CHECK(config_digest IS NULL OR config_digest ~ '^[a-f0-9]{64}$'),error_code text CHECK(error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,device_id),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES private_network_profiles(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,device_id) REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE private_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,profile_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),kind text NOT NULL CHECK(kind IN('ipv4','hostname')),
  address text NOT NULL CHECK(length(address) BETWEEN 1 AND 253),status text NOT NULL DEFAULT 'active' CHECK(status IN('active','retired')),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES private_network_profiles(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE(tenant_id,id),UNIQUE(profile_id,name)
);
CREATE TABLE private_network_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,profile_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),effect text NOT NULL CHECK(effect IN('allow','deny')),
  source_kind text NOT NULL CHECK(source_kind IN('any_endpoint','device')),source_device_id uuid,
  resource_id uuid NOT NULL,protocol text NOT NULL CHECK(protocol IN('tcp','udp')),
  port_start integer NOT NULL CHECK(port_start BETWEEN 1 AND 65535),port_end integer NOT NULL CHECK(port_end BETWEEN 1 AND 65535 AND port_end>=port_start),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','active','retired')),revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES private_network_profiles(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,resource_id) REFERENCES private_resources(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,source_device_id) REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK((source_kind='any_endpoint' AND source_device_id IS NULL) OR (source_kind='device' AND source_device_id IS NOT NULL))
);
CREATE TABLE private_network_profile_revisions (
  profile_id uuid NOT NULL,tenant_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),specification jsonb NOT NULL CHECK(jsonb_typeof(specification)='object'),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(profile_id,revision),
  FOREIGN KEY(tenant_id,profile_id) REFERENCES private_network_profiles(tenant_id,id) ON DELETE RESTRICT
);

ALTER TABLE private_network_profiles ENABLE ROW LEVEL SECURITY;ALTER TABLE private_network_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE private_network_device_observations ENABLE ROW LEVEL SECURITY;ALTER TABLE private_network_device_observations FORCE ROW LEVEL SECURITY;
ALTER TABLE private_resources ENABLE ROW LEVEL SECURITY;ALTER TABLE private_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE private_network_policies ENABLE ROW LEVEL SECURITY;ALTER TABLE private_network_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE private_network_profile_revisions ENABLE ROW LEVEL SECURITY;ALTER TABLE private_network_profile_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY private_network_profiles_scope ON private_network_profiles USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY private_network_device_observations_scope ON private_network_device_observations USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY private_resources_scope ON private_resources USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY private_network_policies_scope ON private_network_policies USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));
CREATE POLICY private_network_profile_revisions_scope ON private_network_profile_revisions USING(tenant_id::text=current_setting('app.tenant_id',true)) WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));

CREATE INDEX private_resources_profile_idx ON private_resources(profile_id,status);
CREATE INDEX private_network_policies_lookup_idx ON private_network_policies(profile_id,resource_id,status,protocol,port_start,port_end);
COMMIT;
