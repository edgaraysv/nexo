# Historial y runner de migraciones PostgreSQL

`npm run db:migrate -- --profile <perfil>` aplica secuencialmente migraciones numeradas y registra el SHA-256 original de cada archivo en `public.nexo_schema_migrations`. Usa un advisory lock de PostgreSQL y envuelve cada archivo junto con su fila de historial en una transacción; el runner valida el checksum antes de omitir una migración ya aplicada. No modifica migraciones históricas y no tiene rollback automático.

## Perfiles explícitos

| Perfil | Secuencia | Destino permitido |
| --- | --- | --- |
| `f09-local` | `001–015 + 017` | Host loopback únicamente |
| `f09-lab` | `001–015 + 017` | Requiere `NEXO_MIGRATION_TARGET=lab` y `--confirm-lab` |
| `f08-local` | `001–016 + 017` | Host loopback únicamente; solo pruebas desechables |
| `ga01-local` | `001–015 + 017 + 018` | Host loopback únicamente; solo pruebas desechables |

**No existe perfil que aplique `016` o `018` al laboratorio AWS.** El `f09-lab` no adopta el esquema AWS existente: el ledger debe existir y el primer uso de `--initialize` solo acepta una base sin relaciones de aplicación. El esquema actual del laboratorio no tiene este historial; no ejecutar el runner allí ni crear un baseline retroactivo sin una comparación/adopción revisada y autorización específica.

## Uso local

En una base PostgreSQL vacía y desechable, defina `DATABASE_URL` con un host de loopback. Ejecute `--initialize` una sola vez para crear el ledger y aplicar el perfil:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo \
  npm run db:migrate -- --profile f09-local --initialize

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/nexo \
  npm run db:migrate -- --profile f09-local
```

`ga01-local` puede agregarse a esa base local F09 para ejercitar `018`. `f08-local` se usa en una base independiente, porque su `016` es incompatible con el perfil F09. CI verifica historial, reejecución, checksums y rechazo de mezcla de perfiles en PostgreSQL efímero.

Para inspeccionar sin conexión: `npm run db:migrate -- --profile f09-local --dry-run`. El runner no infiere URLs ni perfiles y nunca ejecuta `apply` de Terraform.
