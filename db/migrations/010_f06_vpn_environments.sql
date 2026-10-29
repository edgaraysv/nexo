BEGIN;

CREATE TABLE vpn_environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  node_id uuid NOT NULL REFERENCES provider_nodes(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  engine text NOT NULL CHECK (engine='openvpn'),
  protocol text NOT NULL CHECK (protocol='udp'),
  listener_port integer NOT NULL CHECK (listener_port BETWEEN 1024 AND 65535),
  tunnel_ipv4_cidr cidr NOT NULL CHECK (
    family(tunnel_ipv4_cidr)=4
    AND masklen(tunnel_ipv4_cidr) BETWEEN 16 AND 30
    AND (tunnel_ipv4_cidr <<= '10.0.0.0/8'::cidr OR tunnel_ipv4_cidr <<= '172.16.0.0/12'::cidr OR tunnel_ipv4_cidr <<= '192.168.0.0/16'::cidr)
  ),
  ipv6_enabled boolean NOT NULL DEFAULT false CHECK (ipv6_enabled=false),
  namespace_name text NOT NULL UNIQUE CHECK (namespace_name ~ '^nexo-[a-f0-9]{12}$'),
  desired_state text NOT NULL CHECK (desired_state IN ('active','suspended','retired')),
  observed_state text NOT NULL DEFAULT 'pending' CHECK (observed_state IN ('pending','provisioning','active','suspended','error','retired')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  applied_revision bigint CHECK (applied_revision IS NULL OR applied_revision > 0 AND applied_revision <= revision),
  config_digest text CHECK (config_digest IS NULL OR config_digest ~ '^[a-f0-9]{64}$'),
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  created_by uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,name),
  UNIQUE (tenant_id,id)
);

CREATE TABLE vpn_environment_revisions (
  environment_id uuid NOT NULL REFERENCES vpn_environments(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  desired_state text NOT NULL CHECK (desired_state IN ('active','suspended','retired')),
  specification jsonb NOT NULL,
  requested_by uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id,revision),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT,
  CHECK (jsonb_typeof(specification)='object')
);

ALTER TABLE vpn_environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE vpn_environments FORCE ROW LEVEL SECURITY;
ALTER TABLE vpn_environment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vpn_environment_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY provider_vpn_environments ON vpn_environments USING (
  current_setting('app.provider_role',true)='owner'
  OR (current_setting('app.worker_role',true)='operation_dispatch' AND node_id::text=current_setting('app.node_id',true))
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY provider_vpn_environment_revisions ON vpn_environment_revisions USING (
  current_setting('app.provider_role',true)='owner'
  OR tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);

CREATE INDEX vpn_environments_tenant_state_idx ON vpn_environments(tenant_id,desired_state,observed_state);
CREATE INDEX vpn_environments_node_state_idx ON vpn_environments(node_id,desired_state,observed_state);
CREATE UNIQUE INDEX vpn_environments_active_node_port_uidx ON vpn_environments(node_id,listener_port) WHERE desired_state<>'retired';

COMMIT;
