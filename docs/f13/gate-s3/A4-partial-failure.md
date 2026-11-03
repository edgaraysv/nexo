# F13-A4 — Fallo parcial sin apertura de acceso cruzado

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **Lab:** EC2 `i-006cda6fdc86af7a5`, IP `3.226.252.132`

## Evidencia

- No se pudo consultar el estado observado de Beta ni la revisión deseada de Alpha: el login del proveedor respondió HTTP 401.
- El endpoint correcto para suspender un entorno, según `product/api/application.ts`, es `PUT /v1/provider/vpn-environments/:id/state` con `desired_state` y `expected_revision`; la ruta del prompt no existe.
- No se envió una solicitud de suspensión. El inventario remoto de solo lectura mostró forwarding IPv4 `0`, agente `nexo-node-agent` inactivo y ninguna unidad VPN NEXO, namespace o tabla nftables NEXO.
- No hay una medición de Beta antes/después ni de rutas posterior al fallo. No se ejecutó fallback de `killall`.

## Bloqueantes y acción recomendada

1. **Autenticación rechazada (HTTP 401):** impide comprobar que Beta está activo y obtener la revisión exacta de Alpha.
2. **Gate mutante F06 abierto y plano de datos no observado como activo:** suspender Alpha sin verificar Alpha/Beta activos podría alterar un entorno no identificado y no demostrar independencia.
3. **Acción recomendada:** cerrar el gate y validar ambas identidades/estados; luego suspender Alpha únicamente mediante el endpoint de estado con revisión esperada y comprobar Beta y routing antes/después.

## Actualización F13-A v2

- El segundo login respondió **HTTP 401** (`unauthorized`); no se consultaron estados tenant-scoped. Se detuvo el resto de la ejecución según la regla v2.
- Alpha no se suspendió ni restauró; no se creó ni modificó ningún entorno. El bloqueo de A0 consta en [A0](A0-prerequisites.md).
