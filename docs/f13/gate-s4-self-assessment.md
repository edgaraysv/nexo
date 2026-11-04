# Gate S4 — Self-assessment (2026-11-03)

> Preparado por el implementador. Una revisión independiente (E4) debe validar o refutar cada ítem antes de cerrar el gate. Este documento no constituye aprobación.

**Alcance de esta evaluación:** inspección del código y de la evidencia documental disponible en el checkout. No se consultó AWS ni PostgreSQL remoto durante esta evaluación; los estados que dependen de infraestructura requieren verificación independiente y actual.

## Autenticación y sesión

| Ítem | Estado | Evidencia |
|------|--------|-----------|
| MFA obligatorio antes de emitir token de sesión | ✓ PASS | `product/api/application.ts:91-113,131-142`: login entrega un challenge; `/v1/auth/mfa` valida TOTP antes de entregar `selection`; `/v1/session/select` emite el token de sesión. `product/portal/src/auth/AuthContext.tsx:124-141` completa MFA y abre el alcance después. |
| Tokens no persistidos en cliente (sin localStorage) | ✓ PASS | `product/portal/src/auth/AuthContext.tsx:113-114,131-142`: el portal conserva `Session` en `useState` en memoria; el código de autenticación no escribe el token en almacenamiento persistente. |
| Revocación activa al logout | ✓ PASS (solicitud emitida) | `product/portal/src/auth/AuthContext.tsx:152-157` limpia la sesión local y envía `POST /v1/session/revoke`; `product/api/application.ts:165-168` revoca el token en el repositorio. Limitación: el cliente ignora un fallo de red y no confirma al usuario la revocación remota. |
| Sesiones no compartidas entre surfaces | ✓ PASS, con nota | `product/api/application.ts:131-142,171-181` emite y valida el scope `provider` o `tenant`; `providerIdentity` y `companyIdentity` rechazan el scope opuesto. Nota: `select` interpreta `scope_kind` distinto de `provider` como `tenant` y exige `tenant_id`; no exige que el campo esté presente explícitamente. |

## Autorización

| Ítem | Estado | Evidencia |
|------|--------|-----------|
| Provider owner-only endpoints bloqueados al operador | ✓ PASS | `product/api/application.ts:180,187-245`: `providerIdentity(request, true)` rechaza roles distintos de `owner`; creación de empresa/plan, operadores, suscripción, módulos, excepciones de cuota, pagos y configuración usan ese control. |
| Company permissions server-side | ✓ PASS | `product/api/authorization.ts:49-89` define permisos por rol; `product/api/application.ts:181-182` deriva los permisos actuales y responde 403 si falta el requerido, además de validar grants de recurso cuando aplican. |
| Cross-tenant bloqueado | ✓ PASS (en código) | `product/api/application.ts:131-142,181,185,194,212,215,218,221,224` limita la selección de empresa a memberships, toma el tenant de la sesión y verifica que empresas proveedor estén asignadas al `user.id` autenticado antes de consultar. |
| UI no es el único control (security in depth) | ✓ PASS | Las rutas API llaman `providerIdentity`/`companyIdentity` y devuelven 403/404 según rol, permiso, membership o asignación; los guards del portal son solo presentación y no sustituyen estas comprobaciones. Evidencia: `product/api/application.ts:171-182,187-245`. |

## Permisos de base de datos

| Ítem | Estado | Evidencia |
|------|--------|-----------|
| `nexo_runtime`: permisos mínimos sobre `resource_grants` | ⚠ PENDIENTE DE RECONCILIACIÓN | `db/migrations/019_f03_resource_grants.sql` crea la tabla sin grants; el parche local `db/migrations/023_f03_resource_grants_runtime_privileges.sql` concede `SELECT, INSERT, UPDATE`, no `DELETE`. `docs/migrations/README.md:57-60,91-105` dice que 023 no se aplicó al host AWS y advierte que la base carece de ledger. `docs/f13/gate-s3/GATE-S3-REPORTE-V3.md:20-25` reporta un grant manual vía SSM como workaround. Sin lectura independiente actual, no se afirma cuál es el privilegio efectivo hoy ni que la corrección sea persistente. |
| `nexo_runtime`: permisos mínimos sobre tablas F10 de soporte | ⚠ PENDIENTE DE APLICACIÓN/RECONCILIACIÓN | `db/migrations/024_f10_support_runtime_privileges.sql` concede `SELECT, INSERT, UPDATE` solo en las tablas existentes (`support_sessions`, `support_consent`, `support_session_attempts`, `support_session_outbox`), sin `DELETE` ni cambios a RLS. La migración y su prueba local no demuestran privilegios efectivos en AWS; allí no se aplicó 024 y el historial sigue sin ledger. |
| `nexo_runtime` vs `nexo_app`: separación de roles DB | NOT VERIFIED | `infra/aws/lab/nexo-runtime.sql:3-20,36-83` define `nexo_runtime` sin privilegios elevados y separa `nexo_migration`; el artefacto no define `nexo_app`. No se consultaron roles ni grants efectivos de la base remota en esta evaluación. |

## Red y TLS

| Ítem | Estado | Evidencia |
|------|--------|-----------|
| TCP/10000 (Webmin) restringido a IP autorizada | NOT VERIFIED — evidencia contradictoria | `docs/f09/README.md:130,133` documenta que `sg-0cc6a1e19439c3e89` conservaba TCP/10000 desde `0.0.0.0/0`; `docs/f08/evidence.md:133-136` también registra la regla histórica sin afirmar su CIDR. La información de entrada para este assessment indica un cambio a `190.5.151.74/32` el 2026-10-29, pero no hay verificación de la regla efectiva posterior en el checkout; debe consultarse el SG actual. |
| Sin IMDS expuesto a procesos no autorizados | NOT VERIFIED | `docs/f12/evidence.md:18` registra IMDSv2 efectivo y rechazo de una consulta sin token en EC2 el 2026-11-01, pero explícitamente no demuestra aislamiento del dataplane ni de procesos locales no autorizados. Se necesita la prueba de aislamiento correspondiente. |
| TLS en endpoints públicos | NOT VERIFIED — renovación inminente | `docs/f09/README.md:120,127,133` registra HTTPS y un certificado válido hasta el **2026-11-04**, con timer y dry-run observados en la campaña F09, y que no hay Elastic IP asignada. Al 2026-11-03 esa fecha aún no ha pasado; esta evaluación no volvió a sondear el endpoint ni el certificado. Confirmar renovación y estabilidad de URL antes del vencimiento. |

## Gaps críticos antes de S5

1. **Migraciones 023/024 y grants runtime:** ambas existen localmente, pero no se aplicaron al host AWS según `docs/migrations/README.md:59-60,103-105`; la base tampoco tiene ledger. El reporte S3 v3 informa una corrección manual para `resource_grants`, por lo que primero se deben reconciliar los grants efectivos y el historial. No ejecutar migraciones ni SQL remoto sin autorización específica.
2. **TLS F09:** verificar el certificado y la renovación antes del 2026-11-04; confirmar una dirección estable, pues la evidencia disponible indica que no hay Elastic IP asignada.
3. **Motor de soporte remoto:** C9 no está integrado. `product/api/application.ts:420-433` puede responder `503 support_transport_disabled` al abrir la sesión; `product/api/postgres-support-repository.ts:76-77` permite que el transporte no esté configurado y restringe el transporte sintético a pruebas.
4. **Revisión independiente (E4):** pendiente. Este documento lo prepara el implementador y no reemplaza el dictamen de un revisor distinto.
5. **Pruebas adversariales (E5):** la campaña dedicada queda **NOT RUN** en esta evaluación. Antes del gate, registrar evidencia reproducible para:
   - aislamiento cross-tenant: intentar usar el token de empresa A para leer o mutar empresa B;
   - bypass de cuota: intentar exceder la cuota mediante una solicitud directa al endpoint de excepción de cupo;
   - revocación bajo carga: revocar una sesión de soporte mientras se intenta abrirla o mantenerla activa;
   - escalada de operador: invocar endpoints owner-only con un token de operador y confirmar rechazo server-side.

## Veredicto self-assessment

**NO LISTO para gate S4** hasta resolver o validar independientemente:
- los permisos efectivos y la reconciliación de migrations 023/024 en AWS;
- las reglas actuales del SG y la ausencia de exposición indebida a IMDS;
- TLS y su renovación antes del vencimiento reportado;
- el cierre formal de la revisión independiente E4;
- al menos una iteración trazable de pruebas adversariales E5.
