# D06 — cliente Windows, IPC y empaquetado

Estado: **aceptada por el usuario para L07 el 22 de octubre de 2026**.

## Decisión

- Servicio endpoint en **Go**, independiente del ciclo de vida de la interfaz.
- Interfaz de escritorio **Tauri 2 + React/TypeScript**; no contiene ni lee la clave privada.
- IPC Windows mediante named pipe versionado, con framing acotado, allowlist de acciones y ACL para `SYSTEM` y el SID autorizado.
- La URL de control y la ubicación de estado pertenecen a la configuración del servicio; la UI no puede suministrar URLs, rutas ni comandos arbitrarios.
- Tauri expone un único comando local de transporte IPC y no habilita acceso remoto ni plugins de shell, filesystem o HTTP.
- Instalador, servicio SCM, firma de binarios y actualización se validan en Windows real antes de aceptar L07.

## Límites

- Un administrador local o un proceso comprometido bajo el principal autorizado puede superar el límite del IPC; no se promete aislamiento frente a control total del host.
- La ACL identifica al principal de Windows, no a una persona autenticada en NEXO.
- VPN, soporte remoto y backup comercial siguen sin motor; la UI solo puede mostrar estados honestos.
