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

`f10-local` es solo para probar el esquema de consentimiento y ciclo de vida F10 en PostgreSQL local desechable. La migración 020 es el corte inicial y 021 lo evoluciona sin reescribirlo; 021 no se incluye en ningún perfil de laboratorio o despliegue. Ninguna de las dos se aplica a AWS ni a otro entorno persistente. La decisión autenticada por API no sustituye el prompt nativo; el servidor no configura un motor de transporte.

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

Para inspeccionar sin conexión: `npm run db:migrate -- --profile f09-local --dry-run`. El runner no infiere URLs ni perfiles y nunca ejecuta `apply` de Terraform.
