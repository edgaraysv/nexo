# L07 — cliente Windows

Estado: **corte local implementado y verificado**. No equivale a distribución productiva, firma comercial ni aceptación para clientes reales.

## Implementado

- D06 aceptada: servicio Go independiente + Tauri 2 con React/TypeScript.
- Servicio endpoint continuo con polling de control y estado local saneado.
- Named pipe `nexo-endpoint-v1`, protocolo v1, trama máxima de 16 KiB y ACL para `SYSTEM` + SID autorizado.
- Acciones allowlisted: estado, diagnóstico saneado, enrollment endpoint, claim y ejecución del diagnóstico tipado.
- Rechazo explícito de identidades de nodo en el servicio Windows endpoint.
- UI para identidad, aprobación, vigencia de certificado, observaciones y módulos; VPN, soporte y backup se muestran como “No integrado”.
- Puente Tauri único al named pipe, sin plugins de shell, filesystem o HTTP y sin URL/ruta configurable desde la UI.
- Instalador PowerShell de desarrollo con estado restringido a `SYSTEM` y administradores.
- Paquete NSIS `perMachine` con WebView2 bootstrapper embebido, agente Go y hooks para instalar y retirar el servicio.
- Retorno/desinstalación que retira servicio y binario pero conserva la identidad; eliminar estado exige revocación explícita previa.
- Verificador de actualización Ed25519/SHA-256 con compatibilidad de plataforma/versión, staging separado y rollback solo si la versión anterior no está bloqueada.
- Aplicador de desarrollo que conserva el binario anterior, reinicia el servicio, comprueba salud por IPC y solo entonces confirma o revierte.

## Verificación funcional

- La UI Tauri se compiló y ejecutó nativamente; cerrarla no detuvo el servicio.
- El servicio se instaló, reinició, consultó por IPC y retiró mediante SCM preservando su identidad.
- Un usuario Windows estándar temporal recibió acceso denegado al named pipe y fue eliminado al terminar la prueba.
- El recorrido `IPC → servicio Windows → API → aprobación → claim → operación tipada → resultado` pasó con fixtures locales.
- La captura nativa a escala WebView2 200 % está en `artifacts/l07/ui-200-screen.png`; el diseño aplicó reflow sin desbordamiento horizontal visible.

## Límites honestos

- La CA, certificados, claves y trust anchor de actualización son fixtures locales; no deben reutilizarse en producción.
- Distribución autenticada del manifiesto/paquete, clave de firma productiva y firma Authenticode del binario/instalador permanecen **NOT RUN**.
- La aplicación real de una actualización sobre SCM y su rollback inducido permanecen **NOT RUN**; firma, hash, compatibilidad, staging y bloqueo de rollback sí tienen pruebas automatizadas.
- La estructura semántica, foco visible y reflow tienen evidencia; una prueba manual con lector de pantalla no se ejecutó y no se afirma certificación WCAG.
- Bandeja, notificaciones, VPN, soporte remoto y backup comercial no están integrados.
