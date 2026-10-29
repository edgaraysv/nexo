# F08 — despliegue acotado ejecutado y retirada

Cuenta `423597267645`, región `us-east-1`; EC2 `i-006cda6fdc86af7a5` (`10.240.0.78`), VPC `vpc-0732a8d223e36c053`, subnet `subnet-0199aea26c3ec5560`, Security Group `sg-0cc6a1e19439c3e89`. AWS se operó únicamente mediante MCP. Este documento registra la campaña ejecutada; no autoriza ampliar el corte ni sustituye la evidencia de `docs/f08/evidence.md`.

## Fixture ejecutado

- Tenant sintético `79000000-0000-4000-8000-000000000002`; sede `f0810000-0000-4000-8000-000000000001` (`10.240.0.0/24`, `archived`).
- Entorno VPN `f0810000-0000-4000-8000-000000000002`, nodo `72f0e85c-d6f4-4136-8e26-185a610ac3ec`, UDP/21503, namespace `nexo-f08100000000`, pool `10.247.34.0/24`.
- Perfil directo `f0810000-0000-4000-8000-000000000003`, recurso `10.240.0.250` (`f0810000-0000-4000-8000-000000000004`) y política `f0810000-0000-4000-8000-000000000005`: único allow `any_endpoint → 10.240.0.250 TCP/18443`; 18444 sin allow.
- Listener sintético en namespace `nexo-f08-resource`: `10.240.0.250:18443` devolvía `NEXO-F08-SYNTHETIC-ALLOW`; `:18444` habría devuelto `NEXO-F08-SYNTHETIC-DENY` si hubiera superado el filtro. Ambos estaban activos durante el ensayo.
- Endpoint Windows `DESKTOP-ONMV2M8`, dispositivo `dcb009da-b170-4fdf-93fc-6a73b3006533`; IP de egreso observada `190.120.26.242` (el SG temporal cubrió también `.244` y `138.97.142.254`).
- Trayecto directo, retorno `routed`, DNS `local`. Sin gateway, SNAT, split-DNS, rutas VPC ni cambios a ENI/Source-Destination Check.

## Cambios aplicados

1. **API/BD.** Se desplegó la API con las rutas F08 y se aplicó la migración aditiva `013_f08_private_networks.sql`; RLS y grants se mantuvieron. La API siguió ligada solo a `127.0.0.1:3000`. No se restauró dump ni se hizo rollback.
2. **Nodo.** Se actualizó el agente Linux, se inscribió/aprobó el nodo sintético y se activó `nexo-node-agent.service` para el ensayo. Se registró forwarding previo `0`, se activó temporalmente a `1`, y se creó el entorno/namespace/servicio OpenVPN. La ruta host `/32` y el veth del recurso se crearon solo para el fixture.
3. **Windows.** Se instaló/ejecutó `NexoEndpoint` como `LocalSystem` y se inscribió el dispositivo en el tenant B. El endpoint usó un túnel SSH temporal `127.0.0.1:13000 → AWS 127.0.0.1:3000`; la API nunca escuchó en la interfaz pública. Se emitió la credencial VPN y se conectó el entorno.
4. **Red temporal.** Se abrieron en el SG únicamente TCP/22 (túnel API) y UDP/21503 (OpenVPN) desde los tres `/32` observados, con descripciones `TEMP F08 ... 2026-10-28`. **No se abrieron 18443/18444**; el acceso al recurso fue por el túnel VPN. La regla histórica TCP/10000 Webmin no se tocó.
5. **Artefactos.** Se usaron `f08/deploy/20261028/nexo-agent-linux-amd64.gz` y `f08/deploy/20261028/nexo-f08-api-only.tgz` en el bucket de control. No se modificaron route tables VPC, ENI ni Source/Destination Check.

## Verificación

- **18443:** PASS. Probe Windows conectado; `NEXO-F08-SYNTHETIC-ALLOW`; 25 bytes; SYN/SYN-ACK/ACK y cierre en `tun0`.
- **18444:** PASS. Tres SYN sin respuesta; timeout en Windows; `tun0` los muestra y el contador del namespace `inet nexo_env`/`forward` pasa de `16/832` a `19/988` (`+3/+156`). El listener 18444 estaba en `LISTEN`; el paquete se descarta antes de llegar al recurso. La tabla host permanece en `0/0`; el punto real es el namespace VPN.
- **Windows/firewall:** descartado como causa. El mismo proceso conecta a 18443, no hay reglas NEXO/F08 y la captura exterior muestra que los SYN salieron y llegaron a AWS.
- **Cleanup:** PASS con residuales. Entorno/perfil/recurso/política/sitio retirados; dispositivo, nodo y credenciales revocados; sin namespace/rutas/nft/listeners del ensayo; forwarding `0`; SG solo Webmin; SSH cerrado; S3 sin objetos F08; endpoint sin OpenVPN ni credencial válida.
- **F07:** reconexión, multitenant de aceptación y rechazo CRL real `NOT RUN`. La revocación usada para cleanup no es la prueba de rechazo CRL.
- **Restore:** `NOT RUN`; no se restauró AWS Backup ni dump. La migración 013 permanece aplicada.

## Retirada ejecutada

- Entorno `f081…0002`: `retired/retired`, revisión 2. Perfil `f081…0003`: `retired/pending`, revisión 4. Recurso `f081…0004` y política `f081…0005`: `retired`, revisión 2. Sede `f081…0001`: `archived`. Entorno anterior `f080…0002`: `retired/retired`, revisión 2.
- Dispositivo `dcb…` revocado; credencial de dispositivo `60743bed…` revocada; credencial VPN `21e51311…` revocada (serial `43b193…`); operación de nodo `1c473913…` `succeeded`.
- Nodo `72f0…` revocado; credencial de nodo `706f1f45…` revocada; `nexo-node-agent.service` inactive/disabled; identidad local eliminada; PKI/config de los entornos F08 eliminados.
- Sin unidades `nexo-vpn-*`, namespaces, tablas nft, rutas `10.240.0.250/32`/`10.247.34.0/24` ni listeners 18443/18444/21503. API `nexo.service` y worker `nexo-worker.service` activos en loopback (`/` 200, ruta autenticada 401).
- SG: revocadas las seis reglas temporales TCP/22 y UDP/21503; solo queda TCP/10000 Webmin.
- SSH: túnel detenido; `f08-ssh-key` y `f08-known-hosts` eliminados; `authorized_keys` de `ec2-user` vaciado.
- S3: todas las versiones de los dos artefactos F08 eliminadas; `f08/` vacío y `HeadObject` 404.
- Windows: `disconnect_vpn` deja `disconnected`; sin proceso OpenVPN; credencial local `revoked`; `client.crt`, `ca.crt`, `tls-crypt.envelope` y `credential.json.original` eliminados; `run_diagnostic` devuelve `control_unavailable`. El `status` local conserva `enrollment=approved` y certificado `active` como caché; el dispositivo está revocado en el servidor.

## Residuales y bloqueos

Los detalles y rutas exactas están en `docs/f08/evidence.md`.

- `client.key` y `client.csr` en el estado del endpoint siguen presentes por ACL (owner `BUILTIN\Administrators`; usuario sin elevación). La credencial está revocada; requieren borrado por admin.
- El servicio `NexoEndpoint` sigue instalado/ejecutándose como `LocalSystem`; el dispositivo está revocado y no autentica, pero no se pudo detener/desinstalar sin admin. `device-key`/`state.json` permanecen.
- Rutas DCO obsoletas `10.240.0.250/32 via 10.247.34.1` y `10.247.34.0/24` sobre adaptador `Disconnected`; `Remove-NetRoute` devuelve `Access is denied`; requieren admin.
- El binario Windows instalado `AADE7DD196A5A3C8AA02369E844445D1F926D999E77BC08133016E4B563E7CFB` conserva el bug `sameCredentialSerial`; el build local `48eaa85d0f36299af391aa591363cd9e441e9d96976c6ea01e6a571167cd694e` no se desplegó. El serial usado `43b1…` no tenía cero inicial y no activó el bug.
- La reemisión tras revocación fue corregida y probada localmente (`016_f07_vpn_credential_rotation.sql`, `rotation: PASS` en PostgreSQL 17.6 local), pero la base desplegada conserva el unique total: **NOT APPLIED** hasta backup/ventana/autorización.
- La observación de solo lectura y el reporte están implementados y probados localmente con `routeCheck` inyectado; la observación Windows live **NOT RUN** y no hay filas nuevas (`private_network_device_observations` vacío; `observed_state=pending`).
- Restore no destructivo `NOT RUN`; F07 `NOT RUN`. No se declara aceptación general F08/F07.

## P1 local posterior

El código local corrige la reemisión, implementa el reporte de observación (solo `active` con ruta IPv4 verificada) y reintenta cleanup sin bypass de ACL. Las pruebas locales (`npm test`, `f07-postgres`, `f08-postgres`, `runtime-grants`, `go test`, `go vet`, build Windows) están en [`p1-local.md`](p1-local.md). Siguen bloqueados el despliegue, la migración 016 en la base real, la observación live y la limpieza Windows con admin; ver planes P0/P2/P3 en ese documento.

## Estado

**Ejecutado y retirado.** El dataplane sintético F08 es PASS para 18443 y 18444; la API y la migración 013 permanecen desplegadas, sin rollback. La limpieza de AWS/nodo está completa; los residuales de Windows requieren elevación. El P1 local deja reemisión/observación/cleanup probados en el checkout, pero **no desplegados**; la aceptación general F08/F07 no se declara. Sin commit ni push.
