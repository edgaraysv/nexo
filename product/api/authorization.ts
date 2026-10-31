export const COMPANY_PERMISSIONS = [
  'company.summary.read',
  'company.site.read',
  'company.site.create',
  'company.device.read',
  'company.device.create',
  'company.user.read',
  'company.user.invite',
  'company.user.roles.manage',
  'company.resource_grant.manage',
  'company.policy.read',
  'company.policy.manage',
  'company.agent.read',
  'company.agent.invite',
  'company.agent.approve',
  'company.agent.revoke',
  'company.operation.read',
  'company.operation.create',
  'company.audit.read',
  'company.report.export',
  'company.support.start',
  'company.network.read',
  'company.network.manage',
  'company.network.diagnose'
] as const;

export type CompanyPermission = typeof COMPANY_PERMISSIONS[number];

export type CompanyResourceType = 'declared_device' | 'device_identity';

export const RESOURCE_GRANT_PERMISSIONS = {
  declared_device: ['company.device.read'],
  device_identity: [
    'company.agent.read',
    'company.agent.approve',
    'company.agent.revoke',
    'company.operation.read',
    'company.operation.create',
    'company.support.start',
    'company.network.manage',
    'company.network.diagnose'
  ]
} as const satisfies Record<CompanyResourceType, readonly CompanyPermission[]>;

export function isResourceGrantPermission(resourceType: CompanyResourceType, permission: string): permission is CompanyPermission {
  return (RESOURCE_GRANT_PERMISSIONS[resourceType] as readonly string[]).includes(permission);
}

const READ_PERMISSIONS: readonly CompanyPermission[] = [
  'company.summary.read',
  'company.site.read',
  'company.device.read',
  'company.user.read',
  'company.policy.read',
  'company.agent.read',
  'company.operation.read',
  'company.audit.read',
  'company.network.read'
];

const TECHNICIAN_PERMISSIONS: readonly CompanyPermission[] = [
  'company.summary.read',
  'company.site.read',
  'company.device.read',
  'company.device.create',
  'company.user.read',
  'company.policy.read',
  'company.agent.read',
  'company.agent.invite',
  'company.agent.approve',
  'company.agent.revoke',
  'company.operation.read',
  'company.operation.create',
  'company.support.start',
  'company.network.read',
  'company.network.manage',
  'company.network.diagnose'
];

export function permissionsForCompanyRole(role: string): readonly CompanyPermission[] {
  // Export is intentionally never part of an implicit role default.
  if (role === 'company.admin') return COMPANY_PERMISSIONS.filter(permission => permission !== 'company.report.export');
  if (role === 'company.technician') return TECHNICIAN_PERMISSIONS;
  if (role === 'company.auditor' || role === 'company.viewer') return READ_PERMISSIONS;
  return [];
}

export function permissionsForCompanyRoles(roles: readonly string[]): CompanyPermission[] {
  return [...new Set(roles.flatMap(role => permissionsForCompanyRole(role)))];
}
