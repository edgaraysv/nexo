# F03 — usuarios, empresas, permisos y aislamiento

Estado al 30 de octubre de 2026: **F03 local CERRADO** para grants directos por dispositivo. La migración 019, RLS, revocación/expiración en servidor y regresión local se verificaron con PostgreSQL 17.6 efímero. No se desplegó en AWS ni se acepta para producción. Esta autorización reemplaza el diferimiento anterior de grants por recurso. No se implementan herencias por grupo.

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
- `resource_grants` (migración `019_f03_resource_grants.sql`) limita por tenant, usuario, tipo/ID de recurso y permiso, con vigencia, revocación y auditoría. Tipos del corte: `declared_device` y `device_identity`.
- Un permiso de rol **no basta** para operar sobre esos recursos: se exige además un grant vigente para la misma acción. Una membresía inactiva, cambio de rol que retire el permiso, grant vencido o revocado deniega el acceso. No hay bypass implícito para administradores.
- `GET/POST /v1/company/resource-grants`, `GET /v1/company/resource-grants/resources` y `DELETE /v1/company/resource-grants/:grantId` permiten al administrador empresarial administrar grants. La superficie de recursos grantables revela inventario del tenant solo a quien tiene `company.resource_grant.manage`.
- El listado de dispositivos declarados, agentes, operaciones y heartbeats queda filtrado por grants; aprobación/revocación de agentes, creación de operaciones y diagnóstico/red de un dispositivo exigen el grant de la acción correspondiente en el servidor.
- Permisos grantables por tipo: `declared_device` → `company.device.read`; `device_identity` → `company.agent.read/approve/revoke`, `company.operation.read/create` y `company.network.manage/diagnose`. Cada petición requiere además el permiso de rol vigente.
- No se crean grants de compatibilidad automáticamente: las identidades existentes permanecen denegadas hasta que un administrador asigne permisos explícitos. Crear dispositivos e invitar/enrolar endpoints sigue siendo permiso de rol/tenant; el `site_id` opcional solo se valida dentro del tenant y no tiene grant propio en este corte.

## Matriz actual

| Rol | Alcance |
| --- | --- |
| Administrador | 21 permisos actuales de lectura/mutación, incluido `company.resource_grant.manage`; `company.report.export` continúa fuera del default. |
| Técnico | 15 permisos actuales, incluidas operaciones tipadas y red; no administra grants, no crea sedes, invita personas, cambia roles ni consulta auditoría. |
| Auditor | 9 permisos actuales de lectura, incluida auditoría; no administra grants ni muta recursos. |

La API aplica esta matriz aunque la interfaz muestre un control. Ocultar o mostrar botones nunca constituye la autorización.

## Comandos

```bash
npm run verify:f03
node --test tests/f03-authorization.test.mjs tests/l05-device-identity.test.mjs tests/l06-operations.test.mjs tests/f08-private-networks.test.mjs tests/f09-reporting.test.mjs tests/migration-runner.test.mjs
```

La evidencia PostgreSQL real del 30 de octubre está en [evidence.md](evidence.md). `scripts/f03-postgres.mjs` todavía crea un contenedor Docker; no se usó para esta verificación.

## Límites del corte y dependencias diferidas

- Los grants del corte son directos a un usuario y dispositivo; no hay herencia por grupo ni una UI de administración de grants.
- `site`, `access_policy` y `private_resource` no son tipos de grant en la migración 019; sus lecturas/mutaciones siguen con permisos tenant/rol de los cortes previos.
- La consulta/acción de autorización se vuelve a evaluar por solicitud en la API. No modela sesiones remotas ni su cierre; eso pertenece a F10 y no debe inferirse de esta migración.
- Los roles tienen matrices fijas. No existe personalización de permisos por empresa en este corte.
- La administración de grants tiene API, pero no se integró un formulario/UI en este corte.
- `access_policies` sigue siendo configuración empresarial y todavía no participa como motor de autorización de usuarios.
- Las superficies de reportes/exportación añadidas en F09 tienen su cobertura descrita en [evidence.md](evidence.md); no se declara cubierta toda búsqueda ni todo acceso granular por recurso.
- El correo real para invitaciones/recuperación, custodia productiva de claves, rate limiting distribuido, TLS productivo y revisión independiente siguen pendientes.
- La migración 007 y el nuevo código no fueron aplicados al laboratorio AWS. El servicio remoto conserva el corte anterior verificado.

El cierre local de F03 permite comenzar el diseño de autorización de dispositivos de F10, pero no selecciona MeshCentral ni demuestra consentimiento, integración con F10 o revocación de sesiones remotas. Tampoco cierra PV01 globalmente, F02/PV12 ni los gates de clientes/datos reales.

Evidencia: [evidence.md](evidence.md).
