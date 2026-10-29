# L04 — portal empresarial, sedes, usuarios y políticas

Estado: **corte local implementado y verificado**. No equivale a autorización productiva.

## Capacidades

- Portal empresarial separado en `/company`, con selección explícita de empresa después de contraseña y MFA.
- Resumen tenant-scoped de sedes, dispositivos declarados, usuarios y políticas activas.
- Sedes con una o más redes CIDR privadas IPv4/IPv6; se rechazan redes públicas y solapamientos dentro de la empresa.
- Inventario declarado de dispositivos asociado opcionalmente a una sede de la misma empresa.
- Listado de usuarios e invitaciones opacas de 24 horas, ligadas al correo autenticado y consumibles una sola vez.
- Roles empresariales `company.admin`, `company.technician` y `company.viewer`.
- Políticas `allow`/`deny` con estado, vigencia opcional, revisión optimista y rechazo de escrituras obsoletas.
- Persistencia PostgreSQL con RLS forzada en todas las tablas L04 y auditoría tenant existente.

## Decisiones y límites

- `tenant_id` nunca se toma del cuerpo o de parámetros del cliente como autoridad; procede de la sesión tenant validada.
- Solo `company.admin` modifica recursos en este corte. Técnicos y lectores pueden consultar el portal.
- La reducción o ampliación futura de permisos debe realizarse mediante permisos de servidor, no ocultando controles en UI.
- Las invitaciones L04 incorporan cuentas NEXO ya autenticadas. El alta completa de una persona nueva, entrega real de correo y enrolamiento MFA quedan para una fase posterior.
- Los dispositivos son inventario declarado: todavía no contienen claves, certificados ni credenciales persistentes.
- La revisión de políticas usa control de concurrencia; no se implementó aún un motor de ejecución de políticas ni un historial inmutable de cada revisión.
- La UI es mínima y reversible; el framework visual definitivo sigue sin seleccionarse.

## Archivos principales

- `db/migrations/003_l04_company_portal.sql`
- `product/api/company-repository.ts`
- `product/api/postgres-company-repository.ts`
- `product/api/network.ts`
- `tests/l04-company.test.mjs`
- `scripts/l04-postgres.mjs`

## Comandos

```sh
npm run verify:l04
npm run test:l04-postgres
npm test
```
