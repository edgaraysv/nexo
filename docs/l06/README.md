# L06 — comunicación y operaciones API–agente

Estado: **corte local implementado y verificado**. No equivale a operación productiva, recuperación completa ni agente Windows instalado.

## Implementado

- Operación allowlisted `endpoint.runtime_info.v1`, sin argumentos, shell, URL ni destino arbitrario.
- Creación idempotente por empresa y clave; operación y outbox nacen en la misma transacción.
- Dispatcher PostgreSQL con `FOR UPDATE SKIP LOCKED`, lease, intentos y publicación segura para varios workers.
- Entrega al menos una vez: el endpoint vuelve a recibir la operación `ready` hasta confirmar resultado.
- Agente Go `run-once`: autentica, envía heartbeat, ejecuta únicamente el tipo compilado y guarda resultado local antes del ACK.
- Resultados con esquema cerrado (`os`, `arch`, `go_version`) y hora observada separada de la hora recibida.
- ACK/resultados idempotentes y estado visible en el portal empresarial.
- RLS para operaciones, outbox, resultados y heartbeats.
- Identidad de nodo proveedor separada: invitaciones, desafíos, certificados, sesiones, audiencia `node`, tablas y políticas RLS propias.
- Operación allowlisted `node.runtime_info.v1`, sin argumentos, ejecutada por el mismo binario Go bajo identidad de nodo y sin aceptar credenciales endpoint.
- Restore intermedio de un dump cifrado con AES-256-GCM en un PostgreSQL nuevo.
- Checkpoint HMAC externo al backup para detectar una época posterior, aplicar una revocación posterior y registrar una operación posterior ausente sin inventarla.
- Control restaurado en cuarentena; mientras siga activo bloquea sesiones humanas y autenticación/sesiones de endpoints y nodos.

## Límites honestos

- No hay daemon continuo, backoff/DLQ completo, broker, VPN, soporte remoto ni ejecución offline.
- `runtime_info` informa solamente runtime Go/OS/arquitectura; no acepta targets, rutas, comandos ni contenido libre.
- El checkpoint, la CA, las claves de cifrado y los certificados son fixtures locales desechables; custodia, rotación operativa y recuperación completa pertenecen a L08.
- La operación creada después del backup no se reconstruye: se registra como brecha en `security_reconciliation_events` y el control continúa en cuarentena.

AWS, producción, clientes/datos reales, VPN, servicio Windows instalado y desastre total del host permanecen **NOT RUN**.
