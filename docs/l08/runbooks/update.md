# Runbook local — actualización y retorno

1. Aceptar solo manifiesto `nexo.agent-update.v1` con firma Ed25519 válida, SHA-256, plataforma, arquitectura y versión compatibles.
2. Preparar `nexo-agent.pending.exe` separado del binario activo. No permitir URL, ruta o comando suministrado por la UI.
3. Detener el servicio, preservar temporalmente la versión funcional, aplicar el pending y reiniciar.
4. Confirmar estado SCM y salud mediante el IPC versionado antes de retirar la copia anterior.
5. Si falla, volver únicamente a una versión compatible y no bloqueada. Si la versión previa está bloqueada, mantener el servicio detenido y escalar el incidente.

La aplicación y rollback reales de un paquete firmado de producción permanecen NOT RUN.
