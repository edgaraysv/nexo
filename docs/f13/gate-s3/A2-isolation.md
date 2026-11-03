# F13-A2 — Aislamiento LAN Alpha / Beta

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **Lab:** EC2 `i-006cda6fdc86af7a5`, `us-east-1`, IP `3.226.252.132`

## Evidencia

- La ruta de lectura de entornos en el código es `GET /v1/provider/vpn-environments`; no se pudo consultar sin sesión de proveedor (login respondió HTTP 401).
- El inventario remoto de solo lectura por SSM terminó `Success` (command ID `e1a19067-99df-452a-a923-d93548703960`). Observó Amazon Linux 2023, TUN disponible, cgroup v2, PostgreSQL y `nexo.service` activos, y las dos tablas de migración F06 presentes.
- El mismo inventario observó `net.ipv4.ip_forward=0`, `nexo-node-agent.service` `inactive`, ninguna salida de `ip netns list`, `nft list tables` ni unidades `nexo-vpn-*.service`.
- No se crearon entornos, no se aprovisionó Beta y no se ejecutó ping. No se verificaron IDs/CIDR/estado de Alpha y Beta.
- La especificación F06 advierte que namespaces o pools iguales no bastan para demostrar aislamiento: PV15 requiere clientes/gateways y destinos sintéticos homónimos, pruebas de conectividad, rutas y ausencia de respuesta cruzada.

## Bloqueantes y acción recomendada

1. **Autenticación rechazada (HTTP 401):** impide identificar los entornos y dispositivos de Alpha/Beta. Validar el acceso del lab sin reutilizar ni registrar secretos.
2. **Plano VPN sin condiciones operativas observables:** forwarding IPv4 deshabilitado, agente de nodo inactivo y cero namespaces/unidades VPN NEXO en el inventario. No hay un par activo sobre el que probar aislamiento.
3. **Gate F06 y fixtures pendientes:** la aceptación sigue declarada `ready: false`; no crear el entorno Beta ni cambiar red hasta cerrar los prerrequisitos y revisar el runner/cleanup.
4. **Acción recomendada:** habilitar y verificar el plano de prueba mediante un procedimiento aprobado, preparar fixtures sintéticos Alpha/Beta con cleanup exacto, y probar tráfico entre destinos; no aprobar aislamiento solo con inspección de namespaces.

## Actualización F13-A v2

- El segundo intento de login respondió **HTTP 401** (`unauthorized`); no se obtuvieron entornos Alpha/Beta. Conforme a v2, se detuvieron las acciones que dependían de autenticación.
- No se inició el agente de nodo ni se cambió forwarding: falta `/var/lib/nexo-node/identity/state.json` y el gate F06 sigue sin sus prerrequisitos. Véase [A0](A0-prerequisites.md).
- No se crearon entornos ni se ejecutó una prueba de tráfico.
