# D05 — identidad y almacenamiento del agente

Estado: **aceptada por el usuario para el corte local el 22 de octubre de 2026**.

## Decisión

- Servicio/agente en **Go**, compartiendo contratos pero no credenciales entre endpoint y futuro nodo proveedor.
- Claves ECDSA P-256 generadas localmente.
- Certificado X.509 individual de cliente, audiencia `endpoint`, vigencia máxima de 24 horas.
- Invitación de dispositivo: 15 minutos, uno o más usos explícitos, nunca credencial permanente.
- Desafío firmado: 2 minutos, nonce aleatorio y consumo único.
- Aprobación humana `company.admin` obligatoria antes de emitir el certificado.
- Autorización online en cada autenticación; sesión de dispositivo opaca de 5 minutos.
- Ninguna acción sensible offline. Una credencial caducada o sin frescura obliga a reconectar.
- Windows: clave PKCS#8 protegida en reposo con DPAPI de máquina; el proceso conserva el límite de que administrador local o copia en ejecución puede comprometerla.
- Linux local: archivo `0600` como adaptador de desarrollo. Producción exige TPM, PKCS#11 u otro almacén no exportable aceptado.
- Emisor local en proceso Go separado del controlador web. La CA de desarrollo no se reutiliza ni promueve a producción.

## Rotación y recuperación

- Renovar emite un certificado nuevo, marca el anterior `rotated` y conserva ID, clave e historial.
- Revocar invalida certificado y sesiones y libera el cupo, pero conserva el tombstone.
- Pérdida de clave/reinstalación usa nueva invitación y nueva identidad. Una identidad revocada nunca se reactiva silenciosamente.
- La rotación de la clave privada dentro del mismo ID queda fuera de este corte; requiere un flujo adicional firmado por clave antigua o recuperación administrativa.

## Transporte

El agente permite HTTP únicamente en loopback para desarrollo. Fuera de loopback exige HTTPS y usa la validación TLS normal de Go; no existe opción para desactivar globalmente la validación.

El mTLS de transporte, la distribución del trust anchor productivo, TPM/PKCS#11 y los leases offline permanecen para decisiones posteriores. El certificado L05 demuestra identidad en un desafío de aplicación; no es una credencial VPN.
