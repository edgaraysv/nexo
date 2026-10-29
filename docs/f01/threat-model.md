# Modelo mínimo de amenazas y fronteras

Alcance: diseño del producto y superficie acotada del experimento. Las mitigaciones futuras no se declaran implementadas por estar en esta tabla.

Activos: identidad de endpoint, invitaciones, credenciales, configuración de red, contratos y cuotas, sesiones remotas, material de firma/emisión, backups y auditoría. Actores: proveedor/operador, administrador/técnico/auditor empresarial, usuario final, nodo/endpoint y atacante sin membresía.

Fronteras: navegador→API; API→BD/outbox; worker→nodo; UI local→servicio privilegiado; entorno empresarial→host/otra empresa; portal→motor remoto; endpoint→repositorio; pipeline→cliente.

| Amenaza | Control requerido | Evidencia/gate | Situación F01 |
| --- | --- | --- | --- |
| IDOR o tenant suministrado por cliente | Membresía autenticada, recurso+acción, integridad tenant en todas las superficies | PV01; F03/F09/F10/F12 | Solo fixture y función SQL del corte |
| Cupo excedido, replay o escritura parcial | Transacción, serialización del cupo, idempotencia y outbox | PV03/PV09; F04/F05/F07 | Ensayo concurrente sintético |
| Agente ajeno o ACK antiguo | Identidad distinta, ámbito, revisión, expiración y reconciliación | PV09/PV13; F05/F12 | Identidad/revisión fixture; sin transporte real |
| Salida Internet por VPN | Validar rutas IPv4/IPv6 y agregados, deny, DNS split | PV02/PV20; F08/F11/F15 | NOT RUN |
| Acceso lateral, host o metadatos | Namespaces/firewall/archivos/credenciales/límites; bloquear IMDS | PV15–PV20; F06/F12 | NOT RUN |
| Escape kernel/host compartido | No cubierto por namespaces/cgroups; riesgo explícito o separar hosts | Revisión independiente antes F13 | NOT RUN, no certificación futura prometida |
| Abuso de IPC local | Servicio/UI separados, acciones acotadas y usuario autorizado | F07/F12 | NOT RUN |
| Actualización o firma comprometida | Firma, mínimo seguro, anti-downgrade, rotación/revocación y recuperación | PV10; F12 | NOT RUN |
| Remoto sin consentimiento o autorización | Contrato/rol/recurso/permiso vigente en motor; cierre real | PV05–PV07; F10 | NOT RUN |
| Restore reabre acceso revocado | Reconciliar revisiones y bloqueos, no confiar en nodo como autorización | PV09/PV12; F12 | NOT RUN |
| Exposición de secretos o datos | Secretos por ámbito, logs saneados, IAM/BD mínimos, retención legal | F02/F12/F13 | Solo fixtures públicas en laboratorio |
| Pérdida de claves/backup irrecuperable | Custodia explícita, repositorios externos por tenant y restore probado | PV12/PV14; F12/F16 | NOT RUN |

## Abuso y fallo parcial

Operaciones remotas no aceptan shell. No asumir que el primer endpoint que devuelve 202 está listo. Ante caída parcial, negar accesos no confirmados, conservar errores por destino y reconciliar sin duplicar. La vigencia offline debe decidirse antes del gate que la consume; ninguna promesa de revocación instantánea sin control.

## Laboratorio

DB sin puerto publicado; adaptadores solo loopback. Redes/volumen/proyecto Compose únicos; no montajes del host dentro de los servicios API/DB, salvo SQL de fixtures en solo lectura. No `privileged`, host networking ni socket Docker en contenedores. La CLI del runner sí tiene autoridad local de Docker: ejecutar solo en estación confiable. Credenciales estáticas de fixture y funciones SECURITY DEFINER no deben copiarse a producción.

## Incidentes y parada

Cualquier fuga empresarial, acceso indebido a host/metadatos, firma comprometida o reapertura tras restore bloquea el avance. Preservar evidencia minimizada, aislar alcance afectado, revocar confianza comprometida, restaurar/reconciliar, documentar causa y notificar según obligaciones acordadas. No activar WORM para conservar evidencia sin aprobar consecuencias legales y de eliminación.
