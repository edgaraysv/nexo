# Evidencia F07 — catálogo, credenciales y runtime VPN Windows

Fecha UTC: **2026-10-26**. Alcance: cuenta de laboratorio `423597267645`, región `us-east-1`, instancia `i-006cda6fdc86af7a5`. No se usaron clientes ni datos reales.

## Gates locales

- `npm run verify:f07`: **PASS**.
- `npm test`: **PASS, 102/102**.
- `npm run test:runtime-grants`: **PASS**, 12 migraciones, 50 tablas, least privilege y RLS.
- TypeScript API, catálogo autenticado, RLS PostgreSQL, aislamiento tenant, entitlement, UI React, pruebas Go y builds Linux/Windows del agente: **PASS**.
- `go vet ./...` y `go test -race ./cmd/nexo-agent`: **PASS**.
- `git diff --check`: **PASS**.

## Artefactos

- Backup predespliegue: `s3://nexo-lab-423597267645-us-east-1-control/f07/backups/20261026/nexo-f07-predeploy.tar.gz`.
- SHA-256 del backup: `6eb9eb861703ed6d7f53d12620a36195fb69c1a10a24a3c9b216c66e834168dc`.
- Release R1: `s3://nexo-lab-423597267645-us-east-1-control/f07/deploy/nexo-f07-release-20261026-r1.tar.gz`.
- SHA-256 del release: `1f9080adcb695076a54d2e8604ea7e2af94ab78cd23991f7051b9ea5c7f1a70e`.

Las URL prefirmadas fueron efímeras y no se conservan como evidencia.

## Despliegue y recuperación comprobada

El primer intento usó por error `/health`, ruta inexistente que devuelve `404`. El rollback retiró las cuatro políticas de la migración 011, pero un defecto del script de rollback eliminó también `dist/`; la API entró temporalmente en reinicio automático. Se detuvo el avance y se restauró `dist/` desde el backup pre-F07. El gate de recuperación confirmó servicio activo, HTTP `200` en `/`, una única escucha `127.0.0.1:3000` y cero políticas F07.

El segundo intento usó rollback explícito, conservó los archivos previos hasta terminar los gates y finalizó **PASS**:

- `nexo.service`: activo.
- `GET /`: HTTP `200`.
- escucha API: solo `127.0.0.1:3000`.
- `POST /v1/device/vpn/reconcile` sin sesión: HTTP `401`.
- políticas RLS F07 instaladas: `4`.
- `nexo-node-agent.service`: inactivo/deshabilitado.

## Smoke autenticado AWS

Con fixtures ficticios y temporales:

- sesión obligatoria: **PASS**;
- body con `url` extra rechazado con `422`: **PASS**;
- respuesta allowlisted sin nodo, namespace, CIDR, digest, URL, rutas ni PKI: **PASS**;
- entorno de otro tenant no visible: **PASS**;
- solo entorno `active` con revisión aplicada visible: **PASS**;
- módulo suspendido devuelve `disabled` y catálogo vacío: **PASS**;
- dispositivo revocado deja de autenticar y recibe `401`: **PASS**.

## Cleanup final

- tenants y usuario de fixture: `0`;
- entornos VPN: `0`;
- owners proveedor: `0`;
- namespaces de red: `0`;
- forwarding IPv4: `0`;
- agente de nodo: inactivo/deshabilitado;
- API: activa, HTTP `200`, loopback únicamente;
- migración 011: permanece aplicada con sus cuatro políticas.

## No cubierto por R1

- generación de clave VPN y CSR en Windows;
- firma tipada por la CA privada del nodo;
- revocación de credencial VPN;
- conexión/desconexión OpenVPN, recuperación tras reinicio y validación Windows↔AWS.

## R2 — CSR y revocación

Estado AWS: **DESPLEGADO Y VALIDADO EN LABORATORIO**. La migración 012 y el código R2 permanecen aplicados a la EC2 indicada.

- API y repositorios: solicitud CSR tenant-bound, operación tipada, estado, idempotencia y revocación: **PASS local**.
- PostgreSQL/RLS: dispositivo propio, nodo propietario, aislamiento tenant, transición `pending → issued → revocation_pending → revoked`: **PASS local**.
- Nodo Linux: validación criptográfica de CSR P-256, subject administrado, certificado `clientAuth`, emisión idempotente, CA privada no exportada, CRL firmada y revocación idempotente: **PASS local**.
- Servicio endpoint: clave P-256 protegida por DPAPI en Windows (`0600` en el adaptador Linux de laboratorio), CSR persistente, validación de cadena y correspondencia clave-certificado, estado IPC saneado: **PASS local**.
- OpenVPN servidor: `crl-verify` incorporado al renderer y revocación comprobada en AWS: **PASS**. Runtime cliente Windows↔AWS: **BLOCKED** por ausencia de OpenVPN Community en el host de prueba.

### Gate AWS R2

Antes de aplicar la migración 012 se exige: suite F07 completa, regresión general, grants runtime y build cruzado Windows `PASS`; API R1 activa solo en loopback; cero fixtures; backup PostgreSQL/configuración/binarios validado y subido al bucket de control. El smoke R2 debe demostrar solicitud endpoint autenticada, operación ligada al nodo propietario, certificado `clientAuth`, CA privada ausente de API/estado, revocación en CRL y rechazo posterior. Cualquier fallo restaura API/binario/esquema desde el backup y detiene la campaña.

### Ejecución AWS R2 — 2026-10-26

- Backup pre-R2: **PASS**, `s3://nexo-lab-423597267645-us-east-1-control/f07/backups/20261026/nexo-f07-pre-r2.tar.gz`, SHA-256 `960909f796d0185a69473a5bf50a0808190568991a540252dbceec69c5804bc7`, 14,334,217 bytes.
- Release R2: **PASS**, `s3://nexo-lab-423597267645-us-east-1-control/f07/deploy/nexo-f07-release-20261026-r2.tar.gz`, SHA-256 `aea1b9376491f174180694987e4ff125e903c3a1951918e13ba4a06484171734`, 3,297,122 bytes.
- Despliegue migración 012/API/agente: **PASS** (SSM `009b7e8e-7304-4aa8-8ae5-8c0345fac051`): 50 tablas, `/` 200, ruta CSR sin sesión 401 y agente de nodo inactivo/deshabilitado.
- Los primeros dos fixtures de smoke fueron rechazados correctamente: uno usó un namespace no derivado del UUID y otro omitió habilitar temporalmente forwarding. Ambos terminaron en `error` fail-closed y ejecutaron cleanup; no se atribuyen como fallos del producto.
- Smoke corregido CSR→operación nodo→certificado→CRL→revocación: **PASS** (SSM `6ab6ad83-80f5-4796-9579-dd350d847a99`). Confirmó catálogo activo, solicitud autenticada 202, operación tipada ligada al nodo, certificado ECDSA con `clientAuth`, subject derivado de tenant/dispositivo, correspondencia clave-certificado, ausencia de claves privadas en API, revocación en CRL, rechazo OpenSSL con `certificate revoked` y dos operaciones terminales `succeeded`.
- Cleanup posterior: **PASS** (SSM `8d10c332-76e2-4888-b9bf-637f8e955538`): cero filas fixture, entornos, namespaces, unidades y directorios del ensayo; forwarding IPv4 `0`; API activa; agente de nodo inactivo/deshabilitado.
- Estado actual: R2 desplegado y smoke validado en laboratorio. El runtime administrado está implementado localmente; su ejecución nativa Windows↔AWS sigue pendiente.

## Runtime cliente Windows — local

- Render allowlisted de configuración cliente, host derivado, validación de cadena/clientAuth y correspondencia clave-certificado: **PASS unitario**.
- Conectar/desconectar, borrado de clave transitoria, recuperación de intención tras reinicio, rechazo de clave persistente ausente y desconexión fail-closed ante credencial revocada: **PASS con launcher de proceso simulado**.
- Job Object Windows `KILL_ON_JOB_CLOSE`, ejecutable fijo y build `windows/amd64`: **PASS de compilación**.
- UI Tauri con acciones tipadas y estados honestos; build Vite/TypeScript: **PASS**.
- IPC nativo Windows, reconexión después de cerrar la UI y persistencia DPAPI sin PEM en disco: **PASS**.
- Paquete NSIS x64: **PASS**, `product/client/src-tauri/target/release/bundle/nsis/NEXO Endpoint_0.1.0_x64-setup.exe`, 9,428,670 bytes, SHA-256 `b5326674e56a9e25dbbcd8f92943d33a09e92ea509891f9382cbac4a50af88bc`.
- Agente Windows incluido: 11,648,512 bytes, SHA-256 `1d8200b0fdcf673a42232d5902288ee062e6d52789a2d9c7fbd6442610695eb6`.
- OpenVPN Community 2.7.7 (`2.7.701` de winget), ruta administrada y firma Authenticode válida de OpenVPN Inc.: **PASS**.
- Ciclo SCM directo: instalar, reiniciar, IPC posterior al reinicio, desinstalar conservando identidad: **PASS**.
- Ciclo NSIS: instalar UI/servicio, reiniciar SCM, IPC después de cerrar UI y desinstalar conservando identidad: **PASS**. Se corrigió el uso de `ProgramW6432` para que el hook NSIS de 32 bits resuelva OpenVPN y el agente en `Program Files` de 64 bits.

## Campaña nativa Windows↔AWS

- Alcance temporal autorizado: TCP 22 y UDP 21501 exclusivamente desde `190.5.151.74/32`, clave SSH efímera marcada, fixtures `7400…`, forwarding temporal y entorno OpenVPN sintético.
- El primer ensayo fue detenido por dos gates incorrectos del fixture: nombre de unidad duplicado y búsqueda del socket UDP fuera del namespace. Cleanup y baseline: **PASS** (SSM `f84ec34b-2f52-477a-883f-9143e2c84b51`).
- El segundo ensayo alcanzó entorno OpenVPN activo, túnel SSH API e instalación del cliente, pero la inscripción fue rechazada antes de crear el dispositivo porque el fixture omitió `quota_counters(resource='endpoints')`. Cleanup: **PASS** (SSM `448646e5-480b-4c73-875a-ec3b60bc3079`).
- El tercer ensayo añadió cuota explícita y volvió a alcanzar entorno, túnel e instalación, pero el IPC devolvió `enrollment_failed` antes de aprobación. No hubo certificado VPN, conexión OpenVPN ni handshake; la causa exacta entre el servicio `LocalSystem` y el port-forward de sesión queda **BLOCKED/UNRESOLVED**.
- Cleanup final de filas, entorno, namespace, unidad, forwarding, clave temporal y reglas `/32`: **PASS** (SSM `8a9f7701-155b-4e90-9411-b88804378917`). Baseline final: API activa/200, agente nodo inactivo/deshabilitado, cero entornos/namespaces/unidades/fixtures, forwarding `0` y cero reglas temporales: **PASS** (SSM `6776da15-e989-4c41-bd66-3a7213525771`).
- No se afirma handshake Windows↔AWS, adaptador TUN operativo ni recuperación SCM con un túnel activo.

### Reanudación por IP pública — 2026-10-27 UTC

- Se publicó temporalmente la API mediante TLS en `https://3.226.252.132:3000`, conservando el backend en `127.0.0.1:3000`. El SG quedó limitado a las dos salidas `/32` observadas del equipo Windows (`190.120.26.242/32` y `138.97.142.254/32`); nunca se usó `0.0.0.0/0`.
- TLS 1.3, SAN de IP, confianza temporal de CA en Windows y HTTP `200` externo: **PASS**. El terminador `nexo-public-test.service` permanece activo pero deshabilitado únicamente para que el usuario inspeccione el panel; certificado temporal hasta `2026-10-28 22:10:27 UTC`.
- Inscripción directa Windows→IP pública, prueba criptográfica, aprobación y `claim`: **PASS** para el dispositivo temporal `a53ae4fd-65df-4e5f-abc6-b080a3f22467`.
- Se corrigió un error de estado del servicio: una mutación exitosa ahora limpia `last_error` obsoleto. Prueba Go y build `windows/amd64`: **PASS**; el `claim` devolvió certificado activo sin `enrollment_failed` residual.
- Entorno OpenVPN `2d9b4082-6e8d-44d4-82e7-5ec14a16c99e`, listener UDP/21501 dentro del namespace, emisión y persistencia de credencial cliente: **PASS**.
- Handshake Windows↔AWS: **FAIL/BLOCKED**. Los paquetes llegaron desde ambas IP autorizadas, pero el servidor registró `tls-crypt unwrapping failed`: el servidor exige `tls-crypt.key` y el contrato de credencial F07 solo entrega certificado y CA; el cliente administrado no recibe ni configura esa clave.
- No se ejecutaron recuperación SCM con túnel activo ni revocación posterior a conexión. La credencial emitida sí fue revocada antes del cleanup.
- Cleanup del fallo: **PASS**. Servicio Windows y estado retirados; credencial revocada; dispositivo, nodo, entorno, operaciones y sesiones fixture eliminados; namespace/unidad OpenVPN ausentes; forwarding `0`; agente de nodo inactivo/deshabilitado; cero ingress UDP. Se retuvo exclusivamente el fixture administrativo y el acceso TLS TCP/3000 para la revisión UI solicitada.

### Provisión autenticada de `tls-crypt` — implementación local 2026-10-27

- El nodo ahora cifra la clave estática del entorno con ECDH P-256 + AES-256-GCM para la clave pública del CSR del endpoint; el entorno queda ligado como AAD. La API solo conserva y entrega el sobre cifrado a la sesión autenticada del dispositivo.
- El resultado persistido de operación de nodo elimina el sobre antes de guardarse; la credencial lo guarda como ciphertext. La clave estática en claro se materializa solo como archivo temporal protegido durante el arranque de OpenVPN y se elimina al inicializar, desconectar, revocar o reiniciar el servicio.
- Gates locales: ida y vuelta del sobre, rechazo de otro endpoint/entorno, rechazo de alteración/formato inválido, claves temporales con modo `0600`, borrado de material al conectar y cleanup de secretos transitorios obsoletos al reiniciar: **PASS** (`go test ./...`). Build cruzado Windows/amd64: **PASS**.
- Este cambio **no está desplegado**. Handshake real, reconexión real y revocación posterior a sesión siguen **NOT RUN**; no inferirlos de las pruebas de unidad. El gate de campaña anterior permanece como evidencia histórica del fallo previo.

### Despliegue `tls-crypt` y campaña acotada — 2026-10-27 UTC

- Release F07 `df2ef19651277627fa51ef1c0210bfd98fa1b186a7cb10618ad80d2362882576`: **DESPLEGADO**. Binarios del agente: Linux `a618d1c03bb2a3ab2ffcaaf19480a7407550096dfa90c0aaafaa151d9217a07d`; Windows inicial `2ea3b573bd19be77a1b9e8c3a7d05f7d0364ecc957aed7e394a5f444bf9a63f2`.
- Backup predeploy PostgreSQL + `dist/`: **PASS**, `s3://nexo-lab-423597267645-us-east-1-control/f07/backups/20261027/nexo-f07-tlscrypt-predeploy.tar.gz`, SHA-256 `c954567b17b65cb7e811927c8853a19edb64b4c4bf806ebf9ec3f061b477e190`. Release: `s3://nexo-lab-423597267645-us-east-1-control/f07/deploy/nexo-f07-tlscrypt-release-20261027.tar.gz`.
- La migración 014, que no estaba aplicada, se aplicó después del backup; el fixture sintético residual `f08-public-test` se retiró con autorización expresa. Gates posteriores: API `200`, reconciliación VPN sin sesión `401`, F08 `404`, listener único `127.0.0.1:3000`, agente nodo inactivo: **PASS**.
- El túnel de control por SSH hizo necesario separar el host UDP del host de la API. Se añadió un override `NEXO_VPN_REMOTE_HOST` validado, solo de host/IP y fail-closed; no acepta esquema, puerto, espacios, etiquetas DNS vacías/inválidas ni valor vacío. Pruebas Go, contrato cliente y cross-build Windows: **PASS**. Binario Windows usado en el ensayo: SHA-256 `169c230fb30573d277fc73747ebcc6d9fb6ec189bdc8eb01d4c31cf7546702ae`; build local final con validación DNS endurecida: `84d85f2573a58302d55dc89e248dda2f4e24ffefa1b63732e2b1c1459cbf4d7f` (**no desplegado**).
- Campaña sintética: dos tenants, un nodo, dos endpoints y dos entornos se inscribieron/aprobaron correctamente. El endpoint Windows obtuvo solo el catálogo del tenant A y creó una solicitud de credencial ligada a su entorno: **PASS parcial**.
- La campaña se detuvo antes del handshake porque la operación de emisión permaneció `queued`: no había worker de outbox instalado. El intento de levantar un worker transitorio usó `/usr/bin/node`, ruta inexistente en la AMI. Diagnóstico posterior read-only: la ruta fijada por `nexo.service` es `/usr/local/lib/nexo/node`. Conforme al gate de parada, no se reintentó.
- Handshake `Initialization Sequence Completed`, recuperación tras matar OpenVPN y rechazo por CRL: **NOT RUN**. F07 permanece abierto en esos tres gates; no se infieren de la inscripción, catálogo ni pruebas unitarias.
- Cleanup del gate fallido: **PASS**. Endpoints revocados antes del borrado; entornos reconciliados a `retired`; cero tenants/usuarios/nodos/dispositivos/entornos/credenciales fixture; cero namespaces y unidades VPN; forwarding `0`; nodo inactivo/deshabilitado; worker transitorio inactivo; servicio y estado Windows retirados; túnel, clave efímera e ingress TCP/22 y UDP/21501–21502 eliminados. API activa, `/` `200`, F08 `404` y escucha única `127.0.0.1:3000`.

### Prerequisitos para repetir la campaña — 2026-10-27 UTC

- `nexo-worker.service` se añadió al deploy con `ExecStart=/usr/local/lib/nexo/node /opt/nexo/dist/product/operation-worker.js`, usuario/grupo `nexo_runtime`, reinicio acotado y sandbox equivalente al de la API. En AWS quedó **activo y habilitado**; la conexión PostgreSQL `nexo-operation-worker` fue observada y el journal no registró fallos de inicio ni ciclo.
- El agente Windows final con `NEXO_VPN_REMOTE_HOST` se instaló como `NexoEndpoint`: estado **Running**, inicio **Automatic**, override `3.226.252.132`, IPC accesible y estado `unregistered`. El hash del binario instalado coincide con el build local: `84d85f2573a58302d55dc89e248dda2f4e24ffefa1b63732e2b1c1459cbf4d7f`.
- No se crearon fixtures, no se habilitó forwarding, no se inició el agente nodo y no se abrió ingress para esta preparación. Se detectaron y retiraron exactamente dos reglas SG antiguas `NEXO temporary public TLS test` en TCP/3000; el proxy permanece inactivo/deshabilitado y la API escucha únicamente `127.0.0.1:3000`.
- Gates locales: build TypeScript, pruebas de reanudación/outbox, contrato de la unidad, F07/L07, pruebas Go del runtime y cross-build Windows: **PASS**. La próxima campaña puede comenzar desde inscripción, pero handshake, reconexión y revocación siguen **NOT RUN**.

### Intento de repetición — preflight detenido 2026-10-27 UTC

- La IP pública se obtuvo desde WSL con `checkip.amazonaws.com`: `190.5.151.74`.
- El primer gate Windows falló antes de cualquier mutación: `NexoEndpoint` no existía, el registro de servicio/override estaba ausente y el IPC agotó tiempo. El binario local sí conservaba el hash esperado `84d85f2573a58302d55dc89e248dda2f4e24ffefa1b63732e2b1c1459cbf4d7f`.
- Conforme a la regla “gate fallido → detener y limpiar”, no se reinstaló el servicio ni se encadenó un reintento. No se creó clave o túnel SSH, no se abrió ingress, no se crearon fixtures y no se modificó forwarding.
- Baseline posterior: worker persistente `active/enabled`; API activa y solo `127.0.0.1:3000`; nodo `inactive/disabled`; forwarding `0`; cero namespaces, fixtures, entornos y credenciales; cero ingress con descripción NEXO; cero estado Windows de campaña y procesos OpenVPN.
- Handshake, reconexión y revocación real continúan **NOT RUN**. F07 permanece abierto y F08 no se inició.

### Restablecimiento Windows y nueva campaña detenida — 2026-10-27 UTC

- Diagnóstico previo: Windows no conservaba servicio, binario instalado ni directorio de estado. El log SCM solo mostró eventos 7045 de instalaciones anteriores y no aportó un evento de eliminación ni identidad responsable. La evidencia permite afirmar desaparición completa, pero no atribuirla a un actor o causa concreta.
- Preparación fuera de campaña: binario local e instalado SHA-256 `84d85f2573a58302d55dc89e248dda2f4e24ffefa1b63732e2b1c1459cbf4d7f`; EC2 pública `3.226.252.132`; `NexoEndpoint` instalado mediante UAC con API `http://127.0.0.1:13000`, SID autorizado y `NEXO_VPN_REMOTE_HOST=3.226.252.132`. Reinicio SCM, estado `Running/Automatic` e IPC `ok=true, unregistered`: **PASS**.
- Preflight de campaña: worker `active/enabled`, API solo loopback, nodo `inactive/disabled`, forwarding `0`, cero namespaces/fixtures/entornos/credenciales e ingress NEXO: **PASS**. IP de salida obtenida desde WSL: `190.5.151.74`.
- Túnel SSH e ingress TCP/22 + UDP/21501–21502 limitados a `190.5.151.74/32`; HTTP `200` comprobado desde Windows: **PASS**. Se crearon exclusivamente las dos bases administrativas tenant/session y sus tres invitaciones sintéticas.
- El primer intento de inscripción fue detenido porque AWS MCP devolvió `Temporary failure in name resolution` antes de crear el comando SSM. Un segundo error ocurrió al iniciar el cleanup; se verificó recuperación del MCP solo para ejecutar cleanup, no para reintentar la campaña. Inscripciones, aprobación, emisión, aislamiento, handshake, reconexión y revocación: **NOT RUN**.
- Cleanup: **PASS**. Invitaciones, sesiones, tenants, plan y usuario fixture retirados; cero identidades, entornos y credenciales; ingress, túnel, clave y tokens locales eliminados; nodo `inactive/disabled`, forwarding `0`, cero namespaces. `nexo-worker.service` permanece `active/enabled`. La preparación Windows se conserva instalada y `unregistered`, sin `state.json` ni estado de campaña.
- F07 permanece abierto; F08 no se inició. El fallo de infraestructura no se convirtió en un reintento funcional.

### Campaña con diseño de revocación CRL — detenida por defecto de reconciliación 2026-10-27 UTC

#### Preflight y preparación

- MCP verificado con identidad (`423597267645`, `nexo-lab-admin`) y un SSM read-only completado (SSM `81cb6210-0948-48e0-9342-8f4c838f4cd4`): worker `active/enabled` sin errores de ciclo, API activa con listener único `127.0.0.1:3000`, nodo `inactive/disabled`, forwarding `0`, cero namespaces/unidades VPN, cero fixtures/entornos/credenciales, F08 `404`, cero ingress NEXO: **PASS**.
- Windows revalidado sin reinstalar: `NexoEndpoint` `Running/Automatic`, hash instalado `84d85f2573a58302d55dc89e248dda2f4e24ffefa1b63732e2b1c1459cbf4d7f`, `NEXO_VPN_REMOTE_HOST=3.226.252.132`, IPC `ok=true, unregistered`: **PASS**.
- IP de salida obtenida desde WSL: `190.5.151.74`. Ingress temporal TCP/22 y UDP/21501–21502 limitado a ese `/32`; clave SSH efímera, túnel `127.0.0.1:13000` y HTTP `200` comprobado **desde Windows**: **PASS**.
- Fixtures: tenants `77000000-…-001/002`, nodo `5e2eff41-d626-4628-8b06-24cbc7e8162d`, endpoint Windows A `e4a12468-09d9-4d4b-8051-c0b83d38b429`, endpoint B `75029424-81ec-406c-b2d0-9fc4827c906b`, entornos `845d7e51-58c2-4c5e-b516-18e6f98d03de` (UDP/21501) y `d7b5a5c2-4cfa-4844-b387-310916b3dffd` (UDP/21502). Inscripción, prueba de posesión, aprobación y `claim`: **PASS**. Ambos entornos quedaron `active/active` con unidad OpenVPN nativa activa (`18:34:20Z`): **PASS**.

#### Diseño de la prueba de rechazo por CRL (preparado, no ejecutado)

- Se añadió un binario de prueba aislado `product/agent/cmd/nexo-crl-probe` (windows/amd64, SHA-256 `37f25ba80edaab3d45f18d40731e63a5f4c880a181438e8a6177e0e0e152628c`); no modifica el agente ni el estado administrado.
- Diseño: copia protegida (ACL `SYSTEM`/`Administrators`) de `client.key`, `client.crt`, `ca.crt` y `tls-crypt.envelope` antes de revocar; descifrado del sobre con la clave DPAPI del dispositivo; archivos efímeros `0600`; proceso OpenVPN separado con `tls-crypt`, CA, `remote-cert-tls server` y `verify-x509-name <env> name` intactos; reinicio únicamente de la unidad del entorno tras actualizar la CRL.
- Evidencia exigida: alerta `certificate revoked` en el cliente y `VERIFY ERROR … error=certificate revoked` en el journal del servidor. **NOT RUN** (la campaña se detuvo antes).

#### Gate de emisión — FAIL por defecto de producto

- La operación `vpn.client_certificate.issue.v1` terminó `succeeded` y la credencial se emitió, pero no fue posible demostrar de forma determinista `queued → ready → succeeded`: el propio agente revocó la credencial durante la observación.
- Causa medida: el agente del nodo publica `provisioning` en **cada** ciclo de reconciliación (`cmd/nexo-agent/main.go`, `reconcileNodeVPN`) aunque el entorno ya esté sano. Muestreo read-only de 70 lecturas cada 0,5 s (SSM `6ed7274a-0711-43fd-aaf5-3f58275ae873`): `provisioning` en `18:43:03.666–18:43:04.384` y `18:43:18.599–18:43:19.291`, ~0,6–1,4 s cada 15 s.
- El catálogo del endpoint solo expone entornos con `observed_state='active'` (`postgres-vpn-environment-repository.ts`, `available`). Una lectura dentro de esa ventana devuelve `items: []`; `syncVPNCatalog` (`cmd/nexo-agent/service.go`) interpreta la ausencia como retirada y revoca la credencial. Resultado observado: credencial en `revocation_pending` y operación `vpn.client_certificate.revoke.v1` en cola, sin intervención humana sobre la cola.
- Consecuencia: credenciales emitidas se destruyen de forma aleatoria y los gates de handshake/reconexión/CRL no son reproducibles. **Campaña detenida sin reintentos funcionales**.
- Corrección propuesta (no implementada): no publicar `provisioning` cuando el entorno ya está sano y aplicado, y/o exigir retirada confirmada antes de revocar por ausencia de catálogo. Requiere decisión de producto por afectar el contrato fail-closed.

#### Gates restantes

- Aislamiento por endpoint: **NOT RUN** (catálogo oscilante impide medición estable).
- Handshake real `Initialization Sequence Completed`: **NOT RUN**.
- Reconexión real con relanzamiento: **NOT RUN**.
- Rechazo real por CRL en OpenVPN: **NOT RUN**.

#### Cleanup y estado final

- Entornos retirados vía API y reconciliados a `retired` (`observed_state=retired`, `applied_revision=revision`); retirada nativa: `0` namespaces, `0` unidades, `0` archivos de unidad (SSM `fe9f2f86-fe3c-4466-866d-263ea291150b`).
- Fixtures borrados: `0` tenants/usuarios/nodos/dispositivos/entornos/credenciales/operaciones; identidades locales del ensayo eliminadas (SSM `0d83c99a-7143-432d-bdd5-e1b625230f5e`). Directorios PKI de los dos entornos del ensayo eliminados (SSM `30f928ae-4164-4c70-be6c-86ae88a3f8eb`); quedan 4 directorios de campañas anteriores, ajenos a esta ejecución y no tocados.
- Nodo `inactive/disabled`, forwarding `0`, `0` namespaces y `0` unidades OpenVPN; worker restaurado `active/enabled`; API `200` solo `127.0.0.1:3000`; F08 `404` (SSM `cb24cfc8-37d8-489a-81e1-fc182288f60c`): **PASS**.
- Ingress temporal revocado (cero reglas con descripción NEXO), túnel cerrado, clave SSH y tokens eliminados. Windows: estado de campaña eliminado (`state.json`, `vpn/`, catálogo, conexiones); servicio conservado `Running/Automatic`, IPC `unregistered`, `0` procesos OpenVPN, hash sin cambios: **PASS**.
- Hallazgo secundario: retirar un entorno no elimina su directorio PKI en `/var/lib/nexo-node/environments/<id>`; se retiró manualmente el del ensayo.
- F07 permanece **abierto**. F08 no se inició. Sin commit ni push.

### Campaña básica Windows↔AWS — PASS y cierre de F07 — 2026-10-28 UTC

#### Alcance revisado

- El criterio de cierre se redujo explícitamente a demostrar que el endpoint Windows real obtiene una credencial VPN mediante API/worker/nodo reales y completa un handshake OpenVPN administrado contra AWS. Reconexión, aceptación con segundo endpoint/tenant y rechazo real por CRL permanecen como pruebas posteriores y no se declaran PASS. F08 no se inició.
- Cuenta `423597267645`, región `us-east-1`, instancia `i-006cda6fdc86af7a5`, API solo `127.0.0.1:3000`. La IP de salida rotó entre cuatro direcciones; con autorización expresa se limitó ingress temporal al conjunto exacto `190.5.151.74/32`, `138.97.142.254/32`, `190.120.26.242/32`, `190.120.26.244/32` para TCP/22 y UDP/21501–21502.

#### Migración 015 y revisión de seguridad

- Se reprodujo el caso de dos dispositivos sobre el mismo nodo en PostgreSQL real: la segunda emisión obtuvo revisión `3` sin colisión. `scripts/f07-postgres.mjs`: **PASS**; aislamiento RLS, entitlement, emisión y revocación: **PASS**.
- `scripts/runtime-grants.mjs`: **PASS**, 15 migraciones, 55 tablas, least privilege y RLS. La revisión detectó y corrigió dos defectos: PostgreSQL concedía `EXECUTE` a `PUBLIC` por defecto y, en una instalación limpia, `nexo_runtime` se creaba después de 015. El estado aplicado quedó `owner=postgres`, `SECURITY DEFINER=true`, `search_path=public`, `nexo_runtime EXECUTE=true`, `PUBLIC EXECUTE=false` (SSM `a4fbc5a5-59c4-49c8-be3f-22bf92cee2d7`).
- SHA-256: migración 015 `9bc0188ec030cfde169daf400db3c266310ecccb774f4a3aa23903e35e7cf67d`; manifiesto runtime `9d66036732400ce132d0ba71362f5b30f05384b197984de38b728fc641586acf`; `dist` desplegado `9800b5478ff83d3a1af425abc60102521e9a4596e0f9822155eaad5e0eafed31`. API `200`, endpoint VPN sin autenticación `401`, F08 `404`, worker `active/enabled`: **PASS** (SSM `656ac808-4938-4bfe-b53c-c14d0953198a`).

#### Fixtures y emisión

- Tenants `79000000-0000-4000-8000-000000000001/002`; nodo `0b577623-1909-47e3-8d06-3ff5f64f6f36`; endpoint Windows A `f685c10c-4f31-44f1-8c89-c3133fc4067d`; endpoint Linux B `ee9766c5-7334-44ff-b374-27de45a862bb`.
- Inscripción, prueba de posesión, aprobación y claim: **PASS**. Entornos iniciales A `ebec7ff4-039b-4261-a268-9450855a8ed8` (UDP/21501) y B `b33717eb-67e0-4324-9423-48a9dc8cdca5` (UDP/21502) quedaron `active|1|1`: **PASS** (SSM `2b26d3f7-7ae7-4ef7-8e58-c87c7ee4b5f8`).
- Endpoint A recibió una credencial `issued`, serial `0fe74fa88f6cee31facb4da002d978ab`, sobre `tls-crypt` presente; operación `vpn.client_certificate.issue.v1` revisión `1` terminó `succeeded` (SSM `8f4e7af3-c51b-43e6-92ca-513d918c9bbb`). Endpoint A vio solo A y B vio solo B; esta observación no sustituye la aceptación multitenant posterior.

#### Diagnóstico y corrección del handshake

- El primer `connect_vpn` administrado terminó `vpn_start_failed`. El probe aislado reveló que su propia implementación intentaba descifrar el sobre con la clave de identidad del dispositivo en vez de la clave VPN del CSR; se corrigió y verificó. Probe Windows SHA-256 `323d7cbd65835bc975985bddb36e8a4fd6a0502d8cf13dba997129e6ba54b2da`.
- Con el probe corregido, cliente y servidor demostraron `tls-crypt`, CA, EKU e identidad del servidor intactos. El journal identificó la causa real: `could not extract CN ... field length is limited to 64 characters`; el CN anterior `nexo:<tenant UUID>:<device UUID>` medía 78 caracteres.
- Con autorización explícita se cambió únicamente el subject de certificados VPN a `CN=nexo:<device UUID>` y `OU=<tenant UUID>`. El UUID global conserva identidad única y el tenant permanece ligado al certificado; CRL continúa por serial. Pruebas `vpnruntime`, `go vet` y build Linux: **PASS**. Binario Linux desplegado SHA-256 `e0d0cafc6abdc7a4031d611687b251bc54b404fa8f267a1b7df59f3f5c041395` (SSM `fbb00048-2b56-4888-a041-5a7ca65a12bd`).
- Se retiró A mediante API y se creó A2 `0f4c895c-9d26-4861-baaf-8349b4c788c4` en UDP/21501, CIDR `10.247.33.0/24`. La nueva credencial quedó `issued`, serial `778eb4200d08690398be91e4b11461cd`, `tls-crypt` presente y operación revisión `2` `succeeded`; subject verificado `OU=79000000-0000-4000-8000-000000000001, CN=nexo:f685c10c-4f31-44f1-8c89-c3133fc4067d` (SSM `11a85d3e-15cc-4482-9677-d4f3614a7ff3`).

#### Resultado básico

- `connect_vpn` administrado pasó de `connecting` a `connected`. Ese estado solo se publica al observar la línea OpenVPN `Initialization Sequence Completed`: **PASS**.
- Windows mostró un único proceso administrado `openvpn.exe --config C:\ProgramData\NEXO\Endpoint\vpn\0f4c895c-9d26-4861-baaf-8349b4c788c4\runtime\client.ovpn` e IP `10.247.33.2/24` en `OpenVPN Connect DCO Adapter`: **PASS**.
- Servidor: CA y certificado cliente `VERIFY OK`; `Peer Connection Initiated` para `CN=nexo:f685c10c-4f31-44f1-8c89-c3133fc4067d`; pool asignó `10.247.33.2` (SSM `fbfcae6a-de6f-4adb-a93f-0af64a331c69`): **PASS**.
- Resultado de esta ejecución: **PASS básico; F07 cerrado según el criterio revisado**. Reconexión administrada: **NOT RUN**. Rechazo real por CRL: **NOT RUN**. Aceptación con segundo tenant/dispositivo: **NOT RUN**. F08: **NOT RUN**.

#### Estado final y fixtures retenidos inactivos

- La credencial A2 se revocó por API; operación revisión `3` `succeeded` y estado terminal `revoked` (SSM `0234d134-5cd7-46fc-830b-eab57df90c82`). Los tres entornos A, B y A2 quedaron `desired_state=retired`, `observed_state=retired`, `applied_revision=revision`.
- Se conservaron únicamente filas sintéticas para trazabilidad: dos tenants, un nodo aprobado sin clave local, dos endpoints aprobados sin claves locales, tres entornos retirados, dos credenciales de A (A original `issued` pero inutilizable: entorno retirado, PKI y clave cliente eliminadas; A2 `revoked`) y tres operaciones `succeeded`. No quedan sesiones proveedor, tenant, nodo ni dispositivo.
- AWS: nodo `inactive/disabled`, forwarding `0`, namespaces `0`, PKI/directorios de estos tres entornos eliminados; worker `active/enabled`; API HTTP `200` solo loopback (SSM `5328a43e-1c35-4768-af25-5b959880bc65`).
- Windows: `NexoEndpoint` permanece `Running/Automatic`, IPC `unregistered`, VPN `unavailable`, cero procesos OpenVPN; se eliminaron estado, claves y snapshots de campaña. Ingress temporal: cero reglas TCP/22 o UDP/21501–21502. Túnel, clave SSH, tokens y archivos temporales retirados. Sin commit ni push.

### Despliegue de la corrección de parpadeo — 2026-10-27 UTC

- Artefactos: release `s3://nexo-lab-423597267645-us-east-1-control/f07/deploy/nexo-f07-flicker-release-20261027.tar.gz`, SHA-256 `84bfbc8239856953eb86ed55eb4fae806c9226f9e2ab3851bb01229951a8be12`; backup predeploy PostgreSQL + binario + `dist` `.../f07/backups/20261027/nexo-f07-flicker-predeploy.tar.gz`, SHA-256 `044fdc78e40b3c2621a94183f5ec5454d59a8117e97c6ca0c50d532bb74383f1` (SSM `90efa33e-e99c-42e5-9176-f943064b78e3`).
- Nodo Linux: binario `88bf4bd06849f94c09642f57695a417d0472a4ff8bd174831d9a576bd80f0c48` instalado y verificado por hash, agente inactivo (SSM `812988ba-cbe9-4b0b-8863-59c3663b8715`): **PASS**.
- Windows: `NexoEndpoint` reinstalado con `aade7dd196a5a3c8aa02369e844445d1f926d999e77bc08133016e4b563e7cfb`, `Running/Automatic`, override `3.226.252.132`, IPC `unregistered`. El primer intento de elevación fue cancelado por el usuario y no alteró nada; se relanzó con aprobación: **PASS**.
- Verificación de la corrección en AWS (SSM `43372c11-2843-4742-9161-8b52388d3bab`): dos entornos reconciliados `active` y **60/60 muestras `active`, 0 `provisioning`** en muestreo de 30 s con el agente del nodo en ciclo normal: **PASS**. El parpadeo queda eliminado.

### Campaña bloqueada por asignación de revisión de operaciones — FAIL

- Gate de emisión detenido: `POST /v1/device/vpn/credentials` respondió `409` y no se creó la credencial. El cuerpo `{"error":"conflict"}` es el enmascaramiento del filtro seguro, no el código de dominio.
- Causa raíz medida: `node_operations` está bajo RLS y el dispositivo solo ve sus propias filas. Para el dispositivo B, `SELECT … WHERE target_node_id=…` devuelve `visible_ops=0 max_revision=none`, mientras el nodo tiene `all_ops=2 max_revision=2` (SSM `be15cbcd-71a1-4e3d-b863-11af2b5fba90`). `PostgresVpnCredentialRepository.request` calcula `latest+1 = 1` y choca con el índice único `node_operations_target_revision_idx(target_node_id, revision)`; el `23505` se captura y se reporta como conflicto de idempotencia.
- Una inserción directa con revisión libre (99) y el mismo contexto de dispositivo funciona (SSM `b667db69-8590-460e-9f0f-aff10abccff1`), lo que confirma que el fallo es la asignación de revisión, no permisos ni precondiciones del entorno.
- Alcance: cualquier nodo con operaciones previas de otro dispositivo (o de otro entorno emitido por otro dispositivo) rechaza nuevas solicitudes de credencial. Bloquea emisión, handshake, reconexión y CRL.
- Gates: emisión **FAIL**; aislamiento, handshake, reconexión y rechazo real por CRL **NOT RUN**.
- Corrección propuesta (no implementada, requiere migración y autorización): asignar la revisión con un único asignador autoritativo por nodo — función `SECURITY DEFINER` que devuelva `max(revision)+1` (o secuencia por nodo) usada por `request`, `revoke`, `createInternalOperation` y `createOperation` — manteniendo el índice único como invariante. Alternativa descartada: reintentar sobre `23505`, porque bajo RLS el máximo visible sigue siendo `0`.
- Cleanup: **PASS**. Entornos retirados y reconciliados a `retired` (0 namespaces, 0 unidades; SSM `f7f7decb-efb8-495d-9d68-6d9e35ae5654`); fixtures, identidades y operaciones eliminados (SSM `5e87b754-7f32-4ff7-aa3f-40b440a76256`); nodo `inactive/disabled`, forwarding `0`; worker `active/enabled`; API `200` solo loopback; F08 `404`; ingress NEXO 0, túnel, clave y tokens retirados; Windows conserva el binario nuevo instalado y queda `unregistered` sin estado de campaña ni procesos OpenVPN (SSM `87ca1ef8-8d69-4026-8127-cb5fe8d87bb9`).
- F07 permanece **abierto**. F08 no se inició. Sin commit ni push.

> **Estado vigente:** la campaña básica Windows↔AWS del **2026-10-28 UTC**, documentada arriba, sustituye este estado histórico: resultado básico **PASS** y F07 cerrado según el criterio revisado. Las pruebas posteriores indicadas allí permanecen **NOT RUN**.

### Revalidación local — 2026-10-31 UTC

Alcance: pruebas locales con datos sintéticos. **No se contactó AWS ni se ejecutaron acciones remotas.** Esta revalidación no vuelve a comprobar la instancia ni el cliente Windows real.

- Entorno: Node.js `v22.17.0`; Docker Engine `29.5.2`; imagen PostgreSQL `17.6-bookworm`.
- Comparación del fixture con `infra/aws/lab/nexo-runtime.sql`: las 57 tablas referenciadas por grants tienen una migración creadora. `f08-local` omitía únicamente `support_consent` y `support_sessions`, ambas creadas por 020. Se añadió el perfil local, autónomo y desechable `f07-local` (`001–016 + 017 + 019 + 020`); no incluye 018 ni altera el perfil de laboratorio. La documentación de perfiles se actualizó.
- `node --test tests/migration-runner.test.mjs`: **PASS, 9/9**.
- `npm run test:f07-postgres`: **PASS**. Build TypeScript y 19 migraciones con checksum verificado; endpoint RLS, aislamiento tenant, entitlement, catálogo activo, CSR/operación, revocación y reemisión tras revocación: **PASS**.
- `npm run verify:f07`: **PASS**. Typecheck; pruebas TypeScript/API **4/4**; fixture PostgreSQL; build de cliente Windows; suites Go; builds Linux y Windows del agente.
- Defecto de serial: **PASS local**. `sameCredentialSerial` compara el valor numérico; las pruebas Go cubren nibble hexadecimal inicial cero y conexión administrada con ese serial.
- `credential_conflict` después de revocación: **PASS local** con 016 aplicada. PostgreSQL permite emitir una fila nueva tras el estado `revoked`, y conserva el conflicto para otra CSR mientras la credencial nueva está activa. El esquema/migraciones desplegados en AWS no se revalidaron.
- Observación de perfil no registrada: **PASS local**. `TestServiceRunOnceRegistersPrivateNetworkObservation` comprueba que `service.runOnce` obtiene el perfil, verifica la ruta sintética y publica el estado observado; también pasa la prueba de observación activa/error.
- **NOT RUN en esta revalidación:** reconexión automática del OpenVPN Windows real; aceptación de segundo tenant/dispositivo en el entorno real; rechazo real de certificado revocado por OpenVPN/CRL; recorrido Windows↔AWS. El marcador local `crl_revocation: PASS` del script no sustituye la prueba de rechazo real por CRL. F08 permanece fuera de alcance.

**Decisión de fase:** no declarar F07 cerrada con esta evidencia solamente. Los tres defectos de implementación indicados pasan pruebas locales actuales, pero los gates reales de reconexión, aceptación multitenant, CRL y despliegue siguen sin revalidar.
