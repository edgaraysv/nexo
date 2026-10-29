# L02 — registro de decisiones

## D02 — ORM y migraciones

**Resuelta provisionalmente:** SQL parametrizado mediante `pg`, sin ORM.

Motivo: el repositorio ya tiene `pg`, el dominio necesita observar consultas,
transacciones, locks y RLS, y no existe un ORM aprobado. Las migraciones viven
en `db/migrations/` y deben ejecutarse por un runner controlado. Adoptar un ORM
posteriormente requiere un spike de equivalencia que preserve SQL, restricciones,
RLS y pruebas de aislamiento.

## D02-RLS — aislamiento PostgreSQL

**Resuelta:** RLS obligatoria como segunda barrera. Las tablas tenant-scoped se
crean con `ENABLE` y `FORCE ROW LEVEL SECURITY`. `withTenantTransaction` fija
`app.tenant_id` y `app.user_id` con `set_config(..., true)` dentro de la
transacción; el pool no conserva contexto entre solicitudes.

La autorización de aplicación sigue siendo obligatoria. RLS no reemplaza
permisos, membresías ni controles de colas, archivos y exportaciones. El rol de
runtime debe ser independiente del owner y no tener `BYPASSRLS`.

## D03 — identidad humana y MFA

**Resuelta para laboratorio local:** usuario/contraseña con hash scrypt y TOTP
para MFA. Administradores y técnicos deben tener MFA en el modelo. Recuperación
usa token aleatorio de un solo uso almacenado como hash.

Pendiente antes de datos reales: política exacta de administrador único,
reemplazo de factor, custodia del secreto TOTP, rate limit, notificaciones y
adaptador de entrega. No se permite usar recuperación como bypass de MFA.

## D01 — UI del primer corte

**Resuelta para L02:** HTML semántico y JavaScript mínimo servido por la misma
aplicación, sin fijar todavía un framework visual. Incluye etiquetas, foco al
paso MFA, `aria-live`, autocomplete apropiado y selector de empresa posterior a
MFA. Esta elección es deliberadamente reversible antes de L03; no aprueba una
librería de panel ni certifica accesibilidad.

## D04 — persistencia y secretos

El esquema separa usuarios, membresías, roles, permisos, sesiones, factores,
recuperación y auditoría. Los hashes y tokens no son reversibles. El secreto
TOTP se representa como `secret_ciphertext` y se sella localmente con AES-256-GCM
usando una clave de 32 bytes inyectada al servicio. La clave no se guarda en la
base; D04 sigue bloqueando el almacenamiento productivo de secretos hasta definir
custodia, rotación y restore en cuarentena.

## Criterios de cierre del subcorte

PASS requiere compilación, hash/verificación de contraseña, TOTP válido/inválido,
sellado/tamper detection, tokens opacos, migración con RLS forzada y ausencia de
creación de roles bypass.
El recorrido local login/API/UI/PostgreSQL se ejecuta en un contenedor privado
desechable. Proveedores externos, producción, clientes reales y AWS quedan
`NOT RUN`.
