BEGIN;

ALTER TABLE company_invitations DROP CONSTRAINT company_invitations_role_name_check;
ALTER TABLE company_invitations ADD CONSTRAINT company_invitations_role_name_check
  CHECK (role_name IN ('company.admin','company.technician','company.auditor','company.viewer'));

CREATE UNIQUE INDEX membership_roles_single_role_idx ON membership_roles(tenant_id,user_id);

INSERT INTO permissions(id,description) VALUES
  ('company.summary.read','Consultar resumen empresarial'),
  ('company.site.read','Consultar sedes'),
  ('company.site.create','Crear sedes'),
  ('company.device.read','Consultar dispositivos declarados'),
  ('company.device.create','Declarar dispositivos'),
  ('company.user.read','Consultar usuarios y roles'),
  ('company.user.invite','Invitar usuarios'),
  ('company.user.roles.manage','Cambiar el rol fijo de una membresía'),
  ('company.policy.read','Consultar políticas'),
  ('company.policy.manage','Crear o modificar políticas'),
  ('company.agent.read','Consultar agentes'),
  ('company.agent.invite','Crear invitaciones de agente'),
  ('company.agent.approve','Aprobar agentes'),
  ('company.agent.revoke','Revocar agentes'),
  ('company.operation.read','Consultar operaciones y observaciones'),
  ('company.operation.create','Crear operaciones tipadas'),
  ('company.audit.read','Consultar auditoría empresarial')
ON CONFLICT(id) DO UPDATE SET description=excluded.description;

WITH role_defaults(role_name,permission_id) AS (
  VALUES
    ('company.admin','company.summary.read'),('company.admin','company.site.read'),('company.admin','company.site.create'),
    ('company.admin','company.device.read'),('company.admin','company.device.create'),('company.admin','company.user.read'),
    ('company.admin','company.user.invite'),('company.admin','company.user.roles.manage'),('company.admin','company.policy.read'),('company.admin','company.policy.manage'),
    ('company.admin','company.agent.read'),('company.admin','company.agent.invite'),('company.admin','company.agent.approve'),
    ('company.admin','company.agent.revoke'),('company.admin','company.operation.read'),('company.admin','company.operation.create'),
    ('company.admin','company.audit.read'),
    ('company.technician','company.summary.read'),('company.technician','company.site.read'),
    ('company.technician','company.device.read'),('company.technician','company.device.create'),
    ('company.technician','company.user.read'),('company.technician','company.policy.read'),
    ('company.technician','company.agent.read'),('company.technician','company.agent.invite'),
    ('company.technician','company.agent.approve'),('company.technician','company.agent.revoke'),
    ('company.technician','company.operation.read'),('company.technician','company.operation.create'),
    ('company.auditor','company.summary.read'),('company.auditor','company.site.read'),
    ('company.auditor','company.device.read'),('company.auditor','company.user.read'),
    ('company.auditor','company.policy.read'),('company.auditor','company.agent.read'),
    ('company.auditor','company.operation.read'),('company.auditor','company.audit.read'),
    ('company.viewer','company.summary.read'),('company.viewer','company.site.read'),
    ('company.viewer','company.device.read'),('company.viewer','company.user.read'),
    ('company.viewer','company.policy.read'),('company.viewer','company.agent.read'),
    ('company.viewer','company.operation.read'),('company.viewer','company.audit.read')
)
INSERT INTO role_permissions(role_id,permission_id)
SELECT r.id,d.permission_id
FROM roles r JOIN role_defaults d ON d.role_name=r.name
ON CONFLICT DO NOTHING;

COMMIT;
