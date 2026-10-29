BEGIN;

ALTER TABLE operations ADD COLUMN revision bigint;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY target_device_id ORDER BY created_at,id) AS revision
  FROM operations
)
UPDATE operations o SET revision=n.revision FROM numbered n WHERE n.id=o.id;
ALTER TABLE operations ALTER COLUMN revision SET NOT NULL;
ALTER TABLE operations ADD CONSTRAINT operations_revision_check CHECK (revision > 0);
CREATE UNIQUE INDEX operations_target_revision_idx ON operations(target_device_id,revision);

ALTER TABLE node_operations ADD COLUMN revision bigint;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY target_node_id ORDER BY created_at,id) AS revision
  FROM node_operations
)
UPDATE node_operations o SET revision=n.revision FROM numbered n WHERE n.id=o.id;
ALTER TABLE node_operations ALTER COLUMN revision SET NOT NULL;
ALTER TABLE node_operations ADD CONSTRAINT node_operations_revision_check CHECK (revision > 0);
CREATE UNIQUE INDEX node_operations_target_revision_idx ON node_operations(target_node_id,revision);

COMMIT;
