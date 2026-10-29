BEGIN;

DROP POLICY IF EXISTS users_isolation ON users;
CREATE POLICY users_isolation ON users
  USING (
    id::text = current_setting('app.user_id', true)
    OR email = current_setting('app.auth_email', true)
    OR id IN (SELECT user_id FROM memberships WHERE tenant_id::text = current_setting('app.tenant_id', true))
    OR (
      current_setting('app.provider_role', true) = 'owner'
      AND id IN (SELECT user_id FROM provider_users)
    )
  );

DROP POLICY IF EXISTS provider_assignments ON provider_company_assignments;

CREATE POLICY provider_assignments_read ON provider_company_assignments
  FOR SELECT
  USING (
    user_id::text = current_setting('app.user_id', true)
    OR current_setting('app.provider_role', true) = 'owner'
  );

CREATE POLICY provider_assignments_owner_insert ON provider_company_assignments
  FOR INSERT
  WITH CHECK (current_setting('app.provider_role', true) = 'owner');

CREATE POLICY provider_assignments_owner_delete ON provider_company_assignments
  FOR DELETE
  USING (current_setting('app.provider_role', true) = 'owner');

COMMIT;
