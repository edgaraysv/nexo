# Priorización de bloqueos técnicos para v1

**Fecha:** 6 de noviembre de 2026

**Estado:** clasificación vigente derivada del alcance v1 aprobado

**Alcance:** ordena trabajo y gates; no autoriza cambios en AWS, migraciones persistentes, datos reales ni un piloto.

## Resumen ejecutivo

Los cinco hallazgos del diagnóstico son reales, pero no todos bloquean la v1 después de retirar soporte remoto, WireGuard y el cliente universal propio del camino crítico.

| Hallazgo | Clasificación para v1 | Decisión operativa |
|---|---|---|
| F08/F11: rutas privadas | **F08 condicionalmente bloqueante; F11 diferido** | OpenVPN es el motor de v1. Implementar gateway/retorno/SNAT/split-DNS sólo en el alcance exigido por el recurso real de Disamed. WireGuard no bloquea el piloto. |
| F10: transporte remoto | **Diferido** | Soporte remoto está fuera de v1. Mantener `support_transport_disabled` y no mostrarlo como operativo. |
| AWS: BD/TLS/Terraform | **P0 bloqueante** | No desplegar ni ejecutar `terraform apply` hasta inventariar y reconciliar estado, TLS, red, migraciones y retorno. |
| F12: updater/Authenticode/PV12 | **PV12 bloqueante; updater diferido** | La recuperación total del control sí bloquea datos reales. Authenticode, TPM monotónico y rollout SCM corresponden al cliente propio posterior. |
| F13: migración/correo | **P0 bloqueante** | Implementar inventario, cohorte, cutover, switchback selectivo y notificaciones reales antes del piloto. |

## Bloqueo activo A — Definir el trayecto real de Disamed

F08 sólo ejecuta hoy el trayecto directo IPv4 con destinos `/32`. No aplica gateway, `ccd`/`iroute`, retorno `routed|snat`, split-DNS ni reglas positivas `source_kind=device`. F11 sólo asigna la IP `/32` del peer y rechaza rutas privadas.

Antes de implementar rutas se debe inventariar:

1. ubicación y CIDR del recurso privado al que accederán los vendedores;
2. si el recurso está detrás de la LAN de oficina, en AWS o en otro proveedor;
3. necesidad de DNS privado y sufijos concretos;
4. ruta de retorno disponible o necesidad de SNAT privado;
5. plataforma prioritaria y cliente VPN existente;
6. puertos/protocolos autorizados y prueba de revocación.

Si el recurso está detrás de una LAN, F08 gateway es bloqueante y debe cubrir como mínimo OpenVPN `ccd`/`iroute`, una estrategia de retorno aprobada, filtrado por política, observación y cleanup. Si el recurso es alcanzable por el trayecto directo ya probado, el vertical slice puede comenzar sin implementar toda la conectividad de sucursales. No se implementará WireGuard para cerrar este gate.

**Criterio de salida:** un endpoint de Disamed accede únicamente al recurso privado autorizado; Internet sigue local; la revocación corta el acceso; otro tenant no es afectado; el resultado queda observado y auditado.

## Bloqueo activo B — Reconciliar AWS antes de cualquier despliegue

La base AWS recibió migraciones manuales sin `public.nexo_schema_migrations`; faltan `023` y `024` y existe un `GRANT` manual. El TLS de la IP pública venció el 4 de noviembre de 2026. Hay Security Groups y exposición de Webmin fuera de Terraform. El repositorio ya prohíbe aplicar sobre este estado no reconciliado.

Orden seguro:

1. congelar mutaciones y realizar inventario de sólo lectura de EC2, SG, red, DNS/IP, certificados, PostgreSQL, migraciones, servicios y versiones;
2. capturar respaldo y procedimiento de retorno antes de modificar recursos;
3. comparar Terraform con el estado real y clasificar cada diferencia como importar, codificar, reemplazar o retirar;
4. crear un destino PostgreSQL limpio con ledger y aplicar `production` 001–024, en vez de inventar historial sobre una base no reconciliada;
5. definir migración de datos explícita si existe información que deba conservarse;
6. establecer endpoint estable y TLS renovable con una opción compatible con el techo mensual aprobado;
7. retirar la exposición pública de Webmin y usar un plano administrativo restringido;
8. ejecutar plan de sólo lectura, revisar cambios y autorizar por separado cualquier apply.

**Criterio de salida:** historial 001–024 verificable, grants reproducibles sin correcciones manuales, TLS válido y renovable, drift conocido/cerrado, plan sin cambios destructivos inesperados y rollback documentado. Ningún `apply` se deduce de este documento.

## Bloqueo activo C — Herramientas de migración y piloto F13

El producto necesita una operación explícita por cohorte; los endpoints genéricos no sustituyen el cutover.

Entregables mínimos:

1. inventario de usuarios, perfiles, certificados, rutas y dependencias del OpenVPN/Webmin anterior;
2. importación o reconciliación idempotente con reporte de conflictos, sin copiar claves privadas de forma insegura;
3. definición inmutable de una cohorte piloto y sus condiciones de parada;
4. preflight que compruebe cliente, credenciales, rutas, retorno, DNS, recurso y observabilidad;
5. activación escalonada por cohorte;
6. switchback selectivo al servidor anterior sin alterar otros grupos;
7. conciliación posterior de credenciales, rutas, estado y auditoría;
8. evidencia de una semana operativa sin incidentes críticos antes de ampliar la migración.

**Criterio de salida:** una cohorte pequeña de Disamed puede activarse, observarse, revocarse y regresar al servicio anterior sin intervención no documentada ni efecto sobre otros clientes.

## Bloqueo activo D — Notificaciones reales

El `mail-sink` y `NullNotificationSink` son mecanismos de desarrollo. Antes del piloto debe existir un canal real para invitaciones y recuperación de cuenta. Amazon SES es el candidato indicado, no una integración ya aprobada ni configurada.

La implementación debe cubrir dominio/remitente verificado, salida del sandbox cuando corresponda, plantillas sin secretos en logs, tokens de un solo uso, expiración, rebotes/quejas, límites de envío, reintentos idempotentes, auditoría y una ruta operativa cuando falle la entrega.

**Criterio de salida:** invitación y recuperación llegan a una dirección controlada, los tokens no aparecen en logs, un fallo de entrega queda visible y reintentable, y rebotes/quejas no se ignoran.

## Bloqueo activo E — Recuperación integral PV12

PV12 permanece bloqueado aunque exista evidencia parcial de restore y revocación. Antes de datos reales se debe reconstruir el control en un destino nuevo, restaurar PostgreSQL/PKI/configuración, preservar revocaciones, mantener cuarentena, verificar aislamiento y medir RPO/RTO con evidencia trazable.

**Criterio de salida:** ejercicio integral reproducible conforme a `docs/f12/runbooks/total-host-loss.md`, con IDs/evidencia enlazados y revisión independiente. Una snapshot o un control puntual no cierran PV12.

## Trabajo diferido que no bloquea v1

### F10 — Soporte remoto

Conservar el modelo y los spikes, pero no integrar transporte en v1. El HTTP 503 seguro es el comportamiento esperado mientras la capacidad esté deshabilitada. La futura evaluación deberá resolver consentimiento humano, mapeo de RBAC y terminación explícita de sesiones activas.

### F11 — WireGuard

No completar rutas privadas ni aceptación Windows para el piloto. OpenVPN es el motor de v1. F11 vuelve al roadmap después de una migración OpenVPN estable.

### F12 — Cliente propio, Authenticode y TPM

El ciclo SCM, Authenticode, updater y TPM monotónico se retoman cuando se autorice el cliente universal propio. No confundirlos con PV12: la recuperación del servidor sigue siendo obligatoria ahora.

## Orden de ejecución

1. Inventario funcional de Disamed y selección del trayecto mínimo.
2. Inventario AWS de sólo lectura y diseño de reconciliación.
3. Implementación local del F08 mínimo que el inventario demuestre necesario.
4. Herramientas F13 de inventario, cohorte, cutover y switchback.
5. Canal real de notificaciones.
6. Despliegue controlado sobre infraestructura reconciliada, sujeto a autorización separada.
7. Ejercicio PV12 y gates de seguridad/operación.
8. Piloto Disamed con autorización explícita.

## Evidencia principal

- `docs/f08/README.md`
- `docs/f10/README.md`
- `docs/f11/README.md`
- `docs/f12/README.md`
- `docs/f12/runbooks/total-host-loss.md`
- `docs/sprint-status.md`
- `docs/evaluations/meshcentral-1.3.1-spike.md`
- `docs/migrations/README.md`
- `docs/f13/gate-s3/GATE-S3-REPORTE-V3.md`
- `docs/Analisis_Viabilidad_y_Bloqueos_Nexo_AWS.md`
