# F05 — operaciones asíncronas y agente de nodo

Estado: **corte local implementado y verificado**. TypeScript, PostgreSQL y Go aprobaron en local. No se desplegó en AWS.

## Mapa sobre L05/L06

| Criterio F05 | Base reutilizada | Brecha cerrada en F05 |
|---|---|---|
| Registro autenticado del nodo | Invitación, prueba P-256, certificado, sesión y audiencia `node` de L06 | Se conserva sin compartir credenciales endpoint |
| Outbox, workers y tipos | Outbox transaccional y `runtime_info` allowlisted de L06 | Worker separado `start:worker`, ciclos acotados y backoff |
| Idempotencia, revisión, expiración y ACK | Clave idempotente, expiración y resultado persistido de L06 | Revisiones monotónicas, conflicto por reutilización distinta y ACK ligado a revisión/contenido |
| Reintentos y reconciliación | Redelivery de operaciones `ready` y caché local del agente | Expiración de pendientes, reparación de outbox faltante y recuperación tras reinicio del worker |
| Vista de operaciones y errores | Listado empresarial de L06 | Respuesta con revisión, intentos de entrega y `errorCode` saneado |
| Desconexiones | Polling y resultado local previo al ACK de L06 | Contrato explícito descrito abajo |

## Contrato de desconexión

- **API caída:** el worker accede directamente a PostgreSQL y puede publicar operaciones ya confirmadas. No crea operaciones nuevas ni omite autorización.
- **Worker caído:** operación y outbox permanecen `queued`; al reiniciar, otro ciclo reclama con `FOR UPDATE SKIP LOCKED`. Una transacción interrumpida no deja entrega parcial confirmada.
- **Agente o red caídos:** la operación `ready` se entrega de nuevo hasta recibir un ACK válido o vencer. El agente guarda el resultado antes del ACK y reutiliza ese resultado para el mismo ID/revisión.
- **Operación vencida:** reconciliación o lectura del agente la marca `expired`; no se ejecuta ni acepta ACK posterior.
- **ACK repetido:** solo es éxito si revisión, estado, resultado y hora observada coinciden con lo almacenado. Un ACK antiguo o divergente se rechaza.
- **Revisión antigua:** una nueva operación con revisión menor o igual a la última del destino se rechaza. La recuperación se expresa como una revisión posterior válida, nunca borrando historial.
- **Clave idempotente reutilizada:** devuelve la operación original solo si destino y revisión coinciden; si cambia el contenido devuelve conflicto.

## Superficie y límites

- Tipos permitidos: `endpoint.runtime_info.v1` y `node.runtime_info.v1`, ambos sin argumentos.
- No se aceptan shell, URL, ruta, comando, destino de red ni payload arbitrario.
- `npm run start:worker` inicia el worker separado; usa `nexo_runtime`, nunca `postgres`.
- F05 no aprovisiona VPN, soporte remoto ni backup. Esas operaciones se incorporarán solo como tipos cerrados en sus fases correspondientes.
- El sondeo del agente es de 30 segundos y el worker usa PostgreSQL como outbox; no hay broker, DLQ externa ni operación offline sensible.
- La migración `009_f05_operation_reliability.sql` y este código no se aplicaron al laboratorio AWS.

## Retorno

Detener el worker o dejar vencer la operación afectada y emitir una revisión posterior válida. No borrar operaciones, resultados ni auditoría y no restaurar globalmente la base.

## Verificación

```bash
npm run verify:f05
npm run test:f05-postgres
npm run test:runtime-grants
```

Resultados: [evidence.md](evidence.md).
