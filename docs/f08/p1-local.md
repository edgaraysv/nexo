# F08 — P1 local: rotación, observación y cleanup

Fecha de verificación local: **2026-10-28 UTC**. Alcance: checkout local, contenedores PostgreSQL/Go y build Windows. **No** se ejecutó nada contra AWS, Windows desplegado, la base desplegada ni el servicio `NexoEndpoint`; no hubo commit, push ni instalación del binario.

Este documento distingue explícitamente **código local probado**, **despliegue** y **observación live**. No declara aceptación general de F08 ni reabre el ensayo sintético 18443/18444.

## Cambios P1

### Reemisión y historial de credenciales

- `db/migrations/016_f07_vpn_credential_rotation.sql` reemplaza la unicidad total `(tenant_id, device_id, environment_id)` por:
  - un índice único parcial limitado a `pending`, `issued` y `revocation_pending`;
  - un índice de historial por `(tenant_id, device_id, environment_id, created_at DESC, id DESC)`.
- `product/api/postgres-vpn-credential-repository.ts`:
  - reconsulta la credencial activa después del lock por nodo;
  - permite una fila nueva cuando la anterior está `revoked` o `failed`;
  - mantiene `credential_conflict` para un CSR distinto mientras exista una credencial activa;
  - `get` devuelve la activa o, si no existe, la terminal más reciente;
  - `revoke` localiza por serial y no por una fila activa implícita.
- `product/api/vpn-credential-repository.ts` replica el historial y la semántica en memoria.
- La migración se añadió a `scripts/f07-postgres.mjs`, `scripts/f08-postgres.mjs` y `scripts/runtime-grants.mjs`.
- Pruebas: `scripts/f07-postgres.mjs` (`rotation: PASS`), `tests/f07-credential-rotation.test.mjs`.

### Observación F08 de solo lectura

- `product/agent/internal/networkruntime/reconcile.go` expone `HostError` y conserva el código de host en el resultado (`route_missing`, `route_observation_failed`, `profile_unsupported`, `dns_observation_unsupported`, `no_observable_resources`, `resource_observation_unsupported`).
- `product/agent/cmd/nexo-agent/private_network.go`:
  - obtiene el catálogo deseado autenticado;
  - usa un host observador que **no aplica** rutas, DNS ni firewall;
  - solo reporta `active` si todas las rutas IPv4 de los recursos existen localmente;
  - reporta `error` si no puede verificar, nunca un falso `active`;
  - envía el reporte cerrado al endpoint `/v1/device/private-network/:id/report`.
- `product/agent/cmd/nexo-agent/private_network_route.go` y variantes `_windows.go`/`_other.go`:
  - en Windows leen `route print -4` con `System32\route.exe` y timeout;
  - en otros sistemas devuelven error de observación;
  - el parser valida máscaras contiguas y descarta la ruta por defecto.
- `product/agent/cmd/nexo-agent/service.go` ejecuta `syncPrivateNetworks` después de `syncVPNCatalog`; un fallo de observación no hace fail-close al VPN.
- Límites actuales del observador: solo perfiles `direct` + `routed` + DNS `local`, solo recursos IPv4 y solo presencia de ruta local. No prueba conectividad, interfaz VPN, políticas/firewall, gateway, SNAT, split-DNS ni hostname.
- El catálogo deseado solo entrega perfiles `active`; al retirar/suspender un perfil el endpoint no emite por sí mismo un reporte `retired`/`suspended`. Esa reconciliación de retirada queda fuera de este P1 y explica que el perfil histórico F08 siga `pending`.
- Pruebas: `private_network_test.go` (parser, reporte `active`, ruta ausente, error de comando, perfiles no verificables) y el contrato F08 existente.

### Cleanup local

- `product/agent/cmd/nexo-agent/vpn_credentials.go` reintenta la limpieza de un entorno ausente que ya está en estado `revoked`, sin fail-closear entornos sanos si el ACL de Windows impide borrar.
- La limpieza no usa bypass de ACL y conserva `device-key`/`state.json`; esos materiales requieren decisión de admin.
- Pruebas: `TestVPNCredentialRevocationCleansAndReissuesWithNewCSR` y `TestVPNRevokedAbsentEnvironmentRetriesCleanup`.

### Serial y binario local

- Los tests existentes de serial con cero inicial pasan (`TestSameCredentialSerialHandlesLeadingZero`, `TestManagedVPNConnectSucceedsWithLeadingZeroSerial`, `TestSameCredentialSerialNormalizesLeadingZeroes`).
- Build Windows/amd64 local:
  - ruta: `product/agent/bin/nexo-agent.exe`;
  - SHA-256: `48eaa85d0f36299af391aa591363cd9e441e9d96976c6ea01e6a571167cd694e`;
  - **no instalado**; el binario desplegado sigue siendo `AADE7DD196A5A3C8AA02369E844445D1F926D999E77BC08133016E4B563E7CFB`.

## Verificación ejecutada

| Comando / prueba | Resultado | Alcance |
| --- | --- | --- |
| `npm run typecheck` | **PASS** | TypeScript local |
| `npm test` | **PASS**, 108/108 | Suite local |
| `node scripts/f07-postgres.mjs` | **PASS**, `rotation: PASS` | PostgreSQL 17.6 en contenedor |
| `node scripts/f08-postgres.mjs` | **PASS**, `diagnosticConnectivity: NOT_TESTED` | PostgreSQL 17.6 en contenedor |
| `node scripts/runtime-grants.mjs` | **PASS**, 16 migraciones | PostgreSQL 17.6 en contenedor |
| `node scripts/f08.mjs` | **PASS local**, `awsEndToEnd: NOT_RUN` | Control plane local |
| `go test ./...` | **PASS** | Agente, contenedor `golang:1.27.3-bookworm` |
| `go test -race ./cmd/nexo-agent` | **PASS** | Agente |
| `go vet ./...` | **PASS** | Agente |
| Build Windows `GOOS=windows GOARCH=amd64` | **PASS**, hash `48eaa…` | Solo artefacto local |
| Observación en Windows real | **NOT RUN** | Sin ejecución en el host Windows |
| Reemisión en base desplegada | **NOT APPLIED** | La migración 016 no se aplicó a producción |
| Limpieza Windows por ACL | **BLOCKED** | Requiere admin; no se intentó bypass |
| Restore / AWS Backup | **NOT RUN** | Fuera de este P1 |
| Gates F07 (reconexión, multitenant de aceptación, CRL real) | **NOT RUN** | Solo se planifican |

## Estado frente al despliegue

| Elemento | Código local | Desplegado |
| --- | --- | --- |
| Reemisión tras revocación | Corregido y probado en Postgres local | **NO**: la base conserva el unique total hasta aplicar 016 |
| Observación de perfil | Host de solo lectura y reporte implementados | **NO**: no hay observación live ni filas nuevas verificadas en Windows |
| Cleanup de material revocado | Reintento best-effort probado | **BLOQUEADO** por ACL en Windows; no se ejecutó admin |
| Serial con cero inicial | Cubierto por pruebas | **NO**: binario instalado antiguo |
| Binario Windows | Build local `48eaa…` | **NO** instalado |

## Plan P0 — acciones bloqueadas por admin o efecto externo

### P0-A. Limpieza del endpoint Windows

Prerrequisitos: autorización escrita del propietario, ventana de mantenimiento, sesión elevada y confirmación de que la identidad del dispositivo no se reutilizará. No ejecutar desde este checkout.

1. Registrar estado de solo lectura: `Get-Service NexoEndpoint`, `Get-NetRoute -AddressFamily IPv4`, `Get-ChildItem` del estado del endpoint y hashes de los archivos presentes.
2. Detener y deshabilitar el servicio con autorización (`Stop-Service NexoEndpoint`; `sc.exe config NexoEndpoint start= disabled`). No desinstalar todavía.
3. Verificar que no haya proceso OpenVPN ni conexión activa.
4. Eliminar, con elevación y rutas exactas, las rutas DCO obsoletas `10.240.0.250/32` y `10.247.34.0/24` (`Remove-NetRoute -DestinationPrefix ... -Confirm:$false`).
5. Eliminar `client.key` y `client.csr` del entorno revocado. Si el ACL lo impide, no usar bypass silencioso: registrar el error, obtener autorización específica para `takeown`/`icacls` o dejar el residual documentado.
6. `device-key` y `state.json`: conservar si el dispositivo se reutiliza; eliminar solo tras confirmación de baja definitiva y con el servicio detenido.
7. Verificar: servicio detenido/deshabilitado, sin proceso OpenVPN, sin rutas DCO, sin credencial activa, archivos objetivo ausentes y evidencia guardada.

Criterio de salida: residuales Windows cerrados o aceptados por escrito; no se declara PASS de seguridad hasta verificar la ausencia de la clave y la revocación en el servidor.

### P0-B. Despliegue autorizado de los fixes y migración 016

Prerrequisitos: P2 con backup validado, ventana aprobada y hash del artefacto confirmado. No ejecutar ahora.

1. Verificar el artefacto `product/agent/bin/nexo-agent.exe` con SHA-256 `48eaa…` antes de copiarlo.
2. Respaldar la base y registrar el punto de restauración; aplicar `016_f07_vpn_credential_rotation.sql` en una transacción sobre una copia/entorno autorizado.
3. Desplegar la API con los cambios de repositorio y el agente con el binario nuevo; reiniciar solo los servicios autorizados.
4. Verificar el índice parcial, la ausencia del constraint total y una reemisión controlada con un CSR nuevo.
5. Rollback: detener el despliegue, restaurar el backup validado y no borrar filas de credenciales manualmente.

### P0-C. Observación live controlada

Prerrequisitos: P0-B completado y un perfil autorizado con un recurso IPv4 y una ruta local verificable. No reutilizar el fixture sintético retirado.

1. Ejecutar un ciclo del agente y capturar el catálogo deseado.
2. Con ruta presente, verificar reporte `active` y digest en `private_network_device_observations`.
3. Repetir con una ruta ausente y verificar `error`/`route_missing`, sin promover a `active`.
4. Verificar que un fallo de observación no cambie el estado de conexión VPN.

## Plan P2 — restore y reconciliación

### P2-A. Validación de restore no destructivo

1. Elegir una copia AWS Backup o un `pg_dump -Fc` autorizado; no restaurar sobre producción.
2. Restaurar en un contenedor/instancia aislada con credenciales temporales y cifrado en tránsito.
3. Verificar checksum, versión, tablas, RLS, grants y una consulta de solo lectura representativa.
4. Destruir el entorno de prueba solo después de guardar la evidencia; no tocar el entorno real.

Comandos previstos (no ejecutados; el destino debe ser un contenedor aislado):

```bash
pg_dump "$SOURCE_DATABASE_URL" -Fc -f /tmp/nexo-restore.dump
pg_restore --list /tmp/nexo-restore.dump
pg_restore --no-owner --no-privileges -d "$RESTORE_DATABASE_URL" /tmp/nexo-restore.dump
```

Criterio de salida: restore reproducible y verificado; `NOT RUN` hasta que exista autorización y ventana.

### P2-B. Reconciliación de la migración 016

1. Sobre una copia, comprobar el constraint antiguo:
   `SELECT conname FROM pg_constraint WHERE conrelid='vpn_client_credentials'::regclass AND contype='u';`
2. Aplicar 016 y verificar:
   - inexistencia del unique total;
   - existencia de `vpn_client_credentials_active_key` con predicado de estados activos;
   - índice de historial;
   - reemisión de un CSR nuevo tras `revoked` y rechazo de un CSR distinto con credencial activa.
3. Solo tras aprobación, aplicar a producción con backup y ventana; registrar el resultado y el rollback.

Comprobaciones SQL previstas:

```sql
SELECT conname
FROM pg_constraint
WHERE conrelid='vpn_client_credentials'::regclass AND contype='u';

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename='vpn_client_credentials'
ORDER BY indexname;
```

Criterio de salida: migración verificada en copia y producción autorizada; hasta entonces el despliegue sigue **NOT APPLIED**.

## Plan P3 — gates de aceptación pendientes

1. **F07 reconexión:** cortar/restaurar la red controladamente y verificar reconexión, ausencia de procesos huérfanos y estado observable. Evidencia: logs de OpenVPN/agente, estado `connection_state` antes/después y una operación autenticada posterior. `NOT RUN`.
2. **F07 multitenant de aceptación:** dos tenants y el mismo rango privado; verificar aislamiento de catálogo, credenciales y tráfico. Evidencia: IDs y hashes por tenant, catálogo de cada dispositivo y una prueba de tráfico cruzado rechazada. `NOT RUN`.
3. **F07 rechazo CRL real:** revocar un certificado y comprobar que el handshake OpenVPN lo rechaza; la limpieza de material no es esa prueba. Evidencia: intento de conexión rechazado, log del servidor y serial revocado. `NOT RUN`.
4. **F08 observación live:** P0-C; probar ruta presente/ausente y estados del reporte. Evidencia: filas de `private_network_device_observations`, `observed_state`, revisión y digest; no usar el fixture 18444 retirado. `NOT RUN`.
5. **F08 general:** gateway, SNAT, split-DNS y hostname siguen fuera del runtime observado; no se declaran aceptados. Una campaña nueva requiere autorización y no reabre el ensayo 18443/18444.

Criterio de salida: cada gate con evidencia propia, incluyendo resultados negativos; no se extrapola el PASS sintético F08 a estos gates.
