BEGIN;

ALTER TABLE node_operations DROP CONSTRAINT node_operations_type_check;
ALTER TABLE node_operations
  ADD COLUMN arguments jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(arguments)='object'),
  ADD COLUMN requested_device_id uuid REFERENCES device_identities(id) ON DELETE RESTRICT;
ALTER TABLE node_operations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE node_operations ADD CONSTRAINT node_operations_type_check CHECK (
  type IN ('node.runtime_info.v1','vpn.client_certificate.issue.v1','vpn.client_certificate.revoke.v1')
);
ALTER TABLE node_operations ADD CONSTRAINT node_operations_requester_check CHECK (
  (created_by IS NOT NULL AND requested_device_id IS NULL)
  OR (created_by IS NULL AND requested_device_id IS NOT NULL)
);

DROP POLICY node_ops_scope ON node_operations;
CREATE POLICY node_ops_scope ON node_operations USING (
  current_setting('app.provider_role',true) IN ('owner','operator','auditor')
  OR target_node_id::text=current_setting('app.node_id',true)
  OR requested_device_id::text=current_setting('app.device_id',true)
  OR current_setting('app.worker_role',true)='operation_dispatch'
);

CREATE POLICY endpoint_vpn_credential_node ON provider_nodes FOR SELECT USING (
  status='approved'
  AND current_setting('app.device_id',true)<>''
  AND EXISTS (
    SELECT 1 FROM vpn_environments e
    WHERE e.node_id=provider_nodes.id
      AND e.tenant_id::text=current_setting('app.tenant_id',true)
  )
);

CREATE POLICY node_vpn_credential_environment ON vpn_environments FOR SELECT USING (
  current_setting('app.node_id',true)<>''
  AND node_id::text=current_setting('app.node_id',true)
);

CREATE TABLE vpn_client_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  issue_operation_id uuid NOT NULL UNIQUE REFERENCES node_operations(id) ON DELETE RESTRICT,
  revoke_operation_id uuid UNIQUE REFERENCES node_operations(id) ON DELETE RESTRICT,
  csr_sha256 bytea NOT NULL CHECK (octet_length(csr_sha256)=32),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','issued','revocation_pending','revoked','failed')),
  serial text UNIQUE,
  certificate_pem text,
  ca_certificate_pem text,
  not_before timestamptz,
  not_after timestamptz,
  error_code text CHECK (error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id,device_id) REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (tenant_id,device_id,environment_id),
  CHECK ((state IN ('pending','failed') AND serial IS NULL AND certificate_pem IS NULL AND ca_certificate_pem IS NULL AND not_before IS NULL AND not_after IS NULL)
    OR (state IN ('issued','revocation_pending','revoked') AND serial IS NOT NULL AND certificate_pem IS NOT NULL AND ca_certificate_pem IS NOT NULL AND not_before IS NOT NULL AND not_after IS NOT NULL)),
  CHECK (not_after IS NULL OR not_after>not_before)
);

ALTER TABLE vpn_client_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE vpn_client_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY endpoint_vpn_client_credentials ON vpn_client_credentials USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  AND device_id::text=current_setting('app.device_id',true)
);
CREATE POLICY provider_vpn_client_credentials ON vpn_client_credentials USING (
  current_setting('app.provider_role',true)='owner'
);
CREATE POLICY node_vpn_client_credentials ON vpn_client_credentials USING (
  EXISTS (
    SELECT 1 FROM vpn_environments e
    WHERE e.id=vpn_client_credentials.environment_id
      AND e.node_id::text=current_setting('app.node_id',true)
  )
);
CREATE INDEX vpn_client_credentials_environment_state_idx ON vpn_client_credentials(environment_id,state);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexo_runtime') THEN
    GRANT SELECT,INSERT,UPDATE ON vpn_client_credentials TO nexo_runtime;
  END IF;
END $$;

COMMIT;
