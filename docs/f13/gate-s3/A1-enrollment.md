# F13-A1 — Enrollment Windows

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **Lab:** cuenta `423597267645`, región `us-east-1`, EC2 `i-006cda6fdc86af7a5`, IP observada `3.226.252.132`

## Evidencia

- Se encontró `product/agent/bin/nexo-agent.exe`, binario PE32+ x86-64; SHA-256 `48eaa85d0f36299af391aa591363cd9e441e9d96976c6ea01e6a571167cd694e`.
- El CLI local documenta `enroll <base-url> <state-dir> <token> <name>`; no usa los flags `--token`/`--server` del prompt.
- El contrato local define la invitación en `POST /v1/company/device-invitations` (contexto de empresa; `device_kind`, `uses` opcional y `site_id` opcional), consulta de agentes en `GET /v1/company/agents` y aprobación en `POST /v1/company/agents/:id/approve`. El inventario de proveedor es `GET /v1/provider/companies/:tenantId/inventory`; no existe la ruta `/devices` indicada en el prompt.
- El único intento de login del proveedor respondió **HTTP 401**. No se reintentó para evitar agotar el límite de intentos. No se escribieron valores secretos en archivos/evidencias ni se imprimieron; no se obtuvo selección ni token.
- No se creó invitación, no se ejecutó el agente y no se aprobó ningún dispositivo. No hay `device_id` ni estado `ENROLLED` que reportar.

## Bloqueantes y acción recomendada

1. **Autenticación rechazada (HTTP 401):** no fue posible obtener una sesión autenticada para consultar Alpha. Validar la credencial del lab por un canal aprobado y reanudar con un único intento controlado.
2. **Gate mutante F06 aún abierto:** `docs/f06/aws-validation-plan.md` mantiene la aceptación bloqueada hasta completar y revisar fixtures, cleanup reanudable y prerrequisitos. No se creó una invitación ni una identidad persistente mientras el gate no esté resuelto.
3. **Acción recomendada:** resolver ambos bloqueos; después ejecutar el flujo con los endpoints y la sintaxis CLI verificados, usando un endpoint Windows sintético autorizado y registrando la limpieza de cualquier identidad creada.

## Actualización F13-A v2

- El segundo intento de login, realizado tras el intervalo indicado, también respondió **HTTP 401** (`unauthorized`). No se obtuvo challenge; no se envió MFA y no se creó sesión.
- Se alcanzó el límite de dos intentos indicado por v2; se detuvieron las acciones autenticadas restantes. No se creó invitación ni se ejecutó el agente.
- El prerrequisito común A0 quedó bloqueado porque la identidad del nodo falta en EC2; detalle en [A0](A0-prerequisites.md).
