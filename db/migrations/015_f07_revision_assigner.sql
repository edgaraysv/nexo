BEGIN;

-- Revision assigner: reads max(revision) for a node bypassing RLS.
-- Required because callers may run under device-scoped RLS (app.device_id),
-- which only shows operations that device requested, masking prior revisions
-- from other devices or the node itself, and causing a unique-key collision
-- on (target_node_id, revision) when the computed next revision already exists.
--
-- SECURITY DEFINER inherits the superuser owner's BYPASSRLS privilege.
-- Advisory lock (pg_advisory_xact_lock) in callers serializes concurrent inserts.
CREATE FUNCTION nexo_node_latest_revision(p_node_id uuid)
RETURNS bigint
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(MAX(revision), 0)
  FROM node_operations
  WHERE target_node_id = p_node_id
$$;

-- PostgreSQL grants function execution to PUBLIC by default. This function
-- intentionally bypasses RLS, so only the application runtime may call it.
REVOKE ALL ON FUNCTION nexo_node_latest_revision(uuid) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexo_runtime') THEN
    GRANT EXECUTE ON FUNCTION nexo_node_latest_revision(uuid) TO nexo_runtime;
  END IF;
END $$;

COMMIT;
