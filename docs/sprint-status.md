# Estado del Sprint Maestro — revisión de desarrollo F13

**Fecha:** 2026-11-01

**Resultado del corte:** **F13 DEV NOT CLOSED.** La revisión cubre exclusivamente código, migraciones y scripts descritos o necesarios para el alcance F13 de *Sprint maestro de desarrollo de NEXO*, sección «F13 — Piloto real autorizado». No evalúa pruebas, aceptación de producto ni infraestructura AWS.

## Entregables de desarrollo faltantes

| Entregable | Estado | Hallazgo verificable |
|---|---|---|
| Orquestación del corte de piloto por grupo | **NOT IMPLEMENTED** | No se encontró flujo/script F13 que delimite el grupo autorizado, ejecute una activación escalonada, aplique condiciones de parada y evite modificar otros grupos. Los endpoints genéricos de empresa/VPN no constituyen por sí solos una operación de rollout F13. |
| Retorno selectivo del grupo piloto | **NOT IMPLEMENTED** | No existe script ni operación de producto para volver únicamente el grupo afectado, reconciliar sus rutas/credenciales y conservar intactos los demás grupos. El retorno por versión del agente F12 no implementa el switchback de servicio requerido por F13. |
| Soporte remoto real para el recorrido F13 | **NOT IMPLEMENTED** | F10 conserva consentimiento/modelo y transporte sintético; el servidor normal deja el transporte real deshabilitado (`support_transport_disabled`). La aceptación nativa de una persona y la integración de un motor real siguen siendo trabajo de producto documentado en `docs/f10/README.md`. F13 incluye soporte en sus recorridos. |
| Inventario/importación del servicio anterior | **NOT IMPLEMENTED — condicional** | No hay herramienta de inventario/importación ni reconciliador para migrar el servicio OpenVPN anterior. El plan lo condiciona a que se autorice esa migración; no se trata como requisito activo antes de tal autorización. |

## Migraciones

La sección F13 no especifica cambio de esquema ni una migración SQL concreta. En el repositorio hay migraciones `001–022` y el runner `scripts/migrate.mjs`, pero no hay migración `023`/F13 ni una migración de datos de empresas, dispositivos, rutas o credenciales desde el servicio anterior. **No se registra una migración nueva como faltante obligatoria del plan**: su necesidad debe derivarse de decisiones de piloto/migración aprobadas, no inventarse en esta revisión.

## Base reutilizable, no cierre F13

- Hay código para identidad humana, membresías/invitaciones, operación de empresa, catálogo VPN OpenVPN, políticas de red, revocación y reportes.
- F08 documenta un recorrido sintético directo hacia un recurso privado; eso es una base reutilizable, no un workflow de alta de cohorte ni un cierre F13.
- F10 documenta el modelo local de consentimiento, pero no transporte remoto real.
- F11 documenta WireGuard local, con rutas privadas y aceptación Windows/laboratorio como dependencias pendientes.
- Los componentes de actualización F12 son reutilizables para releases, pero no cubren el cutover/retorno selectivo del servicio/grupo piloto.

## Límite de decisión

El Sprint Maestro establece F12 como puerta técnica previa a clientes reales. `docs/f12/README.md` mantiene F12 abierta; esta revisión no reevalúa ni altera ese gate. **Este documento no autoriza piloto, clientes ni datos reales.** Los criterios no implementados arriba deben resolverse antes de considerar F13 DEV cerrado; las decisiones de privacidad, región, retención, política offline, participantes y condiciones de parada son prerrequisitos de producto/operación y se mantienen fuera de este inventario de código.
