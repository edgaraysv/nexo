# F04 — planes, servicios y cuotas

Estado: **corte local implementado y verificado**. No está desplegado en AWS ni autoriza producción.

## Capacidades

- Planes con módulos y cuotas base; suscripciones versionadas con estado y vigencia opcional.
- Estados independientes `active`/`suspended` para VPN, soporte y backup. Suspender un módulo no cambia la suscripción ni los demás módulos.
- Excepciones de cuota versionadas con inicio y fin opcionales.
- Reserva atómica de cuota e idempotencia por empresa, recurso y clave de solicitud; una suscripción fuera de vigencia no admite consumo nuevo.
- Reducción de plan conservadora: mantiene el consumo existente, marca `overLimit` y bloquea nuevas reservas; no elimina recursos ni reduce el contador.
- Pagos manuales inmutables e idempotentes por empresa, sin integración bancaria ni conciliación automática.
- Lectura consolidada de suscripción, módulos, cuotas, excesos y pagos mediante `GET /v1/provider/companies/:tenantId/commercial`.
- Interfaz mínima en `/provider/commercial` para contratación y consumo.
- RLS para módulos, excepciones, reservas y pagos. Un operador solo consulta empresas explícitamente asignadas; las mutaciones comerciales siguen reservadas al propietario.

## Contratos HTTP añadidos

- `GET /v1/provider/companies/:tenantId/commercial`
- `PUT /v1/provider/companies/:tenantId/modules/:module`
- `PUT /v1/provider/companies/:tenantId/quotas/:resource/exception`
- `POST /v1/provider/companies/:tenantId/quotas/:resource/reserve` acepta `idempotency_key`.
- `POST /v1/provider/companies/:tenantId/payments`

Repetir una reserva o un pago con la misma clave y el mismo contenido devuelve el resultado original. Reutilizarla con contenido diferente produce conflicto y no aplica un segundo efecto.

## Retorno

Los cambios comerciales se revierten mediante una nueva revisión de suscripción, módulo o excepción y posterior reconciliación. No se restaura globalmente la base ni se eliminan pagos o consumo histórico.

## Límites

- F04 representa autorización comercial. El estado técnico observado y la reconciliación con motores reales corresponden a F05/F06 y permanecen separados.
- No hay facturación, impuestos, pasarela, moneda múltiple por suscripción, reembolsos ni conciliación bancaria.
- Las revisiones vigentes se auditan, pero este corte no ofrece una API de historial comercial completa.
- El código y la migración `008_f04_commercial_capabilities.sql` no se aplicaron al laboratorio AWS.
- F02 y los pendientes granulares de F03 continúan abiertos de forma independiente.

## Verificación

```bash
npm run verify:f04
npm run test:f04-postgres
npm test
npm run check
```

Resultados: [evidence.md](evidence.md).
