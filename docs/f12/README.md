# F12 — firma de releases, actualización y recuperación por pérdida de host

**Estado:** implementación local en revisión. No habilita producción ni autoriza clientes/datos reales. La firma contra una clave KMS configurada, la aplicación en Windows/SCM, la protección monotónica TPM y el restore AWS por pérdida total de host continúan **NOT RUN/BLOCKED**; la presencia TPM sí fue comprobada, ver [evidencia](evidence.md).

## Alcance aprobado

- Custodia de la clave privada de releases en AWS KMS; ninguna clave privada de firma se guarda en Git, en el agente ni en el paquete de recuperación.
- Actualización automática del servicio Windows desde el feed autenticado del control, con metadatos Ed25519, staging separado, health check por SCM+IPC y rollback de la transacción si sigue permitido.
- Anti-downgrade persistente mediante versión instalada, versión de metadatos, época y mínimo de versión. El nivel base usa DPAPI machine-scope y ACL de Windows.
- Procedimiento de recuperación ante **pérdida total de un host** y medición de objetivos **RPO ≤24 h / RTO ≤4 h**. El alcance no incluye pérdida/compromiso de cuenta AWS o región.
- Dos niveles TPM documentados; TPM no es requisito duro.

## Firma y custodia

`scripts/sign-agent-release.mjs` firma el manifiesto `nexo.agent-update.v2`, no el EXE mediante Authenticode. El contenido del paquete queda vinculado por SHA-256 dentro del manifiesto. El signer invoca AWS KMS `Sign` con `ECC_NIST_EDWARDS25519`, `ED25519_SHA_512` y `MessageType=RAW`; verifica inmediatamente la firma con la clave pública que el agente lleva embebida antes de publicar el feed.

La interoperabilidad documental está comprobada contra la referencia oficial de [KMS key specs](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html): `ED25519_SHA_512` requiere `RAW`; la firma Ed25519 resultante es la forma estándar de 64 bytes aceptada por `crypto/ed25519` de Go. Las pruebas locales comprueban el contrato de bytes y la forma de la clave, pero **no sustituyen una operación `Sign` real contra una clave KMS del entorno**.

El keyring de confianza es JSON de IDs estables a claves Ed25519 públicas raw Base64, codificado en Base64 y embebido al compilar (`NEXO_AGENT_UPDATE_TRUST_KEYS_B64`). La clave privada permanece en KMS. La rotación requiere solapamiento: incluir clave nueva y antigua en un build confiable, distribuirlo, firmar con la nueva, y retirar la anterior solo después de verificar cobertura de clientes. La aprobación de alta/rotación debe quedar en ticket con dos de tres custodios internos; el repositorio no implementa una raíz TUF ni un mecanismo criptográfico threshold 2-de-3. No se debe describir este formato como TUF.

Procedimiento del operador de releases, trust keyring, permisos mínimos y configuración pendiente: [custodia y release](runbooks/signing-and-release.md).

## Actualizador y anti-downgrade

- El agente requiere identidad de endpoint aprobada y obtiene el feed por `/v1/device/agent-updates/current`; el paquete usa una ruta de versión fija. La UI no suministra URLs, rutas ni comandos.
- La API solo publica desde `NEXO_AGENT_UPDATE_DIR`, en formato `current/manifest.json` y `<versión>/nexo-agent.exe`, con límites de tamaño, versión estricta, archivos regulares y rechazo de enlaces simbólicos fuera de la raíz.
- El servicio verifica firma, plataforma/arquitectura, SHA-256, vigencia, `metadata_version`, `security_epoch`, versión mínima y versiones bloqueadas. No sigue redirecciones HTTP.
- El helper `nexo-agent-updater.exe` es un proceso separado del servicio, instalado bajo ACL de `SYSTEM`/administradores. Copia el candidato al mismo volumen/directorio de instalación y usa reemplazo Windows `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)`, espera SCM y named-pipe IPC, y persiste los nuevos high-water marks después del health check.
- El estado persistente se cifra/autentica con DPAPI machine-scope y reside bajo `%ProgramData%\NEXO\Endpoint`, protegido por ACL. La ausencia/corrupción del estado bloquea el servicio; el runtime no reinicializa silenciosamente el high-water mark. Bloquea una instalación inferior a la última registrada; **no resiste** restaurar una imagen completa del disco ni a un administrador local. Esa garantía requiere el nivel TPM opcional.
- Un candidato que inicia tras interrupción debe coincidir por versión y SHA-256 con su manifiesto y paquete firmado en staging; el helper puede reanudar la verificación sin descargar otra release. Un fallo del nuevo servicio retorna al binario previo solo si la versión previa sigue dentro de `minimum_allowed_version` y no aparece en `blocked_rollback_versions`. De lo contrario, el servicio permanece detenido para recuperación manual; no se fuerza un downgrade inseguro.
- Los builds sin trust keyring embebido deshabilitan las actualizaciones y no deben distribuirse como releases operables. El workflow de tags exige la variable pública del keyring, pero la clave KMS/rol de firma y el feed aún deben configurarse fuera del repositorio.

La especificación del formato y del helper queda en el código de `product/agent/internal/updater/secure.go`, `product/agent/internal/updater/apply_windows.go`, `product/agent/cmd/nexo-agent/update_runtime.go` y `product/api/agent-update-feed.ts`.

## TPM: dos niveles de aseguramiento

1. **Nivel 1 — persistencia protegida por sistema operativo (implementado):** DPAPI machine-scope + ACL para `SYSTEM` y administradores. Funciona sin TPM. Protege el estado de escritura/lectura por usuarios estándar y sobrevive reinicios/actualizaciones normales; no ofrece resistencia criptográfica frente a administrador local, restauración de disco/VM ni reemplazo del host.
2. **Nivel 2 — ancla monotónica TPM (opcional, no implementada):** almacenar/validar el high-water mark en TPM 2.0 con una política de plataforma y contador monotónico/no-volátil, vinculado a arranque medido donde el hardware/Windows lo permita. Requiere provisionamiento, prueba de contador, política de recuperación ante cambio de placa/TPM, y una ruta de re-enrollment firmada. Un TPM presente por sí solo no demuestra el control.

La disponibilidad sí pudo comprobarse sin elevar privilegios: `tpmtool getdeviceinformation` informó **TPM Present=True, TPM 2.0, initialized, ready for storage y attestation** (fabricante Nuvoton). `Get-Tpm` y la consulta WMI devolvieron **Access denied / Administrator privilege required**; no se intentaron cambios de propietario, NV index, política PCR o aprovisionamiento. Por tanto el dispositivo existe y está listo según `tpmtool`, pero el nivel 2 sigue **NOT RUN** y su contador/política no están validados.

## Restauración por pérdida total de host

El runbook [total-host-loss](runbooks/total-host-loss.md) reconstruye un destino aislado desde respaldos consistentes, restaura configuración/identidades de control y material de emisión autorizado, reaplica revocaciones/checkpoint, mantiene cuarentena y mide el resultado. Los objetivos aprobados son RPO ≤24 h y RTO ≤4 h, con inicio y fin definidos para que puedan medirse con `scripts/f12-recovery-metrics.mjs`.

El respaldo diario de EBS/EC2 configurado en `infra/aws/lab/backup.tf` no demuestra consistencia de PostgreSQL, recuperación de PKI/secretos ni restore. No se ejecutó ninguna operación AWS en este cambio. El restore productivo y PV12 permanecen abiertos hasta que exista evidencia de un ejercicio real aislado.

## Verificación

```bash
npm run typecheck
npm run build
node --test tests/f12-*.test.mjs tests/l07-client.test.mjs
docker run --rm -v "$PWD/product/agent:/src" -w /src golang:1.27.3-bookworm go test ./...
```

El build cruzado `windows/amd64`, las pruebas nativas Windows/DPAPI, una llamada KMS real, un rollout/rollback del SCM, el restore AWS y PV12 son evidencias separadas; no inferir PASS desde la suite local.
