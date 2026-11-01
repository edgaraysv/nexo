# F12 — runbook de custodia y publicación firmada

## Límites y roles

- Custodio de la clave KMS: administra política y disponibilidad; no exporta clave privada.
- Operador de release: publica desde un artefacto trazable y con aprobación del cambio.
- Dos custodios internos de tres aprueban alta/rotación de clave o elevación de época; conservar ticket, IDs de aprobadores, versión, key ID, digest del paquete y fecha.
- El job de compilación no recibe permiso `kms:Sign`. La identidad de firma debe ser distinta y limitada al KMS key ARN autorizado; usar federación/OIDC de CI, no access keys permanentes. La política IAM exacta depende de cuenta/organización y no se crea en este cambio.

## Preparación de clave (fuera de este cambio)

1. Crear una clave asimétrica KMS de `SIGN_VERIFY` con `ECC_NIST_EDWARDS25519` en una región que lo soporte. No reutilizar la clave KMS de backups, CA, VPN ni cifrado de secretos.
2. Restringir `kms:Sign` a la identidad de publicación aprobada y registrar las llamadas en CloudTrail. La identidad que distribuye el software solo necesita la clave pública.
3. Obtener el DER público mediante el procedimiento KMS aprobado y convertirlo a raw Base64: `node scripts/kms-ed25519-public-key.mjs <public-key.der>`.
4. Añadir el ID estable y la clave raw al keyring JSON, codificar el JSON completo a Base64 y establecer el valor de repositorio `NEXO_AGENT_UPDATE_TRUST_KEYS_B64`. El keyring es público; proteger su integridad de cambios no aprobados.
5. Validar un tag/candidato con permisos de firma de prueba antes de habilitar un release. En este sprint no se configuró una clave ni se hizo una llamada KMS.

## Firma de manifiesto

Requisitos: agente Windows `nexo-agent.exe` construido con el keyring vigente, `aws` CLI autenticado con una sesión aprobada, región del KMS, el ARN/ID de la clave y aprobación del release.

```bash
export NEXO_AGENT_UPDATE_KMS_KEY_ID='arn:aws:kms:<region>:<account>:key/<id>'
export NEXO_AGENT_UPDATE_SIGNING_KEY_ID='release-2026-01'
export NEXO_AGENT_UPDATE_TRUST_KEYS_B64='<base64-json-keyring>'
export AWS_REGION='<region>'
npm run sign:agent-release -- \
  product/agent/bin/nexo-agent.exe release/agent-feed \
  0.2.0 1 1 0.1.0 0.2.0
```

Los argumentos son paquete, raíz del feed, versión de agente, `metadata_version`, `security_epoch`, `minimum_current_version` y `minimum_allowed_version`. El script calcula tamaño/hash, crea metadatos con vigencia de 30 días, firma bytes JSON estables usando KMS `RAW`/`ED25519_SHA_512`, verifica la respuesta con la clave pública embebida, valida la firma del manifiesto previo y rechaza metadatos no monotónicos, y emite:

```text
release/agent-feed/current/manifest.json
release/agent-feed/0.2.0/nexo-agent.exe
```

La versión del artefacto es inmutable. Para renovar vigencia sin cambiar el EXE se vuelve a firmar el mismo paquete con `metadata_version` mayor; no bajar versión, época ni mínimo permitido. `minimum_allowed_version` determina si se permite rollback local tras fallo de health: si el agente previo queda por debajo, el helper lo deja bloqueado. Mantener sincronizados los relojes de control, CI y endpoint; un reloj adelantado/atrasado puede hacer que el agente rechace metadatos, siempre fail-closed. La API sirve estos archivos solo cuando `NEXO_AGENT_UPDATE_DIR` apunta a la raíz validada del feed. La copia al entorno de publicación debe ser atómica y conservar ambos caminos/versiones; no está automatizada ni ejecutada en este corte.

La firma de este manifiesto no reemplaza Authenticode, firma del instalador, revisión de código, SBOM/provenance ni autorización de despliegue. La firma del artefacto de release existente sigue siendo attestations de procedencia.

## Rotación o compromiso

1. Suspender nuevas publicaciones con la clave comprometida y preservar audit logs.
2. Dos de tres custodios aprueban la época nueva, la clave KMS nueva y el alcance de clientes afectados.
3. Construir un agente confiable con keyring solapado; aprobarlo desde la clave vigente si todavía es segura. Para pérdida/compromiso total, usar procedimiento de recovery/root de emergencia revisado; este bootstrap no está automatizado.
4. Publicar una release de reparación con `security_epoch` superior, `metadata_version` superior y `minimum_allowed_version` elevado para excluir versiones comprometidas.
5. Validar firma y distribución en laboratorio, retirar la clave antigua solo con evidencia de clientes soportados actualizados, y documentar excepciones offline.

No incluir claves privadas de firma en backup/restore de host. La recuperación/rotación de KMS y de claves de CA/PKI son procedimientos de custodia diferentes.
