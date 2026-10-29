const migrations001To015 = Object.freeze([
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
]);

const f09 = Object.freeze([...migrations001To015, '017_f09_reporting_permissions.sql']);

export const migrationProfiles = Object.freeze({
  // This profile is intentionally the lab's F09 sequence. 016 and 018 are not included.
  'f09-local': Object.freeze({ migrations: f09, target: 'local' }),
  'f09-lab': Object.freeze({ migrations: f09, target: 'lab' }),
  // 016 is exercised only against disposable local PostgreSQL instances.
  'f08-local': Object.freeze({
    migrations: Object.freeze([...migrations001To015, '016_f07_vpn_credential_rotation.sql', '017_f09_reporting_permissions.sql']),
    target: 'local',
  }),
  // GA-01 is a local-only profile and adds 018 after the F09 baseline; it never includes 016.
  'ga01-local': Object.freeze({
    migrations: Object.freeze([...f09, '018_ga01_assignment_permissions.sql']),
    target: 'local',
  }),
});

export function stripMigrationTransaction(sql, file = '<migration>') {
  const begin = /^((?:\s|--[^\r\n]*(?:\r?\n|$))*)BEGIN\s*;\s*/i.exec(sql);
  if (!begin) throw new Error(`${file}: debe empezar con BEGIN; después de sus comentarios iniciales`);

  const remainder = sql.slice(begin[0].length);
  const commit = /\s*COMMIT\s*;\s*$/i.exec(remainder);
  if (!commit) throw new Error(`${file}: debe terminar con COMMIT;`);

  const body = remainder.slice(0, commit.index).trim();
  if (!body) throw new Error(`${file}: la migración no contiene sentencias`);
  return body;
}
