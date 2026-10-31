# Evaluación local de MeshCentral 1.3.1

Fecha: 29 de octubre de 2026
Estado: **candidato de evaluación únicamente; no seleccionado ni adoptado.** Este spike no autoriza piloto, producción ni datos reales.

## Alcance y método

- MeshCentral `1.3.1`, Node `22.17`, npm `10.9`; instalación y datos temporales fuera del repositorio.
- Un agente Linux x86-64 no-KVM de la versión `legacy-1.2.6`; SHA-384 contrastado con el manifiesto publicado por MeshCentral.
- Servidor y agente en espacios de red `bubblewrap` separados, sin ruta externa durante la ejecución. El único puente desde el host escuchó en `127.0.0.1`; no se usaron AWS, Docker, clientes ni datos reales.
- La descarga del paquete y del agente oficial se hizo antes de aislar la ejecución. No se cambió código del producto, F03 ni configuración de producción.

## Resultados

### Consentimiento por sesión — **no demostrado**

El grupo sintético se configuró con consentimiento `56` (prompt de escritorio, terminal y archivos); las opciones de autoaceptación quedaron desactivadas. Bajo ese prompt, una solicitud de terminal mostró `Connected` al cliente MeshCtrl, pero no apareció un prompt de terminal ni una UI de aceptación/rechazo en el endpoint. La solicitud permaneció sin resultado observable durante 38 segundos y se canceló desde el harness.

No se aceptó ni rechazó una solicitud visual. El agente era no-KVM y el entorno no tenía una UI de endpoint controlable. Por tanto, el resultado no prueba ni aceptación, ni rechazo, ni expiración efectiva del consentimiento. Tampoco demuestra consentimiento de escritorio.

### Permisos y relación con F03 — **parcial, no equivalente**

El operador sintético recibió derechos MeshCentral `1800`: control remoto, escritorio de solo lectura, terminal denegada y archivos denegados. El endpoint aparecía en su lista; `Shell` y `Download` devolvieron `Unable to route`, y no se creó el archivo de descarga objetivo.

Esto demuestra una separación básica de capacidades dentro de un grupo MeshCentral. **No demuestra equivalencia con F03**: MeshCentral mantiene su propio RBAC; no se probó el mapeo de empresa/tenant, rol empresarial, vigencia ni autorización desde la API de Nexo. En la fecha del spike F03 conservaba su corte de roles fijos y no tenía `resource_grants`.

### Revocación — **la baja del grupo no cierra una sesión activa**

Para crear una sesión activa en el endpoint sintético se usó temporalmente consentimiento `0` y derechos `1288` (terminal permitida, archivos denegados). Esto elude consentimiento deliberadamente y **no cuenta como evidencia de una sesión asistida aceptada**.

- Con una terminal activa, retirar al operador del grupo impidió abrir una sesión nueva (`Unable to route`), pero la terminal existente siguió ejecutando un marcador posterior a la revocación. Retirar la asignación por sí solo no produjo revocación inmediata.
- En otra terminal sintética activa, el mensaje explícito `endtunnel` para ese usuario y protocolo recibió `OK`; el cliente terminó en aproximadamente `0,2 s` y no ejecutó un marcador posterior. Esto demuestra el cierre explícito de esa terminal en el laboratorio, no su integración/autorización desde Nexo.
- Al terminar, se restauraron consentimiento `56` y derechos `1800`, verificados nuevamente en el grupo.

**Implicación:** una integración tendría que invocar y verificar el cierre explícito de cada sesión; no basta con retirar el permiso/grupo. La ruta de cierre de pantalla, archivos, otras plataformas y los flujos de Nexo no se probaron.

## Superficie de datos observada

### Transmisión y aislamiento

- La configuración del agente apuntó a `wss://127.0.0.1:43821/agent.ashx`; el host solo expuso el puente temporal en `127.0.0.1:43822`.
- El namespace de red del agente tenía solo `lo`, sin ruta por defecto. No había listener del servidor en el namespace de red del host.
- El endpoint no veía el directorio de datos del servidor, el repositorio ni el home del host; solo el fixture sintético montado. El contenido WSS no se capturó ni descifró.

### Persistencia

En los NeDB locales se observaron:

- cuentas sintéticas, email/nombre, salt y hash de contraseña, membresías y derechos;
- grupo, consentimiento, identidad/nombre del endpoint, IP/host, versión/capacidades del agente y marcas de conexión;
- `sysinfo` con metadatos BIOS, kernel, arquitectura y versiones del agente; `ifinfo` con datos de interfaz;
- eventos con actor/usuario, endpoint/grupo, hora, dirección remota, protocolo, sesión, mensaje y contadores de bytes; muestras de CPU/memoria/tráfico y estado de energía.

Las contraseñas sintéticas no aparecieron en texto plano en las bases. El `.msh` del agente contenía identificadores Mesh/server y URL local; el `meshagent.db` se mantuvo dentro del namespace efímero. El almacén de archivos del servidor quedó vacío; los marcadores de terminal no aparecieron en las bases examinadas. No se habilitó grabación de sesión.

Las bases `.db` contenían revisiones/tombstones junto con documentos vigentes; la política de retención/compactación no se evaluó. Las claves privadas de certificados generadas por el spike quedaron con modo `0644` bajo un directorio de datos `0755`, protegido en esta ejecución por el directorio padre temporal `0700`. Esto requiere endurecimiento explícito y revisión de custodia antes de cualquier uso real.

## Límites y conclusión

No se probaron aceptación/rechazo visual, escritorio KVM, sesiones de archivos permitidas, Windows/macOS, múltiples empresas, carga, retención configurada, ni integración de permisos y cierre con la API de Nexo. El endpoint Linux sintético no valida otros sistemas ni preparación productiva.

**Conclusión:** MeshCentral 1.3.1 sirve para continuar una evaluación técnica local. El control granular por capacidades y un cierre explícito de terminal son observables, pero consentimiento asistido, revocación individual de sesiones concurrentes e integración de permisos con Nexo siguen sin demostrar; la retirada del grupo no corta sesiones ya abiertas. Se mantiene como **candidato**, no como selección, adopción ni autorización para F13.

Al finalizar el spike se detuvieron los procesos; sus archivos temporales quedaron bajo `/tmp/nexo-f10-meshcentral.J6aq6p` y no forman parte del repositorio. Ese directorio contiene el NeDB anterior y metadatos de endpoint no sintéticos; **no se reutiliza para la repetición ni se considera evidencia de identidad sintética desde el primer registro**.

## Actualización del estado Nexo — 30 de octubre de 2026

Después del spike, `resource_grants` quedó implementado y verificado con PostgreSQL 17.6 efímero, RLS y denegación HTTP por grants revocados/vencidos. Esto permite comenzar F10, pero no añade evidencia de integración entre Nexo y MeshCentral, no cambia los resultados de consentimiento/revocación del spike y no convierte al motor en autoridad de permisos. MeshCentral sigue siendo solo candidato.
