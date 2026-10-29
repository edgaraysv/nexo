BEGIN;

CREATE POLICY endpoint_subscription_catalog ON subscriptions
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND current_setting('app.device_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM device_identities
      WHERE device_identities.id::text = current_setting('app.device_id', true)
        AND device_identities.tenant_id = subscriptions.tenant_id
        AND device_identities.status = 'approved'
    )
  );

CREATE POLICY endpoint_subscription_module_catalog ON subscription_modules
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND current_setting('app.device_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM device_identities
      WHERE device_identities.id::text = current_setting('app.device_id', true)
        AND device_identities.tenant_id = subscription_modules.tenant_id
        AND device_identities.status = 'approved'
    )
  );

CREATE POLICY endpoint_plan_catalog ON plans
  FOR SELECT
  USING (
    current_setting('app.device_id', true) <> ''
    AND EXISTS (
      SELECT 1
      FROM subscriptions
      WHERE subscriptions.plan_id = plans.id
        AND subscriptions.tenant_id::text = current_setting('app.tenant_id', true)
        AND EXISTS (
          SELECT 1 FROM device_identities
          WHERE device_identities.id::text = current_setting('app.device_id', true)
            AND device_identities.tenant_id = subscriptions.tenant_id
            AND device_identities.status = 'approved'
        )
    )
  );

CREATE POLICY endpoint_vpn_environment_catalog ON vpn_environments
  FOR SELECT
  USING (
    tenant_id::text = current_setting('app.tenant_id', true)
    AND current_setting('app.device_id', true) <> ''
    AND EXISTS (
      SELECT 1 FROM device_identities
      WHERE device_identities.id::text = current_setting('app.device_id', true)
        AND device_identities.tenant_id = vpn_environments.tenant_id
        AND device_identities.status = 'approved'
    )
  );

COMMIT;
