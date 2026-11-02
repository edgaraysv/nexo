# Evidencia — invitaciones y recuperación desde el portal de cuenta

**Fecha:** 2026-11-01

**Alcance:** portal web NEXO, endpoints de invitación/recuperación y formato SMTP. Solo pruebas locales con repositorios en memoria y transporte SMTP simulado; no se enviaron correos reales ni se usaron datos de clientes.

## Comportamiento implementado

- `GET /account` ofrece inicio de sesión + MFA, aceptación de invitaciones, solicitud de recuperación y establecimiento de contraseña nueva.
- Los correos SMTP incluyen el enlace HTTPS al portal `/account` y el token opaco en el cuerpo; no llevan tokens en la URL.
- La aceptación puede usar una sesión autenticada existente o el token de selección de 5 minutos emitido después de contraseña + MFA. El servidor vincula el token de invitación con el correo autenticado, valida vigencia/uso en el repositorio, consume la selección y crea una sesión para la empresa aceptada.
- Los tokens de recuperación conservan la validación server-side de un solo uso/expiración y la revocación de sesiones. El formulario no revela si una cuenta existe.
- El handoff a `/company` mantiene el token de sesión en memoria de página; para navegar entre vistas se transfiere temporalmente mediante `sessionStorage` de una pestaña y se elimina inmediatamente al cargar el portal.

## Verificación

- `npm run build`: **PASS**.
- `node --test tests/account-access.test.mjs tests/mail-sink.test.mjs tests/l02-product.test.mjs tests/l04-company.test.mjs`: **PASS, 18/18**.
- `npm test`: **PASS, 157/157** (includes build and the full existing suite).
- La prueba integrada obtiene los tokens del transporte SMTP simulado, verifica el rechazo sin MFA y con correo distinto, acepta la invitación, usa la nueva sesión, solicita recuperación, restablece contraseña y verifica revocación de la sesión previa y rechazo de reuso del token.
- La prueba de UI verifica las rutas/formularios, `no-store`, el JavaScript inline parseable y el retiro del handoff de `sessionStorage`.
- Un primer pase de pruebas dio **17/18** por una expresión regular de test que no escapaba paréntesis al construir el patrón. Se corrigió únicamente la aserción; el segundo pase quedó **18/18**. No fue un fallo del flujo funcional.
- **NOT RUN:** SMTP real, navegador/WebView visual, pruebas PostgreSQL de aceptación y despliegue. La seguridad de autorización continúa validándose en el servidor.
