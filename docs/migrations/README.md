# Historial y runner de migraciones PostgreSQL

`npm run db:migrate -- --profile <perfil>` aplica secuencialmente migraciones numeradas y registra el SHA-256 original de cada archivo en `public.nexo_schema_migrations`. Usa un advisory lock de PostgreSQL y envuelve cada archivo junto con su fila de historial en una transacción; el runner valida el checksum antes de omitir una migración ya aplicada. No modifica migraciones históricas y no tiene rollback automático.

## Perfiles explícitos

| Perfil | Secuencia | Destino permitido |
| --- | --- | --- |
| `f07-local` | `001–016 + 017 + 019 + 020` | Host loopback; base desechable exclusiva de la integración F07 |
| `f09-local` | `001–015 + 017 + 019 + 020` | Host loopback únicamente; base efímera/local desechable |
| `f09-lab` | `001–015 + 017` | Requiere `NEXO_MIGRATION_TARGET=lab` y `--confirm-lab` |
| `f08-local` | `001–016 + 017 + 019 + 020` | Host loopback únicamente; base efímera/local desechable |
| `ga01-local` | `001–015 + 017 + 018 + 019` | Host loopback únicamente; solo pruebas desechables |
| `f10-local` | `001–015 + 017 + 019 + 020 + 021` | Host loopback únicamente; base efímera/local desechable |

**No existe perfil que aplique `016` o `018` al laboratorio AWS.** El `f09-lab` no adopta el esquema AWS existente: el ledger debe existir y el primer uso de `--initialize` solo acepta una base sin relaciones de aplicación. El esquema actual del laboratorio no tiene este historial; no ejecutar el runner allí ni crear un baseline retroactivo sin una comparación/adopción revisada y autorización específica.

`f10-local` es solo para probar el esquema de consentimiento y ciclo de vida F10 en PostgreSQL local desechable. La migración 020 es el corte inicial y 021 lo evoluciona sin reescribirlo; no forman parte de un perfil de despliegue AWS. La decisión autenticada por API no sustituye el prompt nativo; el servidor no configura un motor de transporte. El 2026-11-01 se aplicaron manualmente 020 y 021 al PostgreSQL del AWS lab como excepción explícita; véase la evidencia inferior. Esto no acepta F10 ni habilita soporte remoto.

`f09-local` comparte la secuencia de `f10-local` porque el fixture PostgreSQL F09 aplica el SQL completo de grants runtime, que referencia `support_consent` y `support_sessions`. La migración 020 se incluye solo para cerrar ese esquema local de prueba; no amplía el alcance de F09 ni su despliegue. El perfil `f09-lab` permanece `001–015 + 017` y excluye 019/020.

`f07-local` es un perfil de integración dedicado y autónomo para el fixture PostgreSQL F07: combina la rotación de credenciales 016 con 020, ya que el SQL de grants runtime referencia las tablas de soporte. Se inicializa en una base desechable propia; no se compone con otros historiales ni se aplica a AWS. Esto no cambia el alcance ni la aceptación de F10.

`f08-local` conserva 016 después de 015 y añade 020 tras la secuencia F09 para cubrir las tablas citadas por los grants runtime. Su secuencia equivale a `f10-local` más 016; debe inicializarse en una base desechable independiente.

## Uso local

En una base PostgreSQL vacía y desechable, defina `DATABASE_URL` con un host de loopback. Ejecute `--initialize` una sola vez para crear el ledger y aplicar el perfil:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo_f09 \
  npm run db:migrate -- --profile f09-local --initialize

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo_f07 \
  npm run db:migrate -- --profile f07-local --initialize

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo_f10 \
  npm run db:migrate -- --profile f10-local --initialize

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo_f09 \
  npm run db:migrate -- --profile f09-local
```

`ga01-local` debe inicializarse en una base independiente para ejercitar `018`: su secuencia coloca esa migración antes de `019` y excluye `020`, por lo que no se agrega sobre `f09-local`. `f08-local`, `f07-local` y `f10-local` también se inicializan en bases independientes; `f07-local` y `f08-local` incluyen `016` y `020`. `f10-local` añade `021` a la secuencia de F09, solo en la base F10 desechable. Ningún perfil local se aplica a AWS. CI verifica historial, reejecución, checksums y rechazo de mezcla de perfiles en PostgreSQL efímero.

## Estado excepcional del PostgreSQL AWS lab — 2026-11-01

Por autorización explícita se aplicaron manualmente, en este orden, las migraciones `016`, `019`, `020`, `021` y `022` a la base `nexo` de la instancia `i-006cda6fdc86af7a5` (cuenta `423597267645`, región `us-east-1`) mediante SSM `AWS-RunShellScript`. Cada archivo se ejecutó individualmente en su propia transacción como `nexo_migration`; no se creó un ledger ni se escribieron archivos en el host. `017` ya estaba aplicada y `018` no se aplicó.

| Migración | SSM de aplicación | Verificación de solo lectura |
| --- | --- | --- |
| `016_f07_vpn_credential_rotation.sql` | `c7e542c3-4c8f-447a-b3a9-d4042686827d` | `vpn_client_credentials_active_key` y `vpn_client_credentials_history_idx` existen. El preflight de duplicados devolvió cero filas (`430c5e8f-1202-4a50-9fa3-eb14907e5d00`). |
| `019_f03_resource_grants.sql` | `1e6be1a9-64cf-40c4-9654-17134a31aa7b` | `resource_grants` y sus columnas existen (`8b8ed988-0d59-45b0-ab02-6650cbf8e499`). |
| `020_f10_support_consent.sql` | `844761c6-d3e5-4a13-8aec-b116b6dd6827` | `support_sessions` y `support_consent` y sus columnas iniciales existen (`186293c8-95d5-4751-b9e6-4baf65f9f596`). |
| `021_f10_support_lifecycle.sql` | `7d4a68f0-7d77-4419-b326-e99ddb043fb3` | Columnas normalizadas y `support_session_attempts`/`support_session_outbox` verificadas (`1ff63f68-011a-4a0e-98ad-f5ab3168cf00`). Sus tres sentencias `UPDATE` afectaron cero filas. |
| `022_f11_wireguard.sql` | `3f11f385-f82a-41f4-9392-08eb153d7077` | Las cuatro tablas `wireguard_*` y la restricción de motor que admite `openvpn` y `wireguard` verificadas (`432ee06f-ec86-41d5-b910-4bbbebc60457`). |

SHA-256 de los SQL aplicados: `016` `af9af34c8b99cb1631e49d561f0c6b2daa19f63daec60c73a515c3a7fdbb5964`; `019` `4472fd3dc20f3fcd2a055e35fed0114cb71d8b04d1287af5053d77d615df71c3`; `020` `59833098d8ed2acf4e518147377eee1e52612b91d11ca8e2f3d6ffbdbd02f08c`; `021` `e9e2185ef219ada57de0c12ed2d2a64c3dd27678add57ae0e64c8df2693cb193`; `022` `252ed7f0e4d6364958f1310119823cf20bda716cb153049a16bdb12ea9840e22`.

**Advertencia:** `public.nexo_schema_migrations` no existe en esta base. No ejecutar el runner contra ella ni usar `--initialize` hasta reconciliar primero el estado aplicado y definir cómo registrar el historial. Esta excepción de laboratorio no crea un perfil AWS soportado ni implica aceptación/despliegue funcional de F10 o F11.

Para inspeccionar sin conexión: `npm run db:migrate -- --profile f09-local --dry-run`. El runner no infiere URLs ni perfiles y nunca ejecuta `apply` de Terraform.
