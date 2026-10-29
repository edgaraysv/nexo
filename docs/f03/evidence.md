# Evidencia F03 — autorización empresarial inicial

Fecha: 23 de octubre de 2026. Entorno local con Node.js 22, TypeScript 7.0.2, NestJS 12.2.0, Fastify 5.12.7 y PostgreSQL 17.6 en Docker.

## Resultados

- `npm run verify:f03`: **PASS**. Build y typecheck PASS; **4/4 pruebas** de permisos efectivos, enforcement API, cambio de tenant y protección del último administrador.
- `npm run test:f03-postgres`: **PASS**. PostgreSQL real, RLS, roles administrador/técnico/auditor, autorización por acción y auditoría tenant-scoped.
- `npm test`: **81/81 PASS**.
- `npm run test:l04-postgres`: primer intento **FAIL de fixture**. La membresía de empresa B no tenía rol y el nuevo deny-by-default devolvió 403, por lo que el test esperaba una colección inexistente. Se asignó explícitamente `company.auditor` al fixture; repetición **PASS** con flujo empresarial, invitaciones y RLS.
- `npm run test:l05-postgres`: **PASS** para L05/L06, incluido agente Go, prueba de posesión, X.509, renovación, operaciones tipadas, heartbeat, revocación e identidad de nodo separada.
- `npm run check`: **PASS**.
- SQL de roles runtime probado con las siete migraciones: 43 tablas propiedad de `nexo_migration`, SELECT en 40, INSERT en 37, DELETE en 0 y SELECT/INSERT explícitos sobre `role_permissions`.

Una comprobación auxiliar inicial de esa matriz SQL falló antes de crear el contenedor por un error de sintaxis en el comando Node ad hoc. La repetición corregida produjo los resultados anteriores. Un intento posterior de `test:f03-postgres` también abortó antes de migrar porque `pg_isready` se adelantó a la disponibilidad efectiva del socket; el runner ahora exige dos consultas `psql` consecutivas y la repetición fue PASS. Ninguno de esos intentos se presenta como prueba funcional.

## Casos demostrados

1. Administrador recibe los 17 permisos registrados.
2. Técnico puede declarar dispositivos y crear operaciones tipadas, pero recibe 403 al crear sedes, invitar personas o consultar auditoría.
3. Auditor puede consultar inventario y auditoría, pero recibe 403 al mutar dispositivos.
4. Cambiar de empresa revoca el token anterior y la nueva sesión no conserva recursos de la empresa previa.
5. RLS impide que una sesión de empresa B liste recursos o eventos de empresa A.
6. Una membresía activa sin permisos efectivos queda denegada por defecto.
7. Solo un administrador puede cambiar el rol fijo de una membresía y el último administrador activo no puede degradarse. Una carrera PostgreSQL que intentó degradar simultáneamente a los dos administradores terminó con una operación aceptada y otra `last_admin`, conservando uno.

## Evaluación de puerta

**PV01 local: PASS parcial para las superficies empresariales habilitadas y probadas.** No equivale a aprobación productiva ni cubre superficies aún inexistentes como búsqueda, exportación y tareas. F03 permanece abierta por alcance granular por instancia/grupo/vigencia y pruebas restantes. F02/PV12 siguen abiertos de forma independiente.

No se ejecutaron AWS, migraciones remotas, commits ni push.
