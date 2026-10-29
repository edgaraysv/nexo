# Evidencia L08

- Contrato unitario de bundle, alteración, clave incorrecta, generaciones y checkpoint: **PASS**, 3/3.
- `npm run test:l08-recovery`: **PASS** tras F05; restore en destino nuevo en 15.419 s frente al objetivo local de 600 s.
- PostgreSQL 17.6, nueve migraciones, rol sin superusuario/BYPASSRLS, aislamiento RLS, configuración y emisión: **PASS**.
- Revocación posterior reaplicada, sesiones cerradas, cuarentena y operación posterior ausente registrada: **PASS/RECORDED**.
- Pérdida total del host y custodia fuera del equipo: **NOT RUN** por decisión D07.
- `npm run verify:l08`: **PASS**, 6/6 pruebas L08, typecheck, Go test/vet, frontend y Tauri native check.
- `npm run test:l06-postgres`: **PASS**, PostgreSQL/RLS, endpoint/nodo, X.509, outbox, operación tipada, heartbeat y revocación.
- `npm run test:l07-flow`: **PASS** después de ejecutar el servicio sin `stdout`; enrollment, aprobación, claim, diagnóstico y resultado Windows.
- `npm test`: **PASS**, 89/89 pruebas de regresión en el corte F05.
- `npm run check`: **PASS**, 11 requisitos, 37 criterios de aceptación y 114 entradas de catálogo.
- `npm audit --omit=dev` en raíz y cliente: **PASS**, 0 vulnerabilidades reportadas.
- NSIS x64 regenerado con el agente corregido: **PASS**, 8.79 MiB.
- Limpieza final: **PASS**, sin contenedores L05–L08, servicio `NexoEndpoint`, usuarios temporales ni procesos de agente/cliente.

## Defecto detectado y corregido

El flujo de regresión encontró que enrollment/claim/run-once reutilizaban funciones CLI que escribían en `stdout`. Bajo SCM o un proceso sin consola, una operación ya persistida podía terminar reportada como error por un handle de salida inválido. La lógica del servicio ahora usa `io.Discard`; solo los comandos CLI escriben JSON. El harness L07 también rechaza un pipe ocupado y detiene por línea de comando únicamente el proceso que creó.

## Límites finales

Pérdida total del host, medio externo, PITR/WAL, carga productiva, SLA, HSM/WORM, custodia multipartita, actualización firmada productiva, AWS, producción y clientes reales: **NOT RUN**.
