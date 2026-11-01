# F12 — runbook de pérdida total de host de control

**Alcance:** pérdida total de la EC2/host de control; se presupone que la cuenta AWS, la región objetivo, AWS Backup, KMS y el plano de identidad de emergencia siguen disponibles y confiables. No cubre compromiso de cuenta, indisponibilidad regional, recuperación de endpoint ni failover automático. No usar para clientes/datos reales hasta aprobar PV12 y completar el ejercicio operativo.

## Objetivos y reloj de medición

- **RPO ≤24 h:** desde la hora de declaración del incidente hasta el punto de recuperación consistente más antiguo entre base de datos, configuración, PKI/material de emisión y checkpoint externo. Si los componentes no tienen un punto consistente común, el ejercicio falla; no promediar timestamps.
- **RTO ≤4 h:** desde la declaración del incidente hasta tener el control reconstruido en un destino nuevo, aislado, con pruebas de integridad/aislamiento y reconciliación terminadas, todavía en cuarentena. Retirar cuarentena y reabrir acceso es una decisión posterior, no parte del reloj de servicio seguro.
- Guardar timestamps UTC con zona, IDs de recovery points, hash del bundle/checkpoint, versión del código/IaC, comandos, responsables y resultados. Medir con `node scripts/f12-recovery-metrics.mjs exercise-timestamps.json`.

Ejemplo de entrada para el medidor (sustituir por timestamps observados; no reutilizar los del ejemplo como evidencia):

```json
{
  "incidentDeclaredAt": "2026-10-31T12:00:00Z",
  "recoveryPointCreatedAt": "2026-10-31T00:00:00Z",
  "quarantineReadyAt": "2026-10-31T14:00:00Z"
}
```

## Precondiciones que deben existir antes de la guardia

- Backup consistente diario de PostgreSQL y configuración necesaria, con retención/monitorización y punto ≤24 h. Snapshot EBS por sí solo no prueba consistencia lógica de PostgreSQL.
- Backup recuperable de binarios/configuración e inventario de versión de esquema; artefactos/IaC verificados para reconstruir host nuevo.
- PKI/material de emisión autorizado envuelto con una clave de recuperación separada, disponible fuera del host; nunca respaldar claves privadas de endpoint.
- Claves KMS/checkpoint accesibles por identidad break-glass con MFA y permisos mínimos. Clave de firma de releases no forma parte del bundle de control.
- Checkpoint autenticado posterior al backup o una fuente externa de revocaciones/época; el HMAC local de L08 no cuenta como custodia externa.
- Responsable de incidente, operador AWS, revisor de seguridad y criterio de parada identificados.

Si cualquiera de estos elementos falta o su integridad no puede verificarse, detener y mantener servicios en cuarentena. Las plantillas actuales no demuestran que estas precondiciones productivas estén configuradas.

## Procedimiento

1. **Declarar y contener.** Registrar hora UTC; tratar como incidente; suspender credenciales del host perdido y detener nuevas operaciones/enrollments. Si existe posibilidad de compromiso, revocar credenciales de host y firmantes afectados antes de recuperar.
2. **Preservar evidencia.** Guardar IDs de recursos, backup jobs/recovery points, alarma, último heartbeat y hashes disponibles. No reutilizar el host ni restaurar sobre volúmenes/origen existentes.
3. **Elegir punto consistente.** Seleccionar una base recuperable cuya hora, configuración, material de emisión y checkpoint sean compatibles. Registrar el componente más antiguo como `recoveryPointCreatedAt`; confirmar edad ≤24 h.
4. **Crear destino aislado.** Aplicar IaC/versiones aprobadas para un host/volumen nuevo y red administrativa restringida. Sin abrir rutas de tenant, DNS público o tráfico de endpoints durante restore. Nunca ejecutar un `terraform apply` sobre el host perdido sin revisión del plan.
5. **Restaurar datos y software.** Recuperar PostgreSQL en destino nuevo; recrear roles mínimos; restaurar configuración desde sus referencias seguras; reinstalar binarios desde artefactos verificados. No copiar claves privadas de endpoint ni reutilizar credenciales del host perdido.
6. **Recuperar PKI/checkpoint.** Obtener material de emisión autorizado desde custodia separada; si faltan claves o hay sospecha de compromiso, rotar/reemitir por procedimiento de incidente, no crear silenciosamente una nueva CA equivalente. Verificar MAC/firma, época y timestamp del checkpoint fuera del host.
7. **Reconciliar y permanecer en cuarentena.** Elevar época mínima si corresponde, reaplicar revocaciones posteriores, cerrar sesiones, invalidar credenciales expuestas y registrar operaciones posteriores ausentes como brechas. No reactivar dispositivos revocados ni inventar resultados.
8. **Verificar.** Aplicar migraciones aprobadas; comprobar integridad de base, roles, RLS, aislamiento tenant, certificados/CRL, sesiones revocadas, cola/outbox, auditoría, autenticación de nodos y señales health/readiness. Confirmar acceso solo desde plano administrativo autorizado.
9. **Medir.** Marcar `quarantineReadyAt` al completar el paso 8 y ejecutar el medidor. RPO o RTO fuera del umbral = **FAIL**; conservar cuarentena y escalar. No ajustar timestamps retroactivamente.
10. **Revisión y salida.** Un operador distinto coteja el checklist, hashes, huecos, cuotas y revocaciones. Un responsable autorizado decide explícitamente si sale de cuarentena; registrar identidad, decisión, hora y alcance. Retirar volúmenes/recursos de ensayo solo después de conservar evidencia saneada.

## Evidencia mínima por ejercicio

| Campo | Valor observado |
|---|---|
| Incidente, responsable y hora UTC | pendiente por ejercicio real |
| Recovery point de DB/configuración/PKI/checkpoint | IDs y timestamps pendientes |
| Destino nuevo y revisión IaC/código | pendiente |
| Checksums, roles, RLS, aislamiento, revocaciones | PASS/FAIL por control |
| Hora de listo en cuarentena | pendiente |
| RPO / RTO computados | salida JSON del medidor |
| Limpieza del ensayo y excepciones | pendiente |
| Operador y segundo revisor | identidades por ejercicio |

## Retorno

El retorno es hacia un destino reconstruido y reconciliado, no hacia la copia dañada. Si el destino nuevo falla, mantenerlo aislado y seleccionar otro recovery point validado. No sobrescribir la única copia disponible, no bajar la época y no reintroducir credenciales revocadas.
