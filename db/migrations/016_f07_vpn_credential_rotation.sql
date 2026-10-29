BEGIN;

-- A credential is unique only while it is active. A revoked or failed row is
-- history and must not block a new CSR after an explicit revocation.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid='vpn_client_credentials'::regclass
    AND c.contype='u'
    AND (
      SELECT array_agg(a.attname::text ORDER BY a.attname)
      FROM unnest(c.conkey) AS key(attnum)
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=key.attnum
    ) = ARRAY['device_id','environment_id','tenant_id'];
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE vpn_client_credentials DROP CONSTRAINT %I',constraint_name);
  END IF;
END $$;

CREATE UNIQUE INDEX vpn_client_credentials_active_key
  ON vpn_client_credentials (tenant_id, device_id, environment_id)
  WHERE state IN ('pending','issued','revocation_pending');

CREATE INDEX vpn_client_credentials_history_idx
  ON vpn_client_credentials (tenant_id, device_id, environment_id, created_at DESC, id DESC);

COMMIT;
