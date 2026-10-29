# F07 — cliente Windows integrado con F06

Estado: **catálogo R1 y emisión/revocación R2 desplegados y verificados en laboratorio; runtime OpenVPN Windows implementado, empaquetado y verificado localmente**. OpenVPN Community 2.7.7 está instalado en el host Windows de prueba, pero la campaña Windows↔AWS se detuvo en el registro del servicio a través del port-forward temporal y no alcanzó el handshake VPN. No está autorizado para producción, clientes ni datos reales.

## Objetivo

Convertir el corte local L07 en un cliente Windows que descubra y opere únicamente entornos OpenVPN autorizados para su empresa. La interfaz Tauri sigue separada del servicio continuo y nunca recibe claves privadas, bearer tokens ni configuración OpenVPN completa.

## Contrato

- La identidad endpoint conserva `audience=endpoint` y no puede usar contratos de nodo.
- `POST /v1/device/vpn/reconcile` acepta exclusivamente `{}` y deriva empresa/dispositivo de la sesión autenticada.
- La respuesta solo contiene módulo efectivo y descriptores allowlisted: ID, nombre, motor `openvpn`, protocolo `udp`, puerto y revisión.
- El API no acepta ni devuelve rutas, URLs, comandos, ejecutables, argumentos OpenVPN, namespace, IP de tránsito ni material PKI en este contrato.
- El servicio deriva el host remoto de su `base-url` administrado; la UI no puede modificarlo.
- Solo se anuncian entornos `active` observados `active`, con revisión aplicada igual a la deseada y módulo VPN vigente.
- La clave privada VPN se generará en Windows. El nodo firmará un CSR mediante una operación tipada; la CA privada permanecerá en el nodo.
- Suspensión, revocación, retiro o credencial inválida deben desconectar y limpiar en modo fail-closed.

## Estados iniciales del cliente

- `unregistered`: sin identidad endpoint.
- `pending_approval`: prueba de posesión completada, pendiente de aprobación.
- `approved`: identidad y certificado de control válidos.
- VPN `unavailable`: módulo no incluido, suspendido o sin entorno operativo.
- VPN `catalog_ready`: existen descriptores válidos, pero aún no se emitió credencial VPN.
- VPN `disconnected`, `connecting`, `connected`, `error`: reservados para el corte de runtime y nunca se infieren solo por obtener catálogo.

## Contrato CSR y revocación R2

- El servicio Windows genera una clave ECDSA P-256 por entorno, la protege con el keystore DPAPI existente y persiste el CSR para reintentos idempotentes. En el adaptador Linux de laboratorio se usa archivo `0600`. La UI nunca recibe la clave, el CSR ni los certificados PEM.
- `POST /v1/device/vpn/credentials` acepta únicamente `environment_id`, `csr_pem` e `idempotency_key`. La API vuelve a comprobar dispositivo aprobado, tenant, entitlement, entorno activo, revisión aplicada y nodo aprobado.
- La API crea exclusivamente `vpn.client_certificate.issue.v1`, ligada al nodo propietario. Sus argumentos fijos son `request_id`, `environment_id`, `tenant_id`, `device_id` y `csr_pem`.
- El nodo valida firma y clave P-256 del CSR, ignora su subject y emite un certificado `clientAuth` de hasta 24 horas con identidad derivada de tenant/dispositivo. La CA privada no sale del directorio PKI del nodo.
- `POST /v1/device/vpn/credentials/:environmentId/revoke` acepta únicamente el serial emitido e idempotencia. Produce `vpn.client_certificate.revoke.v1`; el nodo exige coincidencia de request, tenant, dispositivo, entorno y serial.
- La revocación actualiza una CRL firmada por la CA del entorno. La configuración OpenVPN usa `crl-verify`; una CRL ausente, corrupta o con permisos incorrectos falla cerrado.
- Cuando un entorno desaparece del catálogo autorizado, el servicio solicita la revocación de una credencial emitida antes de sustituir el catálogo local.
- La revocación administrativa del dispositivo encola primero todas sus revocaciones VPN y solo después revoca sesión/certificado de control, evitando depender de una autenticación posterior del endpoint.
- Estados persistidos: `pending`, `issued`, `revocation_pending`, `revoked`, `failed`. Solo `issued` contiene certificado cliente y CA pública; nunca contiene la clave privada.

## Runtime OpenVPN Windows

- La UI solo puede solicitar `connect_vpn` o `disconnect_vpn` con un `environment_id` validado. No acepta ejecutable, ruta, host, URL, argumentos ni directivas OpenVPN.
- El servicio deriva el host del `base-url` administrado y usa exclusivamente el puerto, protocolo y motor allowlisted del catálogo. El ejecutable se fija en `%ProgramFiles%\OpenVPN\bin\openvpn.exe`; el instalador rechaza ausencia o versión distinta de OpenVPN Community 2.x.
- La configuración cliente es cerrada: UDP, validación de certificado servidor y CN del entorno, TLS 1.2 mínimo, cifrados AEAD, sin management interface, scripts ni rutas aportadas externamente. Se ignora `redirect-gateway` para impedir convertir el endpoint en túnel total por una directiva push.
- La clave persistente permanece en DPAPI. Para iniciar OpenVPN, el servicio crea una copia transitoria dentro del estado ACL-protegido, la elimina al observar `Initialization Sequence Completed` y usa `persist-key` para mantenerla solo en memoria del proceso.
- El proceso OpenVPN pertenece a un Windows Job Object con `KILL_ON_JOB_CLOSE`; detener o terminar el servicio cierra el túnel. La desconexión explícita también retira configuración y clave transitorias.
- La intención de conexión se persiste sin PID, rutas ni secretos. Tras reinicio, solo se recupera cuando catálogo, entitlement y credencial continúan vigentes. Catálogo no disponible, módulo retirado, credencial revocada/vencida o proceso fallido desconectan de forma fail-closed.
- Estados IPC saneados: `disconnected`, `connecting`, `connected`, `error`; los errores son códigos cerrados y la UI nunca recibe configuración ni material PKI.

## Criterios

- PV03: invitación, cupo e idempotencia de registro.
- PV10: actualización autenticada, compatibilidad y rollback seguro.
- PV13: identidad común y activación efectiva del módulo VPN.
- UX03: registro con aprobación explícita.
- UX12: invitaciones y cupos visibles.
- UX13: identidad y activación por plataforma sin prometer módulos no operativos.

El plan ejecutable está registrado como `F07 — Cliente Windows integrado con F06` en el conocimiento del proyecto.

La evidencia del primer corte, incluido el rollback comprobado durante el despliegue, está en [evidence.md](evidence.md).
