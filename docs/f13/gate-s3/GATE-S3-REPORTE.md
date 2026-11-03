# F13-A v1 — Reporte consolidado de cierre del gate S3

> Corte original v1. La actualización más reciente está en [GATE-S3-REPORTE-V2.md](GATE-S3-REPORTE-V2.md).

- **Fecha:** 2026-11-02
- **Versión local revisada:** `a589aa38888400515e5a66164779cacfe0e33c78` (la revisión desplegada de API no se pudo verificar)
- **Cuenta/región:** `423597267645` / `us-east-1`
- **EC2 / IP observada:** `i-006cda6fdc86af7a5` / `3.226.252.132`
- **Alcance ejecutado:** inspección local, consultas HTTP de salud/egress, inspección PowerShell de adaptadores/rutas y comandos SSM de solo lectura. No se crearon invitaciones o entornos, no se aprobaron dispositivos, no se suspendió Alpha ni se reinició un servicio.

| Historia | Resultado | Bloqueantes |
|---|---|---|
| A1 — Enrollment Windows | **BLOCKER** | Login HTTP 401; gate mutante abierto; no se creó ni verificó dispositivo. |
| A2 — Aislamiento LAN Alpha/Beta | **BLOCKER** | Login HTTP 401; forwarding `0`, agente de nodo inactivo y sin plano VPN NEXO observado; fixtures F06 pendientes. |
| A3 — Rutas split-tunnel | **BLOCKER** | Adaptadores OpenVPN desconectados, sin rutas VPN `10.*`; IPs de egress desde WSL discordantes. |
| A4 — Fallo parcial | **BLOCKER** | No se pudo verificar Beta/Alpha por HTTP 401; mutación bloqueada por gate F06. |
| A5 — Reinicio de estado | **BLOCKER** | No se pudo verificar identidad/estado del dispositivo; no se reinició el servicio; `/health` responde 404. |

## Verificaciones comunes

- La EC2 estaba `running` en la cuenta y región esperadas; IP pública observada: `3.226.252.132`.
- El inventario SSM de solo lectura terminó `Success`, command ID `e1a19067-99df-452a-a923-d93548703960`. Observó Amazon Linux 2023, `ip`/`nft`/`systemctl`/`sysctl`/`openvpn` disponibles, TUN presente, cgroup v2, `nexo.service` y PostgreSQL activos, tablas de migración F06 presentes y aproximadamente 27.4 millones de KiB disponibles en `/var/lib`.
- Hallazgos que impiden declarar listo el plano VPN: forwarding IPv4 `0`, `nexo-node-agent.service` `inactive`, y sin salida de `ip netns list`, `nft list tables` o unidades `nexo-vpn-*.service`.
- El login del proveedor respondió **HTTP 401** una vez. No hubo reintentos, no se escribieron valores secretos en archivos/evidencias ni se imprimieron; no se obtuvo selección ni token.
- Dos intentos del wrapper compuesto de preflight finalizaron con error de quoting (`unexpected EOF`). Para no declarar el preflight aprobado, se comprobó el inventario con comandos SSM independientes de solo lectura; el command ID exitoso queda arriba.
- Contratos revisados en `product/api/application.ts`: invitación endpoint `POST /v1/company/device-invitations`; agentes de empresa `GET /v1/company/agents`; entornos VPN `GET /v1/provider/vpn-environments`; cambio de estado `PUT /v1/provider/vpn-environments/:id/state`. Varias rutas del prompt no existen. El CLI requiere `enroll <base-url> <state-dir> <token> <name>`.
- `docs/f06/aws-validation-plan.md` mantiene la fase de aceptación bloqueada hasta resolver fixtures efímeros, cleanup reanudable, revisión/pruebas del runner, umbral de carga y prerrequisitos de operación. No se autorizó una excepción a ese gate durante esta ejecución.

## Detalle de bloqueantes

1. **A1–A5 — sesión de proveedor no disponible.** Causa observada: `POST /v1/auth/login` devolvió HTTP 401; no se continuó a MFA ni selección de ámbito. **Acción recomendada:** validar la credencial activa del lab por un canal aprobado y reintentar una sola vez, sin registrar secretos.
2. **A1, A2, A4 y A5 — gate mutante F06 abierto.** Causa: el plan y el runner del repositorio indican que aceptación sigue `ready: false`; permanecen prerrequisitos de fixtures sintéticos y cleanup reanudable, entre otros. **Acción recomendada:** completar/revisar esos controles y actualizar formalmente el gate antes de crear identidades/entornos, suspender Alpha o reiniciar servicios para aceptación.
3. **A2/A4 — plano de datos no listo/identificado.** Causa: forwarding IPv4 deshabilitado, agente de nodo inactivo y sin namespaces/unidades VPN NEXO observados; además no se pudieron leer los estados tenant-scoped por el fallo de autenticación. **Acción recomendada:** recuperar el plano de laboratorio bajo procedimiento aprobado y verificar Alpha/Beta por identidad y revisión antes de probar aislamiento/fallo parcial.
4. **A3 — falta cliente VPN activo.** Causa: los dos adaptadores OpenVPN Windows observados estaban desconectados y no había rutas VPN `10.*`; las consultas egress desde WSL dieron dos IP diferentes y no son prueba válida del cliente VPN. **Acción recomendada:** repetir desde un endpoint Windows sintético conectado, capturando rutas y egress concordantes.
5. **A5 — pre/post de dispositivo y endpoint health incompletos.** Causa: sin sesión no se obtuvo `device_id`; `/health` devolvió 404 y no hay ruta health en el código revisado. **Acción recomendada:** conservar el mismo `device_id` antes/después del reinicio autorizado y usar systemd como señal de proceso hasta documentar health HTTP.

## Veredicto

**VEREDICTO GATE S3: OPEN.** Ninguna historia alcanzó su criterio de PASS; no se clasifican como FAIL porque las pruebas no se ejecutaron con sus precondiciones. No se hicieron cambios de infraestructura, VPN o dispositivos; no quedó recurso de prueba nuevo que limpiar.

Referencias por historia: [A1](A1-enrollment.md), [A2](A2-isolation.md), [A3](A3-routing.md), [A4](A4-partial-failure.md), [A5](A5-restart.md).
