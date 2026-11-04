BEGIN;

-- Grant only the operations used by the support API and worker. Some local
-- profiles stop before 021 creates attempts and outbox, so each table is optional.
-- Row-level security policies are left unchanged.
DO $$
DECLARE
  support_table text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexo_runtime') THEN
    FOREACH support_table IN ARRAY ARRAY[
      'support_sessions',
      'support_consent',
      'support_session_attempts',
      'support_session_outbox'
    ] LOOP
      IF to_regclass(format('public.%I', support_table)) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE public.%I TO nexo_runtime', support_table);
      END IF;
    END LOOP;
  END IF;
END
$$;

COMMIT;
