# L03 — panel del proveedor y configuración del propietario

Estado: **corte local implementado y verificado**. No equivale a autorización productiva.

## Capacidades

- Contexto proveedor separado del contexto de empresa, emitido solo después de contraseña y MFA.
- Roles proveedor `owner`, `operator` y `auditor`; las mutaciones sensibles actuales requieren `owner`.
- Empresas, planes, módulos, cuotas, suscripciones versionadas y reservas atómicas.
- Configuración normal o referencia protegida. API/listados nunca devuelven `secret_ref`.
- Auditoría del proveedor separada de la auditoría tenant.
- UI mínima para listar/crear empresas y guardar configuración; no es todavía el diseño visual definitivo.

## Decisiones

- El proveedor no se representa como una empresa ficticia. Las sesiones llevan `scope_kind=provider|tenant` y el contexto proveedor no contiene `tenant_id`.
- Los límites de cuota provienen del plan/suscripción, no de la petición que reserva consumo.
- Reducir un límite no elimina recursos ni fuerza `used <= limit`; el exceso queda visible y bloquea nuevas reservas.
- AWS permanece como borrador/referencia. Guardar `aws.workload_role` no contacta AWS ni prueba credenciales.
- Secretos reales no se aceptan como valor normal. Este corte administra referencias; vault/KMS siguen como integración posterior.

## Archivos

- `db/migrations/002_l03_provider.sql`
- `product/api/provider-repository.ts`
- `product/api/postgres-provider-repository.ts`
- `tests/l03-provider.test.mjs`
- `scripts/l03.mjs`

## Límites

No hay pagos externos, AWS, motores VPN/soporte/backup ni clientes reales. La UI
no es una certificación de accesibilidad. Configuración avanzada, asignación de
operadores desde UI y reportes detallados de auditoría se ampliarán dentro del
panel antes de producción.
