# Evidencia L06

- `npm run verify:l06`: **PASS**, typecheck, 3/3 pruebas L06, pruebas Go y build del agente.
- `npm run test:l06-postgres`: **PASS**, endpoint y nodo reales sobre PostgreSQL/RLS, identidades y audiencias separadas, certificados X.509, outbox, entrega al menos una vez, heartbeat y resultados tipados.
- `npm run test:l06-restore`: **PASS**, AES-256-GCM, rechazo de clave incorrecta y alteración, checkpoint HMAC autenticado, restore en destino nuevo, cuarentena y revocación posterior al backup.
- Operación posterior al backup: **RECORDED**, ausente del snapshot y registrada como brecha de reconciliación; no se inventó su contenido ni resultado.
- `npm test`: **PASS**, 65/65 pruebas de regresión.
- `npm run check`: **PASS**, 11 requisitos, 37 criterios de aceptación y 114 entradas de catálogo.
- Contenedores temporales `nexo-l05`/`nexo-l06`: **PASS**, no quedan contenedores tras los ensayos.

## Casos cubiertos

- Idempotencia, dos dispatchers concurrentes, entrega repetida antes del ACK, allowlist cerrada y rechazo de tipo, argumentos, destino o resultado hostiles.
- Invitación, certificado, sesión, audiencia y operación de nodo separados de endpoint.
- Restore anterior a una revocación y a una operación, sin reabrir acceso ni reconstruir datos posteriores ausentes.

AWS, producción, clientes/datos reales, VPN, servicio Windows, custodia productiva de claves y recuperación completa de host: **NOT RUN**.
