\set ON_ERROR_STOP on

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_migration') THEN
    ALTER ROLE nexo RENAME TO nexo_migration;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_migration') THEN
    CREATE ROLE nexo_migration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_runtime') THEN
    CREATE ROLE nexo_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE nexo_migration NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE nexo_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
ALTER DATABASE nexo OWNER TO nexo_migration;
REVOKE ALL ON DATABASE nexo FROM PUBLIC;
GRANT CONNECT ON DATABASE nexo TO nexo_runtime;

\connect nexo

ALTER SCHEMA public OWNER TO nexo_migration;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO nexo_runtime;

SELECT format('ALTER TABLE %I.%I OWNER TO nexo_migration;', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname
\gexec

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, nexo_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, nexo_runtime;

GRANT SELECT ON TABLE
  access_policies, audit_events, company_invitations, control_security_state,
  declared_devices, device_challenges, device_credentials, device_heartbeats,
  device_identities, device_invitations, device_sessions, membership_roles,
  memberships, mfa_factors, node_challenges, node_credentials, node_heartbeats,
  node_operation_outbox, node_operation_results, node_operations, node_sessions,
  manual_payments, operation_outbox, operation_results, operations, plans,
  provider_audit_events, provider_company_assignments, provider_node_invitations, provider_nodes,
  permissions, provider_settings, provider_users, quota_counters, quota_exceptions,
  quota_reservations, recovery_tokens, role_permissions, roles, sessions, site_networks,
  sites, subscription_modules, subscriptions, tenants, users,
  vpn_client_credentials, vpn_environment_revisions, vpn_environments,
  private_network_profiles, private_network_profile_revisions, private_network_device_observations, private_resources, private_network_policies
TO nexo_runtime;

GRANT INSERT ON TABLE
  access_policies, audit_events, company_invitations, declared_devices,
  device_challenges, device_credentials, device_heartbeats, device_identities,
  device_invitations, device_sessions, membership_roles, memberships, role_permissions,
  node_challenges, node_credentials, node_heartbeats, node_operation_outbox,
  node_operation_results, node_operations, node_sessions, operation_outbox,
  manual_payments, operation_results, operations, plans, provider_audit_events,
  provider_company_assignments, provider_node_invitations, provider_nodes,
  provider_settings, quota_counters, quota_exceptions, quota_reservations,
  recovery_tokens, roles, sessions, site_networks, sites, subscription_modules,
  subscriptions, tenants, vpn_client_credentials, vpn_environment_revisions, vpn_environments,
  private_network_profiles, private_network_profile_revisions, private_network_device_observations, private_resources, private_network_policies
TO nexo_runtime;

GRANT UPDATE ON TABLE
  access_policies, company_invitations, device_challenges, device_credentials,
  device_heartbeats, device_identities, device_invitations, device_sessions,
  membership_roles, memberships, node_challenges, node_credentials, node_heartbeats,
  node_heartbeats, node_operation_outbox, node_operations, node_sessions, operation_outbox,
  operations, provider_node_invitations, provider_nodes, provider_settings,
  quota_counters, quota_exceptions, recovery_tokens, roles, sessions,
  subscription_modules, subscriptions, users, vpn_client_credentials, vpn_environments,
  private_network_profiles, private_network_device_observations
TO nexo_runtime;

-- Explicit narrowly scoped deletes. RLS remains authoritative: export grants
-- are tenant-scoped and provider assignments are owner-only.
GRANT DELETE ON TABLE role_permissions, provider_company_assignments TO nexo_runtime;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nexo_runtime;

-- SECURITY DEFINER revision allocation intentionally bypasses device-scoped
-- RLS. Keep execution limited to the application runtime, including when this
-- role is provisioned after migrations have already run.
REVOKE ALL ON FUNCTION nexo_node_latest_revision(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION nexo_node_latest_revision(uuid) TO nexo_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE nexo_migration IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE nexo_migration IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
