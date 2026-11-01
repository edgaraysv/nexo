BEGIN;

ALTER TABLE vpn_environments DROP CONSTRAINT vpn_environments_engine_check;
ALTER TABLE vpn_environments ADD CONSTRAINT vpn_environments_engine_check
  CHECK (engine IN ('openvpn','wireguard'));

CREATE TABLE wireguard_environment_config (
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  server_public_key text CHECK (server_public_key IS NULL OR server_public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  mtu integer NOT NULL DEFAULT 1420 CHECK (mtu = 1420),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (environment_id),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE wireguard_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  device_id uuid NOT NULL,
  tunnel_ipv4 inet NOT NULL CHECK (family(tunnel_ipv4)=4 AND masklen(tunnel_ipv4)=32),
  persistent_keepalive_seconds integer NOT NULL DEFAULT 0 CHECK (persistent_keepalive_seconds IN (0,25)),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked')),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,device_id) REFERENCES device_identities(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (environment_id,device_id),
  UNIQUE (environment_id,tunnel_ipv4),
  UNIQUE (tenant_id,id)
);

CREATE TABLE wireguard_peer_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  peer_id uuid NOT NULL,
  public_key text NOT NULL CHECK (public_key ~ '^[A-Za-z0-9+/]{43}=$'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id,peer_id) REFERENCES wireguard_peers(tenant_id,id) ON DELETE RESTRICT,
  UNIQUE (peer_id,id),
  UNIQUE (peer_id,public_key)
);
CREATE UNIQUE INDEX wireguard_peer_keys_one_active_uidx
  ON wireguard_peer_keys(peer_id) WHERE state='active';
CREATE UNIQUE INDEX wireguard_peer_keys_one_pending_uidx
  ON wireguard_peer_keys(peer_id) WHERE state='pending';
CREATE UNIQUE INDEX wireguard_peer_keys_public_uidx
  ON wireguard_peer_keys(public_key);

CREATE TABLE wireguard_change_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  peer_id uuid NOT NULL,
  candidate_key_id uuid,
  action text NOT NULL CHECK (action IN ('approve','rotate','revoke')),
  expected_revision bigint NOT NULL CHECK (expected_revision > 0),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  summary jsonb NOT NULL CHECK (jsonb_typeof(summary)='object'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','expired')),
  requested_by uuid NOT NULL REFERENCES provider_users(user_id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CHECK ((action IN ('approve','rotate') AND candidate_key_id IS NOT NULL) OR (action='revoke' AND candidate_key_id IS NULL)),
  FOREIGN KEY (tenant_id,environment_id) REFERENCES vpn_environments(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,peer_id) REFERENCES wireguard_peers(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (peer_id,candidate_key_id) REFERENCES wireguard_peer_keys(peer_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX wireguard_previews_one_pending_environment_uidx
  ON wireguard_change_previews(environment_id) WHERE state='pending';
ALTER TABLE wireguard_environment_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE wireguard_environment_config FORCE ROW LEVEL SECURITY;
ALTER TABLE wireguard_peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wireguard_peers FORCE ROW LEVEL SECURITY;
ALTER TABLE wireguard_peer_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE wireguard_peer_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE wireguard_change_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE wireguard_change_previews FORCE ROW LEVEL SECURITY;

CREATE POLICY wireguard_config_owner_all ON wireguard_environment_config FOR ALL
  USING (current_setting('app.provider_role',true)='owner')
  WITH CHECK (current_setting('app.provider_role',true)='owner');
CREATE POLICY wireguard_config_node_read ON wireguard_environment_config FOR SELECT USING (
  current_setting('app.worker_role',true)='operation_dispatch' AND EXISTS (
    SELECT 1 FROM vpn_environments e WHERE e.id=environment_id AND e.node_id::text=current_setting('app.node_id',true)
  )
);
CREATE POLICY wireguard_config_node_key_report ON wireguard_environment_config FOR UPDATE
  USING (current_setting('app.worker_role',true)='operation_dispatch' AND EXISTS (
    SELECT 1 FROM vpn_environments e WHERE e.id=environment_id AND e.node_id::text=current_setting('app.node_id',true)
  ))
  WITH CHECK (current_setting('app.worker_role',true)='operation_dispatch' AND EXISTS (
    SELECT 1 FROM vpn_environments e WHERE e.id=environment_id AND e.node_id::text=current_setting('app.node_id',true)
  ));
CREATE POLICY wireguard_config_company_read ON wireguard_environment_config FOR SELECT USING (
  tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY wireguard_config_device_read ON wireguard_environment_config FOR SELECT USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  AND EXISTS (SELECT 1 FROM device_identities d WHERE d.id::text=current_setting('app.device_id',true) AND d.tenant_id=wireguard_environment_config.tenant_id AND d.status='approved')
);

CREATE POLICY wireguard_peers_owner_all ON wireguard_peers FOR ALL
  USING (current_setting('app.provider_role',true)='owner')
  WITH CHECK (current_setting('app.provider_role',true)='owner');
CREATE POLICY wireguard_peers_node_read ON wireguard_peers FOR SELECT USING (
  current_setting('app.worker_role',true)='operation_dispatch' AND EXISTS (
    SELECT 1 FROM vpn_environments e WHERE e.id=environment_id AND e.node_id::text=current_setting('app.node_id',true)
  )
);
CREATE POLICY wireguard_peers_company_read ON wireguard_peers FOR SELECT USING (
  tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY wireguard_peers_device_read ON wireguard_peers FOR SELECT USING (
  tenant_id::text=current_setting('app.tenant_id',true)
  AND device_id::text=current_setting('app.device_id',true)
  AND EXISTS (
    SELECT 1 FROM device_identities d
    WHERE d.id=wireguard_peers.device_id
      AND d.tenant_id=wireguard_peers.tenant_id AND d.status='approved'
  )
);
CREATE POLICY wireguard_peers_device_register ON wireguard_peers FOR INSERT WITH CHECK (
  state='pending' AND revision=1 AND persistent_keepalive_seconds=0
  AND tenant_id::text=current_setting('app.tenant_id',true)
  AND device_id::text=current_setting('app.device_id',true)
  AND EXISTS (SELECT 1 FROM device_identities d WHERE d.id=device_id AND d.tenant_id=wireguard_peers.tenant_id AND d.status='approved')
  AND EXISTS (
    SELECT 1 FROM vpn_environments e
    JOIN wireguard_environment_config w ON w.environment_id=e.id AND w.tenant_id=e.tenant_id
    JOIN subscriptions s ON s.tenant_id=e.tenant_id
    JOIN plans p ON p.id=s.plan_id
    LEFT JOIN subscription_modules m ON m.tenant_id=e.tenant_id AND m.module='vpn'
      AND (m.valid_from IS NULL OR m.valid_from<=now()) AND (m.valid_until IS NULL OR m.valid_until>now())
    WHERE e.id=wireguard_peers.environment_id AND e.tenant_id=wireguard_peers.tenant_id
      AND e.engine='wireguard' AND e.desired_state='active' AND e.observed_state='active'
      AND e.applied_revision=e.revision AND w.server_public_key IS NOT NULL
      AND s.state IN ('active','grace') AND (s.valid_from IS NULL OR s.valid_from<=now())
      AND (s.valid_until IS NULL OR s.valid_until>now())
      AND coalesce((p.modules->>'vpn')::boolean,false)=true AND coalesce(m.state,'active')='active'
      AND wireguard_peers.tunnel_ipv4 <<= e.tunnel_ipv4_cidr
      AND host(wireguard_peers.tunnel_ipv4)<>host(network(e.tunnel_ipv4_cidr))
      AND host(wireguard_peers.tunnel_ipv4)<>host(network(e.tunnel_ipv4_cidr)+1)
      AND host(wireguard_peers.tunnel_ipv4)<>host(broadcast(e.tunnel_ipv4_cidr))
  )
);

CREATE POLICY wireguard_keys_owner_all ON wireguard_peer_keys FOR ALL
  USING (current_setting('app.provider_role',true)='owner')
  WITH CHECK (current_setting('app.provider_role',true)='owner');
CREATE POLICY wireguard_keys_node_read ON wireguard_peer_keys FOR SELECT USING (
  current_setting('app.worker_role',true)='operation_dispatch' AND EXISTS (
    SELECT 1 FROM wireguard_peers p JOIN vpn_environments e ON e.id=p.environment_id
    WHERE p.id=peer_id AND e.node_id::text=current_setting('app.node_id',true)
  )
);
CREATE POLICY wireguard_keys_company_read ON wireguard_peer_keys FOR SELECT USING (
  tenant_id IN (SELECT tenant_id FROM provider_company_assignments WHERE user_id::text=current_setting('app.user_id',true))
);
CREATE POLICY wireguard_keys_device_read ON wireguard_peer_keys FOR SELECT USING (
  EXISTS (SELECT 1 FROM wireguard_peers p WHERE p.id=peer_id AND p.tenant_id::text=current_setting('app.tenant_id',true) AND p.device_id::text=current_setting('app.device_id',true))
);
CREATE POLICY wireguard_keys_device_register ON wireguard_peer_keys FOR INSERT WITH CHECK (
  state='pending' AND activated_at IS NULL AND revoked_at IS NULL
  AND tenant_id::text=current_setting('app.tenant_id',true)
  AND EXISTS (SELECT 1 FROM wireguard_peers p WHERE p.id=peer_id AND p.tenant_id=wireguard_peer_keys.tenant_id AND p.device_id::text=current_setting('app.device_id',true))
);

CREATE POLICY wireguard_previews_owner_all ON wireguard_change_previews FOR ALL
  USING (current_setting('app.provider_role',true)='owner')
  WITH CHECK (current_setting('app.provider_role',true)='owner');

CREATE POLICY endpoint_wireguard_node_status ON provider_nodes FOR SELECT USING (
  status='approved' AND current_setting('app.device_id',true) <> ''
  AND EXISTS (
    SELECT 1 FROM vpn_environments e
    JOIN device_identities d ON d.id::text=current_setting('app.device_id',true)
      AND d.tenant_id=e.tenant_id AND d.status='approved'
    WHERE e.node_id=provider_nodes.id AND e.engine='wireguard'
      AND e.tenant_id::text=current_setting('app.tenant_id',true)
      AND e.desired_state='active' AND e.observed_state='active'
      AND e.applied_revision=e.revision
  )
);

CREATE INDEX wireguard_peers_environment_state_idx ON wireguard_peers(environment_id,state);
CREATE INDEX wireguard_peers_device_idx ON wireguard_peers(tenant_id,device_id,state);
CREATE INDEX wireguard_previews_expiry_idx ON wireguard_change_previews(state,expires_at);

COMMIT;
