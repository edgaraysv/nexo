BEGIN;

INSERT INTO permissions(id,description)
VALUES('company.support.start','Solicitar soporte asistido en un dispositivo autorizado')
ON CONFLICT(id) DO UPDATE SET description=excluded.description;

INSERT INTO role_permissions(role_id,permission_id)
SELECT id,'company.support.start'
FROM roles
WHERE name IN ('company.admin','company.technician') AND tenant_id IS NOT NULL
ON CONFLICT DO NOTHING;

DO $$
DECLARE grant_constraint text;
BEGIN
  SELECT conname INTO grant_constraint
  FROM pg_constraint
  WHERE conrelid='resource_grants'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%company.agent.read%'
  LIMIT 1;
  IF grant_constraint IS NULL THEN
    RAISE EXCEPTION 'resource_grants permission constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE resource_grants DROP CONSTRAINT %I',grant_constraint);
END $$;

ALTER TABLE resource_grants ADD CONSTRAINT resource_grants_permission_scope CHECK(
  (resource_type='declared_device' AND declared_device_id IS NOT NULL AND declared_device_id=resource_id AND device_identity_id IS NULL AND permission_id='company.device.read')
  OR
  (resource_type='device_identity' AND device_identity_id IS NOT NULL AND device_identity_id=resource_id AND declared_device_id IS NULL AND permission_id IN (
    'company.agent.read','company.agent.approve','company.agent.revoke',
    'company.operation.read','company.operation.create','company.support.start',
    'company.network.manage','company.network.diagnose'
  ))
);

-- Company membership may read only its own contract/module state. This does
-- not grant commercial mutation permissions or expose another tenant's plan.
CREATE POLICY company_subscription_entitlement ON subscriptions
  FOR SELECT USING(
    tenant_id::text=current_setting('app.tenant_id',true)
    AND EXISTS(
      SELECT 1 FROM memberships m
      WHERE m.tenant_id=subscriptions.tenant_id
        AND m.user_id::text=current_setting('app.user_id',true)
        AND m.status='active'
    )
  );

CREATE POLICY company_subscription_module_entitlement ON subscription_modules
  FOR SELECT USING(
    tenant_id::text=current_setting('app.tenant_id',true)
    AND EXISTS(
      SELECT 1 FROM memberships m
      WHERE m.tenant_id=subscription_modules.tenant_id
        AND m.user_id::text=current_setting('app.user_id',true)
        AND m.status='active'
    )
  );

CREATE POLICY company_plan_entitlement ON plans
  FOR SELECT USING(
    EXISTS(
      SELECT 1 FROM subscriptions s
      JOIN memberships m ON m.tenant_id=s.tenant_id
      WHERE s.plan_id=plans.id
        AND s.tenant_id::text=current_setting('app.tenant_id',true)
        AND m.user_id::text=current_setting('app.user_id',true)
        AND m.status='active'
    )
  );

CREATE TABLE support_sessions(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_identity_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  mode text NOT NULL CHECK(mode='assisted'),
  capabilities text[] NOT NULL CHECK(
    cardinality(capabilities) BETWEEN 1 AND 4
    AND capabilities <@ ARRAY['screen','terminal','files','clipboard']::text[]
  ),
  status text NOT NULL CHECK(status IN('pending_consent','consented','rejected','expired','revoked','closed')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  consent_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id,device_identity_id),
  FOREIGN KEY(tenant_id,device_identity_id) REFERENCES device_identities(tenant_id,id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,requested_by_user_id) REFERENCES memberships(tenant_id,user_id) ON DELETE CASCADE,
  CHECK(consent_expires_at>requested_at AND expires_at>consent_expires_at)
);

CREATE TABLE support_consent(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  support_session_id uuid NOT NULL,
  device_identity_id uuid NOT NULL,
  decision text NOT NULL CHECK(decision IN('pending','accepted','rejected','expired','revoked')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  responded_by_device_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  UNIQUE(tenant_id,support_session_id),
  FOREIGN KEY(tenant_id,support_session_id,device_identity_id)
    REFERENCES support_sessions(tenant_id,id,device_identity_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,responded_by_device_id)
    REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT,
  CHECK(expires_at>requested_at),
  CHECK(
    (decision='pending' AND responded_at IS NULL AND responded_by_device_id IS NULL)
    OR (decision IN('accepted','rejected') AND responded_at IS NOT NULL AND responded_by_device_id=device_identity_id)
    OR (decision IN('expired','revoked') AND responded_at IS NOT NULL)
  )
);

ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY support_sessions_tenant_device ON support_sessions
  USING(tenant_id::text=current_setting('app.tenant_id',true) OR device_identity_id::text=current_setting('app.device_id',true))
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) OR device_identity_id::text=current_setting('app.device_id',true));

ALTER TABLE support_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY support_consent_tenant_device ON support_consent
  USING(tenant_id::text=current_setting('app.tenant_id',true) OR device_identity_id::text=current_setting('app.device_id',true))
  WITH CHECK(tenant_id::text=current_setting('app.tenant_id',true) OR device_identity_id::text=current_setting('app.device_id',true));

CREATE INDEX support_sessions_device_status_idx ON support_sessions(tenant_id,device_identity_id,status,requested_at);
CREATE INDEX support_sessions_requester_idx ON support_sessions(tenant_id,requested_by_user_id,requested_at DESC);

COMMIT;
