# Evidencia F04 — capacidades comerciales

Fecha: 23 de octubre de 2026. Entorno local con Node.js 22, TypeScript 7.0.2, NestJS 12.2.0, Fastify 5.12.7 y PostgreSQL 17.6 en Docker.

## Resultados ejecutados

- `npm run verify:f04`: **PASS**, build y typecheck PASS; 5/5 casos de dominio, API e interfaz mínima.
- `npm run test:f04-postgres`: **PASS**. PostgreSQL, RLS, carrera por último cupo, módulos independientes, reducción con exceso, idempotencia y pagos manuales.
- `npm test`: **86/86 PASS** después de añadir la interfaz y endurecer la vigencia de suscripción.
- `npm run check`: **PASS**.
- `npm run test:l08-recovery`: **PASS** inicialmente con las migraciones 001–008 y nuevamente tras F05 con 001–009; restore en destino nuevo, roles/RLS y reconciliación de la brecha posterior al backup.
- `npm run test:runtime-grants`: **PASS** tras validar el SQL runtime sobre 9 migraciones; ownership `nexo_migration`, F04 y heartbeats permitidos, `DELETE` denegado.

## Casos demostrados

1. Dos reservas concurrentes compiten por el último cupo: exactamente una obtiene 200 y la otra 409.
2. Repetir la reserva ganadora devuelve `replayed: true` con el mismo consumo, sin incrementarlo otra vez.
3. Suspender VPN mantiene activa la suscripción, soporte y backup.
4. Reducir de tres endpoints a uno conserva `used=3`, expone `overLimit=true` y rechaza nuevas reservas.
5. Una excepción vigente eleva el límite efectivo sin alterar el límite base del plan.
6. Repetir un pago manual devuelve el mismo identificador; cambiar el importe con la misma clave es conflicto.
7. RLS permite al operador consultar la empresa asignada y devuelve 404 para otra empresa con suscripción existente.
8. La interfaz mínima contiene formularios etiquetados para plan, suscripción, módulo, excepción, pago y lectura de consumo.
9. Una suscripción activa con inicio futuro no admite reservas hasta que su vigencia comience.

## Puerta F04

La aceptación funcional F04 queda **PASS local**. No equivale a despliegue AWS ni a disponibilidad técnica de VPN, soporte o backup.

No se ejecutaron cambios AWS, migraciones remotas, commits ni push.
