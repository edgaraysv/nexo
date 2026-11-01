# F11 — WireGuard básico y parámetros P1

**Estado:** implementación local integrada y validación automatizada aprobada; F11 no está aceptada ni desplegada.

## Custodia de claves

La clave privada WireGuard del servidor se genera en el nodo, dentro del
agente Linux, con X25519 del runtime Go. Se conserva exclusivamente en
`/var/lib/nexo-node/environments/<environment-id>/wireguard/server.key`, bajo
el directorio del servicio y con permisos `0600`. El agente deriva la clave
pública localmente y solo esa clave pública puede aparecer en una respuesta
autenticada del nodo a la API. La clave privada no forma parte de modelos,
payloads HTTP, operaciones, migraciones, auditoría, logs ni reportes.

Si el archivo local existe pero no se puede leer o validar, la reconciliación
falla cerrada: no sustituye la identidad automáticamente. Una regeneración
futura necesita una operación explícita de rotación con preview, confirmación
y evidencia de aplicación. El proceso de clave de servidor es independiente de
la CA/certificados X.509 que OpenVPN ya usa.

La clave privada de cada peer cliente también se genera en el dispositivo; el
plano de control conserva únicamente su clave pública. F11 no implementa una
clave preshared opcional ni la transporta.

## Modelo y alcance

- `vpn_environments` sigue siendo la identidad común; `engine` distingue
  `openvpn` de `wireguard`. No se cambia el motor de un entorno existente.
- La configuración propia de WireGuard vive en una tabla hija. Los peers se
  vinculan a un dispositivo aprobado y reciben una dirección IPv4 del pool.
- `AllowedIPs` se calcula desde el estado autorizado y no es entrada libre. En
  la primera iteración solo se usa la dirección de túnel `/32` del peer; las
  rutas a recursos privados requieren una integración F08 separada y probada.
- `0.0.0.0/0`, IPv6, bridge L2, directivas arbitrarias y peer-to-peer siguen
  deshabilitados.
- Cambiar/agregar/rotar/revocar peers requiere preview con digest y revisión
  base; la confirmación consume el preview una sola vez. El agente observa
  revisiones deseadas por separado de su aplicación.
- MTU queda fijado a 1420 para este perfil inicial; keepalive admite solo 0 o
  25 segundos.

## Límites de despliegue

El nodo Linux debe tener el módulo WireGuard del kernel y `wireguard-tools`
disponibles, y la red de laboratorio debe permitir el UDP del listener. Este
cambio no instala paquetes, no altera security groups y no despliega agentes.
Un handshake no prueba acceso a una aplicación privada. La integración de
rutas/políticas F08, aceptación de cliente Windows, recuperación de la clave
del nodo y pruebas de laboratorio permanecen como gates antes de aceptar F11.

## Evidencia local — 2026-10-31

| Comprobación | Resultado | Alcance |
|---|---|---|
| `npm run typecheck` | **PASS** | TypeScript de API y spike. |
| `npm --prefix product/client run build` | **PASS** | TypeScript del endpoint y build Vite. |
| `npm test` | **PASS** | 142 pruebas, 0 fallidas; incluye recorrido HTTP de registro/aprobación/rotación/revocación, ciclo en memoria y regresión OpenVPN. |
| `npm run test:f11-postgres` | **PASS** | PostgreSQL desechable `postgres:17.6-bookworm`, perfil local de 22 migraciones; permisos de runtime, RLS de endpoint/nodo/empresa, asignación concurrente, preview/confirmación, rotación, revocación y auditoría. La migración `022_f11_wireguard.sql` se aplicó con checksum `252ed7f0e4d6364958f1310119823cf20bda716cb153049a16bdb12ea9840e22`. |
| Go `go test ./...` | **PASS** | Todas las pruebas de paquetes del agente Linux/Windows. |
| Go `GOOS=windows GOARCH=amd64 go build ./...` | **PASS** | Compilación cruzada; no equivale a aceptación ejecutada en Windows. |
| `npm run check` | **PASS** | Trazabilidad, contrato estructural y comprobaciones del repositorio. |
| `git diff --check` | **PASS** | Sin errores de whitespace en el diff. |

Estas comprobaciones son de desarrollo/locales. El runner PostgreSQL destruye
únicamente el contenedor desechable que crea; no aplica migraciones al
laboratorio AWS.

## Gates pendientes (NOT RUN)

- Handshake real entre un nodo Linux WireGuard y cliente Windows, incluyendo
  reconexión, desconexión, rotación aprobada y revocación observada.
- Aceptación manual del cliente Windows y limpieza de servicio/túnel nativo en
  ejecución sobre Windows. La compilación cruzada no demuestra este resultado.
- Recorrido F08 de extremo a extremo hacia recursos privados. La primera
  iteración rechaza configuración WireGuard con rutas privadas y solo declara
  `AllowedIPs` `/32` del servidor; no se afirma acceso a aplicaciones.
- Instalación y compatibilidad comprobada del módulo/kernel WireGuard,
  `wireguard-tools`, UDP/firewall y entorno de laboratorio.
- Restauración de la identidad/clave privada del servidor y aceptación de
  recuperación PV12; la custodia local y el fallo cerrado no prueban recuperación.
- F12, revisión independiente de seguridad y condiciones de despliegue/producción.

**Decisión:** continuar solo en laboratorio con datos sintéticos. No declarar
F11 aceptada ni habilitar clientes o datos reales hasta cerrar los gates y
obtener la aceptación responsable definida por el plan maestro.
