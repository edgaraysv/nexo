# Evidencia L05

## Verificaciones

- `npm run verify:l05`: tipos, 5/5 pruebas API, pruebas Go, build Windows y prueba DPAPI nativa: **PASS**.
- `npm run test:l05-postgres`: agente Go real + API + PostgreSQL/RLS + emisor X.509: **PASS**.
- `npm test`: regresión completa **62/62 PASS**.
- Certificado emitido verificado contra la CA local y sujeto ligado al ID: **PASS**.
- Renovación conserva ID y cambia serie; certificado anterior deja de autenticar: **PASS**.
- Revocación invalida la sesión existente y autenticaciones posteriores: **PASS**.
- Competencia por un cupo admite exactamente un endpoint: **PASS**.

## Casos negativos cubiertos

- Invitación vencida/agotada, audiencia de nodo, cuota llena.
- Clave distinta, desafío repetido y reclamación repetida.
- Pendiente sin aprobación, certificado ajeno y serie anterior tras renovación.
- Reintento con la misma clave conserva el ID y no consume otra cuota.

AWS, producción, clientes reales, servicio Windows instalado, TPM/PKCS#11, mTLS, VPN y acciones offline: **NOT RUN**.
