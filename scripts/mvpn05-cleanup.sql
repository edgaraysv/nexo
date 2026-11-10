\set ON_ERROR_STOP on

\if :{?tenant_id}
\else
  \echo 'tenant_id is required'
  \quit 3
\endif
\if :{?actor_user_id}
\else
  \echo 'actor_user_id is required'
  \quit 3
\endif
\if :{?gateway_device_id}
\else
  \echo 'gateway_device_id is required'
  \quit 3
\endif
\if :{?profile_id}
\else
  \echo 'profile_id is required'
  \quit 3
\endif
\if :{?site_id}
\else
  \echo 'site_id is required'
  \quit 3
\endif

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
SET LOCAL search_path = pg_catalog, public;

CREATE TEMP TABLE mvpn05_cleanup_scope (
  tenant_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  gateway_device_id uuid NOT NULL,
  profile_id uuid NOT NULL,
  site_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO mvpn05_cleanup_scope
VALUES (
  :'tenant_id'::uuid,
  :'actor_user_id'::uuid,
  :'gateway_device_id'::uuid,
  :'profile_id'::uuid,
  :'site_id'::uuid
);

LOCK TABLE public.private_network_profiles,
  public.private_network_profile_revisions,
  public.private_network_device_observations,
  public.private_network_policies,
  public.private_resources,
  public.vpn_client_credentials,
  public.device_sessions,
  public.device_credentials,
  public.device_identities,
  public.device_invitations,
  public.sites,
  public.site_networks,
  public.quota_counters,
  public.audit_events
IN SHARE ROW EXCLUSIVE MODE NOWAIT;

DO $cleanup$
DECLARE
  s mvpn05_cleanup_scope%ROWTYPE;
  invitation uuid;
  changed integer;
  next_revision bigint;
BEGIN
  SELECT * INTO STRICT s FROM mvpn05_cleanup_scope;

  IF current_database() <> 'nexo_mvpn01' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'M-VPN-05 cleanup requires postgres on nexo_mvpn01';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.memberships
    WHERE tenant_id = s.tenant_id
      AND user_id = s.actor_user_id
      AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'cleanup actor is not an active tenant member';
  END IF;

  SELECT invitation_id INTO STRICT invitation
  FROM public.device_identities
  WHERE id = s.gateway_device_id
    AND tenant_id = s.tenant_id
    AND site_id = s.site_id
    AND device_kind = 'gateway'
    AND audience = 'gateway'
    AND status = 'approved'
    AND name LIKE 'mvpn05-%'
  FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1
    FROM public.device_invitations
    WHERE id = invitation
      AND tenant_id = s.tenant_id
      AND site_id = s.site_id
      AND device_kind = 'gateway'
      AND audience = 'gateway'
  ) THEN
    RAISE EXCEPTION 'gateway invitation does not match cleanup scope';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.sites
    WHERE id = s.site_id
      AND tenant_id = s.tenant_id
      AND code LIKE 'mvpn05-%'
      AND status = 'active'
  ) OR (
    SELECT count(*)
    FROM public.site_networks
    WHERE tenant_id = s.tenant_id AND site_id = s.site_id
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.site_networks
    WHERE tenant_id = s.tenant_id
      AND site_id = s.site_id
      AND network = '10.250.0.0/24'::cidr
  ) THEN
    RAISE EXCEPTION 'temporary site does not match M-VPN-05 scope';
  END IF;

  SELECT revision + 1 INTO STRICT next_revision
  FROM public.private_network_profiles
  WHERE id = s.profile_id
    AND tenant_id = s.tenant_id
    AND site_id = s.site_id
    AND gateway_device_id = s.gateway_device_id
    AND path_mode = 'gateway'
    AND return_mode = 'snat'
    AND dns_mode = 'split'
    AND desired_state = 'active'
    AND name LIKE 'mvpn05-%'
  FOR UPDATE;

  IF (SELECT count(*) FROM public.private_resources
      WHERE tenant_id = s.tenant_id AND profile_id = s.profile_id) <> 1
     OR (SELECT count(*) FROM public.private_network_policies
         WHERE tenant_id = s.tenant_id AND profile_id = s.profile_id) <> 1
     OR (SELECT count(*) FROM public.vpn_client_credentials
         WHERE tenant_id = s.tenant_id
           AND device_id = s.gateway_device_id
           AND state IN ('issued','revocation_pending')) <> 1 THEN
    RAISE EXCEPTION 'temporary profile resources or VPN credential do not match expected cardinality';
  END IF;

  UPDATE public.private_network_policies
  SET status = 'retired', revision = revision + 1
  WHERE tenant_id = s.tenant_id
    AND profile_id = s.profile_id
    AND status <> 'retired';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one policy to retire, got %', changed; END IF;

  UPDATE public.private_resources
  SET status = 'retired', revision = revision + 1
  WHERE tenant_id = s.tenant_id
    AND profile_id = s.profile_id
    AND status <> 'retired';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one resource to retire, got %', changed; END IF;

  UPDATE public.private_network_device_observations
  SET revision = next_revision,
      observed_state = 'retired',
      error_code = NULL,
      updated_at = now()
  WHERE tenant_id = s.tenant_id
    AND profile_id = s.profile_id;

  UPDATE public.private_network_profiles
  SET desired_state = 'retired',
      observed_state = 'retired',
      revision = next_revision,
      applied_revision = next_revision,
      error_code = NULL,
      updated_at = now()
  WHERE id = s.profile_id
    AND tenant_id = s.tenant_id;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one profile to retire, got %', changed; END IF;

  INSERT INTO public.private_network_profile_revisions(
    profile_id, tenant_id, revision, specification, requested_by
  )
  SELECT id, tenant_id, revision,
    jsonb_build_object(
      'site_id', site_id,
      'vpn_environment_id', vpn_environment_id,
      'path_mode', path_mode,
      'gateway_device_id', gateway_device_id,
      'return_mode', return_mode,
      'dns_mode', dns_mode,
      'dns_servers', dns_servers,
      'dns_suffixes', dns_suffixes,
      'desired_state', desired_state
    ),
    s.actor_user_id
  FROM public.private_network_profiles
  WHERE id = s.profile_id AND tenant_id = s.tenant_id;

  UPDATE public.vpn_client_credentials
  SET state = 'revoked', revoked_at = now(), updated_at = now()
  WHERE tenant_id = s.tenant_id
    AND device_id = s.gateway_device_id
    AND state IN ('issued','revocation_pending');
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one VPN credential to revoke, got %', changed; END IF;

  UPDATE public.device_credentials
  SET status = 'revoked'
  WHERE tenant_id = s.tenant_id
    AND device_id = s.gateway_device_id
    AND status = 'active';

  UPDATE public.device_sessions
  SET revoked_at = now()
  WHERE tenant_id = s.tenant_id
    AND device_id = s.gateway_device_id
    AND revoked_at IS NULL;

  UPDATE public.device_identities
  SET status = 'revoked', revoked_at = now()
  WHERE tenant_id = s.tenant_id
    AND id = s.gateway_device_id
    AND status = 'approved';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one gateway identity to revoke, got %', changed; END IF;

  UPDATE public.device_invitations
  SET revoked_at = coalesce(revoked_at, now()), uses_remaining = 0
  WHERE tenant_id = s.tenant_id AND id = invitation;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one invitation to archive, got %', changed; END IF;

  UPDATE public.sites
  SET status = 'archived'
  WHERE tenant_id = s.tenant_id
    AND id = s.site_id
    AND status = 'active';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'expected one site to archive, got %', changed; END IF;

  UPDATE public.quota_counters
  SET used = greatest(used - 1, 0), updated_at = now()
  WHERE tenant_id = s.tenant_id AND resource = 'endpoints';
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 1 THEN RAISE EXCEPTION 'endpoint quota row is missing'; END IF;

  INSERT INTO public.audit_events(
    tenant_id, actor_user_id, action, resource_type, resource_id, metadata
  ) VALUES
    (s.tenant_id, s.actor_user_id, 'private_network.profile.retired', 'private_network_profile', s.profile_id::text,
      jsonb_build_object('reason','M-VPN-05 Capa D ephemeral cleanup')),
    (s.tenant_id, s.actor_user_id, 'site.archived', 'site', s.site_id::text,
      jsonb_build_object('reason','M-VPN-05 Capa D ephemeral cleanup')),
    (s.tenant_id, s.actor_user_id, 'device.revoked', 'device', s.gateway_device_id::text,
      jsonb_build_object('reason','M-VPN-05 Capa D ephemeral cleanup','invitation_id',invitation));

  IF EXISTS (
    SELECT 1 FROM public.private_network_profiles
    WHERE id = s.profile_id
      AND (desired_state <> 'retired' OR observed_state <> 'retired' OR applied_revision <> revision)
  ) OR EXISTS (
    SELECT 1 FROM public.private_resources
    WHERE tenant_id = s.tenant_id AND profile_id = s.profile_id AND status <> 'retired'
  ) OR EXISTS (
    SELECT 1 FROM public.private_network_policies
    WHERE tenant_id = s.tenant_id AND profile_id = s.profile_id AND status <> 'retired'
  ) OR EXISTS (
    SELECT 1 FROM public.vpn_client_credentials
    WHERE tenant_id = s.tenant_id AND device_id = s.gateway_device_id AND state <> 'revoked'
  ) OR EXISTS (
    SELECT 1 FROM public.device_identities
    WHERE tenant_id = s.tenant_id AND id = s.gateway_device_id AND status <> 'revoked'
  ) OR EXISTS (
    SELECT 1 FROM public.sites
    WHERE tenant_id = s.tenant_id AND id = s.site_id AND status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'cleanup postcondition failed';
  END IF;
END
$cleanup$;

SELECT 'cleanup_ready' AS result,
  p.tenant_id,
  p.id AS profile_id,
  p.desired_state,
  p.observed_state,
  p.revision,
  p.applied_revision,
  d.id AS gateway_device_id,
  d.status AS gateway_status,
  s.id AS site_id,
  s.status AS site_status
FROM pg_temp.mvpn05_cleanup_scope x
JOIN public.private_network_profiles p ON p.id = x.profile_id
JOIN public.device_identities d ON d.id = x.gateway_device_id
JOIN public.sites s ON s.id = x.site_id;

COMMIT;
