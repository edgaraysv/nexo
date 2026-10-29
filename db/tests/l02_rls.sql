\set ON_ERROR_STOP on
CREATE ROLE nexo_l02_runtime LOGIN PASSWORD 'l02-runtime-fixture-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO nexo_l02_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexo_l02_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexo_l02_runtime;

INSERT INTO tenants(id, slug, display_name) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'empresa-a', 'Empresa A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'empresa-b', 'Empresa B');
INSERT INTO users(id, email, password_hash) VALUES
  ('11111111-1111-4111-8111-111111111111', 'a@example.test', 'fixture-not-a-real-hash'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test', 'fixture-not-a-real-hash');
INSERT INTO memberships(tenant_id, user_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '22222222-2222-4222-8222-222222222222');

SET ROLE nexo_l02_runtime;
DO $$ BEGIN
  IF (SELECT count(*) FROM tenants) <> 0 THEN RAISE EXCEPTION 'RLS leaked rows without context'; END IF;
END $$;

BEGIN;
SELECT set_config('app.tenant_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT set_config('app.user_id', '11111111-1111-4111-8111-111111111111', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM tenants) <> 1 THEN RAISE EXCEPTION 'Tenant A context did not expose exactly one tenant'; END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb') THEN RAISE EXCEPTION 'Tenant B leaked into tenant A'; END IF;
  IF (SELECT count(*) FROM users) <> 1 THEN RAISE EXCEPTION 'User scope leaked across tenants'; END IF;
END $$;
COMMIT;

BEGIN;
SELECT set_config('app.tenant_id', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
SELECT set_config('app.user_id', '22222222-2222-4222-8222-222222222222', true);
DO $$ BEGIN
  IF (SELECT count(*) FROM tenants) <> 1 THEN RAISE EXCEPTION 'Tenant B context did not expose exactly one tenant'; END IF;
  IF EXISTS (SELECT 1 FROM tenants WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') THEN RAISE EXCEPTION 'Tenant A leaked into tenant B'; END IF;
END $$;
COMMIT;

RESET ROLE;
