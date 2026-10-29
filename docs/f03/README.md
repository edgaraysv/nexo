# F03 — usuarios, empresas, permisos y aislamiento

Estado: **corte inicial local implementado y verificado; fase no cerrada**. F02 continúa abierta y este trabajo no se desplegó en AWS.

## Alcance implementado

- Reutiliza autenticación con contraseña, MFA, sesiones revocables, membresías y contexto empresarial derivados por servidor de L02–L04.
- Autorización deny-by-default por permiso tipado de acción/recurso en cada endpoint empresarial habilitado.
- Roles empresariales vigentes: `company.admin`, `company.technician` y `company.auditor`.
- `company.viewer` permanece únicamente como alias de lectura para datos históricos; las invitaciones nuevas no lo aceptan.
- `/v1/me` devuelve los permisos efectivos de la sesión tenant.
- `/v1/company/audit` expone hasta 200 eventos recientes, sujeto a `company.audit.read` y RLS empresarial.
- La migración `007_f03_company_authorization.sql` registra 17 permisos, limita cada membresía a un rol empresarial y asigna defaults a roles existentes.
- Una invitación aceptada asigna también los permisos default del rol dentro de la misma transacción.
- `PUT /v1/company/users/:userId/role` permite al administrador cambiar el rol fijo; un bloqueo por tenant serializa el cambio y rechaza retirar el último administrador activo.

## Matriz actual

| Rol | Alcance |
| --- | --- |
| Administrador | 17 permisos de lectura y mutación del corte. |
| Técnico | 12 permisos: consulta general, alta de dispositivos/agentes, aprobación/revocación y operaciones tipadas; no crea sedes, invita personas, administra políticas ni consulta auditoría. |
| Auditor | 8 permisos exclusivamente terminados en `.read`, incluida auditoría; no muta recursos. |

La API aplica esta matriz aunque la interfaz muestre un control. Ocultar o mostrar botones nunca constituye la autorización.

## Comandos

```bash
npm run verify:f03
npm run test:f03-postgres
npm test
```

## Límites antes de cerrar F03

- Los permisos distinguen acción y tipo de recurso, pero aún no expresan asignaciones por instancia concreta, grupo o vigencia delegada.
- Los roles tienen matrices fijas. No existe personalización de permisos por empresa en este corte.
- `access_policies` sigue siendo configuración empresarial y todavía no participa como motor de autorización de usuarios.
- No existen aún superficies de búsqueda, exportación o tareas; sus casos IDOR permanecen NOT RUN, no PASS.
- El correo real para invitaciones/recuperación, custodia productiva de claves, rate limiting distribuido, TLS productivo y revisión independiente siguen pendientes.
- La migración 007 y el nuevo código no fueron aplicados al laboratorio AWS. El servicio remoto conserva el corte anterior verificado.

Evidencia: [evidence.md](evidence.md).
