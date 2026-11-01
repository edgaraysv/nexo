# F12 — evidencia local y estado de aceptación

Fecha de esta revisión: 1 de noviembre de 2026. Evidencia de código local o AWS lab no equivale a despliegue ni aprobación productiva.

| Control / prueba | Estado | Evidencia y límite |
|---|---|---|
| Contrato KMS Ed25519 → Go | **PASS (AWS lab real, 2026-11-01)** | Con `nexo-lab-signer`, KMS firmó `RAW`/`ED25519_SHA_512` un payload de manifiesto de 431 bytes; firma de 64 bytes, `KMS Verify=true`, y `VerifySecureManifest` aceptó el manifiesto. Fixture persistente en `product/agent/internal/updater/testdata/live-kms-ed25519/`. No es un release ni ensayo Windows. |
| Custodia KMS y signer | **PASS (lab) / PRODUCCIÓN NOT RUN** | Clave `arn:aws:kms:us-east-1:423597267645:key/3f3b6523-8b33-4921-bbbb-e25140e9b4c7`; rol `arn:aws:iam::423597267645:role/nexo-lab-signer`. La key policy concede uso criptográfico solo a ese rol y `ED25519_SHA_512`; root conserva administración sin `Sign`/`Verify`. El rol no tiene `kms:CreateKey`, `kms:DeleteKey` ni `kms:ScheduleKeyDeletion`. Ver restricciones detalladas abajo. |
| Trust keyring en builds tagged | **IMPLEMENTADO / CONFIGURACIÓN PENDIENTE** | `.github/workflows/f01.yml` inyecta la variable pública y bloquea tag Windows si falta. No se ejecutó el workflow remoto y el repositorio aún debe recibir el keyring aprobado. |
| Feed de updates autenticado | **PASS (tests unitarios)** | Rutas de endpoint tras `deviceIdentity`, archivos regulares bajo root fijada, versión estricta, límite de tamaño, symlink rechazado; tests F12 3/3. No hay feed desplegado/configurado. |
| Verificación, staging y replay | **PASS (tests Go)** | Suite `internal/updater` más vector firmado por KMS live: firma, hash, plataforma, expiración, metadata version, security epoch, minimum allowed, rollback state y package alterado. No se desplegó el agente en Windows. |
| Runtime Windows/helper | **IMPLEMENTADO / CROSS-BUILD PASS / NATIVO NOT RUN** | Primera comprobación tras 2 min y luego cada 6 h; helper separado valida firma/paquete y espera SCM+IPC con una respuesta `health` pequeña y versión esperada antes de avanzar versión/hash instalados. Metadatos de misma versión avanzan solo después de comparar el hash activo con el manifiesto firmado. Reemplazo usa `MoveFileEx` y reanuda un candidato interrumpido solo si coincide con staging firmado. No se ejecutó Windows/SCM en este corte. |
| Anti-downgrade nivel 1 | **IMPLEMENTADO / PRUEBAS GO LINUX PASS / DPAPI NATIVO NOT RUN** | DPAPI machine-scope, estado atómico con reemplazo Windows y ACL del instalador. Tests Linux usan el adaptador no-Windows y no demuestran DPAPI. El servicio falla cerrado si falta el estado. |
| TPM del laboratorio / nivel 2 | **PRESENCIA PASS / PROTECCIÓN NOT RUN** | `tpmtool getdeviceinformation` informó TPM Present=True, TPM 2.0, inicializado y listo para storage/attestation. `Get-Tpm`/WMI requieren elevación en este entorno. No se aprovisionó ni probó contador NV, PCR o recuperación de TPM. |
| Medidor RPO/RTO | **PASS (fixtures)** | Test en límites exactos 24 h/4 h y fuera de objetivo; calcula desde timestamps dados. No mide infraestructura real. |
| Pérdida total de host productivo / AWS / PV12 | **NOT RUN** | Se crearon en AWS lab únicamente la clave/rol/alias de firma F12; no se hizo restore ni se modificaron recursos de recuperación. La IaC de lab y el restore sintético no prueban host-loss real. Los targets RPO ≤24 h/RTO ≤4 h son medibles pero no demostrados. |
| Segunda lectura interna | **PASS WITH OPEN GATES** | Segunda pasada del checklist por OpenCode GPT-6 Luna Fast (IA; misma sesión que implementó, no revisor humano independiente), 31-10-2026. La prueba KMS lab se ejecutó posteriormente el 1-11-2026; Windows nativo, AWS/host-loss, recuperación y revisión independiente siguen abiertos. |

## Comandos locales

Resultados locales ejecutados el 31-10-2026, conservados como registro histórico:

- `npm run typecheck`: **PASS**.
- `npm run verify:f12`: **PASS, 11/11**; incluye build TypeScript y pruebas Node focalizadas.
- `npm test`: **PASS, 149/149**.
- `docker run --rm -v "$PWD/product/agent:/src" -w /src golang:1.27.3-bookworm go test ./...`: **PASS**.
- Mismo contenedor con `go vet ./...`: **PASS**.
- Cross-build de `./cmd/nexo-agent` y `./cmd/nexo-agent-updater` para `windows/amd64`: **PASS**; esto no ejecuta los binarios.
- Cross-compilación de los paquetes de prueba Windows del updater y del servicio (`go test -c`): **PASS**; sus tests/DPAPI/SCM no se ejecutaron localmente.
- Windows-native Go/DPAPI/SCM tests: **NOT RUN**; `go` no está instalado/disponible en PowerShell (`go` no reconocido).
- `npm run test:l08-recovery`: **NOT RUN en este registro**; su fixture es sintético y conserva los límites L08.

Comprobaciones adicionales del 1-11-2026:

- `npm run verify:f12`: **PASS, 11/11**.
- `docker run --rm -v "$PWD/product/agent:/src" -w /src golang:1.27.3-bookworm go test ./...`: **PASS**, incluida la prueba persistente del vector KMS live.
- `TestLiveLabKMSManifestIsAcceptedByGoVerifier`: **PASS** con `VerifySecureManifest`; reloj de fixture fijo en `issued_at` para que el vector criptográfico no caduque como test. Las pruebas temporales se mantienen separadas.

## Evidencia de AWS KMS real (2026-11-01)

- Cuenta/región: `423597267645` / `us-east-1` (lab). Clave activa `ECC_NIST_EDWARDS25519`, `SIGN_VERIFY`; alias `alias/nexo-lab-423597267645-us-east-1-agent-release-signing`.
- ARN de clave: `arn:aws:kms:us-east-1:423597267645:key/3f3b6523-8b33-4921-bbbb-e25140e9b4c7`.
- ARN de rol: `arn:aws:iam::423597267645:role/nexo-lab-signer`. Trust limitado al usuario IAM `nexo-lab-admin` para este ensayo de un operador; sesión observada `arn:aws:sts::423597267645:assumed-role/nexo-lab-signer/nexo-f12-kms-go-verification`.
- La key policy solo da `kms:Sign`/`kms:Verify` al rol con condición `kms:SigningAlgorithm=ED25519_SHA_512`. La declaración de root permite administración/lectura/recuperación y gestión del alias, pero no `Sign` ni `Verify`. La policy inline del rol limita el recurso al ARN de esta clave y las mismas acciones/algoritmo; no concede creación ni eliminación de claves, ni programación de borrado. Alta y alias están gestionados en `infra/aws/lab/release-signing.tf` (`prevent_destroy`, ventana de borrado de 30 días).
- Resultado de firma: payload JSON de 431 bytes; `KMS Sign` devolvió 64 bytes usando `MessageType=RAW` y `ED25519_SHA_512`; `KMS Verify` devolvió `SignatureValid=true`. Clave pública: DER 44 bytes / Ed25519 raw 32 bytes.
- Manifiesto sintético `key_id=nexo-lab-f12-2026-11`, SHA-256 del payload de paquete de prueba `f5f22e0f099c4edc84979e64f949e85525d1e75b6bf43bfceb7ca06237890566`. Node también validó la firma con `verifyKmsSignature`; Go aceptó el manifiesto con `VerifySecureManifest`. Firma y clave pública del vector son datos públicos de prueba, no material privado.
- No se publicó feed, no se firmó un `.exe`, no se configuró el trust keyring en GitHub Actions, no se validó CloudTrail y no se ejecutó Windows/SCM. No se usó ticket ni 2-de-3 en el lab; esos controles siguen siendo de F13/producción.
- Un `terraform plan` completo de solo lectura detectó drift ajeno al alcance KMS (SG asociado/IMDS hop limit, tags y regla Webmin); **no se aplicó**. No inferir que el resto del lab quedó reconciliado.

## Decisión

La integración criptográfica KMS→Go del lab está **PASS**, pero **F12 no se marca como puerta productiva cerrada**. Antes de ello se exige: trust anchor aprobado en build Windows, prueba Windows de update y rollback en staging, configuración real de backups/checkpoint fuera del host, ejercicio de pérdida de host con RPO/RTO, segundo revisor independiente registrado y cierre de PV12 por separado.
