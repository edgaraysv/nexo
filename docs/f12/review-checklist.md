# F12 — checklist de segunda lectura interna

La segunda lectura es una revisión interna acotada del diff y de evidencia local. No sustituye ejecución Windows/AWS, auditoría independiente externa ni autorización productiva.

## Checklist

- [x] El material privado de firma no aparece en código/configuración/artefactos F12; no se configuró ni exportó clave privada KMS.
- [x] KMS usa `ED25519_SHA_512` con `RAW`; Go recibe clave raw de 32 bytes y firma de 64 bytes. La revisión del 31-10 comprobó el vector cruzado local; el ensayo KMS live posterior (01-11) y el resultado Go constan en [evidencia F12](evidence.md).
- [x] El release verifica la firma KMS con keyring embebido y rechaza distintos bytes bajo el mismo semver; valida también firma/monotonicidad del manifiesto previo.
- [x] El agente autentica el feed, limita bytes, rechaza redirecciones y no acepta ruta/comando de UI; el paquete se transmite en stream acotado.
- [x] Firma, hash, OS/arquitectura, expiración, metadata version, epoch y mínimo persistente se verifican antes de staging.
- [x] La versión/hash instalados solo avanzan tras health check; metadatos de misma versión requieren hash activo firmado; SCM+IPC valida estado y versión esperada; rollback respeta `minimum_allowed_version` y `blocked_rollback_versions`; candidatos interrumpidos requieren coincidencia con paquete/manifiesto firmado.
- [x] DPAPI/ACL y límites ante admin/restauración están descritos; TPM nivel 2 es opcional y no implementado; presencia lab verificada por `tpmtool`, provisión/contador no ejecutados.
- [x] El runbook ordena destino nuevo, punto consistente, cuarentena, revocaciones/checkpoint y registro de brechas; el ejercicio real sigue NOT RUN.
- [x] El medidor usa timestamps observados y límites definidos; fixtures sintéticos están etiquetados y no se llaman producción.
- [x] PASS/FAIL/NOT RUN/BLOCKED se contrastaron con la evidencia disponible; no se declara aceptación productiva.

## Registro

| Revisor (nombre/identidad) | Fecha | Resultado | Hallazgos / referencias |
|---|---|---|---|
| OpenCode GPT-6 Luna Fast (IA; misma sesión que implementó, no revisor humano independiente) | 2026-10-31 | PASS WITH OPEN GATES | Segunda pasada interna del checklist y diff F12. `npm run verify:f12` 11/11, `npm test` 149/149, Go tests/vet y cross-build Windows PASS. KMS real, ejecución Windows/DPAPI/SCM y restauración AWS continúan NOT RUN; por ello no es aceptación productiva ni revisión independiente. |
