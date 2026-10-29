# F02 — pruebas operativas AWS pendientes de autorización

**RESTORE NOT RUN.** El 23 de octubre de 2026 se ejecutó el inventario y posteriormente una configuración SSM autorizada de roles, permisos y servicio; no se ejecutó recuperación. Este procedimiento no autoriza crear, parar, reemplazar ni restaurar instancias. Solo ejecutar sobre el laboratorio dedicado con aprobación explícita y fixtures sintéticas. No tocar OpenVPN anterior, clientes o recursos de otras sesiones.

La autorización posterior de **trabajo local sin AWS** permite un ensayo distinto con PostgreSQL en Docker. Su alcance y resultados se registran en [local-lab.md](local-lab.md) y [evidence.md](evidence.md). Los pasos AWS siguientes conservan NOT RUN; un restore local no los aprueba.

## Qué debe quedar demostrado

1. **PASS parcial:** IDs/tags, VPC, SG sin entrada, volumen cifrado, IMDSv2, bucket privado/TLS/versionado/KMS y entrega de Flow Logs observados. SSM Run Command comprobó además que NEXO escucha solo en loopback; no se probó conectividad externa activa ni se abrió sesión interactiva.
2. Definir con el usuario RPO/RTO del control, custodios y política de retención. Preparar exportación consistente de PostgreSQL, configuración/inventario, material de emisión y claves necesarias, con acceso mínimo y cifrado. No introducir secretos en Terraform, user data o logs. La snapshot diaria de disco no sustituye esta exportación.
3. Generar copia sintética del control en almacenamiento externo al nodo; verificar inventario, hashes, permisos, acceso autorizado y rechazo no autorizado. Registrar también claves necesarias y recuperación de estado IaC. Este corte no crea aún exportador ni concede escritura del host al bucket.
4. **PENDIENTE primer ciclo:** plan, selección y retención configurados, pero se observaron 0 jobs y 0 recovery points. El plan se creó a las 03:23 UTC, después del horario diario de las 03:00 UTC, por lo que el primer ciclo elegible es el 24 de octubre de 2026. Falta verificar éxito/fallo observable y definir notificación/responsable; no conceder un rol de restauración amplio automáticamente. La política administrada de backup no implica permisos de restore.
5. Restaurar en un destino **nuevo y aislado**, nunca sobre el origen; recuperar control y comprobar integridad, identidad, inventario y ausencia de acceso de clientes. Rotar credenciales que pudieran haber sido comprometidas, sin reutilizar secretos expuestos. Medir duración y pérdida de datos respecto al RPO/RTO acordado.
6. Reconstruir nodo desde IaC en laboratorio y verificar configuración inicial segura; los namespaces/servicios VPN y su reconstrucción se probarán cuando existan. El contenido del nodo no fue inspeccionado durante la lectura, por lo que una futura recreación aislada deberá inventariar explícitamente el punto de partida y no se considerará por sí sola prueba de PV17.
7. Retirar solo recursos de ensayo expresamente inventariados; respetar `prevent_destroy`, retención de snapshots, versiones S3 y claves KMS. Antes de una limpieza, plan de borrado específico y autorización del usuario. Conservar reporte saneado con fechas, IDs, resultados y aprobador.

## Riesgos residuales

Un solo host y una sola AZ comparten dominio de fallo; snapshot y backup no son failover. La cuenta única lab/prod comparte administración; un administrador puede vulnerar protecciones de IaC. No hay réplica entre cuentas/regiones, WORM ni alarma operativa verificada. Hasta recuperar el control desde copia limpia dentro de metas acordadas, **PV12 sigue NOT RUN y no se incorporan clientes reales**.
