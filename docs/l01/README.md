# L01 — decisiones mínimas, trazabilidad y base local

Estado: **implementado localmente; verificación estructural PASS**. La aceptación funcional de L02 y sus decisiones sensibles siguen pendientes.

## Alcance ejecutado

- Línea base exacta del catálogo administrable: 114 IDs, sin duplicados ni IDs inventados.
- Cobertura explícita de RF01–RF11, PV01–PV21 y UX01–UX16.
- Clasificación de cada requisito/parámetro como `local`, `posterior` o `fuera-prohibido`.
- Separación documental entre producto previsto y fixtures/laboratorios F01/F02.
- Registro de decisiones mínimas y puertas que bloquean L02.
- Validador reproducible: `npm run verify:l01`.

## Límites

Esta fase no implementa login, MFA, ORM, RLS, panel, agente, PKI, certificados,
AWS ni secretos. No genera credenciales y no ejecuta migraciones sobre datos
reales. Los resultados PASS de este validador son estructurales y documentales,
no aceptación funcional de PV/UX.

## Evidencia

El reporte se genera en `artifacts/l01/report.json` (ruta ignorada por Git).
La validación comprueba también los hashes de las fuentes preservadas mediante
`docs/f01/sources.json` y falla si se altera el catálogo sin actualizar la
decisión de trazabilidad de forma explícita.
