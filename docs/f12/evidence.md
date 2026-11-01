# F12 — evidencia local y estado de aceptación

Fecha de esta revisión: 31 de octubre de 2026. Evidencia de código local no equivale a despliegue, llamada AWS ni aprobación productiva.

| Control / prueba | Estado | Evidencia y límite |
|---|---|---|
| Contrato KMS Ed25519 → Go | **PASS (interfaz/documentación)** | AWS documenta `ECC_NIST_EDWARDS25519`, `ED25519_SHA_512` + `MessageType=RAW`; el código valida firma Ed25519 estándar de 64 bytes con `crypto/ed25519`. Test de contrato de bytes Go y Node. No se firmó con una clave KMS real. |
| Custodia KMS y signer | **IMPLEMENTADO / NOT RUN** | `scripts/sign-agent-release.mjs` invoca KMS `Sign`, verifica con el trust keyring y no manipula claves privadas. No hay KMS key ARN/rol de publicación configurados; la operación de firma queda NOT RUN. |
| Trust keyring en builds tagged | **IMPLEMENTADO / CONFIGURACIÓN PENDIENTE** | `.github/workflows/f01.yml` inyecta la variable pública y bloquea tag Windows si falta. No se ejecutó el workflow remoto y el repositorio aún debe recibir el keyring aprobado. |
| Feed de updates autenticado | **PASS (tests unitarios)** | Rutas de endpoint tras `deviceIdentity`, archivos regulares bajo root fijada, versión estricta, límite de tamaño, symlink rechazado; tests F12 3/3. No hay feed desplegado/configurado. |
| Verificación, staging y replay | **PASS (tests Go)** | Firma, hash, plataforma, expiración, metadata version, security epoch, minimum allowed, rollback state y package alterado; suite `internal/updater`. No es un ensayo de paquete KMS real. |
| Runtime Windows/helper | **IMPLEMENTADO / CROSS-BUILD PASS / NATIVO NOT RUN** | Primera comprobación tras 2 min y luego cada 6 h; helper separado valida firma/paquete y espera SCM+IPC con una respuesta `health` pequeña y versión esperada antes de avanzar versión/hash instalados. Metadatos de misma versión avanzan solo después de comparar el hash activo con el manifiesto firmado. Reemplazo usa `MoveFileEx` y reanuda un candidato interrumpido solo si coincide con staging firmado. No se ejecutó Windows/SCM en este corte. |
| Anti-downgrade nivel 1 | **IMPLEMENTADO / PRUEBAS GO LINUX PASS / DPAPI NATIVO NOT RUN** | DPAPI machine-scope, estado atómico con reemplazo Windows y ACL del instalador. Tests Linux usan el adaptador no-Windows y no demuestran DPAPI. El servicio falla cerrado si falta el estado. |
| TPM del laboratorio / nivel 2 | **PRESENCIA PASS / PROTECCIÓN NOT RUN** | `tpmtool getdeviceinformation` informó TPM Present=True, TPM 2.0, inicializado y listo para storage/attestation. `Get-Tpm`/WMI requieren elevación en este entorno. No se aprovisionó ni probó contador NV, PCR o recuperación de TPM. |
| Medidor RPO/RTO | **PASS (fixtures)** | Test en límites exactos 24 h/4 h y fuera de objetivo; calcula desde timestamps dados. No mide infraestructura real. |
| Pérdida total de host productivo / AWS / PV12 | **NOT RUN** | No se crearon ni cambiaron recursos AWS; la IaC de lab y el restore sintético no prueban host-loss real. Los targets RPO ≤24 h/RTO ≤4 h son medibles pero no demostrados. |
| Segunda lectura interna | **PASS WITH OPEN GATES** | Segunda pasada del checklist por OpenCode GPT-6 Luna Fast (IA; misma sesión que implementó, no revisor humano independiente), 31-10-2026. Se revisó código y documentación; gates de ejecución KMS, Windows nativo, AWS/host-loss permanecen abiertos. |

## Comandos locales

Resultados locales ejecutados el 31-10-2026:

- `npm run typecheck`: **PASS**.
- `npm run verify:f12`: **PASS, 11/11**; incluye build TypeScript y pruebas Node focalizadas.
- `npm test`: **PASS, 149/149**.
- `docker run --rm -v "$PWD/product/agent:/src" -w /src golang:1.27.3-bookworm go test ./...`: **PASS**.
- Mismo contenedor con `go vet ./...`: **PASS**.
- Cross-build de `./cmd/nexo-agent` y `./cmd/nexo-agent-updater` para `windows/amd64`: **PASS**; esto no ejecuta los binarios.
- Cross-compilación de los paquetes de prueba Windows del updater y del servicio (`go test -c`): **PASS**; sus tests/DPAPI/SCM no se ejecutaron localmente.
- Windows-native Go/DPAPI/SCM tests: **NOT RUN**; `go` no está instalado/disponible en PowerShell (`go` no reconocido).
- `npm run test:l08-recovery`: **NOT RUN en este registro**; su fixture es sintético y conserva los límites L08.

## Decisión

El código/documentación F12 queda preparado para revisión; **F12 no se marca como puerta productiva cerrada**. Antes de ello se exige: clave y rol KMS configurados, build Windows con trust anchor real, prueba Windows de update y rollback en staging, configuración real de backups/checkpoint fuera del host, ejercicio de pérdida de host con RPO/RTO, segundo revisor registrado y cierre de PV12 por separado.
