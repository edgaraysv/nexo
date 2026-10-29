# GA-01 — integración administrativa entre F09 y F10

**Estado:** aprobado por el responsable de producto el 29 de octubre de 2026. Implementación local inicial en curso; despliegue AWS no autorizado por esta aprobación. GA-01 es una puerta independiente y no renumera F09, F10 ni las fases posteriores.

## Fuente y decisión

El plan compartido en PLANS, **«Sprint maestro de desarrollo de NEXO»**, define F09 como «Paneles completos, telemetría y reportes» y exige que la interfaz mínima se construya junto con cada funcionalidad. El corte F09 existente integró reportes, pero las demás herramientas administrativas quedaron distribuidas. GA-01 cierra esa brecha antes de F10 sin incorporar soporte remoto.

El identificador aprobado es **GA-01**. La gestión de asignaciones debe incluir el cierre mínimo de su API.

## Corte local implementado

- Entrada unificada en `/admin`, con login, MFA, selección explícita de superficie y empresa, identidad/rol/alcance visibles y navegación diferenciada para proveedor y empresa.
- Base visual derivada de los tokens y patrones de `design/nexo-ui/`; los cuatro originales se preservan sin cambios. Se mantiene un placeholder identificado porque no hay logo maestro ni fuentes aprobadas.
- Vistas integradas de lectura para empresas, comercial, nodos, entornos VPN, operaciones, usuarios, sedes, dispositivos, agentes, redes, recursos, políticas y auditoría. Las herramientas de mutación preexistentes siguen enlazadas mientras se completa su traslado al shell.
- Estados de carga, vacío, error y sin permiso. La UI no presenta heartbeat, estado aplicado o diagnóstico de política como conectividad probada.

### Cierre mínimo de asignaciones

| Contrato | Autorización | Efecto |
|---|---|---|
| `GET /v1/provider/operators` | provider owner | Lista operadores y estado |
| `GET /v1/provider/companies/:tenantId/operators` | provider owner | Lista asignaciones actuales |
| `PUT /v1/provider/companies/:tenantId/operators/:userId` | provider owner | Asigna de forma idempotente |
| `DELETE /v1/provider/companies/:tenantId/operators/:userId` | provider owner | Desasigna; `404` si no existe |

Asignación y desasignación efectivas generan una sola vez `operator.assigned` y `operator.unassigned`; repetir el `PUT` no duplica el evento. El runtime PostgreSQL requiere `DELETE` únicamente en `provider_company_assignments`. La migración local `018_ga01_assignment_permissions.sql` separa lectura (owner o asignación propia) de inserción/eliminación (solo owner), de modo que RLS también impide mutaciones directas de operator. El script local de grants se actualizó, pero ni `018` ni el grant se aplicaron en AWS.

## Corrección de autorización

`GET /v1/provider/nodes` y `GET /v1/provider/node-operations` quedan limitados a owner. No existe todavía una asignación de nodos que permita exponer inventario global a operator/auditor sin ampliar el modelo de permisos. Las vistas por empresa de F09 conservan su alcance por asignación.

## Límites vigentes

- Soporte remoto, sesiones, consentimiento y política desatendida permanecen en F10.
- Backup/restore comercial permanece en F16.
- El runtime F08 sigue limitado a trayecto directo IPv4. Gateway, SNAT y split-DNS no se presentan como aplicados. `network-diagnostics` conserva `connectivity: not_tested`.
- La migración `016` permanece **NOT APPLIED**. GA-01 no depende de aplicarla. La nueva `018` está implementada localmente y también permanece **NOT APPLIED** en AWS.
- No se ejecutó suite completa, P2, AWS, restore, rollback, zoom gráfico real al 200 % ni lector de pantalla.
- `/admin` no acredita readiness productiva ni conformidad WCAG.

## Evidencia local del 29 de octubre de 2026

- **PASS** — `npm run typecheck`.
- **PASS** — build y 13 pruebas dirigidas de L03/L06/F09; incluyen API de asignaciones, autorización owner-only y shell `/admin`.
- **PASS** — `npm run test:ga01-postgres` sobre PostgreSQL `17.6-bookworm` desechable: migraciones `001-015 + 017 + 018`, con `016` omitida; listado, asignación idempotente, desasignación, grants runtime, RLS owner-only, auditoría sin duplicados y limpieza.
- **PASS** — recorrido Chromium headless local con owner, operator, auditor del proveedor, admin, técnico y auditor empresarial; ciclo asignar/desasignar, shell de solo lectura para roles no-owner, reflow a 390 px y foco programático. Captura: `/tmp/opencode/ga01-admin-mobile.png`.
- **FAIL (corregido y repetido PASS)** — el primer recorrido real detectó uso de `event.currentTarget` después de `await` en login/MFA; los formularios ahora capturan su referencia antes de esperar.
- **BLOCKED** — `node scripts/check.mjs` por hash baseline previo de `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`; el baseline no se actualizó silenciosamente.
- **NOT RUN** — lector de pantalla, zoom gráfico real al 200 %, suite completa, despliegue/rollback AWS y restore.

## Aceptación pendiente del gate implementado

1. Completar el traslado de las mutaciones preexistentes al shell común o aprobar explícitamente la navegación temporal a herramientas operativas conectadas.
2. Completar la verificación manual de teclado (secuencia completa), zoom gráfico real al 200 % y lector de pantalla; conservar cada resultado como PASS/FAIL/NOT RUN independiente.
3. Resolver explícitamente el baseline previo de `scripts/check.mjs` sin ocultar el cambio de la especificación UX/UI.
4. Preparar despliegue y rollback del laboratorio y solicitar autorización separada antes de cualquier mutación AWS.
