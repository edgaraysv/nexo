# L02 — identidad, seguridad y persistencia local

Estado: **corte local implementado y verificado**. No equivale a autorización productiva.

## Decisiones resueltas

- **ORM:** no se incorpora ORM en este corte. Se conserva `pg` con SQL/migraciones versionadas y consultas parametrizadas. La decisión es reversible sin cambiar el contrato de dominio.
- **Aislamiento:** PostgreSQL RLS es defensa adicional, con `FORCE ROW LEVEL SECURITY` y contexto transaccional `app.tenant_id`/`app.user_id`. También limita usuarios, factores MFA y recuperación al contexto autorizado. El servidor deriva el contexto de sesión/membresía; el navegador no lo establece.
- **Contraseñas:** `scrypt` con sal aleatoria y parámetros codificados; nunca texto plano.
- **MFA:** TOTP de seis dígitos con ventana acotada para la verificación local. El secreto TOTP se modela como ciphertext y requiere custodia D04 antes de producción.
- **Sesiones:** tokens opacos, almacenados como SHA-256, con expiración y revocación explícita.
- **Recuperación e invitaciones:** tokens opacos de un solo uso y expiración; el servidor usa un adaptador SMTP configurado por entorno. La entrega real permanece NOT RUN hasta configurar y validar un proveedor.

## Entregables

- `db/migrations/001_l02_identity.sql`: esquema, restricciones, índices y políticas RLS.
- `product/api/security.ts`: primitives de contraseña, tokens, TOTP y sellado AES-GCM del secreto TOTP.
- `product/api/`: API NestJS/Fastify separada de los spikes, repositorios en memoria/PostgreSQL y UI mínima de acceso.
- `tests/l02.test.mjs`: pruebas negativas y positivas del corte.
- `tests/l02-product.test.mjs`: login, MFA, selección/cambio de empresa, revocación, recuperación y UI.
- `scripts/l02-postgres.mjs`: migración y recorrido real sobre PostgreSQL desechable con rol runtime RLS.

## Límites y pendientes

Este corte no emite certificados, no usa AWS, no crea usuarios reales ni conecta
un proveedor externo de identidad. La UI es mínima y mantiene el bearer token
solo en memoria; no es todavía el panel L03. La custodia operativa de la clave
AES, configuración y prueba real de entrega SMTP, rate limiting distribuido y
revisión independiente siguen pendientes antes de producción/clientes reales.

El proveedor SMTP se configura con las variables documentadas en
[`notifications.md`](notifications.md). Sin esa configuración el servidor no
arranca, evitando que un despliegue use silenciosamente sinks no-op. Las pruebas
inyectan un transporte stub; no requieren credenciales ni envían correo real.

La migración debe ejecutarse con el propietario de esquema. El runtime requiere
un rol separado `NOSUPERUSER` y `NOBYPASSRLS`; no se crea automáticamente para
evitar asumir privilegios de PostgreSQL.

El sellado local requiere una clave de 32 bytes inyectada por el entorno del
servicio. No se guarda en la base ni se incluye en el repositorio; su custodia,
rotación, backup y recuperación siguen bloqueadas por D04.

## Recorrido verificado

Contraseña válida → desafío MFA → MFA válida → lista de membresías → selección
explícita de empresa → sesión opaca tenant-scoped → `/v1/me` → cambio de empresa
con revocación del token anterior → revocación. Recuperación responde igual para
correo conocido/desconocido, usa token de un solo uso, cambia el hash y revoca
sesiones existentes.

Las membresías no se entregan tras validar solo contraseña: se muestran después
de MFA. El `tenant_id` seleccionado se contrasta con las membresías del servidor.
