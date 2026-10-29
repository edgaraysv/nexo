# Evidencia F05

Fecha: 23 de octubre de 2026. Entorno local; PostgreSQL 17.6 desechable en Docker.

## Resultados

- `npm run verify:f05`: **PASS**; build y typecheck, 6/6 pruebas F05/L06, pruebas Go y build del agente.
- `npm run test:f05-postgres`: **PASS** con rol `nexo_runtime`: reinicio del worker, worker independiente de API, redelivery, revisión antigua, conflicto idempotente, expiración y heartbeat de nodo.
- `npm run test:runtime-grants`: **PASS** sobre 9 migraciones y 47 tablas; ownership `nexo_migration`, RLS F04, grants de heartbeat y `DELETE` denegado.
- `npm run test:l06-postgres`: **PASS** tras la migración 009; agente Go real, identidades, certificados, outbox, redelivery, heartbeat y operaciones endpoint/nodo.
- `npm test`: **89/89 PASS**.
- `npm run check`: **PASS**.
- `npm run test:f04-postgres`: **PASS** como regresión comercial sobre las nueve migraciones.
- `npm run test:l08-recovery`: **PASS** sobre las nueve migraciones; restore en destino nuevo y brecha posterior al backup registrada.
- Go se ejecutó de forma desechable con `golang:1.26.3-bookworm` y descarga automática del toolchain 1.27.3 exigido por `go.mod`; no se instaló Go en el host.

## Escenarios demostrados

1. La misma operación puede entregarse varias veces antes del ACK y conserva ID/revisión.
2. Un resultado se persiste una sola vez; el ACK idéntico se acepta y uno divergente se rechaza.
3. Un ACK con revisión antigua se rechaza.
4. Reutilizar una clave idempotente con otra revisión produce conflicto.
5. Una revisión menor o igual a la última del destino se rechaza.
6. Una operación permanece pendiente durante la caída del worker y se recupera con un repositorio/pool nuevo.
7. El worker despacha directamente desde PostgreSQL sin una instancia API activa.
8. Una operación vencida se reconcilia a `expired` y deja de entregarse.
9. El tipo allowlisted y los esquemas cerrados de L06 siguen rechazando shell, argumentos, destinos y resultados arbitrarios.
10. La vista devuelve revisión, intentos y error saneado sin exponer excepciones internas.

## Aceptación

La evidencia PostgreSQL, TypeScript y Go deja **PV09 PASS local** para la superficie implementada: redelivery sin duplicar efectos, revisión/ACK vinculados y ausencia de shell arbitrario. No equivale a despliegue productivo ni a validar todavía operaciones VPN, soporte o backup.

AWS, producción, migraciones remotas, clientes/datos reales, commits y push: **NOT RUN**.
