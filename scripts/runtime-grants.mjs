import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const name = `nexo-runtime-${randomUUID().slice(0, 8)}`;
const image = process.env.RUNTIME_POSTGRES_IMAGE ?? 'postgres:17.6-bookworm';
const migrations = [
  '001_l02_identity.sql',
  '002_l03_provider.sql',
  '003_l04_company_portal.sql',
  '004_l05_device_identity.sql',
  '005_l06_operations.sql',
  '006_l06_node_restore.sql',
  '007_f03_company_authorization.sql',
  '008_f04_commercial_capabilities.sql',
  '009_f05_operation_reliability.sql',
  '010_f06_vpn_environments.sql',
  '011_f07_endpoint_vpn_catalog.sql',
  '012_f07_vpn_client_credentials.sql',
  '013_f08_private_networks.sql',
  '014_f07_tls_crypt_envelope.sql',
  '015_f07_revision_assigner.sql',
  '016_f07_vpn_credential_rotation.sql',
  '017_f09_reporting_permissions.sql',
  '018_ga01_assignment_permissions.sql',
  '019_f03_resource_grants.sql',
  '020_f10_support_consent.sql',
  '021_f10_support_lifecycle.sql'
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function psql(input, args = []) {
  return run('docker', ['exec', '-i', name, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'nexo', ...args], { input }).trim();
}

try {
  run('docker', ['image', 'inspect', image]);
  run('docker', ['run', '--rm', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=runtime-fixture-password', '-e', 'POSTGRES_DB=nexo', image]);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const first = spawnSync('docker', ['exec', name, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']);
    if (first.status === 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      const second = spawnSync('docker', ['exec', name, 'psql', '-X', '-U', 'postgres', '-d', 'nexo', '-c', 'SELECT 1']);
      if (second.status === 0) { ready = true; break; }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!ready) throw new Error('PostgreSQL did not become ready');
  for (const migration of migrations) psql(await readFile(`db/migrations/${migration}`, 'utf8'));
  psql(await readFile('infra/aws/lab/nexo-runtime.sql', 'utf8'));

  const tableCount = Number(psql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p')"));
  const wrongOwners = Number(psql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind IN('r','p') AND r.rolname<>'nexo_migration'"));
  const unsafeRole = psql("SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR rolcanlogin=false FROM pg_roles WHERE rolname='nexo_runtime'");
  const deleteGrants = Number(psql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p') AND has_table_privilege('nexo_runtime',c.oid,'DELETE')"));
  const expectedDeleteGrants = Number(psql("SELECT count(*) FROM (VALUES ('role_permissions'),('provider_company_assignments')) expected(table_name) WHERE has_table_privilege('nexo_runtime',format('public.%I',table_name),'DELETE')"));
  const f04Missing = Number(psql("SELECT count(*) FROM (VALUES ('subscription_modules','SELECT,INSERT,UPDATE'),('quota_exceptions','SELECT,INSERT,UPDATE'),('quota_reservations','SELECT,INSERT'),('manual_payments','SELECT,INSERT')) expected(table_name,privileges), LATERAL unnest(string_to_array(privileges,',')) privilege WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const heartbeatMissing = Number(psql("SELECT count(*) FROM (VALUES ('device_heartbeats'),('node_heartbeats')) expected(table_name), (VALUES ('SELECT'),('INSERT'),('UPDATE')) required(privilege) WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const f04RlsMissing = Number(psql("SELECT count(*) FROM (VALUES ('subscription_modules'),('quota_exceptions'),('quota_reservations'),('manual_payments')) expected(table_name) LEFT JOIN pg_class c ON c.relname=table_name AND c.relnamespace='public'::regnamespace WHERE NOT coalesce(c.relrowsecurity,false) OR NOT coalesce(c.relforcerowsecurity,false)"));
  const f06Missing = Number(psql("SELECT count(*) FROM (VALUES ('vpn_environments','SELECT,INSERT,UPDATE'),('vpn_environment_revisions','SELECT,INSERT')) expected(table_name,privileges), LATERAL unnest(string_to_array(privileges,',')) privilege WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const f06RlsMissing = Number(psql("SELECT count(*) FROM (VALUES ('vpn_environments'),('vpn_environment_revisions')) expected(table_name) LEFT JOIN pg_class c ON c.relname=table_name AND c.relnamespace='public'::regnamespace WHERE NOT coalesce(c.relrowsecurity,false) OR NOT coalesce(c.relforcerowsecurity,false)"));
  const f07Missing = Number(psql("SELECT count(*) FROM (VALUES ('vpn_client_credentials','SELECT,INSERT,UPDATE')) expected(table_name,privileges), LATERAL unnest(string_to_array(privileges,',')) privilege WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const f07RlsMissing = Number(psql("SELECT count(*) FROM pg_class WHERE relname='vpn_client_credentials' AND relnamespace='public'::regnamespace AND (NOT relrowsecurity OR NOT relforcerowsecurity)"));
  const f08Missing = Number(psql("SELECT count(*) FROM (VALUES ('private_network_profiles','SELECT,INSERT,UPDATE'),('private_network_profile_revisions','SELECT,INSERT'),('private_network_device_observations','SELECT,INSERT,UPDATE'),('private_resources','SELECT,INSERT'),('private_network_policies','SELECT,INSERT')) expected(table_name,privileges), LATERAL unnest(string_to_array(privileges,',')) privilege WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const f08RlsMissing = Number(psql("SELECT count(*) FROM (VALUES ('private_network_profiles'),('private_network_profile_revisions'),('private_network_device_observations'),('private_resources'),('private_network_policies')) expected(table_name) LEFT JOIN pg_class c ON c.relname=table_name AND c.relnamespace='public'::regnamespace WHERE NOT coalesce(c.relrowsecurity,false) OR NOT coalesce(c.relforcerowsecurity,false)"));
  const resourceGrantMissing = Number(psql("SELECT count(*) FROM (VALUES ('resource_grants','SELECT,INSERT,UPDATE')) expected(table_name,privileges), LATERAL unnest(string_to_array(privileges,',')) privilege WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const resourceGrantRlsMissing = Number(psql("SELECT count(*) FROM pg_class WHERE relname='resource_grants' AND relnamespace='public'::regnamespace AND (NOT relrowsecurity OR NOT relforcerowsecurity)"));
  const supportMissing = Number(psql("SELECT count(*) FROM (VALUES ('support_consent'),('support_sessions'),('support_session_attempts'),('support_session_outbox')) expected(table_name), (VALUES ('SELECT'),('INSERT'),('UPDATE')) required(privilege) WHERE NOT has_table_privilege('nexo_runtime',format('public.%I',table_name),privilege)"));
  const supportRlsMissing = Number(psql("SELECT count(*) FROM (VALUES ('support_consent'),('support_sessions'),('support_session_attempts'),('support_session_outbox')) expected(table_name) LEFT JOIN pg_class c ON c.relname=table_name AND c.relnamespace='public'::regnamespace WHERE NOT coalesce(c.relrowsecurity,false) OR NOT coalesce(c.relforcerowsecurity,false)"));
  const publicCreate = psql("SELECT has_schema_privilege('public','public','CREATE')");
  const publicTableGrants = Number(psql("SELECT count(*) FROM information_schema.role_table_grants WHERE grantee='PUBLIC' AND table_schema='public'"));
  const revisionFunctionRuntime = psql("SELECT has_function_privilege('nexo_runtime','public.nexo_node_latest_revision(uuid)','EXECUTE')");
  const revisionFunctionPublic = psql("SELECT has_function_privilege('public','public.nexo_node_latest_revision(uuid)','EXECUTE')");

  assert.equal(tableCount, 60);
  assert.equal(wrongOwners, 0);
  assert.equal(unsafeRole, 'f');
  assert.equal(deleteGrants, 2, 'DELETE must remain limited to role_permissions and provider_company_assignments');
  assert.equal(expectedDeleteGrants, 2, 'both explicitly allowlisted DELETE grants must exist');
  assert.equal(f04Missing, 0);
  assert.equal(heartbeatMissing, 0);
  assert.equal(f04RlsMissing, 0);
  assert.equal(f06Missing, 0);
  assert.equal(f06RlsMissing, 0);
  assert.equal(f07Missing, 0);
  assert.equal(f07RlsMissing, 0);
  assert.equal(f08Missing, 0);
  assert.equal(f08RlsMissing, 0);
  assert.equal(resourceGrantMissing, 0);
  assert.equal(resourceGrantRlsMissing, 0);
  assert.equal(supportMissing, 0);
  assert.equal(supportRlsMissing, 0);
  assert.equal(publicCreate, 'f');
  assert.equal(publicTableGrants, 0);
  assert.equal(revisionFunctionRuntime, 't');
  assert.equal(revisionFunctionPublic, 'f');
  console.log(JSON.stringify({ phase: 'runtime-grants', migrations: migrations.length, tables: tableCount, ownership: 'PASS', leastPrivilege: 'PASS', delete: 'ALLOWLISTED (2 TABLES)', f04: 'PASS', f06: 'PASS', f07: 'PASS', f08: 'PASS', f03ResourceGrants: 'PASS', f10SupportConsent: 'PASS', f10SupportLifecycle: 'PASS', heartbeats: 'PASS', rls: 'PASS', image }));
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
