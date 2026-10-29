# Evidencia L07

- Frontend `tsc` + Vite: **PASS**.
- Pruebas Go de protocolo, allowlist, saneamiento y frontera endpoint/node: **PASS**.
- Cross-build `windows/amd64` del servicio Go: **PASS**.
- Named pipe con SID real, dos conexiones sucesivas y DPAPI nativo: **PASS**.
- Verificación de actualización (firma Ed25519, SHA-256, plataforma, downgrade, staging separado y versión de rollback bloqueada): **PASS** en pruebas Go.
- Rustup 1.29.1 y Visual Studio 2022 Build Tools C++; `cargo fmt --check`, `cargo check` y build release nativo: **PASS**.
- `npm run verify:l07`: **PASS**, 4/4 pruebas L07, pruebas Go, named pipe/DPAPI nativos, frontend y comprobación Tauri nativa.
- Instalador NSIS de 8.79 MiB: **PASS**, instalación `perMachine`, UI instalada, reinicio SCM, IPC tras cerrar UI, desinstalación y preservación de identidad.
- Windows Service Control Manager: **PASS**, instalación, inicio, reinicio, consulta IPC y retirada sin eliminar identidad.
- Aislamiento por principal: **PASS**, un usuario estándar temporal obtuvo acceso denegado; usuario y servicio fueron retirados.
- `npm run test:l07-flow`: **PASS**, enrollment por IPC, aprobación humana, claim, operación `endpoint.runtime_info.v1`, resultado `windows` y diagnóstico sin material privado.
- Escala WebView2 200 %: **PASS** visual para reflow; captura en `artifacts/l07/ui-200-screen.png`.
- `npm test`: **PASS**, 69/69 pruebas de regresión.
- `npm run check`: **PASS**, 11 requisitos, 37 criterios de aceptación y 114 entradas de catálogo.
- Limpieza final: **PASS**, cero servicios `NexoEndpoint`, usuarios `NexoL07*` y procesos `nexo-agent`/`nexo-client`.

## Casos cubiertos

- Framing máximo de 16 KiB, versión e ID válidos, mensaje malformado, versión incorrecta y acción desconocida.
- Estado saneado, rechazo de campos extra, frontera endpoint/nodo, rate limit local y ausencia de clave privada, certificado PEM, claim token o bearer en diagnósticos.
- Reconexión tras cerrar UI, DPAPI nativo, ACL `SYSTEM` + SID autorizado y denegación para otro usuario.
- Paquete alterado, clave de firma incorrecta, downgrade y plataforma incompatible rechazados; staging no reemplaza el binario activo.

Aplicación SCM real de actualización/rollback, lector de pantalla manual, Authenticode, distribución autenticada, AWS, producción, clientes/datos reales, VPN, soporte remoto y backup comercial: **NOT RUN**.
