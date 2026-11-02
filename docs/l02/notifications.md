# L02 — entrega SMTP de invitaciones y recuperación

El servidor de producción conecta `InvitationSink` y `RecoverySink` a un único
transporte SMTP mediante `SmtpNotificationSink`. Los mensajes son texto plano,
usan TLS implícito o STARTTLS obligatorio, y el adaptador comprueba que el
proveedor acepte al destinatario. No registra destinatarios, tokens ni el
contenido de mensajes.

## Configuración del servicio

Definir estas variables en el archivo de entorno protegido del servicio:

| Variable | Requisito |
| --- | --- |
| `NEXO_SMTP_HOST` | Host SMTP, sin esquema ni puerto. |
| `NEXO_SMTP_PORT` | Puerto entre 1 y 65535. |
| `NEXO_SMTP_TLS_MODE` | Opcional: `implicit` o `starttls`; por defecto `implicit` en 465 y `starttls` en los demás puertos. El transporte no permite SMTP sin TLS. |
| `NEXO_SMTP_USER` | Usuario SMTP. |
| `NEXO_SMTP_PASSWORD_FILE` | Ruta absoluta a un archivo de secreto legible por `nexo_runtime`; no poner la contraseña directamente en variables de entorno. |
| `NEXO_MAIL_FROM` | Dirección de remitente, sin nombre de presentación. |
| `NEXO_PUBLIC_URL` | URL HTTPS pública del API, sin credenciales, query ni fragmento. Puede incluir un prefijo de ruta. |

El secreto debe tener una sola línea y no se incluye en Git. Se recomienda
mantenerlo legible solo por root y el grupo del servicio. La configuración SMTP
se valida al iniciar; si falta o es inválida, el proceso falla en lugar de
arrancar con entrega deshabilitada. El inicio no abre una conexión SMTP ni
verifica credenciales remotas; la conectividad solo se ejercita al enviar un
mensaje real.

## Semántica y límites conocidos

- Recuperación responde `202 accepted` tanto para correos existentes como
  desconocidos. Un fallo SMTP de recuperación se registra con un código genérico
  sin cambiar la respuesta; no hay cola ni reintento automático en este corte.
- La invitación solo responde `202 pending` si SMTP acepta el destinatario. El
  registro se crea antes del envío y, ante fallo, queda un token no divulgado
  hasta su expiración (24 h). No se reintenta automáticamente.
- Los mensajes describen los endpoints API y tokens; aún no hay pantallas
  dedicadas para completar recuperación o aceptar invitaciones desde un enlace.
- Las pruebas unitarias usan un transporte stub inyectado. No prueban
  credenciales, entrega, rebotes, reputación ni configuración de un proveedor
  real. Hasta completar una prueba de extremo a extremo, SMTP permanece
  **NOT RUN** y B7 no se declara operacional.
