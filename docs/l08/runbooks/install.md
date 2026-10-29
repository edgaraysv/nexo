# Runbook local — instalación

1. Confirmar Node 22, Go 1.27.3, Rust estable, MSVC Build Tools, Docker y PostgreSQL 17.6 usados por el corte.
2. Ejecutar `npm ci`, `npm run build`, `npm run verify:l07` y `npm run verify:l08` desde un checkout confiable.
3. Generar el agente Windows y el NSIS solo con `scripts/l07-package.ps1`; no sustituir recursos firmados por rutas recibidas desde la UI.
4. Instalar como administrador y comprobar `NexoEndpoint`, named pipe, ACL y salud IPC. La UI permanece sin privilegios.
5. Si una comprobación falla, retirar servicio/binario con el desinstalador preservando la identidad. No borrar `ProgramData\NEXO\Endpoint` como mecanismo de revocación.

Este procedimiento es de desarrollo. Authenticode, distribución autenticada y trust anchors productivos siguen pendientes.
