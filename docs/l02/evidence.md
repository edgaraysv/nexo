# Evidencia L02

## Resultado

- `npm run verify:l02`: PASS para compilación, tipos y 11 pruebas específicas de identidad/producto.
- `npm run test:l02-postgres`: PASS con PostgreSQL `17.6-bookworm`, migración, RLS y recorrido real de identidad/recuperación.
- `npm test`: PASS, 45/45 pruebas de regresión del repositorio.
- `npm run check`: PASS; trazabilidad F01 y hashes de fuentes preservados.
- AWS, servicios externos, datos/clientes reales: NOT RUN.

## Controles demostrados

- Contraseña scrypt con sal y rechazo de contraseña errónea.
- TOTP válido/inválido y secreto sellado AES-256-GCM con detección de alteración.
- No enumeración básica en solicitud de recuperación, token de un uso y revocación de sesiones al recuperar.
- Sesión opaca almacenada como hash, expiración/revocación y cambio de tenant que invalida el token anterior.
- Empresas visibles después de MFA; selección verificada contra membresías del servidor.
- RLS forzada: sin contexto no hay filas; tenant A y B no se cruzan; rol runtime `NOSUPERUSER`/`NOBYPASSRLS`.
- UI mínima con estados de acceso, MFA y selector; token solo en memoria.
- JSON malformado responde con error saneado y cinco fallos de contraseña activan limitación local temporal.

## Límites

El proveedor de recuperación es un adaptador local de pruebas. No hay SMTP/IdP,
rate limiter distribuido, TLS productivo, clave maestra custodiada ni auditoría
de seguridad independiente. El PASS prueba el corte local, no producción.
