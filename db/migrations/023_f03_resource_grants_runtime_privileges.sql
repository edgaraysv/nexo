BEGIN;

-- 019 is historical and may already be applied; repair its missing runtime grant
-- without rewriting the migration or broadening access to DELETE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexo_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON resource_grants TO nexo_runtime;
  END IF;
END
$$;

COMMIT;
