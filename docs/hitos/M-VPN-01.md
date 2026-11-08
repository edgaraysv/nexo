# M-VPN-01 — Plataforma lab AWS operativa con HTTPS, migraciones y correo

## Apertura

- **Hito:** M-VPN-01 — Plataforma lab AWS operativa: HTTPS, migraciones aplicadas, ZeptoMail funcional.
- **Etapa:** VPN-OpenVPN / infraestructura base. Este hito valida que el lab AWS responde, el schema está actualizado y el correo de alta funciona; no acredita conectividad VPN ni enrolamiento de endpoints.
- **Fecha y zona horaria:** 2026-11-07, UTC−06:00.
- **Fuente:** reporte de cierre transcrito en la conversación; puntos verificados por el usuario en la instancia AWS real.
- **Repositorio, rama y commit base:** `C:\laragon\www\nexo`, `master`, anterior a `6e75985`.
- **Lab, entorno local o CI:** instancia AWS EC2 (AMI al2023, Account ID 423597267645); acceso por SSM; Node directo (npm no disponible en EC2). PostgreSQL en RDS. ZeptoMail como proveedor SMTP.
- **Prerrequisitos:** infraestructura AWS provisionada; dominio y TLS configurados; migraciones previas aplicadas.
- **Flujo:** verificar HTTPS en la instancia; aplicar migraciones pendientes con Node directo; verificar ledger; enviar correo de prueba vía ZeptoMail; confirmar que TCP/10000 está limitado al CIDR autorizado.
- **Resultado esperado:** HTTP/2 200 en el endpoint de salud; ledger con 24 entradas; correo aceptado con Message-ID; puerto 10000 inaccesible desde rangos no autorizados.

| ID | Obligatoria | Tipo | Comando exacto o pasos | Resultado esperado | Evidencia requerida y actor |
|---|---|---|---|---|---|
| P1 | Sí | Integración real AWS | `GET https://[dominio]/v1/health` | HTTP/2 200 `{"status":"ok"}` | Respuesta HTTP observada; operador en la instancia. |
| P2 | Sí | Integración real AWS | Aplicar migraciones con Node directo; `node scripts/check-migration-history.mjs` | Ledger con 24 entradas, sin huecos | Salida del comando; operador. |
| P3 | Sí | Integración real AWS | Enviar correo de prueba vía ZeptoMail | Correo aceptado; Message-ID devuelto | Message-ID del log de envío; operador. |
| P4 | Sí | Integración real AWS | Intentar conexión a TCP/10000 desde IP no autorizada | Conexión rechazada o timeout | Resultado de la prueba de conectividad; operador. |

## Continuación

- **Estado actual:** PASS en instancia AWS real.
- **Hallazgos durante la ejecución:** `npm` no está instalado en EC2; las migraciones deben ejecutarse con Node directamente. ZeptoMail reemplaza Amazon SES en este entorno de lab. Los grants de `support_consent`/`support_sessions` en `nexo-runtime.sql` debían ser condicionales para no fallar en perfiles que excluyen F10; corregido en el commit de este hito.

## Cierre

- **Fecha y zona horaria:** 2026-11-07 (UTC−06:00).
- **Versión evaluada:** SHA `6e75985` en `master`. Commit de cierre: `6e75985`.
- **Cambios del hito:** `infra/aws/lab/main.tf` añade `aws_security_group.web` (HTTP/HTTPS) separado del SG admin y regla de salida SMTP para ZeptoMail; `nexo-runtime.sql` hace condicionales los grants de F10; `product/api/application.ts` agrega `GET /v1/health`; `tests/product-health.test.mjs` verifica el endpoint; `infra/aws/lab/opentofu-provider.lock.hcl` separa el lock de OpenTofu de Terraform.

| ID | Comando, pasos o corrida | Tipo | Resultado | SIMULADA | Versión, entorno y evidencia |
|---|---|---|---|---|---|
| P1 HTTPS | `GET /v1/health` en instancia AWS real | integración real AWS | **PASS** | No | HTTP/2 200; respuesta `{"status":"ok"}`; instancia EC2 al2023. |
| P2 Migraciones | Migraciones aplicadas con Node directo; ledger verificado | integración real AWS | **PASS** | No | Ledger con 24 entradas; sin huecos; Node directo (npm ausente en EC2). |
| P3 ZeptoMail | Correo de prueba enviado | integración real AWS | **PASS** | No | Correo aceptado; `Message-ID: <d152da2f-783c-61a1-4fc1-0cffa68e36d1@sysmedia.net>`. |
| P4 Puerto 10000 | TCP/10000 limitado a 190.5.151.74/32 | integración real AWS | **PASS** | No | Puerto inaccesible desde rangos no autorizados; regla SG verificada. |

- **Pendiente conocido no bloqueante:** administración por SSM conservada; portal completo requiere Next.js 15 + React 19 (fuera del alcance de este hito).
- **Veredicto:** **PASS** para M-VPN-01: HTTPS, migraciones (24 entradas), ZeptoMail y restricción de puerto verificados en instancia AWS real.
- **Evidencia:** verificación directa en instancia EC2 al2023; commit `6e75985` en `master`.
