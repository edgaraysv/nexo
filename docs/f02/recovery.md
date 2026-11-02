# F02 / PV12 — recuperación y criterios de aceptación

**Estado al 29 de octubre de 2026: PV12 ABIERTO. Restore AWS: NOT RUN.** Este runbook no autoriza lecturas AWS autenticadas, crear/parar/reemplazar/restaurar instancias, aplicar IaC ni ejecutar migraciones en AWS. Cualquier actividad remota requiere alcance, identidad/cuenta, región, permisos, costos, riesgos, limpieza y autorización explícita separada.

La evidencia AWS disponible es histórica: última lectura documentada el 23 de octubre de 2026. En ella había 0 backup jobs, 0 recovery points y 0 snapshots propios; ese inventario no demuestra el estado actual. No se revalidó AWS en este corte. Los ensayos Docker locales solo prueban sus fixtures y no aprueban PV12.

## Inventario de cobertura y brechas

| Activo | Evidencia local | Falta para PV12 / producción |
| --- | --- | --- |
| PostgreSQL | F02 guarda `control.dump` sintético de `f02_fixture`. L08 genera un dump SQL de una base sintética con migraciones locales 001–018 y lo importa en otro volumen PostgreSQL. | No existe export consistente/restaurable observado del control AWS. Aún debe inventariarse su versión/esquema realmente desplegados, datos requeridos, extensiones, RLS, integridad y compatibilidad. Un snapshot de disco no sustituye `pg_dump`/PITR consistente. |
| Roles, ownership y ACL | F02 crea `f02_reader` desde fixture; `pg_dump` no incluye roles globales. L08 conserva metadata de un rol sintético y lo recrea explícitamente con grants de ensayo. | No se captura ni prueba la definición completa de roles, memberships, owners, grants/default privileges, credenciales ni configuración HBA del control real. La reconstrucción de prueba no equivale a recuperar esos permisos. |
| Configuración | F02 incluye `node.fixture.json`. L08 incluye un JSON mínimo (`schemaVersion`, entorno sintético y referencia de credencial). | No cubre configuración real de NEXO, systemd, PostgreSQL, TLS, DNS, host, IaC, políticas variables, agentes ni valores de secretos. La consistencia atómica entre base y configuración real no está demostrada. |
| PKI | Solo hay cadenas de certificado/clave ficticias en fixtures; L08 cifra material aleatorio sintético dentro del bundle. | No se respalda ni restaura una CA real, su clave privada de emisión, certificados/chain, CRL/OCSP, trust anchors, políticas de serial/expiración ni rotación. Tampoco se prueba firma/verificación criptográfica de certificados reales. Las claves privadas propias de endpoints no deben copiarse al control. |
| Secretos y custodia | L08 crea claves AES/HMAC aleatorias temporales y separa directorios de bundle y claves; todo permanece en el mismo host de prueba. | No cubre la clave de sellado, credenciales DB/runtime, secretos de servicios, referencias/valores de secretos reales, KMS, custodios, escrow ni recuperación desde otro dominio de fallo. El ensayo no demuestra pérdida total del host. |
| Estado de agentes y reconciliación | L08 simula una identidad aprobada, credencial y sesión; aplica desde checkpoint una revocación posterior al snapshot, cierra la sesión y registra una operación ausente. Verifica cuarentena y tenant RLS en PostgreSQL. | No contacta agentes reales ni prueba la recuperación de sus claves locales, autenticación/renovación, inventario completo, entrega/ACK/reintento de operaciones o convergencia tras reconexión. Solo prueba el comportamiento de una fixture sintética, no una reconciliación de flota. |
| Host, servicios e infraestructura | F02 reconstruye contenedores aislados; L08 restaura en volumen nuevo. | No hay reconstrucción AWS/EC2, sistema operativo, red, IAM, SSM, almacenamiento externo, balanceo, alarmas ni recuperación regional probada. |

### Lectura correcta de la evidencia

- **Local vigente del nuevo ensayo:** PASS `npm run test:l08-recovery`, reporte final `artifacts/l08/recovery-runs/6b9c0436-ebec-4117-ab0e-3984defead5a/report.json`; cubre el runner modificado y solo sus fixtures sintéticas. La lista 001–018 se ejecuta únicamente dentro de Docker local; no representa las migraciones presentes en AWS.
- Ensayos anteriores del mismo día preservados en `artifacts/l08/recovery-runs/e978dd96-8c3c-43b7-ab06-8a37d7be21ea/report.json` (PASS; 18.111 ms) y `artifacts/l08/recovery-runs/95b2bd04-756b-40cb-8c2f-1824183d8616/report.json` (PASS; 17.655 ms). Cada repetición quedó en una ruta única.
- **Local histórica:** `artifacts/f02-local/latest.json` (22-oct-2026; 7/7 y limpieza PASS) solo cubre `control.dump` y `node.fixture.json`. `artifacts/l08/recovery-report.json` (24-oct-2026) es evidencia anterior y no se debe sobrescribir.
- **AWS histórica:** última evidencia de inventario 23-oct-2026 en [evidence.md](evidence.md); no se ha revalidado el estado después de esa fecha. Restore/reconstrucción permanecen **NOT RUN**.
- Un hash/manifiesto detecta cambios accidentales respecto a ese manifiesto, pero no autentica al emisor si ambos se pueden reemplazar. Un bundle autenticado local no prueba disponibilidad de su clave desde otra ubicación.

## Propuesta RPO/RTO para aprobación del usuario

Valores **propuestos, no aprobados ni vigentes** para F02/PV12; son distintos de D07, que solo acepta la prueba L08 local.

- **RPO candidato: ≤24 horas.** Medido desde el incidente hasta el punto más reciente de una copia *consistente, completa, cifrada y verificada* de PostgreSQL, configuración necesaria, material/estado de emisión recuperable y referencias de secretos, con un checkpoint de seguridad autenticado de época igual o posterior. Si no existe un conjunto recuperable dentro de esa ventana, el objetivo falla; un snapshot diario de disco sin export consistente no satisface el criterio.
- **RTO candidato: ≤4 horas** desde la declaración del incidente hasta un control recuperado en destino aislado, con integridad verificada, credenciales expuestas tratadas, revocaciones/sesiones/brechas reconciliadas y **cuarentena todavía activa**. Incluye aprovisionamiento del destino y pruebas; no incluye aprobar la salida de cuarentena ni reabrir tráfico de clientes.
- Estos candidatos no se deducen de los 12–20 s de ensayos locales ni de D07. No hay medición AWS, carga real, tamaño productivo ni capacidad probada; factibilidad pendiente. Una copia diaria fallida o tardía incumple el RPO aunque exista una política configurada.
- Para aprobarlos hace falta decidir también retención, custodios, frecuencia/alertas, responsable de declarar incidente, ventana de mantenimiento y quién autoriza la salida de cuarentena. No registrar estos valores como aceptados hasta recibir aprobación explícita.

## Ensayo local autorizado y límites

`npm run test:l08-recovery` crea contenedores y volúmenes con UUID y etiquetas de ejecución, usa la imagen PostgreSQL fijada por digest, red `none`, sin puertos publicados, genera solo datos sintéticos y restaura a un volumen nuevo. Verifica bundle/clave, importación, roles/RLS, esquema local 001–018, configuración y material de emisión ficticios, epoch/checkpoint, cuarentena, revocación, cierre de sesión y brecha de operación. El reloj de restore empieza antes de crear el destino e incluye importación y comprobaciones; excluye limpieza. Los recursos se borran solo tras verificar etiqueta y nombre de esta ejecución; la evidencia se escribe en una ruta única con creación exclusiva (`wx`).

Es una prueba funcional local, no una exportación de AWS ni de PKI real. El bundle, las claves y el checkpoint solo se separan en directorios temporales del mismo host. `totalHostLoss` permanece **NOT_RUN**. Si el proceso recibe SIGKILL o falla el motor Docker, no se debe ejecutar `prune`: inventariar el `runId` y retirar únicamente recursos con ese label y los nombres de esa ejecución.

## Criterios acumulativos para cerrar PV12

1. Aprobar formalmente RPO/RTO, alcance, retención, custodios, alertas y responsable de recuperación. Mantenerlos distintos de D07.
2. Verificar en un corte autorizado el estado actual de la cuenta/región y un recovery point realmente completado, íntegro, disponible y descifrable; no inferir recuperabilidad de la existencia del vault, plan u objeto.
3. Inventariar de forma versionada la base y dependencias reales, configuración, roles/owners/ACL, PKI y material de emisión recuperable, referencias/custodia de secretos, estado IaC y necesidades de agentes; separar explícitamente claves privadas de endpoints que no se respaldan en el control.
4. Restaurar en destino nuevo y aislado con datos autorizados/sintéticos, sin clientes, tráfico ni cambios al origen. Verificar importación transaccional, conteos/integridad, esquema realmente desplegado, RLS/tenants, permisos mínimos, PKI/cadena/revocación y configuración.
5. Verificar checkpoint desde custodia separada; rechazar MAC inválido, época obsoleta y clave/bundle incorrectos. Reaplicar revocaciones, invalidar sesiones/credenciales, registrar operaciones ausentes sin inventar resultados y reconciliar agentes sin reactivar identidades revocadas. Mantener cuarentena hasta revisión humana explícita.
6. Medir pérdida de datos y tiempo end-to-end con los límites aprobados, incluida reconstrucción del destino; demostrar que ambos objetivos se cumplen en el perfil de carga acordado. Probar notificación de fallo y procedimiento de escalamiento.
7. Retirar únicamente los recursos de restauración identificados, comprobar limpieza, preservar backups/versiones/snapshots necesarios y guardar reporte saneado con timestamps, IDs, resultados y aprobador. Una limpieza incompleta impide PASS.
8. Aceptar explícitamente los riesgos residuales y documentar qué evidencia sigue siendo local/histórica. Un ensayo local o un job exitoso aislado no cierra por sí solo PV12.

## Riesgos fuera de este ensayo

- La evidencia AWS está fechada y su estado operativo actual es desconocido. No se hicieron lecturas autenticadas en esta tarea.
- La evidencia histórica registró un principal administrativo con acceso IAM permanente y sin MFA; su estado actual no se revalidó. MFA y retiro del acceso permanente siguen **pospuestos por decisión del usuario** y son riesgos abiertos, no mitigados por el ensayo.
- Webmin debe permanecer limitado a `190.5.151.74/32`; este trabajo no cambió ni revalidó reglas AWS.
- Un único host/AZ, administración compartida y ausencia de copia inmutable o réplica externa mantienen dominios de fallo comunes. Un snapshot no es failover y no demuestra recuperación ante pérdida regional o compromiso administrativo.
- Sin restauración íntegra desde copia limpia dentro de objetivos aprobados, **F02 permanece abierta, PV12 no se cierra y no se incorporan clientes/datos reales**.
