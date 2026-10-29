BEGIN;

-- Explicit export authorization. Deliberately do not add role_permissions rows:
-- no company role receives export access by default.
INSERT INTO permissions(id, description)
VALUES ('company.report.export', 'Exportar datos de reportes empresariales autorizados')
ON CONFLICT (id) DO UPDATE SET description = excluded.description;

-- Provider-side agents also produce operational events. Keep human attribution
-- explicit and never attribute a node/device result to the user who requested it.
ALTER TABLE provider_audit_events ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE provider_audit_events ADD COLUMN IF NOT EXISTS actor_kind text NOT NULL DEFAULT 'user';
ALTER TABLE provider_audit_events ADD COLUMN IF NOT EXISTS actor_id text;
UPDATE provider_audit_events SET actor_id=actor_user_id::text WHERE actor_id IS NULL;
ALTER TABLE provider_audit_events ALTER COLUMN actor_id SET NOT NULL;

-- Keep the previously deployed application rollback-compatible: before F09 it
-- inserts human events without actor_kind/actor_id. Defaults actor_kind to
-- 'user'; this trigger derives actor_id from its existing actor_user_id.
CREATE OR REPLACE FUNCTION provider_audit_legacy_actor_compat()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.actor_kind = 'user' AND NEW.actor_id IS NULL AND NEW.actor_user_id IS NOT NULL THEN
    NEW.actor_id := NEW.actor_user_id::text;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_audit_legacy_actor_compat ON provider_audit_events;
CREATE TRIGGER provider_audit_legacy_actor_compat
BEFORE INSERT ON provider_audit_events
FOR EACH ROW EXECUTE FUNCTION provider_audit_legacy_actor_compat();

ALTER TABLE provider_audit_events ADD CONSTRAINT provider_audit_actor_check CHECK (
  (actor_kind='user' AND actor_user_id IS NOT NULL AND actor_id=actor_user_id::text)
  OR (actor_kind IN ('node','device','system') AND actor_user_id IS NULL AND length(actor_id) BETWEEN 1 AND 160)
);

CREATE INDEX IF NOT EXISTS provider_audit_tenant_time_idx ON provider_audit_events(tenant_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS audit_tenant_action_time_idx ON audit_events(tenant_id,action,created_at DESC,id DESC);

-- Provider audit is globally visible only to owners. Operators and auditors
-- can read events only for tenants explicitly assigned to their user.
DROP POLICY IF EXISTS provider_audit_visible ON provider_audit_events;
CREATE POLICY provider_audit_visible ON provider_audit_events USING (
  current_setting('app.provider_role', true) = 'owner'
  OR tenant_id IN (
    SELECT tenant_id
    FROM provider_company_assignments
    WHERE user_id::text = current_setting('app.user_id', true)
  )
);
CREATE POLICY provider_audit_insert_actor ON provider_audit_events FOR INSERT WITH CHECK (
  (actor_kind='user' AND actor_user_id::text=current_setting('app.user_id',true) AND current_setting('app.provider_role',true) IN ('owner','operator','auditor'))
  OR (actor_kind='node' AND actor_user_id IS NULL AND actor_id=current_setting('app.node_id',true))
  OR (actor_kind='device' AND actor_user_id IS NULL AND actor_id=current_setting('app.device_id',true))
  OR (actor_kind='system' AND actor_user_id IS NULL AND current_setting('app.worker_role',true)='operation_dispatch')
);

COMMIT;
