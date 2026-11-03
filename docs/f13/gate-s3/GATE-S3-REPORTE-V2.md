# F13-A v2 — Reporte de ejecución

- **Fecha:** 2026-11-02
- **Versión local revisada:** `a589aa38888400515e5a66164779cacfe0e33c78` (no se pudo verificar la revisión desplegada)
- **EC2:** `i-006cda6fdc86af7a5`, cuenta `423597267645`, región `us-east-1`, IP revalidada `3.226.252.132`
- **Datos:** sintéticos únicamente; no se crearon empresas, usuarios, dispositivos ni entornos.
- **Resultado general:** **OPEN**. Se detuvo la ejecución al alcanzar dos respuestas HTTP 401 en login, conforme a la regla v2.

| Historia | Resultado | Detalle |
|---|---|---|
| A0 — Prerrequisitos | **BLOCKER** | Servicio de nodo deshabilitado/inactivo; identidad requerida ausente; forwarding `0`. No se inició el agente ni se alteró la red. |
| A1 — Enrollment Windows | **BLOCKER** | No hubo sesión tras dos HTTP 401; no se creó invitación ni se ejecutó el agente. |
| A2 — Aislamiento LAN | **BLOCKER** | No se consultaron entornos en v2; fixtures y gate F06 pendientes. Sin prueba de tráfico. |
| A3 — Split-tunnel | **BLOCKER** | No se repitió por detención de autenticación; evidencia previa muestra interfaces OpenVPN desconectadas y sin rutas VPN. |
| A4 — Fallo parcial | **BLOCKER** | No se verificó Beta ni se suspendió Alpha. |
| A5 — Reinicio de estado | **BLOCKER** | No se pudo verificar dispositivo; no se reinició `nexo.service`. |

## A0 — resultado y causa

SSM de solo lectura terminó `Success` (command ID `e3e4105c-7ef2-473e-a290-a5eb24024024`). EC2 está `running`; `nexo-node-agent.service` está `inactive` y `disabled`; el binario está presente, pero falta `/var/lib/nexo-node/identity/state.json`, que el unit file exige mediante `ConditionPathExists`. `ip_forward` sigue en `0`. La consulta de entornos ejecutada bajo `nexo_runtime` devolvió cero filas, pero no se considera inventario global porque RLS puede filtrar el resultado.

No se inició el agente: sin identidad, systemd no lo ejecutaría y, con identidad válida, el reconciliador privilegiado podría aplicar estados VPN persistidos. No se modificó forwarding: es un cambio global, F06 exige precondiciones/retorno y el literal `=1d` del prompt está malformado. Detalle: [A0-prerequisites.md](A0-prerequisites.md).

## Autenticación y punto de detención

- Se hicieron dos intentos de `POST /v1/auth/login` con la credencial de laboratorio proporcionada, separados por el intervalo solicitado; ambos respondieron **HTTP 401**. El segundo reportó el código `unauthorized`.
- No se obtuvo challenge, por lo que no se envió TOTP ni se seleccionó ámbito. No se hicieron más intentos ni llamadas autenticadas.
- Se detuvieron las historias restantes según el caso de detención total definido en v2. Las evidencias de v1 se conservan como observaciones previas; A3 no se volvió a probar en v2.

## Contratos y errores del prompt corregidos antes de ejecución

- La invitación de endpoint usa `POST /v1/company/device-invitations` en ámbito de empresa y `device_kind: "endpoint"`; `"windows"` no está admitido.
- `POST /v1/session/select` consume la selección. Para elegir Alpha se requiere un nuevo ciclo de autenticación y `tenant_id`; la misma selección no sirve primero para provider y luego para tenant.
- `POST /v1/provider/vpn-environments` requiere también `protocol` y `listener_port`; el JSON del prompt no los incluye.
- El código no define `GET /v1/company/agents/:id`; existe el listado y la ruta de aprobación. El cliente Go no ofrece flag `--insecure` y usa la validación TLS estándar, por lo que el certificado self-signed requiere confianza configurada.
- El plan F06 declara `acceptance` no listo hasta cerrar fixtures efímeros, cleanup reanudable, respaldo/retorno y revisión/pruebas del runner. La ejecución v2 no anuló ese gate.

## Bloqueantes y acciones recomendadas

1. **Autenticación 401 dos veces:** validar por canal seguro que la cuenta y la credencial sean vigentes; reanudar solo con autorización, sin incluir secretos en evidencias.
2. **A0 sin identidad de nodo:** completar el enrolamiento/aprobación sintéticos del nodo y verificar su estado persistido antes de iniciar el servicio.
3. **Forwarding y gate F06:** preparar backup/retorno, fixtures y runner reanudable; habilitar forwarding únicamente con cambio de red aprobado y valor `1`.
4. **A1/A2/A4/A5:** una vez resueltos los anteriores, ejecutar con contratos corregidos y registrar/limpiar recursos exactos de prueba.
5. **A3:** repetir desde Windows con VPN activa, rutas visibles y mediciones egress concordantes.

**VEREDICTO GATE S3: OPEN.** No hay PASS. No se hicieron cambios de infraestructura, VPN o dispositivos; no quedaron recursos nuevos que limpiar. Los dos POST de login fallidos se registraron como autenticación y no produjeron sesión.

Evidencias: [A0](A0-prerequisites.md), [A1](A1-enrollment.md), [A2](A2-isolation.md), [A3](A3-routing.md), [A4](A4-partial-failure.md), [A5](A5-restart.md).
