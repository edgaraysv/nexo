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

**PV01 local al 23 de octubre: PASS parcial para las superficies empresariales habilitadas y probadas.** En esa fecha aún no existían búsqueda, exportación ni reportes; F09 añadió después parte de esa cobertura, según la actualización siguiente. En esa fecha F03 permanecía abierta por alcance granular por instancia/grupo/vigencia y pruebas restantes. F02/PV12 siguen abiertos de forma independiente.

No se ejecutaron AWS, migraciones remotas, commits ni push.

## Actualización de cobertura tras F09 — 29 de octubre de 2026

La nota del 23 de octubre sobre búsqueda, exportación y reportes describe el estado de esa fecha; F09 incorporó después estas superficies. En esta sesión:

- `npm run build`: **PASS**.
- `node --test tests/f03-authorization.test.mjs tests/f09-reporting.test.mjs`: **PASS, 8/8**. Los fixtures verifican permisos empresariales, el alcance tenant de auditoría/inventario del proveedor, denegación de empresas no asignadas, filtros/paginación de reportes y exportación CSV mediante grant explícito, permiso de lectura del dataset y revocación.
- `npm run test:f03-postgres`: **BLOCKED** antes de crear el contenedor porque `docker` no está disponible en esta distribución WSL. No se ejecutó una prueba PostgreSQL en este corte; el PASS del 23 de octubre es evidencia histórica, no repetida.

Esta regresión cubre el alcance actual de empresa/asignación, no permisos por instancia, grupo o vigencia. Tampoco demuestra un filtro de búsqueda aislado contra IDs fuera de alcance ni completa la matriz PostgreSQL de PV01.

### Decisión de cierre local — estado histórico al 29 de octubre

El responsable de producto autorizó entonces cerrar F03 **solo bajo el modelo de roles fijos**. La granularidad por instancia, grupo y vigencia se difería a una etapa posterior dependiente de F10; `resource_grants` quedaba fuera de ese corte. Esta decisión fue reemplazada por la autorización posterior registrada abajo.

## Actualización — grants por recurso autorizados y cierre local, 30 de octubre de 2026

La autorización de trabajo más reciente reemplaza el diferimiento de grants anterior. `019_f03_resource_grants.sql` y el servidor añaden grants directos por tenant, usuario, dispositivo declarado/identidad de endpoint, permiso y vigencia. La API permite que el administrador del tenant liste recursos grantables, cree/reemplace grants y los revoque; la revocación cambia el estado y deja auditoría. No hay permiso implícito por ser `company.admin`.

### Evidencia de código y pruebas sintéticas

- `npm run build`: **PASS**.
- `node --test tests/f03-authorization.test.mjs`: **PASS, 6/6**. Cubre ausencia de grants por defecto, aislamiento entre recursos y tenants, manager solo administrador, acción no incluida en el rol, vencimiento, revocación/regrant y denegación tras perder el permiso de rol.
- `node --test tests/f03-authorization.test.mjs tests/l05-device-identity.test.mjs tests/l06-operations.test.mjs tests/f08-private-networks.test.mjs tests/f09-reporting.test.mjs tests/migration-runner.test.mjs`: **PASS, 26/26** tras compilar el código actual. La suite existente usa repositorios en memoria; no se presenta como 26 pruebas respaldadas por PostgreSQL. La prueba estática de migración inspecciona transacción/FK/RLS, no ejecuta SQL.
- `npm run check`: **PASS** para los gates locales de trazabilidad y contrato experimental.
- `npm run verify:f03`: un intento **TIMEOUT** anterior, al límite de 120 s y tras emitir 5 de 6 resultados; no se toma como PASS. La suite F03 se ejecutó directamente y completó **6/6 PASS**.

### PostgreSQL 17.6 y capa HTTP real

- Se descargó el release oficial `postgresql-17.6.tar.bz2` y se verificó su SHA-256 publicado (`e0630a…cd7a8b0`). PostgreSQL y sus herramientas se compilaron en un directorio privado bajo `/tmp`; no se instalaron paquetes del sistema ni servicios.
- Clúster temporal con `initdb` y `pg_ctl`, escuchando solo en `127.0.0.1` y con socket dentro del directorio temporal. Las migraciones 001–006 y 007 se aplicaron solo como prerrequisitos de esquema/roles; después `019_f03_resource_grants.sql` aplicó sin errores (**PASS**) en PostgreSQL 17.6 real.
- La tabla y sus políticas tienen RLS habilitado y forzado. Con el rol runtime `nexo_l02_runtime` (`NOBYPASSRLS`), tenant A obtuvo exactamente su fila de `resource_grants`; la fila de tenant B no fue visible (**PASS**). `db/tests/l02_rls.sql` también pasó contra ambos tenants.
- Con `PostgresCompanyRepository` y `PostgresDeviceRepository` conectados al mismo PostgreSQL 17.6 y la API Fastify real, aprobar un endpoint con grant activo devolvió **204**; sin grant, con grant vencido y con grant revocado devolvió **403** en el servidor (**PASS**).
- Limpieza verificada: `pg_ctl stop` terminó el servidor; `pg_ctl status` confirmó detenido; no quedaron procesos `postgres`, listener TCP ni sockets Unix; se eliminó el directorio temporal completo (**PASS**).

### Decisión

**F03 local CERRADO** para el corte autorizado: migración 019 aplicada en PostgreSQL 17.6, aislamiento RLS, denegación HTTP por grant vencido/revocado y regresión 26/26 PASS. La evidencia real de PostgreSQL incluye RLS y la ruta HTTP de grants; la suite de 26 conserva fixtures en memoria, como se declara arriba. `scripts/f03-postgres.mjs` no se ejecutó porque depende de Docker; la verificación de este corte usó el servidor efímero nativo autorizado. No se ha aplicado la migración a AWS ni a otro entorno persistente. **F10 queda habilitada para comenzar**, sin que eso seleccione MeshCentral ni autorice piloto/producción. AWS, despliegue, commit y push: **NOT RUN**.
