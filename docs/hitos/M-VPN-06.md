# M-VPN-06 — Auditoría de denegaciones de acceso F08

## Apertura

- **Etapa:** VPN-OpenVPN / diagnóstico F08 y persistencia de auditoría.
- **Fecha:** 2026-11-10.
- **Fuente:** captura adjunta en la conversación (`image-1.png`), sin bytes conservados localmente. Transcripción: política efectiva por dispositivo; X de empresa A accede al recurso Y; Z de la misma empresa es denegado; ambos tienen VPN activa. Cierre original: petición HTTPS positiva devuelve 200, negativa rechazada/403 y auditoría del dispositivo Z con razón `policy_denied`.
- **Repositorio y base:** `/mnt/c/laragon/www/nexo`, rama `master`, HEAD base y `origin/master` `3e1d942fada88ec2982fd91f240a0beb464cd41e`.
- **Árbol previo:** `docs/ux/nexo-dashboard-v2.1/HANDOFF.md` estaba modificado y había archivos ajenos sin seguimiento; se preservaron. Los cambios de este hito no se mezclan con esos archivos.
- **Prerrequisito:** M-VPN-05, cuyo P6 registrado ejercitó allow/deny con gateway; evidencia en `docs/hitos/evidence/mvpn05-p6-p7-p9/p6-allow.txt`, `p6-deny.txt` y `p6-correlation.txt`.

### Contrato autorizado

- El responsable acotó este cambio a la llamada explícita `POST /v1/company/network-diagnostics`: registrar solo `default_deny` y `explicit_deny` en `audit_events`.
- La respuesta del diagnóstico y la lógica allow no se modifican. `policy_denied` de la captura es la descripción semántica del rechazo; se conservan los literales actuales `default_deny` y `explicit_deny`.
- Se usa `audit_events.metadata` JSONB existente, sin migración 028, columnas o tabla nuevas. `metadata` incluye `device_id`, `resource_id` y `reason`; `tenant_id` y `created_at` se escriben en sus columnas.
- No se registran decisiones allow/configuration-pending ni paquetes del dataplane nft. El evento se genera al consultar el diagnóstico, no en el hot path de paquetes.
- Evaluación de apertura: `nexo-apertura`, sesión `ses_e37b9f10fffek84Ih5iah2QISb`, VALIDADA para el alcance de implementación y pruebas locales. La comprobación en DB live quedó como paso separado.

## Implementación

- `product/api/postgres-private-network-repository.ts`: calcula la razón una vez y, dentro de la transacción de `diagnose`, inserta `network.diagnostic.denied` en `audit_events` únicamente para `default_deny` o `explicit_deny`.
- `product/api/private-network-repository.ts`: la implementación en memoria modela el mismo comportamiento para pruebas; añade constantes de acción/tipo y un inspector de eventos.
- `tests/f08-private-networks.test.mjs`: caso API dedicado verifica ambos motivos, ausencia de eventos para allow/configuration-pending y conjunto exacto de claves de respuesta.
- `scripts/f08-postgres.mjs`: verifica inserción PostgreSQL de ambos motivos, metadata, tenant/recurso/tiempo y que allow/configuration-pending no incrementen los eventos.
- **Migraciones:** sin cambios; no existe archivo 028.

## Pruebas locales

| Prueba | Tipo | Resultado | Evidencia |
|---|---|---|---|
| `npm run test:f08-postgres` | Integración PostgreSQL local (`postgres:17.6-bookworm`, perfil `f08-local`, 25 migraciones) | **PASS** en la repetición | Auditoría `default_deny` y `explicit_deny`; allow/configuration-pending no generan eventos. El primer intento falló en una expresión de concatenación JSONB (`text ->> unknown`); se parentizó cada extracción y la repetición pasó. |
| `npm test` | Regresión Node | **PASS**, 174 aprobados, 1 omitido, 0 fallos (175 total) | Incluye el test F08 nuevo; Node 22.17.0. El omitido fue `E5-4: plan endpoint quota rejects a third device enrollment`. |
| `npm run typecheck` | TypeScript | **PASS** | Proyectos spike, API y portal. |
| `docker run --rm -v "$PWD":/src -w /src/product/agent golang:1.27.3-bookworm go test ./...` | Unitaria Go | **PASS** | Paquetes del agente; `vpnruntime` incluido. |
| `npm run build && node --test tests/f08-private-networks.test.mjs` | Focal F08 | **PASS**, 6/6 | Repetición tras endurecer la aserción de respuesta exacta. |
| `git diff --check` | Higiene de diff | **PASS** después del último ajuste de aserciones | Repetido en el árbol actual; debe ejecutarse de nuevo si se modifica el diff. |

Salidas completas y diff exacto del candidato: `docs/hitos/evidence/mvpn06/{test-f08-postgres.log,npm-test.log,typecheck.log,go-test.log,build-and-f08.log,diff-check.log,candidate.diff.gz}`. El SHA-256 del flujo descomprimido de `candidate.diff.gz` es `97e98b8d017f18ba79ccd510fc86bf47d2759b1732fb79df39db0543674df8b0`.

## Comprobación en `nexo_mvpn01`

- Cuenta `423597267645`, región `us-east-1`, nodo EC2 `i-006cda6fdc86af7a5`. Preflight read-only SSM `1583569a-63dc-4be5-ac78-1e5602a261de`: DB `nexo_mvpn01`; `nexo_runtime` tiene INSERT/SELECT y `audit_events` tiene RLS/FORCE RLS; endpoint `dd8cae89-2afe-4967-a1d0-abe8844e2536` está `approved`; recurso `3494038c-661a-42e5-8b38-a2562cedee87` y perfil `fbea6b76-14d9-4698-afd8-1fc46b2e8cf2` están activos.
- Preflight read-only SSM `a6174d78-a476-4423-a19d-794840bac72d`: perfil directo; política activa TCP/18443 `any_endpoint`.
- SSM `033da5f3-1294-4f1b-9cbf-b412d3cd5f57` probó el INSERT con rol `nexo_runtime` y contexto del tenant dentro de una transacción, devolvió una fila con `id=141`, `reason=default_deny`, el endpoint/recurso indicados y `created_at=2026-11-11 02:18:55.75772+00`, y ejecutó **ROLLBACK**.
- Postverificación read-only SSM `b0a352e3-9a49-4d37-a8c7-b30e5123e3d0`: cero filas de prueba persistidas.
- **Ejecución live autorizada posterior:** sin desplegar ni reiniciar el servicio, un proceso Node one-off como `nexo_runtime` calculó el diagnóstico sobre el endpoint aprobado `dd8cae89-2afe-4967-a1d0-abe8844e2536`, el recurso activo `3494038c-661a-42e5-8b38-a2562cedee87` y TCP/18444 (sin política allow coincidente; política permitida existente TCP/18443), y ejecutó el INSERT con `COMMIT`. SSM `effe403a-703c-4468-beb2-80520eeab2f9` terminó con error **después del COMMIT**: el verificador del script buscó `persisted.metadata` sin haber seleccionado esa columna. La lectura read-only inmediata SSM `86f98ca3-013f-4f2f-a90a-8b76560c6655` confirmó exactamente una fila reciente: id **142**, acción `network.diagnostic.denied`, `device_id=dd8cae89-2afe-4967-a1d0-abe8844e2536`, `resource_id=3494038c-661a-42e5-8b38-a2562cedee87`, `reason=default_deny`, timestamp `2026-11-11 02:33:56.352536+00`.
- **Límite de esta ejecución:** se ejecutó un runner Node one-off con la lógica/consultas de diagnóstico y el INSERT sobre la DB real; no se cargó el módulo candidato compilado ni se llamó la ruta HTTP del API. El servicio live no se desplegó ni reinició. No se inició instancia ni se abrió ventana. Ver `docs/hitos/evidence/mvpn06/audit-db-check.txt`.

## Revisión independiente y estado

- `nexo-cierre`, sesión nueva `ses_e379821c4ffebFFkYs0yaq4dBs`, dictaminó **PENDIENTE** sobre la evidencia previa. No evaluó la fila persistida id 142 ni el endurecimiento posterior del test.
- El test de respuesta se reforzó después para comparar exactamente las claves, incluyendo `appliedRevision` solo cuando existe. La focal F08 posterior pasó 6/6.

### Dictamen independiente final

- **Worker:** `nexo-cierre`, sesión `ses_e377d9b97ffevyXgVP8hrI6Lgl`, solo lectura.
- **Dictamen:** **PASS-CON-PENDIENTES** para el candidato local. Consideró satisfecho el alcance local con el diff revisado y las pruebas, sin exigir API HTTP live. El runner directo de DB se clasificó como evidencia complementaria; no se presentó como llamada al endpoint ni como ejecución del módulo candidato.
- **Veredicto final de la versión evaluada:** **PASS-CON-PENDIENTES** para el candidato local basado en `3e1d942fada88ec2982fd91f240a0beb464cd41e` más el diff identificado en `candidate.diff.gz` (flujo descomprimido).
- **Estado:** **VERIFICADO — solo candidato local**. No equivale a publicación o despliegue live. Pendientes fuera de este cierre: despliegue/verificación HTTP live, sujeto a autorización; el skip E5-4 corresponde a cuota de enrolamiento y no es gate de M-VPN-06.
- No se hizo commit ni push. El hash de trabajo es el diff identificado en la tabla de evidencia, no un commit.

## Continuación autorizada: despliegue live (2026-11-11 UTC)

- El responsable autorizó desplegar el candidato en `nexo.service` con backup compilado, swap, health HTTP 200 y rollback automático ante fallo; después pidió invocar el diagnóstico F08 y verificar una fila nueva `default_deny` para el dispositivo correcto, y solo si pasa hacer commit local sin push.
- Preflight SSM **read-only** `60b6850d-432a-415c-a3ce-e129c3f4b04e`: cuenta `423597267645`; instancia `i-006cda6fdc86af7a5` running, SSM online, `nexo.service` active/running, `NRestarts=0`, health actual `GET /v1/health` HTTP 200 (`{"status":"ok"}`), `/opt/nexo/dist/product` directory root:nexo_runtime (750), 38 archivos/641436 bytes, espacio disponible ~25.8 GB. En ese instante aún no se había creado el backup ni hecho swap.
- DB preflight SSM **read-only** `4da18e28-955c-475d-825d-4b946054d5b8`: el único endpoint aprobado de tenant A es `dd8cae89-2afe-4967-a1d0-abe8844e2536`; no hay ningún actor elegible con grant activo `company.network.diagnose` para ese dispositivo. El recurso `3494038c-661a-42e5-8b38-a2562cedee87` está active; para TCP/18444 no hay política activa coincidente. Código vigente `application.ts:71,186-187,371-378` exige `company.network.diagnose` y `resource_grant` sobre `source_device_id` antes de llamar al repositorio. Sin el grant, la ruta responde 403 y no puede generar `default_deny`.
- El responsable autorizó un grant temporal mínimo para el endpoint, con expiración y revocación tras la prueba. La primera tarjeta de credencial no pudo leerse desde el shell; no se leyó ni expuso. El primer token que sí pudo usarse autenticó como `provider.owner`; solo se consultó `/v1/me`, sin cambiar/revocar esa sesión ni mutar datos. Se limpió su transporte cifrado efímero. La tarjeta siguiente entregó un token tenant-scoped: SSM `0dc772d7-4dbb-4644-954f-9b8d9dde205a` confirmó tenant A, actor `184193d0-2d3c-4056-9940-7f1053d06221`, rol `company.admin` y permisos `company.resource_grant.manage` + `company.network.diagnose`. El token nunca se imprimió ni se incluyó en parámetros SSM en claro.
- Build local `npm run build`: **PASS**. El paquete compilado `/tmp/opencode/mvpn06-api-product.tgz` tiene SHA-256 `60d187025bda15eb965113d6dfe5fcd8c0b7f55dd6c91e7ff10f390b65aa6901`, 119772 bytes, 39 entradas. La primera cadena de validación terminó exit 1 porque buscó el literal `network.diagnostic.denied` en el módulo PostgreSQL que lo importa desde otro módulo; la comprobación corregida confirmó el import en `postgres-private-network-repository.js` y el literal en `private-network-repository.js`, y empaquetó el artefacto.
- Grant temporal creado mediante el API con HTTP 201, SSM `9f11bdbd-a511-45fc-b86c-24637204cd04`: ID `8e093cd0-100b-44a5-88cc-d4c97de28e61`, actor administrador indicado, dispositivo `dd8cae89-2afe-4967-a1d0-abe8844e2536`, permiso `company.network.diagnose`, válido desde `2026-11-11T03:34:20.884Z` hasta `2026-11-11T04:34:20.000Z`. El mismo flujo lo revocó después de la prueba.
- Backup compilado remoto SSM `7210ae9a-003d-4135-8da1-cbdae3b07446`: `/root/mvpn06/backups/20261111T0335Z/nexo-dist-product-predeploy.tgz`, 119544 bytes, SHA-256 `5286a649c678962e244e181639730b1451190d6e6a10848ff0109d48691d5fec`, permisos 0600; extracción de restauración y `diff -qr` contra `/opt/nexo/dist/product`: **PASS**.
- Artefacto candidato en S3 SSE-KMS: `s3://nexo-lab-423597267645-us-east-1-control/deploy/mvpn06/20261111T0335Z/nexo-mvpn06-api-product.tgz`, versión `4FYSTT6TSw7vP8RYfELpDcCcOB.368aM`, 119772 bytes, SHA-256 `60d187025bda15eb965113d6dfe5fcd8c0b7f55dd6c91e7ff10f390b65aa6901`; concuerda con el build local.
- Primer intento SSM `4e9a363a-4c64-4c5d-a522-9e5dc78e3748`: **FAIL antes del swap**, stderr `failed to run commands: exit status 141`, stdout vacío. La línea de listado `tar -tzf ... | grep -q ...` era previa a `SWAP_STARTED`; el diagnóstico independiente (`nexo-diagnostico`, sesión `ses_e374e3839ffex1u7851yQhmhCG`) consideró plausible SIGPIPE de `tar` por `grep -q` junto con `pipefail`, sin poder confirmarlo solo por ese log. Preflight read-only SSM `9bda1457-4488-48df-9210-b92893bd4bc3` corroboró servicio/health HTTP 200 intactos, backup y artefacto con hashes esperados, sin `product.pre-mvpn06`; el mismo listado ejecutado a archivo dio `tar_list_exit=0`, `grep_member_exit=0`. No fue necesario rollback porque el swap no empezó.
- Despliegue SSM `650392d3-a857-40c6-b4a2-e8888cb5d26f`: **PASS** tras cambiar la validación del listado a archivo temporal, sin pipeline. Swap compilado completado; health check `GET /v1/health` HTTP 200 y body `{"status":"ok"}`. `nexo.service`, `nexo-node-agent.service` y `nexo-worker.service` active; artefacto y backup verificados por SHA-256; el árbol compilado anterior quedó preservado en `/opt/nexo/dist/product.pre-mvpn06-20261111T0335Z` y el tar de backup permanece intacto.
- Diagnóstico live SSM `260dda04-0a3a-4e9c-a2ab-87c32a394a7c`: llamada real HTTP `POST /v1/company/network-diagnostics` para el endpoint aprobado `dd8cae89-2afe-4967-a1d0-abe8844e2536`, recurso activo `3494038c-661a-42e5-8b38-a2562cedee87`, TCP/18444. Respuesta HTTP 200, `decision=deny`, `reason=default_deny`, `connectivity=not_tested`. La consulta posterior encontró exactamente una fila nueva, ID **145**, tenant `e4186fac-0dd4-4aaa-8f0f-e4342e19af8a`, action `network.diagnostic.denied`, resource_type `private_resource`, device `dd8cae89-2afe-4967-a1d0-abe8844e2536`, resource y metadata.resource_id `3494038c-661a-42e5-8b38-a2562cedee87`, metadata.reason `default_deny`, created_at `2026-11-11T03:45:16.274852+00`.
- En el mismo flujo, revocación del grant temporal por API HTTP 204 y comprobación SQL de `revoked_at=2026-11-11 03:45:16.700151+00`; token/cifrado temporal removidos del host. Postverificación read-only SSM `0bfcadea-06f5-49e8-ae99-7824fe3edd1c`: fila 145 sigue legible, grant revocado, API/agent/worker activos con `NRestarts=0`, health HTTP 200. No se disparó rollback.
- Evidencia detallada y salidas SSM: `docs/hitos/evidence/mvpn06/deployment-run.txt`; trazabilidad reproducible de source→build→artefacto y códigos de salida: `docs/hitos/evidence/mvpn06/closure-verification.txt`.

### Revisión independiente final del cierre live

- Primera sesión nueva de `nexo-cierre`, `ses_e374502c3ffepXE0Sp9Y5tiDMg`: dictamen **PENDIENTE / BLOQUEADO**, sin discrepancia funcional; solicitó evidencia recalculada de diff, identidad del artefacto y códigos de salida para typecheck/diff-check. No accedió a AWS.
- Se completó esa evidencia sin mutaciones live: el diff de las cuatro rutas actuales concuerda byte a byte con el flujo de `candidate.diff.gz`; typecheck/build/diff-check terminan con exit 0; archive normalizado reconstruido y candidato desplegado tienen el mismo SHA-256 y `cmp` exit 0; hashes de los dos módulos de auditoría concuerdan entre build local y postcheck live. Detalle en `closure-verification.txt`.
- Evaluación independiente nueva de `nexo-cierre`, sesión `ses_e37416c7bffeAnT37rhIcoWFsb`, solo lectura: **PASS-CON-PENDIENTES**, estado **VERIFICADO**. Confirmó el contrato y diff, las pruebas API/PostgreSQL, la cadena local de artefacto y la evidencia documental de backup/swap/HTTP/audit/revocación/health. No repitió AWS ni recalculó allí los registros; calificó expresamente su dictamen como basado en evidencia documental y revisión estática. No encontró mismatch funcional.
- Pendientes fuera del alcance de este cierre: el test E5-4 omitido por cuota de enrolamiento sigue **NOT_RUN**; la conectividad HTTPS del dataplane no se probó y no se toma como sustituida por el diagnóstico HTTP. El dictamen corresponde al alcance posterior autorizado de auditoría del endpoint y al candidato identificado. Se autoriza crear el commit local condicionado por el responsable; **sin push**.
