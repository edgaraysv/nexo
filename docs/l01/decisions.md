# Decisiones mínimas L01

Estado: **propuestas para aceptación antes de L02**. L01 no autoriza adoptar
componentes sensibles por defecto.

## ADR-L01-001 — Fronteras de producto y laboratorio

El código productivo futuro se separará de `spikes/`, fixtures y laboratorios
F01/F02. Los tokens, contraseñas, ACK y funciones SQL experimentales no son
credenciales ni contratos productivos. Un importador automático debe fallar si
un módulo de producto depende de rutas de laboratorio.

**Alternativa rechazada:** reutilizar el endpoint experimental como enrollment
productivo. No contiene invitación limitada, prueba de posesión, aprobación ni
revocación real.

## ADR-L01-002 — Persistencia y aislamiento

Se conserva la decisión aceptada de NestJS/Fastify/PostgreSQL y monolito
modular con workers. ORM/migraciones y RLS siguen pendientes de spike y
aceptación. El contexto de empresa debe derivarse de sesión/membresía en el
servidor; `tenant_id` del navegador nunca autoriza.

Antes de L02 se debe probar el aislamiento de API, consultas, pool/conexiones,
colas, archivos y exportaciones. Si se adopta RLS, el rol runtime no puede ser
owner ni tener `BYPASSRLS` y debe probarse el contexto transaccional.

## ADR-L01-003 — Identidad humana y de dispositivo

Las personas usarán usuario/contraseña y MFA según rol. El cliente tendrá
identidad propia basada en claves generadas localmente y certificado individual
de dispositivo; no guardará la contraseña humana. Emisión/CA, mTLS o alternativa,
rotación, TTL y offline quedan bloqueados por D05 antes de emitir credenciales.

## ADR-L01-004 — Configuración y secretos

La configuración normal será tipada, versionada, con ámbito, revisión, preview,
auditoría y validación. Secretos se gestionarán por referencia o entrada de
reemplazo de solo escritura; nunca se devolverán por GET/exportación. Claves
privadas de dispositivos, firma/CA y cifrado no serán exportables desde el
panel. Para AWS se prefieren roles y credenciales temporales; no se usarán
claves root ni se contactará AWS en L01.

## ADR-L01-005 — Evidencia y retorno

Cada comprobación debe quedar como `PASS`, `FAIL`, `NOT RUN` o `BLOCKED`, con
entorno y artefacto. Los fallos de L01 se corrigen en documentación/validador;
no se reescriben fuentes históricas. El reporte es reproducible y no contiene
secretos.

## Puertas de aceptación

| ID | Decisión | Bloquea |
| --- | --- | --- |
| D01 | Frontend y estados/accesibilidad mínimos | UI de L02 |
| D02 | ORM/migraciones y aislamiento/RLS | Persistencia de L02 |
| D03 | Identidad humana, MFA, recuperación y sesiones | Autenticación de L02 |
| D04 | Cifrado, custodia y restore en cuarentena | Material sensible y recuperación |
| D05 | Servicio endpoint/nodo, certificado, transporte, rotación y offline | L05 |
| D06 | UI/IPC/empaquetado Windows | L07 |
| D07 | Metas de carga/recuperación y fuente post-backup de revocaciones | Cierre L08 |

Ninguna puerta se considera aceptada solo porque exista este documento.
