# F13-A5 — Reinicio y reconstrucción de estado

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **Lab:** EC2 `i-006cda6fdc86af7a5`, IP `3.226.252.132`

## Evidencia

- Antes de cualquier cambio, el inventario SSM de solo lectura observó `nexo.service` y `postgresql.service` `active`; `nexo-node-agent.service` estaba `inactive`.
- No se pudo consultar el estado del dispositivo antes/después: el login del proveedor respondió HTTP 401. No hay `device_id` verificado para comparar identidad.
- **No se reinició** ningún servicio. El gate mutante F06 sigue abierto y no se dispone del estado autenticado de un dispositivo de prueba.
- `GET /health` devolvió HTTP 404 (`not_found`) y no se encontró una ruta health en `product/api/application.ts`; el estado `active` de systemd es la única comprobación de proceso disponible en esta ejecución.

## Bloqueantes y acción recomendada

1. **Autenticación rechazada (HTTP 401):** no se puede establecer el estado/identidad de referencia del dispositivo.
2. **Gate y evidencia de reconstrucción incompletos:** reiniciar sin identidad de prueba verificada no permite demostrar que el mismo dispositivo conserva estado `ENROLLED`.
3. **Health HTTP no disponible:** `/health` no está implementado en el código observado y responde 404.
4. **Acción recomendada:** resolver autenticación y gate; registrar el `device_id`/estado antes, reiniciar solo `nexo.service` por SSM y verificar el mismo registro después. Usar systemd como health check hasta que exista una ruta de salud documentada.

## Actualización F13-A v2

- El segundo login respondió **HTTP 401** (`unauthorized`); no se obtuvo estado de dispositivo. La condición de detención total de v2 se alcanzó antes de A5.
- No se reinició `nexo.service`; permanecen las observaciones de solo lectura documentadas arriba.
