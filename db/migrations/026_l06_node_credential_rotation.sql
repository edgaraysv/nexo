BEGIN;

CREATE TABLE node_credential_rotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id uuid NOT NULL REFERENCES provider_nodes(id) ON DELETE CASCADE,
  source_credential_id uuid NOT NULL REFERENCES node_credentials(id),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','issuing','completed','expired')),
  created_by uuid NOT NULL REFERENCES provider_users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  issued_credential_id uuid REFERENCES node_credentials(id),
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND issued_credential_id IS NOT NULL)
    OR (status <> 'completed' AND completed_at IS NULL AND issued_credential_id IS NULL)
  )
);

CREATE UNIQUE INDEX node_credential_rotations_one_open_per_node
  ON node_credential_rotations(node_id)
  WHERE status IN ('pending','issuing');

ALTER TABLE node_credential_rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE node_credential_rotations FORCE ROW LEVEL SECURITY;

CREATE POLICY node_credential_rotation_scope ON node_credential_rotations
  USING (
    current_setting('app.provider_role', true) = 'owner'
    OR (
      node_id::text = current_setting('app.node_id', true)
      AND id::text = current_setting('app.node_rotation_id', true)
    )
  )
  WITH CHECK (
    current_setting('app.provider_role', true) = 'owner'
    OR (
      node_id::text = current_setting('app.node_id', true)
      AND id::text = current_setting('app.node_rotation_id', true)
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexo_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON node_credential_rotations TO nexo_runtime;
  END IF;
END
$$;

COMMIT;
