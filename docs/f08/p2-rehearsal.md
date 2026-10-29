# F08 P2 — restore y ensayo local de 015/016

Fecha: **2026-10-28 UTC**. Alcance: descarga del backup F07 `flicker`, dos restores locales y ensayo de migraciones/rotación en una copia. No se accedió a AWS durante esta ejecución salvo la descarga autorizada previa mediante URL prefirmada; no se cambió ningún recurso remoto. No hubo acceso a Windows, VPN, servicio desplegado ni base real. Sin commit, push o PR.

## Dictamen

| Gate | Estado | Alcance |
| --- | --- | --- |
| Integridad e identidad del backup | **PASS** | VersionId fijado, SHA-256 documentado y gzip íntegro |
| Restore reproducible | **PASS** | El mismo dump restauró en `nexo` y `nexo_replay` |
| Baseline original | **PASS, limitado por datos** | Schema, owners, RLS, grants y huellas comparados; el dump solo contiene 19 filas en tres tablas |
| Prerrequisito 015 | **PASS local** | Aplicada solo a `nexo`; ausente en `nexo_replay` |
| Ensayo 016 | **PASS local** | Aplicada solo a `nexo`; no aplicada a la base real |
| API de credenciales | **PASS de repositorio** | Escenarios ejecutados con PostgreSQL y `nexo_runtime`; HTTP autenticado **NOT RUN** |
| F09 | **No iniciada** | Evaluación y decisiones al final de este documento |

## Backup, integridad y restore

- Objeto: `s3://nexo-lab-423597267645-us-east-1-control/f07/backups/20261027/nexo-f07-flicker-predeploy.tar.gz`.
- `VersionId`: `Xl8fhJp7y8ZEOTzG8KO4EiSJOV7H3QzW`; la respuesta descargada confirma el mismo ID, fecha `2026-10-27T22:40:28Z` y tamaño `6,437,964` bytes.
- SHA-256 del archivo: `044fdc78e40b3c2621a94183f5ec5454d59a8117e97c6ca0c50d532bb74383f1`; coincide con `docs/f07/evidence.md`.
- `gzip -t`: **PASS**. El tar no presentó rutas absolutas ni `..`; solo se extrajo `nexo.dump`. No se ejecutaron ni extrajeron `nexo-agent` o `dist/`.
- ETag reportado por S3 (`76993d646f4ac39118e2a6c93c5772bd`) no coincide con MD5 local (`f4d0f42bc84df6b6e850e3d0fee6bc2f`). La respuesta declara SSE-KMS; por ello no se trató el ETag como MD5 del objeto. La integridad se acepta por el SHA-256 de referencia y gzip íntegro, no por ETag.
- Dump: PostgreSQL custom, versión de archivo `1.16-0`, 461 entradas TOC, compresión gzip; generado por `pg_dump 17.11` desde servidor `17.11`. `pg_restore` 17.11 lo leyó correctamente.
- Nota de manejo: durante la inspección se generó transitoriamente una representación SQL completa de `nexo.dump` para revisar su cabecera/DDL. No se usó para restaurar ni se transfirió fuera del entorno local. Después la eliminé para no conservar una copia textual adicional del backup; informo esta excepción porque retirar ese archivo de trabajo entra en tensión con la instrucción de preservar evidencias. El backup autorizado y el dump original extraído siguen conservados.
- Servidor de ensayo: PostgreSQL `17.11`, imagen amd64 fijada por digest `sha256:2cd2c0f809604aaeff6f0ec8f40aecbd025613107561015c69369a1a7f1d3416`.
- Restore ejecutado en ambas bases con `pg_restore --exit-on-error --single-transaction --verbose -U postgres -d <base> /tmp/nexo.dump`; ambos **PASS**, sin errores ni warnings.
- Roles globales no incluidos en el archive: se recrearon localmente `nexo_migration` (NOLOGIN) y `nexo_runtime` (LOGIN), ambos sin superusuario ni BYPASSRLS. Contraseñas temporales quedaron en archivos `0600` fuera del repo y no se incluyen en este informe.

### Aislamiento local

Contenedor `nexo-f08-p2-db`, volumen persistente `nexo-f08-p2-pgdata`, red Docker `nexo-f08-p2-net` con `internal=true`. El contenedor no publica puertos (`5432/tcp: null`), no tiene política de reinicio y solo está conectado a esa red interna. Los runners de Node para las pruebas se conectaron a la misma red interna; no se habilitó salida a producción. Contenedor, volumen, backup y evidencias se conservan como se autorizó.

Comprobaciones: `docker network inspect nexo-f08-p2-net`, `docker inspect nexo-f08-p2-db`, `docker volume inspect nexo-f08-p2-pgdata`, `pg_isready`, `SHOW server_version`.

## Baseline pre-migraciones y reproducibilidad

Antes de aplicar 015/016:

- El archive tiene **50 tablas** públicas y **50 entradas TABLE DATA**; no se asumieron 55.
- Hay **19 filas en total**, solo en `control_security_state` (1), `permissions` (17) y `plans` (1). `tenants`, `users`, `provider_nodes`, `vpn_environments`, `node_operations` y `vpn_client_credentials` están vacías. No hay muestras representativas de credenciales ni operaciones que permitan validar retención de datos de negocio; el baseline es predominantemente schema-only.
- Los owners de las 50 tablas son `nexo_migration`. 47 tablas tienen RLS **enabled y forced**; las tres sin RLS son `control_security_state`, `permissions` y `security_reconciliation_events`.
- Se registraron políticas, grants efectivos y definición de esquema. En ambas copias, el rol `nexo_runtime` conserva en `vpn_client_credentials` `SELECT/INSERT/UPDATE`, sin `DELETE`.
- Comparación `nexo` ↔ `nexo_replay` antes de migraciones: `pg_dump --schema-only --no-owner --no-privileges`, normalizado solo para quitar las líneas aleatorias `\restrict`/`\unrestrict`; las 50 huellas de contenido JSON por tabla; owners/RLS; políticas; grants. Diferencias: **ninguna**.

La comparación demuestra que el restore es reproducible; no demuestra restore de una carga de negocio representativa porque la copia contiene solo esas 19 filas.

### Inventario de migraciones inferido del esquema

El dump no incluye ledger de migraciones; por eso se informa presencia de objetos, no una afirmación basada en historial oficial:

- Las estructuras base y objetos de 010–012 están presentes; 014 está presente por `tls_crypt_key_envelope`.
- **013 no está presente**: faltan las cinco tablas `private_network_*` y sus políticas de tabla. Esto concuerda con que el objeto es un backup `predeploy` del 27 de octubre, mientras `docs/f08/README.md` y `docs/f08/evidence.md` registran 013 desplegada después. No se aplicó 013: no era una dependencia de 015/016 ni fue autorizada para este restore.
- **015 no estaba presente**: faltaba `nexo_node_latest_revision(uuid)`.
- **016 no estaba presente**: existía la unicidad total `vpn_client_credentials_tenant_id_device_id_environment_id_key`; faltaban los índices parcial activo e histórico.
- Por tanto, la diferencia entre las dos restauraciones es cero; la diferencia con el esquema local/deploy posterior se explica por el momento `predeploy` del artefacto, no por un restore incompleto.

## 015 y 016 — copias locales únicamente

1. Se guardaron las huellas del baseline original.
2. Se aplicó `db/migrations/015_f07_revision_assigner.sql` solo en `nexo` (SHA-256 `9bc0188ec030cfde169daf400db3c266310ecccb774f4a3aa23903e35e7cf67d`). La función quedó `SECURITY DEFINER`, ejecutable por `nexo_runtime` y no por `PUBLIC`; las 50 huellas originales no cambiaron.
3. Se aplicó `db/migrations/016_f07_vpn_credential_rotation.sql` solo en `nexo` (SHA-256 `af9af34c8b99cb1631e49d561f0c6b2daa19f63daec60c73a515c3a7fdbb5964`).
4. Verificación posterior: `vpn_client_credentials_active_key` existe con predicado `pending/issued/revocation_pending`; existe `vpn_client_credentials_history_idx`; la unique total antigua no existe. RLS sigue enabled+forced. El rol runtime conserva SELECT/INSERT/UPDATE y no tiene DELETE. Las 50 huellas originales son idénticas a las anteriores a 015/016.
5. `nexo_replay` permanece sin 015/016: la función e índices nuevos están ausentes y la unique total original sigue presente.

Consultas verificables quedaron en `/tmp/opencode/f08-p2/evidence/016-verification.txt` y `replay-unmigrated-verification.txt`.

## Ensayos de credenciales en la copia `nexo`

Se usaron los repositorios `PostgresVpnCredentialRepository` y `PostgresNodeRepository` contra `nexo`, con `nexo_runtime` y contexto RLS de tenant/dispositivo. El runner no expuso HTTP ni autenticación HTTP.

| Escenario | Resultado |
| --- | --- |
| CSR idéntico devuelve la misma credencial activa | **PASS** |
| CSR distinto con credencial pendiente, emitida o `revocation_pending` | **PASS**, `credential_conflict` |
| Reemisión luego de `revoked` | **PASS** |
| Reemisión luego de `failed` | **PASS** |
| `get` elige activa sobre historial terminal y la terminal más reciente si no hay activa | **PASS** |
| `revoke` por serial válido; serial inexistente no revoca | **PASS** |
| Revocación conserva filas de historial | **PASS**, quedaron 3 filas de fixture (failed/revoked/revoked) |
| Prueba HTTP autenticada / API E2E | **NOT RUN** |

Evidencia final: `/tmp/opencode/f08-p2/evidence/credential-repository-test-run3.json`. Hubo intentos preliminares del harness que no llegaron a evaluar el último assert funcional: una lectura de verificación no establecía contexto RLS y varias repeticiones chocaron con claves únicas de fixtures previos. Se corrigieron usando contexto runtime y fixtures únicos; la ejecución final de todos los escenarios terminó **PASS**. Esos datos de ensayo permanecen en `nexo`; no se limpiaron el volumen ni el contenedor.

## Suite local y límites del resultado

- `npm run build`: **PASS**.
- `npm run typecheck`: **PASS**.
- `npm test`: **PASS**, 108/108.
- Los resultados anteriores son de repositorio/suite local; no son pruebas HTTP autenticadas ni pruebas desplegadas.
- No se aplicó 016 a la base real. El estado desplegado continúa **NOT APPLIED**, conforme a `docs/f08/evidence.md` y `docs/f08/deployment-plan.md`; no se consultó ni modificó esa base durante P2.

## F09 — definición, criterios y dependencias encontradas (sin iniciar F09)

La fuente de trazabilidad `docs/f01/traceability.json` nombra **F09 “Paneles y reportes”**. Asocia RF08 (“Telemetría, auditoría y reportes”) a F05/F09 y PV01, PV08, PV09 y PV11. Criterios explícitos localizados:

- **PV01:** manipular identificadores de otra empresa en API/reportes; denegar sin filtrar datos.
- **PV08:** reiniciar agente y repetir telemetría; no duplicar contadores e identificar huecos.
- **PV09:** interrumpir API, cola o red durante un cambio; reconciliar idempotentemente y mostrar estado honesto.
- **PV11:** medir túneles y soporte con carga representativa; documentar línea base, límites y degradación.
- **UX:** UX01/02 contexto y aislamiento empresarial; UX06 no confundir VPN conectada con recurso alcanzable; UX11 estado parcial/reintento; UX14 teclado/lector de pantalla; UX15 zoom, viewport estrecho y contenido íntegro. Los escenarios están descritos en `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`.
- **Datos/operación:** catálogo `Nexo_Catalogo_de_Parametros_Administrables.md`, OPS01–08: estado con fuente/fecha/calidad, conexiones/bytes/tasas/latencia sin doble conteo, auditoría sin secretos, retención/exportación tenant-scoped, alertas, diagnóstico observado sin shell y operaciones idempotentes/reconciliables.
- `docs/f01/architecture.md` define observabilidad conceptualmente como `UsageSample`/`AuditEvent` con ámbito empresarial, deduplicación, fuente, hora y cobertura; no como un contrato implementado.

**Ambigüedad a resolver:** el documento de análisis de producto usa **RF09** para conexiones directas/descubrimiento/relay; la trazabilidad asigna ese RF09 a **F15**. No es lo mismo que la fase **F09**, pero la numeración puede inducir error. La descripción de F09 en la trazabilidad sí apunta a paneles/reportes; no encontré un plan F09 detallado ni una aceptación de producto F09 cerrada.

### GO/BLOCKED separado

| Actividad futura | Decisión | Dependencias y motivo |
| --- | --- | --- |
| Diseño | **GO limitado, tras confirmar alcance** | Hay criterios para iniciar diseño de navegación, vistas, permisos, fuente/frescura/cobertura y estados. Antes, el responsable de producto debe confirmar que F09 es “Paneles y reportes” y que RF09 de relay permanece en F15. Este informe no inicia ese diseño. |
| Implementación local | **BLOCKED** | No existe contrato F09 de métricas/retención/exportación/deduplicación, alertas, permisos por reporte ni cobertura. PV08, PV01 y UX14/15 siguen sin aceptación F09. P2 valida 016, no valida telemetría; además el backup reproducido no contiene 013, así que no es una base completa para probar reportes F08. No aplicar 013 sin autorización aparte. |
| Despliegue | **BLOCKED** | F09 no está implementada/aceptada; PV11 requiere carga acordada y medida antes del piloto; PV12/seguridad previa a clientes reales sigue pendiente. Persisten límites F07/F08 documentados: 016 no aplicada en real, observación Windows live no ejecutada y residuales Windows que requieren admin. Ningún despliegue fue autorizado ni ejecutado. |

**F09 no se inició**, no se modificó código F09 y no se hizo despliegue.

## Evidencia local conservada

Directorio: `/tmp/opencode/f08-p2/evidence/`. Incluye headers sin URL prefirmada, hash, lista del tar, TOC y versión `pg_restore`, logs de los dos restores, fingerprints, schema/policies/grants/RLS, verificaciones 015/016/replay, `npm-test.log`, `typecheck.log`, log de build y resultado del ensayo. El backup original y dump extraído permanecen bajo `/tmp/opencode/f08-p2/backup/` y `/tmp/opencode/f08-p2/restore/`, con permisos restrictivos. No borrar estos datos, el volumen ni el contenedor hasta acordar su retirada.
