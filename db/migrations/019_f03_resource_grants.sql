BEGIN;

-- Resource grants are a second authorization boundary: role permissions still
-- apply, but do not by themselves grant access to any particular device.
ALTER TABLE declared_devices
  ADD CONSTRAINT declared_devices_tenant_id_id_unique UNIQUE (tenant_id,id);

INSERT INTO permissions(id,description)
VALUES('company.resource_grant.manage','Asignar y revocar permisos por recurso empresarial')
ON CONFLICT(id) DO UPDATE SET description=excluded.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT id,'company.resource_grant.manage'
FROM roles
WHERE name='company.admin' AND tenant_id IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE TABLE resource_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  resource_type text NOT NULL CHECK(resource_type IN ('declared_device','device_identity')),
  resource_id uuid NOT NULL,
  declared_device_id uuid,
  device_identity_id uuid,
  permission_id text NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  granted_by uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(tenant_id,user_id,resource_type,resource_id,permission_id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,granted_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,revoked_by) REFERENCES memberships(tenant_id,user_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,declared_device_id) REFERENCES declared_devices(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,device_identity_id) REFERENCES device_identities(tenant_id,id) ON DELETE CASCADE,
  CHECK(valid_until IS NULL OR valid_until>valid_from),
  CHECK((revoked_at IS NULL)=(revoked_by IS NULL)),
  CHECK(
    (resource_type='declared_device' AND declared_device_id IS NOT NULL AND declared_device_id=resource_id AND device_identity_id IS NULL AND permission_id='company.device.read')
    OR
    (resource_type='device_identity' AND device_identity_id IS NOT NULL AND device_identity_id=resource_id AND declared_device_id IS NULL AND permission_id IN (
      'company.agent.read','company.agent.approve','company.agent.revoke',
      'company.operation.read','company.operation.create',
      'company.network.manage','company.network.diagnose'
    ))
  )
);

ALTER TABLE resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE resource_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY resource_grants_tenant ON resource_grants
  USING(tenant_id::text=current_setting('app.tenant_id',true))
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true));

CREATE INDEX resource_grants_user_action_idx
  ON resource_grants(tenant_id,user_id,resource_type,permission_id,resource_id)
  WHERE revoked_at IS NULL;

COMMIT;
