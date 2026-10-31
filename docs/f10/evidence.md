# F10 — evidencia local

Fecha de corte: 31 de octubre de 2026. Las pruebas funcionales usan fixtures y motores sintéticos; no se usaron AWS, clientes, endpoints ni datos reales.

## Verificado

- `npm run typecheck`: PASS.
- `npm run build`: PASS.
- `npm test`: PASS, 139 pruebas.
- `npm run check`: PASS limpio (código de salida 0; sin advertencias ni errores). Pasaron las validaciones incluidas: sintaxis de scripts/pruebas, hashes de fuentes contra baseline, cobertura de trazabilidad (11 requisitos, 37 criterios y 114 entradas de catálogo), estructura del contrato experimental y presencia de entregables F01. El propio resultado delimita el contrato a validación estructural (`structural_not_full_openapi_certification`): no certifica OpenAPI completa ni aceptación del producto.
- `npm run test:runtime-grants`: PASS con PostgreSQL 17.6 desechable; 21 migraciones, 60 tablas, ownership, least-privilege, allowlist de DELETE y RLS forzado verificados.
- `npm run test:f10-postgres`: PASS con PostgreSQL 17.6 en contenedor Docker efímero, puerto publicado solo en `127.0.0.1` y contenedor retirado al terminar.
- El fixture PostgreSQL aplicó `f09-local` con 020, insertó filas legadas pending/accepted y luego ejecutó `f10-local`; 021 se aplicó sin reescribir 020 y el runner verificó los checksums del historial. El pending legado quedó `rejected`/`migration_021`; el accepted legado quedó registrado como `legacy_api` y no satisface el gate actual `endpoint_api`.
- El mismo fixture verificó el rol runtime y RLS: el nonce anterior dejó de ser válido al emitir uno nuevo, el nonce vigente se consumió una sola vez y en PostgreSQL solo quedó `nonce_hash`; el runtime sin contexto empresarial no leyó la sesión.
- El motor sintético confirmó retry de fallo definitivo de `open()` (misma sesión y clave, dos intentos), terminación persistente tras un primer fallo y cierre por worker. También se probó revocación durante una apertura: el gate se cerró, la terminación quedó en outbox y se confirmó después de que el motor informara la sesión.
- Pruebas API en memoria cubren denegaciones por rol/grant/vigencia/endpoint/entitlement, nonce inválido y replay, rechazo, timeout atómico lógico, consentimiento independiente del historial de sesión, `open_failed` tras tres intentos, reconciliación de resultado ambiguo y bloqueo de `opening_unknown`.
- El servidor normal no inyecta transporte: `/open` responde `support_transport_disabled`. El endpoint de autorización sigue informando `transport_started:false`. Los identificadores internos del motor no se devuelven en respuestas API.

## No probado / bloqueado

- Prompt nativo y acción humana: no existe integración; `endpoint_api` acredita la identidad del dispositivo, no una decisión humana frente a un prompt.
- Transporte real, proveedor remoto, E2E de cliente, acciones post-cierre y SLA remoto de terminación ≤5 s: NOT RUN.
- Despliegue AWS, piloto, producción, clientes y datos reales: excluidos. La evidencia local no cambia el NO-GO de preparación para producción.
- `open_failed` y `opening_unknown` tienen reglas locales comprobadas, pero requieren un transporte concreto con semántica de idempotencia/conciliación comprobada antes de habilitar cualquier apertura real.
