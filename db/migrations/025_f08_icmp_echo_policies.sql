BEGIN;

ALTER TABLE private_network_policies
  ADD COLUMN icmp_type integer,
  ADD COLUMN icmp_code integer,
  ALTER COLUMN port_start DROP NOT NULL,
  ALTER COLUMN port_end DROP NOT NULL,
  DROP CONSTRAINT private_network_policies_protocol_check;

ALTER TABLE private_network_policies
  ADD CONSTRAINT private_network_policies_protocol_check
    CHECK(protocol IN('tcp','udp','icmp')),
  ADD CONSTRAINT private_network_policies_transport_shape_check
    CHECK(
      (protocol IN('tcp','udp')
        AND port_start IS NOT NULL
        AND port_end IS NOT NULL
        AND port_start BETWEEN 1 AND 65535
        AND port_end BETWEEN port_start AND 65535
        AND icmp_type IS NULL
        AND icmp_code IS NULL)
      OR
      (protocol='icmp'
        AND port_start IS NULL
        AND port_end IS NULL
        AND icmp_type=8
        AND icmp_code=0)
    );

CREATE INDEX private_network_policies_icmp_lookup_idx
  ON private_network_policies(profile_id,resource_id,status,icmp_type,icmp_code)
  WHERE protocol='icmp';

COMMIT;
