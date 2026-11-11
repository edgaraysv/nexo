# M-VPN-06 — fuentes factuales para revisión independiente

Este paquete reúne captura/transcripción, decisiones del responsable y evidencia de versión/pruebas. No contiene dictámenes.

## Fuente y criterio

- Captura de conversación `image-1.png`: política efectiva por dispositivo F08; X del tenant A accede al recurso Y; Z del tenant A es denegado con ambos VPN activos. La evidencia inicial ilustra HTTPS allow (200), deny (rechazo/403) y una consulta de auditoría para Z.
- Alcance autorizado más reciente: persistir en `audit_events` únicamente los resultados de diagnóstico F08 `default_deny` y `explicit_deny`; incluir tenant, device_id, resource_id, reason y created_at. Mantener la respuesta API y la lógica allow; no registrar paquetes nft ni decisiones allow/configuration_pending.
- Decisión de esquema autorizada: `audit_events.metadata` JSONB; no migración 028, columnas ni tabla nuevas. `metadata` contendrá `device_id`, `resource_id`, `reason`; `created_at` usa el default.
- Literal `policy_denied` de la captura es semántico, no un literal que deba añadirse al contrato actual de la respuesta.

## Base y versión candidata

- Rama `master`; base/HEAD inicial y `origin/master`: `3e1d942fada88ec2982fd91f240a0beb464cd41e`.
- El candidato no está committeado. El diff exacto de cuatro rutas está comprimido en `candidate.diff.gz`; SHA-256 de su flujo descomprimido `97e98b8d017f18ba79ccd510fc86bf47d2759b1732fb79df39db0543674df8b0`.
- Rutas incluidas en el diff: `product/api/postgres-private-network-repository.ts`, `product/api/private-network-repository.ts`, `scripts/f08-postgres.mjs`, `tests/f08-private-networks.test.mjs`.
- Otros cambios preexistentes fuera del diff: `docs/ux/nexo-dashboard-v2.1/HANDOFF.md` modificado y archivos ajenos sin seguimiento.

## Fuentes de pruebas locales

- `npm test`, Node 22.17.0, salida completa `npm-test.log`: 175 tests, 174 pass, 0 fail, 1 skip. Fragmento relevante: líneas 308–309 (caso F08 audit), 1065–1072 (resumen). El skip es `E5-4: plan endpoint quota rejects a third device enrollment`.
- `npm run test:f08-postgres`, PostgreSQL `17.6-bookworm`, perfil `f08-local`, salida completa `test-f08-postgres.log`. Resultado final: líneas 61–62; historial de 25 migraciones y asserts F08 PASS. Primer intento anterior: error SQL `operator does not exist: text ->> unknown` en concatenación de extracción JSONB; el script parentizó cada extracción antes de concatenar; la repetición PASS.
- `npm run build && node --test tests/f08-private-networks.test.mjs`, salida completa `build-and-f08.log`: líneas 12–15 caso audit; 42–49 resumen 6/6 PASS.
- `npm run typecheck`, salida completa `typecheck.log`, exit 0.
- `docker run --rm -v "$PWD":/src -w /src/product/agent golang:1.27.3-bookworm go test ./...`, salida completa `go-test.log`, exit 0.
- `git diff --check`, salida `diff-check.log`, exit 0.

## Fuentes de DB real

- Cuenta `423597267645`, región `us-east-1`, instancia `i-006cda6fdc86af7a5`, DB `nexo_mvpn01`.
- SSM de preflight read-only `1583569a-63dc-4be5-ac78-1e5602a261de`: `nexo_runtime` tiene INSERT/SELECT en `audit_events`; RLS y FORCE RLS habilitados; endpoint `dd8cae89-2afe-4967-a1d0-abe8844e2536` approved; recurso `3494038c-661a-42e5-8b38-a2562cedee87` y perfil `fbea6b76-14d9-4698-afd8-1fc46b2e8cf2` active/direct.
- SSM read-only `a6174d78-a476-4423-a19d-794840bac72d`: policy activa TCP/18443 allow/any_endpoint; no había regla coincidente en TCP/18444.
- INSERT con rol/contexto runtime dentro de transacción revertida: SSM `033da5f3-1294-4f1b-9cbf-b412d3cd5f57`, id 141; rollback. Postconsulta `b0a352e3-9a49-4d37-a8c7-b30e5123e3d0`: cero filas persistidas.
- Runner Node one-off sobre datos reales, SSM `effe403a-703c-4468-beb2-80520eeab2f9`: calculó `deny/default_deny` en TCP/18444 y ejecutó INSERT+COMMIT como `nexo_runtime`. El proceso reportó `persisted_row_verification_failed` después del commit porque intentó leer `persisted.metadata` no proyectado por su SELECT.
- Lectura posterior read-only `86f98ca3-013f-4f2f-a90a-8b76560c6655`: fila id 142, tenant `e4186fac-0dd4-4aaa-8f0f-e4342e19af8a`, action `network.diagnostic.denied`, resource_type `private_resource`, device `dd8cae89-2afe-4967-a1d0-abe8844e2536`, resource `3494038c-661a-42e5-8b38-a2562cedee87`, reason `default_deny`, created_at `2026-11-11 02:33:56.352536+00`.
- El runner fue un one-off Node con consultas/lógica equivalente; no cargó el módulo candidato compilado ni invocó HTTP `POST /v1/company/network-diagnostics`. El servicio API no se desplegó/reinició. No se inició instancia ni se abrió una ventana.

## Despliegue live y recorrido HTTP real

- El responsable autorizó expresamente backup compilado, swap de `nexo.service`, health 200, rollback si falla health/fila, llamada al diagnóstico para default-deny, y commit local solo si pasa; sin push.
- Preflight SSM `60b6850d-432a-415c-a3ce-e129c3f4b04e`: cuenta `423597267645`, EC2 `i-006cda6fdc86af7a5` running/SSM online; API active, NRestarts 0, health HTTP 200; worker y agent activos. SSM `4da18e28-955c-475d-825d-4b946054d5b8`: único endpoint aprobado del tenant A dd8..., 0 actores con grant diagnóstico activo. TCP/18444 no tenía política coincidente.
- Token validado mediante `/v1/me`, SSM `0dc772d7-4dbb-4644-954f-9b8d9dde205a`: actor `184193d0-2d3c-4056-9940-7f1053d06221`, tenant A, rol company.admin y ambos permisos requeridos. El token fue cifrado con llave RSA efímera en memoria/transporte, no quedó en stdout, comandos SSM ni repo.
- Grant temporal de diagnóstico creado por API HTTP 201, SSM `9f11bdbd-a511-45fc-b86c-24637204cd04`, ID `8e093cd0-100b-44a5-88cc-d4c97de28e61`; revocado al terminar por API HTTP 204. El log completo está en `deployment-run.txt`.
- Artefacto compilado S3 SSE-KMS `s3://nexo-lab-423597267645-us-east-1-control/deploy/mvpn06/20261111T0335Z/nexo-mvpn06-api-product.tgz`; VersionId `4FYSTT6TSw7vP8RYfELpDcCcOB.368aM`, 119772 bytes, SHA-256 `60d187025bda15eb965113d6dfe5fcd8c0b7f55dd6c91e7ff10f390b65aa6901`.
- Backup compilado remoto SSM `7210ae9a-003d-4135-8da1-cbdae3b07446`: `/root/mvpn06/backups/20261111T0335Z/nexo-dist-product-predeploy.tgz`, SHA-256 `5286a649c678962e244e181639730b1451190d6e6a10848ff0109d48691d5fec`; restore check PASS.
- Primer intento SSM `4e9a363a-4c64-4c5d-a522-9e5dc78e3748` FAIL exit 141 antes del swap, stderr exacto `failed to run commands: exit status 141`, stdout vacío. Diagnóstico independiente (sesión `ses_e374e3839ffex1u7851yQhmhCG`) consideró plausible SIGPIPE en `tar -tzf | grep -q` con `pipefail`. Confirmación read-only SSM `9bda1457-4488-48df-9210-b92893bd4bc3`: runtime intacto y health 200; `tar_list_exit=0`, `grep_member_exit=0` cuando se materializó listado a archivo; old dir ausente. No se tocó servicio, por lo que no hubo rollback.
- Swap SSM `650392d3-a857-40c6-b4a2-e8888cb5d26f` PASS tras sustituir la tubería por lista temporal: health HTTP 200/body status ok; `nexo.service`, node-agent y worker activos; backups/candidato SHA verificados; old tree preservado.
- Llamada live real SSM `260dda04-0a3a-4e9c-a2ab-87c32a394a7c`: POST `/v1/company/network-diagnostics`, source device `dd8cae89-2afe-4967-a1d0-abe8844e2536`, resource `3494038c-661a-42e5-8b38-a2562cedee87`, TCP/18444; HTTP 200, `decision=deny`, `reason=default_deny`, `connectivity=not_tested`.
- Query SQL read-only posterior al inicio de la llamada devolvió exactamente una fila: id 145, tenant A, action `network.diagnostic.denied`, resource_type `private_resource`, resource_id y metadata.resource_id `3494038c-661a-42e5-8b38-a2562cedee87`, metadata.device_id `dd8cae89-2afe-4967-a1d0-abe8844e2536`, metadata.reason `default_deny`, created_at `2026-11-11T03:45:16.274852+00`.
- Grant temporal revocado HTTP 204; SQL read-only confirmó revoked_at `2026-11-11 03:45:16.700151+00`. Postcheck SSM `0bfcadea-06f5-49e8-ae99-7824fe3edd1c`: fila 145 sigue visible, API/agent/worker active, cada NRestarts=0, health 200, transporte efímero ausente. No se activó rollback. No commit/push aún.
- Cierre local de trazabilidad: `closure-verification.txt`; recálculo del diff autorizado y `cmp` byte a byte con el flujo descomprimido de `candidate.diff.gz` PASS (mismo SHA); typecheck/build/diff-check exit 0; rebuild normalizado `dist/product` reproduce exactamente el artefacto probado (mismo SHA y `cmp` exit 0); hashes de ambos módulos compilados de auditoría concuerdan entre checkout local y postcheck del árbol live. Salida detallada conservada en `closure-verification.txt` y `deployment-run.txt`.
