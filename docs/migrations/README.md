# Historial y runner de migraciones PostgreSQL

`npm run db:migrate -- --profile <perfil>` aplica secuencialmente migraciones numeradas y registra el SHA-256 original de cada archivo en `public.nexo_schema_migrations`. Usa un advisory lock de PostgreSQL y envuelve cada archivo junto con su fila de historial en una transacción; el runner valida el checksum antes de omitir una migración ya aplicada. No modifica migraciones históricas y no tiene rollback automático.

## Perfiles explícitos

| Perfil | Secuencia | Destino permitido |
| --- | --- | --- |
| `f07-local` | `001–016 + 017 + 019 + 020 + 022–027` | Host loopback; base desechable exclusiva de la integración F07 |
| `f09-local` | `001–015 + 017 + 019 + 020 + 022–027` | Host loopback únicamente; base efímera/local desechable |
| `f09-lab` | `001–015 + 017` | Requiere `NEXO_MIGRATION_TARGET=lab` y `--confirm-lab` |
| `f08-local` | `001–016 + 017 + 019 + 020 + 022–027` | Host loopback únicamente; base efímera/local desechable |
| `ga01-local` | `001–015 + 017 + 018 + 019 + 023 + 025–027` | Host loopback únicamente; solo pruebas desechables |
| `f10-local` | `001–015 + 017 + 019–027` | Host loopback únicamente; base efímera/local desechable |
| `f11-local` | `001–027`, estrictamente en orden | Host loopback únicamente; base efímera/local desechable |
| `production` | `001–027`, estrictamente en orden | Requiere `NEXO_MIGRATION_TARGET=production` y `--confirm-production`; `--initialize` exige base vacía |

**No existe perfil que aplique `016` o `018` al laboratorio AWS.** El `f09-lab` no adopta el esquema AWS existente: el ledger debe existir y el primer uso de `--initialize` solo acepta una base sin relaciones de aplicación. El esquema actual del laboratorio no tiene este historial; no ejecutar el runner allí ni crear un baseline retroactivo sin una comparación/adopción revisada y autorización específica.

El perfil `production` define el historial completo desde una base nueva: crea `public.nexo_schema_migrations` **antes** de `001`, y registra cada archivo y su SHA-256 en la misma transacción de esa migración. Rechaza bases no vacías sin historial, mezcla de perfiles, huecos y checksums divergentes. Toda ejecución requiere una `DATABASE_URL` explícita, `NEXO_MIGRATION_TARGET=production` y `--confirm-production`; no se infiere ni selecciona una conexión. `--dry-run` no requiere URL, no abre conexiones y enumera las migraciones/checksums del perfil.

`f10-local` es solo para probar el esquema de consentimiento y ciclo de vida F10 en PostgreSQL local desechable. La migración 020 es el corte inicial y 021 lo evoluciona sin reescribirlo; 023 corrige el grant runtime omitido por 019 y 024 concede privilegios mínimos a las tablas de soporte existentes. Ninguna forma parte de una secuencia de despliegue AWS implícita. La decisión autenticada por API no sustituye el prompt nativo; el servidor no configura un motor de transporte. El 2026-11-01 se aplicaron manualmente 020 y 021 al PostgreSQL del AWS lab como excepción explícita; véase la evidencia inferior. Esto no acepta F10 ni habilita soporte remoto.

`f09-local` incluye 020 porque el fixture PostgreSQL aplica el SQL completo de grants runtime, que referencia `support_consent` y `support_sessions`; incluye 022 porque el repositorio VPN usado por las pruebas consulta `wireguard_environment_config`; 023 repara el privilegio de `resource_grants` en bases que ya aplicaron 019; y 024 otorga privilegios a las tablas de soporte disponibles, tolerando que el perfil no incluya las tablas de ciclo de vida 021. Las migraciones 025–027 cierran el contrato F08/identidad vigente del fixture local. Esto no amplía el alcance de F09 ni su despliegue. El perfil `f09-lab` permanece `001–015 + 017` y excluye 019/020/022–027.

`f10-upgrade-seed-local` es un corte **solo de fixture** que termina en 020 para insertar filas heredadas antes de probar 021 y 023 mediante `f10-local`. No es un perfil operativo ni debe usarse fuera de ese ensayo.

`f07-local` es un perfil de integración dedicado y autónomo para el fixture PostgreSQL F07: combina la rotación de credenciales 016 con 020, ya que el SQL de grants runtime referencia las tablas de soporte, y añade 022–027 para el repositorio y contrato runtime vigente. Se inicializa en una base desechable propia; no se compone con otros historiales ni se aplica a AWS. Esto no cambia el alcance ni la aceptación de F10.

`f08-local` conserva 016 después de 015 y añade 020 para cubrir las tablas citadas por los grants runtime, además de 022/023 para las consultas VPN actuales y su privilegio runtime, 024 para las tablas de soporte existentes, 025 para ICMP echo, 026 para rotación de nodo y 027 para audiencia de gateway. Debe inicializarse en una base desechable independiente.

## Uso local

Para inspeccionar el perfil completo sin conexión:

```bash
npm run db:migrate -- --profile production --dry-run
```

La forma de inicializar una base de producción previamente provisionada y vacía es:

```bash
NEXO_MIGRATION_TARGET=production DATABASE_URL="$DATABASE_URL" \
  npm run db:migrate -- --profile production --initialize --confirm-production
```

La implementación del perfil se ejercita contra PostgreSQL desechable local, nunca AWS, mediante `npm run test:prod-migrate`. El ensayo solo crea un contenedor Docker de esta ejecución, publica PostgreSQL en loopback, verifica las 27 filas/checksums y elimina el contenedor etiquetado. No despliega ni ejecuta migraciones en una base real.

### Evidencia del perfil production — 2026-11-01

- `npm run db:migrate -- --profile production --dry-run`: **PASS**, enumeró `001–022` en orden con SHA-256 y sin `DATABASE_URL`.
- `npm run test:prod-migrate`: **PASS** sobre PostgreSQL `17.6-bookworm` en Docker local y puerto loopback. Base desechable vacía inicializada; ledger creado antes de las migraciones; 22/22 filas en orden con checksums íntegros; segunda ejecución omitió las 22 tras validar hashes; dry-run sin conexión y guardas de confirmación comprobadas.
- `tests/migration-runner.test.mjs`: una ejecución inicial **FAIL** por una aserción de fixture que todavía limitaba 016 a perfiles locales; se corrigió para incluir el perfil completo production. Reejecución final: **PASS, 13/13**.
- AWS: **NOT CONTACTED**. El ensayo no usó credenciales, SSM ni endpoints AWS; el contenedor de esta ejecución fue retirado.

### Corrección del GRANT runtime — 2026-11-03

- `019_f03_resource_grants.sql` se conserva sin cambios: crea `resource_grants`, pero no concede `SELECT`, `INSERT` ni `UPDATE` a `nexo_runtime`.
- `023_f03_resource_grants_runtime_privileges.sql` añade el grant forward-only y condicional a la existencia de `nexo_runtime`; no concede `DELETE`. Todos los perfiles operativos que aplican 019 y el perfil `production` incluyen 023. La única excepción es `f10-upgrade-seed-local`, un corte test-only que se detiene en 020 para probar el upgrade posterior.
- A0–A5 del gate S3: el operador reportó **PASS** en la EC2 `i-006cda6fdc86af7a5`, SSM `e0367f6c` (2026-11-03). Este resultado se registra como reportado, no verificado independientemente en esta ejecución.
- 023 es una corrección local pendiente de despliegue; no se aplicó SQL ni se hizo deploy remoto. La base AWS indicada más abajo carece de ledger, por lo que no se debe ejecutar allí el runner ni aplicar 023 sin reconciliar historial y contar con autorización específica.

Validación local de esta corrección:

- `node --test tests/migration-runner.test.mjs`: **PASS**, 15/15; perfiles que aplican 019 incluyen 023 y el checksum histórico de 019 sigue siendo `4472fd3dc20f3fcd2a055e35fed0114cb71d8b04d1287af5053d77d615df71c3`.
- `npm test`: **PASS**, 162/162; build TypeScript incluido.
- `npm run test:runtime-grants`: **PASS**, 22 archivos de migración en el fixture, 60 tablas; se verificó 023 antes del SQL centralizado: `SELECT/INSERT/UPDATE` presentes y `DELETE` ausente.
- `npm run test:prod-migrate`: **PASS**, perfil production 23/23 en PostgreSQL desechable; ledger, checksums, reejecución y dry-run verificados; AWS no contactado.
- Fixtures PostgreSQL F04–F11: **PASS**. F06/F07/F08/F09/F10 incluyen 022, que el repositorio VPN actual requiere para consultar la configuración WireGuard; F10 también comprueba la transición 020→021 desde un corte de fixture separado.
- SHA-256 de 023: `08e3a10677d3e0238c1c55462b5341e4af13c2d4ed45843f9ac906fefc4b1111`.

### Privilegios runtime de soporte — 2026-11-03

- `024_f10_support_runtime_privileges.sql` concede solo `SELECT`, `INSERT` y `UPDATE` a `nexo_runtime` sobre las tablas F10 que existan: `support_sessions`, `support_consent`, `support_session_attempts` y `support_session_outbox`. No concede `DELETE` ni modifica políticas/RLS.
- Los perfiles que incluyen 020 incorporan 024 después de 023, excepto `f10-upgrade-seed-local`, que es un corte histórico test-only. La migración verifica individualmente cada tabla para tolerar perfiles locales que aún no aplican 021.
- AWS: **NOT CONTACTED / NOT APPLIED**. No se desplegó la API ni se aplicó esta migración a la base del lab; allí falta reconciliar el historial antes de considerar cualquier SQL.
- `npm run test:runtime-grants`: **PASS**, 23 migraciones/60 tablas; comprobó que 024 otorga grants en `support_sessions`/`support_consent` aun cuando faltan las tablas creadas por 021, y después valida los cuatro grants, ausencia de `DELETE` y RLS.
- `npm run test:f10-postgres`: **PASS**, transición 020→021, backfill heredado, privilegios runtime/RLS y ciclo de vida sintético; transporte remoto real **NOT RUN**.
- `npm run test:prod-migrate`: **PASS**, secuencia production 24/24 en PostgreSQL Docker local con ledger/checksums, reejecución y dry-run; AWS no contactado.
- `npm test`: **PASS**, 165 pasaron, 1 omitida, 0 fallidas. `npm run typecheck`, `npm run build` y `npm run build:portal`: **PASS**; rutas `/admin`, `/admin/` y aliases verificadas contra los destinos React.
- SHA-256 de 024: `c9484d2aa0aebc10fb40ba98080b07185af85e77f595eca902fdbc0c6dc48aea`.
- Ninguna de estas pruebas aplicó la migración a AWS o desplegó la API; no implica cierre de C9, E4 ni las pruebas P1 de Windows/OpenVPN.

### Preparación F08 ICMP echo — 2026-11-07

- La nueva `025_f08_icmp_echo_policies.sql` permite únicamente ICMP echo request (tipo 8/código 0) con destino de recurso IPv4 exacto. TCP/UDP conserva el esquema de puertos existente; la columna de puertos queda nula para ICMP.
- `025` se añade al final de los perfiles locales que consumen F08 y del baseline `production`. `f09-lab` queda intencionalmente sin cambios: no se aplica migración ni se reconcilia el historial AWS durante esta preparación.
- El SG Terraform y la migración de DB siguen siendo artefactos locales sujetos a revisión y a sus gates propios. No se ejecutó el runner contra AWS ni se aplicó Terraform.

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

`ga01-local` debe inicializarse en una base independiente para ejercitar `018`: su secuencia coloca esa migración antes de `019` y excluye `020`, por lo que no se agrega sobre `f09-local`. `f08-local`, `f07-local` y `f10-local` también se inicializan en bases independientes; `f07-local` y `f08-local` incluyen `016` y `020`. El ensayo F10 usa el corte test-only `f10-upgrade-seed-local` para insertar filas antiguas tras 020 y luego ejecuta `f10-local` para comprobar 021/022/023/024. Ningún perfil local se aplica a AWS. CI verifica historial, reejecución, checksums y rechazo de mezcla de perfiles en PostgreSQL efímero.

### M-VPN-05 Capa A — audiencia de gateway (027)

- `027_f08_gateway_device_audience.sql` amplía `device_invitations.audience` y `device_identities.audience` a `endpoint|gateway`, pero exige que `audience=device_kind` en ambas tablas.
- La migración aborta sin reescribir datos si encuentra una fila heredada incoherente, por ejemplo `device_kind='gateway'` con `audience='endpoint'`. Esa identidad requiere una decisión explícita y re-enrolamiento.
- `027` cierra los perfiles locales que ya llegan a 026 y el baseline `production`; `f09-lab` y el corte histórico `f10-upgrade-seed-local` permanecen sin cambios.
- `npm run test:mvpn05-migrations` reconstruye 001–026 en PostgreSQL desechable, prueba el aborto atómico y la matriz de pares en invitaciones e identidades. `npm run test:prod-migrate` verifica 001–027, ledger, checksums y reejecución.
- No se aplicó `027` al PostgreSQL AWS lab ni se desplegó la API durante Capa A.

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

`023_f03_resource_grants_runtime_privileges.sql` y `024_f10_support_runtime_privileges.sql` no están en esa lista: no se han aplicado al host AWS.

**Advertencia:** `public.nexo_schema_migrations` no existe en esta base. No ejecutar el runner contra ella ni usar `--initialize` hasta reconciliar primero el estado aplicado y definir cómo registrar el historial. Esta excepción de laboratorio no crea un perfil AWS soportado ni implica aceptación/despliegue funcional de F10 o F11.

Para inspeccionar sin conexión: `npm run db:migrate -- --profile f09-local --dry-run`. El runner no infiere URLs ni perfiles y nunca ejecuta `apply` de Terraform.
