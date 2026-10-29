# F09 — reporting operativo inicial

**Estado:** alcance local de F09 terminado y desplegado/verificado en el laboratorio AWS existente. Zoom gráfico real al 200 % y lector de pantalla quedan como pendientes aceptados, no bloqueantes y **NOT RUN**. No hay certificación de accesibilidad ni declaración de preparación productiva.

## Artefacto

- `prototype.html`: prototipo autocontenido, con datos ficticios, interacción local de navegación y vistas separadas de proveedor/empresa. No está conectado a las APIs.
- Sin llamadas de red, API, persistencia ni acciones que modifiquen datos. No contiene credenciales ni información de clientes.
- El prototipo aislado no modifica `product/api`, permisos, migraciones, AWS, Windows o VPN. El corte funcional y el despliegue del laboratorio se documentan por separado abajo. No se toca ni reabre el entorno/evidencias P2.

## Decisiones de alcance F09-inicial

1. Reutilizar `audit_events` para la vista empresarial; `/v1/company/audit` ahora tiene filtros/paginación y mantiene `company.audit.read` y RLS de tenant.
2. Reutilizar `provider_audit_events`; `/v1/provider/companies/:tenantId/audit` ahora tiene filtros/paginación. `owner` puede consultar cualquier empresa existente; `operator` y `auditor` solo las asignadas, comprobado en API y con RLS.
3. Conservar las emisiones existentes del proveedor: `company.created`, `operator.assigned`, `plan.created`, cambios de suscripción/módulo/cupo, pagos y settings.
4. Añadir a F09-inicial eventos transaccionales para aprobación/revocación de nodo, invitaciones de nodo, creación/resultado de operaciones de nodo y cambios de estado/configuración de entorno VPN. Esos huecos dejan incompleta una auditoría operativa; no se cubrirán con eventos duplicados.
5. Auditoría empresarial ya registra varias operaciones (sitio/equipo, invitaciones/aceptación, roles, políticas, endpoints y operaciones); antes de sumar emisores se hará una matriz evento→tabla→acción para añadir solo huecos de alto impacto del alcance F09.
6. El resumen de empresa muestra cupos/counters comerciales únicamente como consumo de cupo contratado. No infiere bytes, tasas, latencia, salud de backup, soporte operativo, gateway disponible ni conectividad desde configuración aplicada.

## Inicial / posterior

**Inicial:** APIs de solo lectura para resumen, auditoría empresarial y de proveedor, inventario de agentes, operaciones/heartbeats y lectura comercial de proveedor; filtros y páginas acotadas; señales de heartbeat separadas del registro; fuentes, timestamps, frescura/cobertura y `cache-control: no-store`. Las UI administrativas integradas viven en `/provider/reports` y `/company/reports`, enlazadas desde las superficies existentes; `product/client` sigue siendo el cliente endpoint y no se usa como panel. La exportación queda limitada a resumen y auditoría empresarial, protegida por permiso independiente y permisos de lectura del dataset.

**Posterior:** nueva instrumentación de bytes/tasas/latencia y métricas de soporte/backup; alertas/canales; retención configurable y exportación avanzada; streaming/SIEM; pruebas activas de conectividad a recursos; estado real de gateway/retorno/SNAT/DNS; diagnóstico avanzado.

## Permisos y criterios de salida

- Proveedor: `owner` con alcance global; `operator` y `auditor` limitados a empresas asignadas. No se confía solo en filtrado de UI.
- Empresa: permisos actuales `company.summary.read`, `company.site.read`, `company.device.read`, `company.agent.read`, `company.operation.read`, `company.audit.read` y `company.network.read`. Las vistas no elevan permisos. Los técnicos sin `company.audit.read` no reciben auditoría.
- CSV empresarial: `company.report.export` independiente, definido en migración local `017` y sin grants automáticos. Un usuario con `company.user.roles.manage` puede concederlo o revocarlo a un rol del tenant mediante `/v1/company/report/export-grants`; el cambio es idempotente y se audita en la misma transacción. Se exige además `company.summary.read` o `company.audit.read`, según dataset.
- Aceptación: (1) no cruce de tenant/asignación; (2) fuente/tiempo/frescura/cobertura declarados; (3) duplicados y huecos visibles, sin duplicar contadores; (4) cambio parcial no se presenta como éxito/conectividad; (5) auditoría saneada y scoped; (6) estados diferenciados y estructura preparada para teclado/lector/zoom.

La migración `016` real sigue **NOT APPLIED**. No se consultó ni alteró; se omitió en la validación PostgreSQL desechable.

## Iteración de prototipo — validación UX local

En la iteración original del prototipo se modificaron `docs/f09/README.md` y `prototype.html`; la adopción de la base SYSMedia también actualizó `AGENTS.md` y `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`. Esa maqueta aislada no usaba red/API/persistencia. El corte funcional posterior sí modifica API, permisos y migración local, detallados en la sección final; no modifica P2 ni recursos AWS.

### Cambios visibles

- Se distinguen panel del proveedor y portal empresarial, con superficie, rol, empresa y alcance de muestra visibles. El cambio de superficie, rol o empresa limpia filtros, detalles y la casilla de permiso CSV simulado.
- Los fixtures empresariales están asociados a Empresa Alfa; Beta/Delta no heredan sus filas. Los escenarios de operador solo ofrecen empresas marcadas como asignadas en la muestra. Esto es filtrado de demostración, no un control de acceso.
- Inventario, operaciones y auditoría tienen filtros locales funcionales y detalles contextuales saneados. Registro, heartbeat, configuración aplicada y conectividad comprobada no se confunden.
- Indicadores exponen fuente, unidad, periodo, hora observada/recibida cuando existe, frescura y cobertura. Cuando falta una fila o una fuente, se indica “No disponible”/“No medido”; no se infiere cero.
- Los bloques permiten alternar carga, sin datos, antiguo, sin permiso, no contratado cuando corresponde y error parcial; el estado es local y recuperable.
- Navegación con teclado, enlace para saltar al contenido, foco visible, etiquetas, anuncios breves, tablas adaptables y reducción de movimiento. La vista se reordena para pantallas estrechas.
- Los CSV siguen siendo una demostración acotada. Se bloquean inicialmente; la casilla simula un permiso explícito, y archivo/nombre/contenido indican que son datos ficticios. No prueba autorización ni descarga real de datos Nexo.
- Se aplica a la maqueta la paleta principal SYSMedia, sus tokens funcionales propuestos y radios/sombras discretos; se eliminó el fondo degradado anterior. El nombre de producto sigue siendo Nexo y se muestra el tagline oficial.
- No existe archivo maestro del logo ni fuentes en el repositorio. Por eso el encabezado usa un placeholder visible, no redibuja el símbolo; Manrope/Inter quedan como nombres preferidos con fallback local y sin carga remota. La apariencia final de marca espera los assets aprobados.

### Verificaciones de esta iteración

Evidencia separada por tipo; no equivale a certificación ni a prueba de producción.

| Tipo | Resultado | Evidencia / límite |
|---|---|---|
| Código | **PASS** | Parseo HTML y `node --check` del script inline. Sin dependencias añadidas. |
| Ejecución local | **PASS** | Chromium headless por CDP: navegación por superficie, filtros de empresa/inventario/operaciones/auditoría, detalle, limpieza de contexto, estados, recuperación, CSV bloqueado por defecto y generación de CSV demo con etiqueta ficticia. Sin errores de consola/runtime en el recorrido. |
| Sistema visual | **PASS limitado** | Tokens de color/geometría y texto SYSMedia verificados en el prototipo. Ratios calculados para pares representativos: texto primario/blanco 14.18:1, secundario/blanco 5.85:1, acción/blanco 5.37:1 y estados sobre sus fondos suaves 4.81–5.39:1. No certifica WCAG; no se pudo verificar logo/fuentes oficiales porque sus archivos no están en el repositorio. Colores funcionales y tipografías siguen siendo propuestas pendientes de aprobación. |
| Teclado/foco | **PASS** | Tab alcanza primero “Saltar al contenido”; foco visible; Enter lleva al `main`. No es evaluación completa de lector de pantalla ni conformidad WCAG. |
| Reflow | **PASS** | Chromium headless/CDP en viewport CSS 320×800, 360×800, 390×844, 768×1024, 1024×768, 1280×720 y 1440×900: sin overflow horizontal del documento. Se eliminó `min-width: 320px` del `body` para aprobar 320 px. Capturas y `results-final.json` bajo `/tmp/opencode/f09-review/`. |
| Aumento 200 % | **NOT RUN** | No se ejecutó navegador gráfico con zoom real. El equivalente a mitad del viewport anterior no se usa como cierre de este criterio. |
| Descarga CSV física | **NOT RUN** | Se verificaron nombre y contenido Blob interceptando la descarga dentro del navegador; no se verificó el guardado por el sistema operativo. |
| Navegador OpenChamber | **NOT RUN** | No había cliente OpenChamber conectado; se usó Chromium local headless/CDP para render e interacción. |
| Autorización real / WCAG | **NOT RUN** | Son fuera del alcance del prototipo; ninguna interacción prueba permisos, seguridad de tenant ni conformidad. |

### Pendientes y veredicto

- Validar el flujo con producto/diseño y una revisión manual en navegador gráfico al 200 % y con tecnologías de asistencia antes de usarlo como criterio de aceptación.
- Para integrar una UI, probar nuevamente autorización server-side, aislamiento de tenant/asignación y concesión del permiso específico de exportación; el estado visual no es una decisión de seguridad.
- **Veredicto UI/UX de esta iteración: mejora sustancial; apta para revisión del prototipo, no para producción.** Se atendieron las recomendaciones aprobadas y las verificaciones locales enumeradas pasan. Persisten límites de validación visual/assistiva y no se declara conformidad WCAG.

La migración `016` real permanece **NOT APPLIED**. P2 no se reabrió ni se repitieron sus pruebas.

## Corte funcional y preparación de despliegue — 28 de octubre de 2026

### Superficies/API implementadas

- Auditoría empresarial (`/v1/company/audit`), inventario (`/v1/company/agents`), operaciones (`/v1/company/operations`) y heartbeats (`/v1/company/heartbeats`) paginados/filtrables. Máximo de 100 filas por página, orden estable y validación de fechas/filtros.
- Nuevas vistas de proveedor por empresa para auditoría, inventario, operaciones y heartbeats, además de lectura comercial limitada a tenants asignados. Auditoría de proveedor: `owner` global; `operator` y `auditor` solo en tenants asignados, aplicado en API y RLS.
- Las vistas operativas declaran fuente, unidad, hora de generación, frescura y cobertura; usan `cache-control: no-store`. Inventario no retorna PEM ni material de clave privada; las vistas de proveedor omiten información de credencial.
- CSV limitado a resumen y auditoría empresarial. Requiere `company.report.export` y el permiso de lectura del dataset; el permiso no se concede por defecto. Auditoría admite hasta 500 filas y exige que el conjunto filtrado quepa en una página; se neutralizan celdas tipo fórmula. Inventario y operaciones no son exportables.
- `db/migrations/017_f09_reporting_permissions.sql` define el permiso sin asignaciones implícitas, ajusta la política RLS de auditoría de proveedor y conserva compatibilidad de escritura con el release anterior para permitir rollback de aplicación. En el laboratorio se aplicó `017` y los grants runtime mínimos descritos abajo; no se ejecutó allí todo `infra/aws/lab/nexo-runtime.sql`.
- `/provider/reports` y `/company/reports` consumen las APIs reales, aplican el alcance devuelto por el servidor, presentan estados vacíos/parciales y metadatos de fuente/frescura/cobertura. La administración empresarial del grant es por rol y requiere confirmación explícita.
- `provider_audit_events` distingue actores `user`, `node`, `device` y `system`; los resultados de agentes no se atribuyen al usuario que originó una operación.

### Matriz evento → acción → tabla

Todos los emisores listados escriben dentro de la misma transacción que el cambio durable. Los reintentos idempotentes de resultado y heartbeat no crean un segundo evento.

| Área / acción durable | Evento | Tabla | Actor / alcance |
|---|---|---|---|
| Empresa: sitio, equipo declarado, invitación/aceptación, rol y política | `site.created`, `device.declared`, `user.invited`, `invitation.accepted`, `user.role_changed`, `policy.created`, `policy.updated` | `audit_events` | `user`; tenant actual |
| Endpoint: invitación, aprobación y revocación | `device.invitation.created`, `device.approved`, `device.revoked` | `audit_events` | `user`; tenant actual |
| Operación endpoint: creación y resultado terminal | `operation.created`, `operation.completed` | `audit_events` | creación `user`; resultado `device` en metadata; tenant de la operación |
| Heartbeat endpoint modificado | `device.heartbeat.received` | `audit_events` | `device` en metadata; tenant del dispositivo |
| Grant de exportación por rol | `report.export_permission.granted`, `report.export_permission.revoked` | `audit_events` | `user`; tenant y rol afectados |
| Proveedor: empresa, asignación, plan, suscripción/módulo/cupo, pago y setting | eventos existentes `company.created`, `operator.assigned`, `plan.created`, `subscription.changed`, `subscription.module_changed`, `quota.exception_changed`, `payment.recorded`, `setting.changed` | `provider_audit_events` | `user`; global o tenant según recurso |
| Nodo: invitación, aprobación, revocación y creación de operación | `node.invitation.created`, `node.approved`, `node.revoked`, `node.operation.created` | `provider_audit_events` | `user` o `device`; global salvo operación solicitada por dispositivo |
| Resultado y heartbeat de nodo modificados | `node.operation.completed`, `node.heartbeat.received` | `provider_audit_events` | `node`; global o tenant derivado cuando existe dispositivo solicitante |
| VPN: creación, estado deseado y reporte observado modificado | `vpn.environment.created`, `vpn.environment.desired_state_changed`, `vpn.environment.observed_state_reported` | `provider_audit_events` | `user` para cambios deseados; `node` para observación; tenant del entorno |

### Matriz de aceptación actual

| Criterio | Estado | Evidencia / límite |
|---|---|---|
| Prototipo: recorrido, estados y comprobaciones funcionales | **PASS** | 30/30 checks en `/tmp/opencode/f09-review/results-final.json`; Chromium headless, fixtures ficticios y sin llamadas de red. |
| Reflow 320–1440 px | **PASS** | Siete viewports indicados en la tabla de verificación. |
| Zoom real 200 % / lector de pantalla | **PENDIENTES ACEPTADOS — NOT RUN** | No bloquean el cierre local; Chromium headless disponible y no se encontró lector de pantalla. No son PASS ni implican declaración WCAG. |
| API: autorización, aislamiento, filtros, paginación y CSV | **PASS local** | `tests/f09-reporting.test.mjs` usa fixtures no vacíos y cubre acceso directo, 403/404, filtros/límites, páginas, CSV permitido, neutralización de fórmulas, conjunto de 501 filas rechazado y revocación. Regresión dirigida: 33/33 pruebas en ocho suites, sin P2. |
| PostgreSQL desechable y RLS | **PASS local** | `node scripts/f09-postgres.mjs`: migraciones 001–015 + 017; omite 016; comprueba scopes, grant/revocación, atomicidad, actores tipados y no duplicados. No aplica migraciones reales. |
| UI administrativa conectada a las APIs | **PASS local** | Recorrido Chromium headless contra servidor real con fixtures: autenticación/MFA, proveedor y empresa, tablas no vacías, metadatos, grant/revocación, consola sin errores y alcance de empresa. Evidencia: `/tmp/opencode/f09-ui-integrated-results.json` y capturas `f09-*-integrated.png`. |
| Teclado/foco y reflow de UI integrada | **PASS local limitado** | Skip link primero en tabulación, controles nativos y foco visible. Sin overflow del documento a 320, 360, 390, 768, 1024, 1280 y 1440 px. No equivale a lector de pantalla ni zoom gráfico real. |
| Cobertura de auditoría del alcance F09 | **PASS local** | Matriz anterior y ensayo PostgreSQL comprueban emisores de endpoint, nodo y VPN, escritura atómica, actor explícito y deduplicación en reintentos idénticos. |
| Concesión del permiso de exportación | **PASS local** | Gestión por rol aprobada, protegida por `company.user.roles.manage`, cero grants automáticos, confirmación UI, lectura adicional del dataset y auditoría atómica. |
| Despliegue y smoke AWS de laboratorio | **PASS limitado** | EC2 y PostgreSQL local existentes; HTTPS, login/MFA, reportes, PostgreSQL, aislamiento, grant/revocación/CSV y limpieza de fixtures verificados. Evidencia y límites en la sección siguiente. No es readiness productiva. |

### Despliegue en laboratorio AWS — evidencia del release `f09-20261029T033523Z`

**Alcance y recurso:** reutiliza la EC2 `i-006cda6fdc86af7a5` en `us-east-1` y PostgreSQL local existente; no se creó RDS ni Elastic IP. La API y el worker están activos. La URL actual es <https://3.226.252.132/>; las páginas `/provider/reports` y `/company/reports` responden por HTTPS. HTTP redirige a HTTPS.

| Control | Resultado verificado | Evidencia / límite |
|---|---|---|
| Build y artefacto | **PASS** | Build TypeScript local; release `f09/releases/f09-20261029T033523Z/product.tar.gz`, versión S3 `Q8B5TJA0y5tSGO7aC4xKVj4QWLGYCJX6`, KMS; SHA-256 `d7add9b2f8780f803f1a139ed379edbbde2785b8f9ab6d461dc570d0e31ba676`. |
| Respaldo previo de PostgreSQL | **PASS — creado y verificado** | `/var/lib/nexo/backups/nexo-pre-f09-20261029T033523Z.dump`; 478042 bytes, `pg_restore --list` devolvió 525 entradas. S3: `s3://nexo-lab-423597267645-us-east-1-control/f09/backups/nexo-pre-f09-20261029T033523Z.dump`, versión `qGt3NR4vecZ9VqN2axZf7YWpQhBBGPEv`, SSE-KMS. **No se ensayó restauración.** |
| Migración y grants runtime | **PASS** | Aplicada `017`; `016` continúa **NOT APPLIED**. Se verificaron `SELECT` runtime en `audit_events` y `provider_audit_events`, `DELETE` en `role_permissions`, constraint y trigger de compatibilidad. No se crearon grants automáticos para `company.report.export`; cero filas de grants al aplicarla. |
| Servicios y HTTPS | **PASS** | API/worker y Nginx activos; ambas páginas 200 y redirección HTTP 301. Certificado Let’s Encrypt de IP válido hasta **4 nov 2026**. Timer diario `nexo-certbot-renew.timer` activo y `certbot renew --dry-run` **PASS**. |
| Smoke autenticado | **PASS** | Login y MFA, resumen y auditoría empresarial vía PostgreSQL, grant y revocación de exportación, CSV permitido durante el grant y denegado antes/después. La auditoría de proveedor para tenant asignado pasó; tenant no asignado fue denegado con 404. |
| Fixtures | **PASS** | Datos de prueba efímeros eliminados; verificación final encontró cero filas residuales. |
| Seguridad de red | **PASS con exposición preexistente** | SG web adicional `sg-03cdfbdcb51d62fd5`: inbound TCP 80/443 desde IPv4 público, cero reglas de egreso. Se conservó intacto el SG `sg-0cc6a1e19439c3e89`, incluida su regla TCP/10000 desde `0.0.0.0/0`; los grupos se acumulan en la instancia. No se abrió SSH ni un puerto de API adicional. |
| Rollback de aplicación | **Preparado, no ensayado** | Release anterior conservado en `/opt/nexo/releases/pre-f09-20261029T033523Z/product`; `017` conserva compatibilidad de escrituras con el código anterior. El path activo `/opt/nexo/dist/product` debe seguir siendo un directorio real, no symlink. No se hizo rollback ni se revirtió la migración. |

**Límites que siguen vigentes:** el certificado corto y la URL dependen de la IP pública dinámica; al detener/iniciar la EC2 la IP puede cambiar y requerir reemitir el certificado. No se asignó Elastic IP. No se probó restauración del backup, VPN, recuperación/rollback, métricas/alertas ni P2; tampoco se ejecutaron suites completas. El `main.tf` de `infra/aws/lab/` no representa el SG web adicional, por lo que no se debe aplicar Terraform sin revisar primero un plan y reconciliar el estado. El puerto TCP/10000 público preexistente sigue expuesto y requiere decisión separada.

### Trabajo pendiente antes de cualquier uso productivo

1. Aprobar arquitectura, DNS/IP estable, exposición y terminación TLS para producción; resolver la exposición existente de TCP/10000 y definir acceso administrativo. La API continúa escuchando solo en loopback detrás de Nginx.
2. Diseñar infraestructura y base productivas separadas del laboratorio; revisar la secuencia real de migraciones —incluido `016`— mediante autorización separada. Ensayar restauración del backup y rollback en un entorno no productivo.
3. Aprobar custodia de secretos/CA, IAM mínimo, logging y retención, métricas/alertas, health/readiness, costos y responsables operativos.
4. Crear pipeline reproducible con verificaciones/escaneo y reconciliar IaC con los recursos del laboratorio antes de cualquier `plan`/`apply`.
5. Validar VPN, zoom gráfico real al 200 % y tecnologías de asistencia. No declarar conformidad WCAG sin evaluación específica.

El despliegue y los smoke checks anteriores solo acreditan el laboratorio; **no implican readiness productiva**. `016` sigue **NOT APPLIED**, P2 no se reabrió y no se afirma recuperación probada.

### Veredictos independientes

- **Prototipo:** **PASS para revisión local**, no productivo; zoom real y lector de pantalla siguen NOT RUN.
- **Implementación funcional:** **PASS local** para APIs, PostgreSQL desechable, UI integrada, autorización, grants y auditoría. **Alcance local F09 terminado con salvedades aceptadas:** zoom gráfico real al 200 % y lector de pantalla permanecen **NOT RUN**, no bloqueantes y no PASS; no se declara conformidad WCAG.
- **AWS:** **PASS limitado** para el despliegue/smoke del laboratorio; no equivale a preparación productiva.

La migración `016` permanece **NOT APPLIED**; P2 no se reabrió ni se repitieron sus pruebas.
