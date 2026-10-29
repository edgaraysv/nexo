# Runbook local — backup del control

1. Crear un snapshot consistente de PostgreSQL con `pg_dump --no-owner --no-acl` y registrar la versión de esquema compatible.
2. Incluir configuración necesaria, metadata de roles mínimos y material de emisión autorizado. No incluir claves privadas de endpoints.
3. Cifrar y autenticar el payload completo con AES-256-GCM y una clave aleatoria de 32 bytes identificada por generación.
4. Guardar archivo cifrado y clave/checkpoint en ubicaciones separadas con permisos mínimos. En el corte local permanecen en el mismo equipo: no cuentan como recuperación de host.
5. Verificar inmediatamente descifrado, hash, generación de clave y ausencia de plaintext sensible en el archivo.
6. Conservar generaciones antiguas mientras existan backups retenidos que dependan de ellas; probarlas antes de retirar una clave.

El RPO local es el punto del snapshot. No hay PITR ni copia continua.
