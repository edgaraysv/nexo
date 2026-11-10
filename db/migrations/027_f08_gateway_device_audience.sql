BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM device_invitations
    WHERE audience NOT IN ('endpoint','gateway') OR audience <> device_kind
  ) OR EXISTS (
    SELECT 1 FROM device_identities
    WHERE audience NOT IN ('endpoint','gateway') OR audience <> device_kind
  ) THEN
    RAISE EXCEPTION 'gateway audience migration requires coherent existing device rows';
  END IF;
END
$$;

ALTER TABLE device_invitations
  DROP CONSTRAINT device_invitations_audience_check,
  ADD CONSTRAINT device_invitations_audience_check
    CHECK (audience IN ('endpoint','gateway') AND audience=device_kind);

ALTER TABLE device_identities
  DROP CONSTRAINT device_identities_audience_check,
  ADD CONSTRAINT device_identities_audience_check
    CHECK (audience IN ('endpoint','gateway') AND audience=device_kind);

COMMIT;
