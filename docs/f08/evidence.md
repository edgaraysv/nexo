# Evidencia F08 — acceso directo Windows↔AWS y bloqueo de 18444

Fecha de la campaña: **2026-10-28 UTC**. Cuenta `423597267645`, región `us-east-1`, EC2 `i-006cda6fdc86af7a5` (`10.240.0.78`), Security Group `sg-0cc6a1e19439c3e89`. AWS se consultó y modificó únicamente mediante MCP. Sin commit ni push.

## Resultado

El corte sintético F08 se ejecutó y se retiró. El endpoint Windows conectó por OpenVPN al entorno `f0810000-0000-4000-8000-000000000002` y alcanzó `10.240.0.250:18443` con la respuesta identificable; el intento a `10.240.0.250:18444` fue descartado realmente en el namespace VPN aunque el listener denegado estaba activo. **El gate de dataplane sintético es PASS; no es una aceptación general de F08 ni amplía F07.**

| Gate | Resultado | Evidencia |
| --- | --- | --- |
| Windows → AWS TCP/18443 | **PASS** | Probe conectado, `NEXO-F08-SYNTHETIC-ALLOW`, 25 bytes; `tun0`/veth/contadores |
| Windows → AWS TCP/18444 | **PASS** | Tres SYN, sin SYN-ACK; timeout; contador `+3/+156`; drop en `forward` del namespace VPN |
| Listener 18444 activo durante el intento | **PASS** | `10.240.0.250:18444` en `LISTEN` dentro de `nexo-f08-resource`; no recibió tráfico |
| Causa del bloqueo | **PASS** | `inet nexo_env`, cadena `forward`, `policy drop`; tabla host en `0/0` |
| Firewall Windows como causa | **Descartado** | Mismo proceso conecta a 18443; sin reglas NEXO/F08; los SYN salieron y llegaron a AWS |
| Entrega node-scoped / conexión del endpoint | **PASS** | Entorno y perfil entregados; OpenVPN conectado; ruta `/32` y retorno |
| Observación del perfil en el plano de control | **NOT RECORDED** | `private_network_device_observations` sin filas; perfil retirado con `observed_state=pending`; runtime local aplicado |
| Retirada de fixtures y cleanup | **PASS con residuales** | Entorno/perfil/recurso/política/sitio retirados; dispositivo/nodo/credenciales revocados; nodo, SG y S3 limpios; residuales Windows abajo |
| Restore no destructivo | **NOT RUN** | No se restauró dump ni AWS Backup; no se hizo rollback destructivo |
| Fix del binario Windows desplegado | **NOT DEPLOYED** | Binario instalado con el bug de serial; fix local sin commit ni despliegue |
| F07 reconexión, multitenant de aceptación y rechazo CRL real | **NOT RUN** | Fuera de este corte; la revocación de cleanup no es la prueba de rechazo CRL |
| Commit/push | **Ninguno** | El checkout completo sigue sin rastrear |

## P1 local posterior (2026-10-28)

Después de la campaña se corrigió y probó localmente el código de reemisión, observación y reintento de cleanup. **Esto no cambia el resultado histórico ni el estado desplegado**: la migración `016_f07_vpn_credential_rotation.sql` no se aplicó a la base desplegada, el binario instalado sigue siendo `AADE7DD196A5A3C8AA02369E844445D1F926D999E77BC08133016E4B563E7CFB` y no se ejecutó una observación en Windows real.

| Verificación P1 | Resultado | Alcance |
| --- | --- | --- |
| Reemisión tras revocación | **PASS local** (`rotation: PASS`) | PostgreSQL 17.6 en contenedor; no desplegado |
| Observación con host de solo lectura | **PASS local** | Pruebas con `routeCheck` inyectado; Windows live `NOT RUN` |
| Cleanup de entorno revocado ausente | **PASS local** | Reintento best-effort; ACL Windows sigue `BLOCKED` |
| Serial con cero inicial | **PASS local** | Pruebas Go existentes; binario instalado antiguo |
| Build Windows/amd64 | **PASS local**, SHA-256 `48eaa85d0f36299af391aa591363cd9e441e9d96976c6ea01e6a571167cd694e` | No instalado |
| `npm test` / `npm run typecheck` | **PASS**, 108/108 | Suite local |
| `go test ./...` / `go test -race ./cmd/nexo-agent` / `go vet ./...` | **PASS** | Contenedor Go local |
| `node scripts/f08-postgres.mjs` | **PASS**, `diagnosticConnectivity: NOT_TESTED` | PostgreSQL en contenedor |
| `node scripts/runtime-grants.mjs` | **PASS**, 16 migraciones | PostgreSQL en contenedor |
| Restore / AWS Backup | **NOT RUN** | Fuera de P1 |

Detalle de cambios, límites y planes P0/P2/P3: [`p1-local.md`](p1-local.md).

## Trayecto observado

- Windows: ruta `10.240.0.250/32 via 10.247.34.1` sobre el adaptador DCO de OpenVPN; IP de egreso observada en la captura exterior `190.120.26.242` (el SG temporal cubrió además `190.120.26.244` y `138.97.142.254`).
- OpenVPN: UDP/21503 hacia `3.226.252.132`; `tls-crypt`, CA y certificado de cliente del entorno; sin `redirect-gateway`, sin gateway, SNAT, split-DNS ni rutas VPC.
- Nodo: namespace VPN `nexo-f08100000000`; `tun0` `10.247.34.1/24`, cliente `10.247.34.2`; veth `nxn9ea15ef4b5` `100.127.122.134/30`.
- Recurso: namespace `nexo-f08-resource`; veth `nxf08r` `100.127.250.2/30`; listener en `10.240.0.250:18443` y `:18444`; ruta host `10.240.0.250/32 via 100.127.250.2 dev nxf08h`.
- API: el endpoint usó un túnel SSH temporal `127.0.0.1:13000 → AWS 127.0.0.1:3000`; la API permaneció ligada solo a loopback. El SG temporal abrió TCP/22 y UDP/21503, **nunca** 18443/18444.

## 18443 — permitido

Probe final (`2026-10-28`, UTC):

- `start=14:02:08.6734755Z`
- `18443=14:02:08.8570465Z result=connected response=NEXO-F08-SYNTHETIC-ALLOW`
- `end=14:02:16.8943075Z`

`tun0` muestra SYN, SYN-ACK, ACK, 25 bytes de respuesta y cierre:

```text
14:02:08.843209 10.247.34.2.59501 > 10.240.0.250.18443: Flags [S]
14:02:08.843269 10.240.0.250.18443 > 10.247.34.2.59501: Flags [S.]
14:02:08.899474 10.240.0.250.18443 > 10.247.34.2.59501: Flags [P.], length 25
```

El intento anterior de las 13:59 también obtuvo respuesta en la captura exterior; el puerto permitido no incrementó el contador de drop.

## 18444 — bloqueado de verdad

El listener denegado estaba en `LISTEN` (`10.240.0.250:18444`, python3 PID 355962). El cliente Windows quedó en `SynSent` y agotó el timeout; no recibió SYN-ACK.

Probe final:

- `18444=14:02:16.8932743Z result=timeout`
- `tun0`: tres SYN desde `10.247.34.2:59503` a `10.240.0.250:18444` a las `14:02:10.994`, `14:02:12.008` y `14:02:14.021`; sin respuesta.
- Contador del namespace VPN, tabla `inet nexo_env`, cadena `forward`:
  - antes: `counter packets 16 bytes 832 drop`
  - después: `counter packets 19 bytes 988 drop`
  - delta: **+3 paquetes / +156 bytes**
- La cadena tiene `policy drop`; solo existe el `accept` exacto de 18443 y su retorno `established,related` para 18443. Durante el intento, la tabla host `nx_f08100000000` permanecía en `0/0` para 18444: el paquete se descartaba antes, en el namespace VPN.

La captura exterior del intento anterior (`13:59:38–13:59:54 UTC`) demuestra que los SYN salieron de Windows y llegaron a AWS como tres paquetes UDP de 76 bytes, sin respuesta:

```text
13:59:40.612  ens5 In  190.120.26.242.54378 > 10.240.0.78.21503: UDP, length 76
13:59:40.612  nxh9ea15ef4b5 Out 190.120.26.242.54378 > 100.127.122.134.21503: UDP, length 76
13:59:41.625  ens5 In  190.120.26.242.54378 > 10.240.0.78.21503: UDP, length 76
13:59:43.637  ens5 In  190.120.26.242.54378 > 10.240.0.78.21503: UDP, length 76
```

No hubo respuesta del servidor para esos tres paquetes. La captura del veth a la salida del namespace VPN (`13:57`) solo contiene 18443; 18444 nunca llega al recurso. El firewall de Windows no fue la causa: el mismo proceso conecta a 18443, no hay reglas NEXO/F08/18443/18444 y la captura exterior prueba que el tráfico salió.

## Evidencia de cleanup

### Plano de control

| Fixture | Estado final |
| --- | --- |
| Sede `f0810000-0000-4000-8000-000000000001` | `archived` |
| Entorno `f0810000-0000-4000-8000-000000000002` | `desired=retired`, `observed=retired`, revisión 2 |
| Perfil `f0810000-0000-4000-8000-000000000003` | `desired=retired`, `observed=pending`, revisión 4 |
| Recurso `f0810000-0000-4000-8000-000000000004` | `retired`, revisión 2 |
| Política `f0810000-0000-4000-8000-000000000005` | `retired`, revisión 2 |
| Dispositivo `dcb009da-b170-4fdf-93fc-6a73b3006533` | `revoked` desde `2026-10-28 14:28:57.298474+00` |
| Nodo `72f0e85c-d6f4-4136-8e26-185a610ac3ec` | `revoked` desde `2026-10-28 14:31:06.078871+00` |
| Credencial VPN `21e51311-6ad3-4c22-b679-6d03b2f5d0e8` | `revoked`, serial `43b193d128c95d5585587f5fe1470cca` |
| Operación de revocación `1c473913-ac39-42f6-ab88-16a0aa4ce05b` | `vpn.client_certificate.revoke.v1` `succeeded` |
| Credencial del dispositivo `60743bed-572a-4d58-ab67-14114259815f` | `revoked`, serial `72144b12586883c740a6710e13174f4b` |
| Credencial del nodo `706f1f45-9fec-4efd-98ec-a8a04ce384fb` | `revoked`, serial `f23508e6ee428f6e25b5d569acbacc45` |
| Entorno anterior `f0800000-0000-4000-8000-000000000002` | `retired/retired`, revisión 2 |

### Nodo

- `nexo.service` (API) y `nexo-worker.service`: **active**; API solo en `127.0.0.1:3000`; `/` responde `200` y una ruta autenticada sin sesión responde `401`.
- `nexo-node-agent.service`: **inactive/disabled**; identidad local `/var/lib/nexo-node/identity` eliminada; sin proceso OpenVPN.
- Sin unidades `nexo-vpn-*`, sin namespace VPN ni namespace de recurso, sin tablas nft propias, sin ruta `10.240.0.250/32`, sin rutas `10.247.34.0/24`/`100.127.0.0/16`, sin listeners 18443/18444/21503.
- `net.ipv4.ip_forward=0` restaurado.
- PKI de los entornos F08 (`ca.key`, `server.key`, `tls-crypt.key`, certificados) y `openvpn.conf` eliminados; directorios de entorno y `f08-forwarding-before` retirados.
- Fixture manual de recurso eliminado: `nexo-f08-resource.service` detenido/deshabilitado, namespace/veth/ruta/listener retirados, `/usr/local/lib/nexo/f08-synthetic-listener.py` eliminado.
- Unidad y binario del agente nodo permanecen instalados, pero sin identidad y deshabilitados.

### Endpoint Windows

- `disconnect_vpn`: `connection_state=disconnected`; sin proceso OpenVPN; adaptador DCO `Disconnected`.
- `revoke_vpn_credential`: `revocation_pending` local y luego `revoked` en el plano de control; el nodo completó la operación de revocación.
- `credential.json` local: `state=revoked`, serial `43b193d128c95d5585587f5fe1470cca`.
- Eliminados por el agente: `client.crt`, `ca.crt`, `tls-crypt.envelope`, `credential.json.original`.
- `run_diagnostic` final: `ok=false`, `error=control_unavailable`; estado VPN local `unavailable`, cero entornos.
- El `status` local aún muestra `enrollment=approved` y certificado `active`; es caché del servicio. La fila del dispositivo en el servidor está `revoked` y `run_diagnostic` devuelve `control_unavailable`; no es una sesión válida.
- Dispositivo revocado en el servidor; el servicio `NexoEndpoint` sigue instalado y ejecutándose como `LocalSystem` (sin elevación no se puede detener/desinstalar).

### SG, SSH y S3

- SG `sg-0cc6a1e19439c3e89`: revocadas las seis reglas temporales (UDP/21503 y TCP/22 para `138.97.142.254/32`, `190.120.26.242/32`, `190.120.26.244/32`); permanece solo la regla histórica **TCP/10000 Webmin**.
- Túnel SSH PID 28976 detenido; `C:\ProgramData\NEXO\f08-ssh-key` y `f08-known-hosts` eliminados; `authorized_keys` de `ec2-user` vaciado; sin reglas TCP/22.
- S3 `nexo-lab-423597267645-us-east-1-control`: eliminadas todas las versiones de `f08/deploy/20261028/nexo-agent-linux-amd64.gz` y `f08/deploy/20261028/nexo-f08-api-only.tgz`; `ListObjectVersions` para `f08/` vacío y `HeadObject` 404.
- API y migración 013 permanecen desplegadas; no se ejecutó rollback destructivo. No se restauró dump ni AWS Backup.

### Evidencia local

Copia en `/tmp/opencode/f08-evidence/` (temporal, sin claves ni tokens):

- Captura `tun0` (extracto en `tun0-pcap.txt`) — SHA-256 del pcap `be38fcce2c5425cf3d0cec82d4e83ca14ed78eecd99aef7270a34ec311f0c386` (725 bytes, 11 paquetes).
- Captura del veth (extracto en `host-veth-pcap.txt`) — SHA-256 del pcap `16c85aa97fc830ad8ba0800b27373918d78f1c616654d9eca611b6860ba3af16` (633 bytes, 8 paquetes).
- Captura exterior (extracto en `outer-udp-pcap.txt`) — SHA-256 del pcap `8652be1ecb400204c2ff83eed3b4dada1d1a2f34fba641e899915a736b3eaa83` (5930 bytes, 48 paquetes).
- `counters.txt`, `probes.txt`, `namespaces.txt`, `routes-config.txt`, `windows-status-before-cleanup.json`, `windows-status-after-retire.json`, `windows-service-status.json`, `windows-vpn-catalog.json`, `windows-vpn-connections.json`.
- `final-node.txt`, `sg-after.txt`, `s3-after.txt`, `windows-final-residuals.txt` — verificación final de nodo/SG/S3 y residuales Windows.

Nota local: `/tmp/opencode/f08-build/nexo-agent.exe` (owner root) no se pudo borrar sin sudo; es un binario de build, no contiene credenciales. El resto de temporales locales y de `%TEMP%` se eliminó; se conserva `f08-evidence`.

## Residuales y bloqueos

| Residual | Estado | Acción requerida |
| --- | --- | --- |
| `C:\ProgramData\NEXO\Endpoint\vpn\f0810000-0000-4000-8000-000000000002\client.key` y `client.csr` | Presentes; ACL owner `BUILTIN\Administrators`; usuario sin permiso de borrado; credencial **revocada** | Admin: detener/limpiar el endpoint y borrar ambos archivos; no hay uso válido de la clave |
| `C:\ProgramData\NEXO\Endpoint\device-key`, `state.json` y servicio `NexoEndpoint` | Servicio `Running/Automatic` como `LocalSystem`; dispositivo revocado; sin OpenVPN | Admin: detener/desinstalar el servicio y eliminar la identidad local si no se reutiliza |
| Rutas DCO `10.240.0.250/32 via 10.247.34.1` y `10.247.34.0/24` | Presentes sobre adaptador `Disconnected`; `Remove-NetRoute` devuelve `Access is denied` | Admin: eliminar las rutas; no hay tráfico mientras el adaptador esté desconectado |
| Binario Windows `C:\Program Files\NEXO\nexo-agent.exe` SHA-256 `AADE7DD196A5A3C8AA02369E844445D1F926D999E77BC08133016E4B563E7CFB` | Instalado; conserva el bug `sameCredentialSerial`; el build local `48eaa…` **no se desplegó** | Desplegar el fix con elevación y revalidar; el serial usado `43b1…` no tenía cero inicial y no activó el bug |
| Reemisión tras revocación | **Código local corregido y `rotation: PASS` en PostgreSQL local**; la base desplegada conserva el unique total, por lo que la reemisión sigue **NOT APPLIED** allí | Aplicar `016_f07_vpn_credential_rotation.sql` solo con backup, ventana y autorización (P0/P2) |
| Observación del perfil | Cero filas nuevas en `private_network_device_observations`; `observed_state=pending`; el host de solo lectura y el reporte están implementados y probados localmente, pero la observación Windows live sigue **NOT RUN** | Ejecutar P0-C con un perfil autorizado; no declarar `active` sin ruta verificada ni sin fila de observación |
| Restore | `NOT RUN`; no se restauró dump ni AWS Backup | Ejecutar una validación no destructiva antes de un rollback real |
| F07 | Reconexión, multitenant de aceptación y rechazo CRL real `NOT RUN` | No se amplía la aceptación F07 con este corte |

## Conclusión

El dataplane sintético F08 quedó demostrado: 18443 permitido con respuesta identificable y 18444 realmente descartado en el namespace VPN, con el listener denegado activo y contadores/capturas concordantes. La retirada dejó el nodo y AWS sin el entorno, las rutas, los listeners, las reglas temporales ni los artefactos S3 del ensayo, y el endpoint sin OpenVPN ni credencial VPN válida.

Quedan residuales de limpieza que requieren elevación en Windows: `client.key`/`client.csr` presentes con credencial revocada, las rutas DCO obsoletas y el servicio endpoint instalado. El P1 local corrigió y probó la reemisión, el reporte de observación y el reintento de cleanup, pero **no están desplegados**: la base conserva el unique antiguo, el binario instalado sigue siendo `AADE…` y no se ejecutó una observación Windows real. El restore no se validó y F07 sigue `NOT RUN`. No hubo commit ni push.
