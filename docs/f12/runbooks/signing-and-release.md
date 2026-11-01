# F12 — runbook de custodia y publicación firmada

## Límites y roles

- Custodio de la clave KMS: administra política y disponibilidad; no exporta clave privada.
- Operador de release: publica desde un artefacto trazable y con aprobación del cambio.
- Para F13/producción, dos custodios internos de tres aprueban alta/rotación de clave o elevación de época; conservar ticket, IDs de aprobadores, versión, key ID, digest del paquete y fecha. Este control no se aplicó al ensayo de un operador en AWS lab F12.
- Para producción, el job de compilación no recibe permiso `kms:Sign`; la identidad de firma debe ser distinta, limitada al KMS key ARN autorizado y federada por OIDC, sin access keys permanentes. La política de producción depende de la cuenta/organización y sigue pendiente. La policy IAM específica del rol de lab se documenta abajo y no debe promoverse a producción.

## Preparación de clave para producción

1. Crear una clave asimétrica KMS de `SIGN_VERIFY` con `ECC_NIST_EDWARDS25519` en una región que lo soporte. No reutilizar la clave KMS de backups, CA, VPN ni cifrado de secretos.
2. Restringir `kms:Sign` a la identidad de publicación aprobada y registrar las llamadas en CloudTrail. La identidad que distribuye el software solo necesita la clave pública.
3. Obtener el DER público mediante el procedimiento KMS aprobado y convertirlo a raw Base64: `node scripts/kms-ed25519-public-key.mjs <public-key.der>`.
4. Añadir el ID estable y la clave raw al keyring JSON, codificar el JSON completo a Base64 y establecer el valor de repositorio `NEXO_AGENT_UPDATE_TRUST_KEYS_B64`. El keyring es público; proteger su integridad de cambios no aprobados.
5. Validar un tag/candidato con permisos de firma de prueba antes de habilitar un release. La clave y el rol descritos en la sección siguiente son exclusivos del AWS lab; no constituyen la identidad OIDC ni la clave aprobada para producción.

## KMS configurado para el ensayo F12 en AWS lab

- Clave: `arn:aws:kms:us-east-1:423597267645:key/3f3b6523-8b33-4921-bbbb-e25140e9b4c7`; spec `ECC_NIST_EDWARDS25519`, uso `SIGN_VERIFY`, estado `Enabled`, alias `alias/nexo-lab-423597267645-us-east-1-agent-release-signing`.
- Rol de firma: `arn:aws:iam::423597267645:role/nexo-lab-signer`; trust restringido al operador IAM `nexo-lab-admin` para asumir este rol en el ensayo.
- La key policy concede `kms:Sign` y `kms:Verify` únicamente al rol, con `kms:SigningAlgorithm=ED25519_SHA_512`. La policy inline IAM del rol repite esa restricción y limita el recurso al ARN anterior. No concede `kms:CreateKey`, `kms:DeleteKey` ni `kms:ScheduleKeyDeletion`.
- El principal root de la cuenta conserva administración/lectura/recuperación y gestión del alias, incluida `kms:PutKeyPolicy`; su declaración no contiene `kms:Sign` ni `kms:Verify`. Es una capacidad administrativa de recuperación, no permiso criptográfico ordinario.
- Prueba real del 2026-11-01: se asumió el rol, KMS firmó el manifiesto sintético de 431 bytes con `RAW`/`ED25519_SHA_512`, la firma resultó de 64 bytes, `KMS Verify` devolvió `true`, y el verificador Go `VerifySecureManifest` aceptó el manifiesto usando la clave pública raw de 32 bytes. Vector persistente y detalle: [evidencia F12](../evidence.md).
- El ensayo no usó ticket ni aprobación 2-de-3; esos controles se reservan a F13/producción. No se configuró CloudTrail como evidencia de auditoría, GitHub Actions, el feed ni una release Windows. No copiar esta clave/rol de lab a producción.

## Firma de manifiesto

Requisitos para publicar: agente Windows `nexo-agent.exe` construido con el keyring aprobado, `aws` CLI autenticado con la sesión aprobada (rol de publicación, no identidad de build), región del KMS, ARN/ID de la clave y aprobación del release. El rol interactivo de lab anterior es solo para el ensayo documentado.

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
