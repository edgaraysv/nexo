# design.md — Nexo

> **Propósito:** fuente de instrucciones UX/UI para agentes de diseño y desarrollo que trabajen en el panel del proveedor, el portal empresarial y el cliente endpoint de Nexo. Consultar este archivo antes de diseñar o implementar una pantalla; contrastarlo con el análisis técnico, la definición de producto y el catálogo de parámetros vigentes. Ante una decisión no resuelta, conservar el límite de producto y documentar la propuesta en vez de asumir que ya está implementada.

**Versión:** 1.0 · 20 de octubre de 2026  
**Tipo:** especificación de experiencia y handoff para diseño, desarrollo y QA.  
**Estado:** propuesta de producto; no describe pantallas implementadas ni certifica accesibilidad.  
**Fuentes internas vigentes:** `Analisis_Tecnico_Proyecto_Nexo.docx` v1.2, `Definicion_de_Producto_Nexo.docx`, `Nexo_Contexto_para_Agentes_IA.md` y `Nexo_Catalogo_de_Parametros_Administrables.md`.  
**Método:** Multimodal UI/UX Reviewer, modo `full + handoff/implementation-ready`. Solo se revisaron especificaciones; no se observaron capturas, código de producto, prototipos ni ejecución.

## 1. Objetivo y límites

Diseñar un producto comprensible para tres superficies relacionadas:

1. **Panel del proveedor:** administra empresas, contratos, nodos, entornos VPN, operaciones y salud global. Su operador ve únicamente sus asignaciones y no adquiere acceso remoto implícito a equipos de clientes.
2. **Portal de la empresa:** administra equipos, sucursales, recursos, políticas, usuarios, soporte y reportes de su propia empresa. El técnico actúa solo dentro de sus permisos delegados; el auditor consulta sin modificar.
3. **Cliente endpoint:** aplicación local con una identidad por dispositivo y módulos VPN, soporte y respaldo independientes. Windows es la primera plataforma de escritorio del piloto; macOS y Linux requieren validación de compatibilidad. Android e iOS/iPadOS son una evolución enfocada en VPN y diagnóstico básico, sin control de pantalla remoto.

Nexo es el nombre de trabajo. **No se han aprobado logotipo, paleta, tipografía, framework ni sistema de componentes.** Primero inspeccionar el repositorio y cualquier marca existente; no imponer dependencias, un tema o un estilo ajeno. Este documento define comportamiento y estructura que deben sobrevivir a la futura decisión visual.

### Invariantes de producto

- Una EC2 nueva puede alojar entornos VPN lógicos aislados por empresa; la interfaz nunca los representa como servidores físicos dedicados.
- La VPN llega solo a recursos privados autorizados. No ofrecer una opción para enviar toda la navegación a Internet por la VPN; validar rutas IPv4/IPv6 y agregados equivalentes.
- Un equipo con el cliente puede llegar a un servidor con el cliente sin gateway, cuando existe una política expresa. Se necesita un gateway para acceder a equipos de una LAN que no ejecutan el cliente o para enlazar una sucursal completa.
- Registrar un gateway no configura automáticamente el router de la sucursal. El flujo debe verificar retorno por ruta explícita o SNAT privado y explicar sus consecuencias.
- El soporte remoto puede contratarse y funcionar sin VPN. El respaldo de archivos es un módulo opcional posterior; tampoco depende de la VPN.
- Activar un nuevo módulo en un endpoint ya registrado conserva identidad e historial; puede requerir una actualización firmada o permiso nativo, pero no otro registro ni otro instalador manual.
- Un cambio solicitado, uno aplicado en el nodo y la conectividad observada son momentos diferentes. Un túnel conectado no prueba que un ERP responda.
- La operación habitual se hace por panel/API/agente; la interfaz no ofrece shell del host, editor libre de directivas VPN, Webmin incrustado ni exposición de secretos.

## 2. Usuarios, tareas y dispositivos

| Persona | Tarea de mayor frecuencia | Decisión que necesita tomar | Superficie principal |
| --- | --- | --- | --- |
| Propietario del proveedor | Alta y salud de empresas/entornos | Qué empresa, nodo, plan, cupo y cambio requieren atención | Panel del proveedor, escritorio |
| Operador del proveedor | Diagnóstico de casos asignados | Dónde falla una operación sin ver datos de otras empresas | Panel del proveedor, escritorio |
| Administrador de empresa | Controlar accesos y delegaciones | Quién puede entrar a qué recurso y hasta cuándo | Portal, escritorio/tablet |
| Técnico de empresa | Añadir equipos y conectar sedes | Qué registro, ruta, DNS o política falta para llegar al recurso | Portal, escritorio/tablet |
| Auditor de empresa | Consultar actividad y consumo | Qué ocurrió, cuándo y bajo qué alcance de medición | Portal, escritorio |
| Usuario final | Conectar VPN y aceptar asistencia | Si su equipo está listo y quién solicita control | Cliente local, escritorio; móvil para VPN |

**Métodos de entrada:** teclado y ratón en panel/portal; teclado, ratón y avisos nativos en escritorio; toque y patrones del sistema en móvil. Diseñar para contenido largo en español, fechas locales y nombres de empresas/sucursales extensos.

## 3. Arquitectura de información

### 3.1 Panel del proveedor

| Navegación | Vista principal | Acción primaria | Detalle contextual |
| --- | --- | --- | --- |
| Resumen | Alertas, operaciones fallidas y salud de nodos | Resolver incidente | Fuente, hora de observación y empresa |
| Empresas | Lista filtrable por estado/plan | Crear empresa | Contrato, cupos, módulos, operadores asignados |
| Nodos | Capacidad, salud, versiones y entornos | Diagnosticar nodo | Uso real, servicios, mantenimiento, copia del control |
| Entornos VPN | Entornos por empresa/nodo | Crear entorno | Motor, rango, puerto, políticas, operación y revisiones |
| Operaciones | Cola con progreso y errores | Reintentar/revertir si procede | Actor, cambios, dependencias, resultados por componente |
| Auditoría | Eventos filtrables | Exportar alcance permitido | No incluir secretos ni datos de otras empresas |
| Administración | Operadores, planes y parámetros aprobados | Gestionar asignaciones | MFA, permisos, cuotas y cambios de alto impacto |

**Contexto de empresa visible y persistente:** en fichas, asistentes, breadcrumbs, títulos, confirmaciones y operaciones. Cambiar de empresa requiere acción explícita; nunca conservar una selección de recurso de la empresa anterior. El operador solo ve las empresas asignadas.

### 3.2 Portal de la empresa

| Navegación | Contenido | Acción primaria |
| --- | --- | --- |
| Resumen | Servicios contratados, estado observado, equipos y sedes con incidentes | Resolver pendiente prioritario |
| Equipos | Inventario, alta, aprobaciones y ficha de endpoint | Invitar equipo |
| Sucursales y redes | Sedes, gateways, LAN, recursos, rutas de retorno/NAT y DNS | Añadir sucursal o recurso |
| Políticas | Grupos, matriz origen → destino y reglas por servicio/puerto | Crear regla |
| Soporte | Equipos, técnicos autorizados, sesiones e historial | Solicitar asistencia |
| Respaldos | Políticas, última copia, versiones y restauración | Restaurar archivo (solo cuando exista el módulo) |
| Actividad y reportes | Operaciones, auditoría y consumo con periodo/fuente | Filtrar/exportar |
| Usuarios y permisos | Miembros, roles, delegación por sede/recurso | Invitar usuario |
| Suscripción | Capacidades, cupos, uso y estados de cada módulo | Consultar o solicitar cambio de plan |

La navegación muestra únicamente módulos disponibles para esa empresa. Para servicios contratables pero no activos, usar una explicación contextual y una ruta comercial autorizada, sin aparentar que una función opera. Los permisos de lectura y escritura se comprueban en servidor; ocultar o deshabilitar un botón no es autorización.

### 3.3 Cliente endpoint de escritorio

| Área | Contenido mínimo | Acción |
| --- | --- | --- |
| Inicio | Identidad de empresa/equipo, estado del agente, estado separado de VPN, soporte y respaldo | Ir al módulo afectado |
| VPN | Conexión, recursos autorizados, última comprobación y diagnóstico | Conectar/desconectar cuando esté permitido |
| Soporte | Disponibilidad, solicitudes pendientes, técnico, alcance y sesiones | Aceptar/rechazar/finalizar sesión |
| Respaldo (posterior) | Cobertura, última copia verificada, próxima ejecución y errores | Ver detalles/solicitar restauración permitida |
| Actividad | Historial local de conexión y asistencia, con privacidad | Ver evento |
| Ajustes y ayuda | Inicio automático si aplica, diagnóstico, versión, permisos y actualización | Comprobar estado/copiar informe saneado |

Usar una vista breve en área de notificaciones del sistema para conexión y sesión activa, pero mantener accesibles en la ventana principal identidad, consecuencias, diagnóstico y controles. No confundir **cerrar la ventana** con desconectar el servicio. Un endpoint que actúa como gateway tiene una vista técnica adicional de redes anunciadas y estado de ruta/retorno; el usuario normal no ve controles de enrutamiento.

### 3.4 Cliente móvil futuro

Una pantalla de conexión VPN, recursos autorizados, diagnósticos básicos, empresa e identidad. Seguir patrones y permisos del sistema operativo. No trasladar a móvil los controles de pantalla remota, configuración avanzada del gateway ni respaldo que no estén validados por plataforma. Etiquetar este diseño como evolución, no entregable del piloto Windows.

## 4. Taxonomía de estados y reglas de presentación

No reutilizar una única etiqueta «activo» para todas las entidades. La UI y la API necesitan campos separados:

| Dimensión | Valores de referencia | Presentación y acción |
| --- | --- | --- |
| Suscripción de cada módulo | Pendiente de activación, activa, en gracia, suspendida, cancelada | Motivo, vigencia, capacidad y responsable; no inferir estado técnico |
| Registro del endpoint | Invitado, pendiente, activo, suspendido, retirado | Mostrar aprobación/revocación e identidad |
| Capacidad local del módulo | No contratado, disponible, pendiente de permisos, habilitado, error, suspendido | Aclarar si falta contrato, política, instalación o permiso nativo |
| Conexión VPN | Desconectada, conectando, conectada, degradada, desconectando, error | Mostrar último contacto y prueba al recurso por separado |
| Salud del gateway | Sin señal, túnel conectado, rutas anunciadas, retorno verificado, recurso probado, degradado | No llamar «sucursal operativa» por un heartbeat |
| Cambio de configuración | Borrador, validando, solicitado, aplicando, aplicado, verificando, operativo, error, revertido | Línea de tiempo, revisión, actor, última señal y siguiente acción |
| Sesión de soporte | Solicitada, esperando consentimiento, iniciando, activa, finalizando, finalizada, rechazada, expirada, error | Participante, permisos y control para terminar |
| Respaldo | Programado, ejecutando, completado, parcial, fallido, verificado mediante restauración | «Copia completada» no equivale a recuperabilidad verificada |

**Modelo transversal de estado:** `valor + fuente + timestamp + alcance + frescura + acción recomendada`. Diferenciar «sin datos», «sin permiso», «servicio no contratado», «sin conexión» y «fallo». Nunca convertir telemetría antigua en una luz verde actual. Un fallo en VPN no borra el estado de soporte ni de respaldo.

### Contenido de estados reutilizables

| Estado de pantalla | Debe responder |
| --- | --- |
| Vacío | Qué falta, quién puede crearlo y el primer paso permitido |
| Cargando | Qué operación sigue en curso y si puede abandonar la pantalla |
| Parcial | Qué se completó, qué quedó pendiente y si se mantiene seguro |
| Error | Qué falló, qué se conserva y cómo reintentar sin duplicar |
| Sin permisos | Qué acción requiere otro rol, sin revelar recursos fuera del ámbito |
| Desactualizado | Hace cuánto se observó, si aún se aplica la última política y qué verificar |
| Suspendido | Qué módulo se suspendió, su efecto concreto y quién puede reactivarlo |

## 5. Flujos prioritarios del panel

### F01 — Proveedor crea empresa y entorno VPN

1. Selecciona «Crear empresa»; define datos mínimos y contrato VPN. La vista previa muestra cupos y módulos.
2. En la ficha de empresa selecciona «Crear entorno VPN»; elige nodo, motor disponible, puerto/rango y política inicial de denegación. Opciones avanzadas validadas se agrupan y explican.
3. Validador muestra colisiones **dentro del entorno**, reserva de puerto, capacidad, impacto y que no se creará una ruta a Internet. Un CIDR idéntico de otra empresa aislada no debe producir falsa colisión.
4. Confirma con nombre de empresa y resumen de consecuencias. Ve una operación trazable: solicitado → aplicado → verificación pendiente → operativo o error.
5. La verificación real con endpoint/recurso se presenta aparte. Si falla, el entorno incompleto queda bloqueado y se ofrece diagnóstico/reintento/reversión.

### F02 — Técnico de empresa añade un equipo individual

1. En «Equipos» selecciona «Invitar equipo»; fija sede/grupo, tipo normal o gateway, sistema operativo, caducidad y número de usos dentro de sus permisos/cupo.
2. Vista previa de lo que habilitará la invitación; muestra el código una sola vez, con copiar/descargar instrucciones sin exponer secretos en auditoría.
3. Usuario instala el cliente, registra su equipo y ve empresa, nombre de dispositivo y permisos solicitados antes de aceptar. Claves e identidad se generan localmente.
4. Si la empresa exige aprobación, ambos ven «Pendiente de aprobación» sin acceso a recursos. El técnico aprueba/rechaza con identidad y metadatos visibles.
5. El técnico comprueba agente, conexión VPN y acceso al recurso permitido; un fallo de prueba no cambia retrospectivamente el registro a «no registrado».

**Casos de error:** invitación vencida/consumida, empresa equivocada, cupo agotado, dispositivo duplicado, permiso nativo faltante, equipo retirado o usuario sin `endpoint.create`. Explicar recuperación sin crear credenciales parciales.

### F03 — Conectar un recurso directo o una sucursal

Ofrecer una **elección de tarea**, no una preferencia de motor: «Conectar un equipo/servidor con cliente Nexo» o «Conectar toda una red mediante gateway».

- **Equipo directo:** registrar el servidor como endpoint, seleccionar servicio/puerto, asignar política origen → destino y probar desde un equipo autorizado. Aclarar que no se publica automáticamente toda su LAN ni se abre acceso entre todos los peers.
- **Sucursal:** crear sede, CIDR y recursos; invitar gateway apto para funcionamiento continuo; anunciar rutas; seleccionar «ruta de retorno en router» o «SNAT privado», con explicación de que SNAT oculta la IP original del usuario al recurso; probar ida, regreso y aplicación concreta.
- Si dos LAN de la **misma empresa** se solapan, bloquear ruta ambigua y remitir a diseño de traducción/renumeración posterior. Entre empresas aisladas puede repetirse el CIDR.

### F04 — Crear política de acceso

Asistente con origen (grupo/equipo/sede), destino (recurso/servidor/red), protocolo/puerto, dirección y vigencia. Antes de aplicar, mostrar «Quién podrá llegar a qué» y cambios sobre reglas existentes. Denegar por defecto. Tras publicar, distinguir política aplicada de prueba del servicio. Una excepción temporal muestra motivo y expiración desde la lista.

### F05 — Diagnosticar acceso a ERP o archivos

Desde una ficha de equipo o recurso, «Probar acceso»: comprobar agente → túnel → ruta → resolución privada DNS si aplica → política → firewall/puerto → respuesta de aplicación. Cada paso expone resultado, hora, dispositivo de prueba y permiso necesario para repetir. Si el router de la sucursal no es administrado por Nexo, presentar instrucciones verificables y estado «pendiente de configuración externa», nunca «configurado».

### F06 — Autorizar soporte remoto

Administrador de empresa habilita técnicos/equipos y, si procede, acceso del proveedor con empresa, equipos, modalidad, motivo y vencimiento. En sesión asistida, la solicitud muestra identidad verificada del técnico, empresa, permisos separados (pantalla, control, terminal, archivos y portapapeles), motivo y botones explícitos «Permitir esta sesión» / «Rechazar». La sesión desatendida exige una política previa visible. El usuario puede finalizar la sesión; el portal refleja el cierre y la auditoría. No representar al proveedor como autorizado por el simple hecho de gestionar el nodo.

### F07 — Respaldo y restauración (módulo opcional posterior)

Si se contrata, configurar carpetas, exclusiones, horario, cuota y retención; vista previa de cobertura. Mostrar última copia completada **y** última restauración verificada por separado. Para restaurar, elegir equipo, versión, archivos y destino, revisar posibles sobrescrituras, ejecutar y verificar. Un repositorio externo y claves por empresa son información de operación del proveedor, no selector libre de rutas de almacenamiento para el usuario final.

## 6. Flujos del cliente endpoint

### E1 — Instalación y vinculación

Invitación → verificación de empresa/fecha → instalación del paquete de la plataforma → permisos del sistema explicados justo cuando se necesitan → identidad local → registro → aprobación opcional → módulos habilitados → prueba de recurso. Indicar claramente si el equipo está registrado pero todavía no tiene permiso para conectarse. El reintento de red no debe generar otra identidad.

### E2 — Uso diario de VPN

Mostrar en primer nivel «Conectada a [empresa]» o estado pertinente, última comprobación y destinos privados disponibles. La acción conectar/desconectar aparece solo si la política la delega. Aclarar que la navegación general a Internet sigue local. Si hay túnel pero no ERP, «VPN conectada; no se pudo acceder a ERP», con diagnóstico y enlace a soporte, en lugar de una luz verde genérica.

### E3 — Sesión de soporte asistido

Solicitud entrante → identidad y permisos → aceptar/rechazar → indicador persistente de sesión activa → control local «Finalizar asistencia» → resumen y registro. Si se añaden terminal, archivos o portapapeles, mostrar permiso diferenciado y nuevo consentimiento según contrato del motor. Fallo de permiso nativo debe impedir empezar lo no autorizado y explicar cómo corregirlo.

### E4 — Activación posterior de módulo

Cuando se contrata soporte o respaldo, el cliente existente presenta «Nuevo servicio disponible»; muestra qué cambia, requiere actualización o permiso cuando corresponda, aplica la política y confirma estado operativo. No pide una segunda inscripción del dispositivo. Si el módulo falla, los otros mantienen su estado propio.

### E5 — Sin conexión al control

Mostrar última observación y vigencia efectiva de política sin prometer revocación inmediata. El cliente distingue red sin Internet, túnel caído y portal no disponible. Las acciones permitidas durante contingencia deben derivarse del contrato técnico de expiración, aún por decidir, y estar redactadas para el usuario.

## 7. Especificación de pantallas y componentes

| Componente | Datos y comportamiento | Estados críticos |
| --- | --- | --- |
| Selector de empresa | Nombre, rol, contrato; limpia selección anterior al cambiar de contexto | Sin membresía, múltiples empresas, cambio fallido |
| Cabecera de recurso | Empresa/sede/endpoint, estado, última observación y acciones permitidas | Señal antigua, suspendido, sin permiso |
| Lista operativa | Búsqueda, filtros, orden, paginación, selección contextual y vistas guardadas si justificadas | Vacía, parcial, sin red, volumen alto |
| Tarjeta/tabla de módulo | Contrato, habilitación, agente, operación y estado observado separados | No contratado, pendiente, error |
| Vista previa de cambio | Valor anterior/nuevo, alcance, reconexiones, dependencias y retorno | Conflicto, alto impacto, fallo parcial |
| Línea de tiempo de operación | Eventos por actor, tiempo, revisión deseada/aplicada y verificación | Reintento, revertido, timeout, señal perdida |
| Matriz de acceso | Origen, destino, puerto, vigencia y efecto; filtros | Regla implícita, conflicto, ausencia de acceso |
| Constructor de invitación | Ámbito, plataforma, caducidad/usos, cupo y secreto de una sola vista | Expirada, consumida, duplicada |
| Diagnóstico guiado | Paso, fuente, tiempo, resultado y próxima acción | Prueba no autorizada, timeout, parcial |
| Solicitud de soporte | Técnico, empresa, permisos, duración y consentimiento | Expirada, revocada, sesión activa |
| Configuración DNS privada | Dominios internos, resolvers, grupos y prueba de resolución | Conflicto, resolver inaccesible, DNS público local |
| Estado de backup (P2) | Cobertura, última copia, última restauración probada, cuota | Parcial, sin prueba, clave/repositorio inaccesible |

**Patrón de formularios:** etiqueta persistente, ejemplo, validación en el campo y en servidor, resumen de errores enlazado a cada campo, conservar valores tras error, prevenir doble envío. CIDR, puertos, unidades, fechas y zonas horarias tienen formato y explicación visible. No colocar parámetros riesgosos en un interruptor sin contexto.

**Acciones destructivas:** mostrar entidad exacta, empresa, efecto sobre túneles/equipos, posibilidad de reversión y servicios que continúan. La baja de un endpoint revoca credenciales; la suspensión puede revertirse. «Eliminar empresa» no debe ser un atajo para borrar datos sin política de retención definida.

## 8. Matriz de permisos visible

| Acción | Proveedor propietario | Operador asignado | Admin empresa | Técnico delegado | Auditor | Usuario endpoint |
| --- | --- | --- | --- | --- | --- | --- |
| Crear empresa/entorno VPN | Sí | Según delegación explícita | No | No | No | No |
| Ver nodos y capacidad global | Sí | Solo alcance operativo | No | No | No | No |
| Invitar/aprobar equipos | Según gestión contratada | Solo empresa asignada y permiso | Sí | Según grupo/sede | Lectura si autorizada | Solo completar invitación propia |
| Configurar sedes, redes y políticas | Según rol de soporte | Solo asignación y permiso | Sí | Según delegación | Lectura | No |
| Iniciar soporte sobre equipo del cliente | Solo con autorización vigente | Solo con autorización vigente | Con permiso de soporte | Con permiso de soporte | No | Aceptar/terminar sesión propia |
| Modificar contrato y cupos | Sí | Según delegación comercial | Ver/solicitar | Ver si autorizado | Ver | No |
| Consultar auditoría | Global conforme a rol | Empresas asignadas | Su empresa | Alcance delegado | Su empresa | Actividad propia |

Esta tabla describe visibilidad objetivo, no sustituye permisos granulares. Los controles deshabilitados deben explicar el motivo cuando revelar su existencia sea apropiado; recursos ajenos a la empresa no aparecen ni se enumeran. La API aplica tenant, acción, recurso, contrato y vigencia en cada operación.

## 9. Lenguaje y microcopy de referencia

Usar español claro en la primera capa y término técnico entre paréntesis cuando ayude: «Red de la sucursal (CIDR)», «Equipo que conecta la oficina (gateway)». Reservar «nodo» para infraestructura del proveedor. «Endpoint» puede aparecer en diagnóstico avanzado, mientras «equipo» es la etiqueta de uso diario.

| Contexto | Texto recomendado |
| --- | --- |
| Operación aún no terminada | «Solicitud recibida. El entorno aún no está aplicado en el nodo.» |
| Motor aplicado, pendiente de uso real | «Configuración aplicada. Falta probar el acceso desde un equipo.» |
| Túnel sin aplicación | «VPN conectada. No se pudo abrir ERP; revisa la ruta o el puerto 443.» |
| Router externo | «Agrega esta ruta en el router de la oficina y vuelve a probar. Nexo no puede cambiar ese router.» |
| SNAT | «El servidor verá la IP del gateway en lugar de la IP de cada usuario.» |
| Registro pendiente | «Equipo registrado. Esperando aprobación para acceder a recursos.» |
| Soporte asistido | «Ana Pérez, técnica de Empresa Alfa, solicita ver y controlar tu pantalla durante esta sesión.» |
| Fallo con datos conservados | «No se pudo aplicar el cambio. Se conservó la configuración anterior. Revisa el conflicto y vuelve a intentar.» |
| Backup sin prueba | «Última copia completada: [fecha]. Restauración aún no comprobada.» |

Evitar «Todo listo» para un cambio solo solicitado; «Acepto» en acciones destructivas; «Error desconocido» como único diagnóstico; «Conectado» cuando solo responde el agente; afirmaciones de alta disponibilidad, cifrado extremo a extremo o recuperación inmediata sin pruebas.

## 10. Sistema visual y comportamiento adaptable

### Diseño de información

- Perfil primario: **administración y operación** para panel/portal; perfil secundario: **aplicación de uso diario** para el cliente. Priorizar tareas, densidad útil, lectura de tablas y alertas importantes.
- Especificar tokens semánticos antes de colores hexadecimales: `surface`, `text`, `border`, `focus`, `success`, `warning`, `danger`, `info`, `pending`, `offline`, `disabled`. El estado también se comunica con texto e icono, nunca solo color.
- Mantener contrastes y focos medibles después de elegir paleta. Usar números tabulares para métricas, tráfico, IP y tiempos. Evitar truncar identificadores críticos sin forma de verlos completos.
- Una sola familia de iconos y una escala tipográfica corta. Evitar visualización decorativa donde una tabla con unidades y fuente permita decidir mejor.
- No llenar el panel de tarjetas idénticas. Resumen breve arriba; listas priorizadas y tablas filtrables para operación; detalle contextual para una entidad.
- Movimiento solo para transición de estado o confirmación; sin animaciones permanentes de conexión. Respetar preferencia de movimiento reducido.

### Adaptación por superficie

| Superficie | Comportamiento esperado | Prueba mínima sugerida |
| --- | --- | --- |
| Panel/portal escritorio | Navegación lateral o equivalente, tablas con encabezados estables, panel de detalle sin perder filtros | 1280×720 y 1920×1080, zoom 200 % |
| Portal tablet | Navegación compacta, filtros accesibles, tablas con estrategia de columnas prioritarias y detalle | 768×1024, ambas orientaciones |
| Portal móvil de consulta | Estado, búsqueda y tareas básicas sin scroll horizontal; operaciones de red complejas pueden pedir escritorio con explicación | 360×800 y 390×844 |
| Cliente Windows | Ventana redimensionable, controles del sistema, área de notificaciones y avisos persistentes de soporte | 1366×768 y 200 % de escala |
| Cliente móvil futuro | Patrones nativos, estado de VPN y diagnósticos; permisos del SO explicados | Pantallas pequeñas/grandes y rotación pertinente |

Los valores anteriores son **escenarios de verificación**, no tamaños fijos de diseño ni promesa de compatibilidad ya probada. El stack, los puntos de ruptura y los componentes se elegirán después de inspeccionar el código y la marca.

### Accesibilidad operativa

Estructura semántica, nombres/roles/estados de controles, navegación íntegra con teclado, foco visible, orden lógico, objetivo táctil adecuado, errores ligados al campo, encabezados de tablas, avisos dinámicos anunciados, modales con gestión de foco y salida, reflow con zoom, contraste medido y movimiento reducido. Para acciones de soporte, el botón local de finalizar debe permanecer identificable incluso cuando se comparte pantalla. Esto es una especificación de diseño: **no constituye certificación WCAG**.

## 11. Priorización de pantallas por etapa

| Etapa | Panel/portal | Endpoint | Puerta de salida UX |
| --- | --- | --- | --- |
| P0: laboratorio | Empresa ficticia, nodo, entorno, operación, sedes/gateway, equipo y diagnóstico básico | Registro y VPN Windows, estado por módulo, error/reintento | Dos empresas aisladas, LAN repetidas, Internet local y estado de aplicación comprobado |
| P1: producto inicial | Autoservicio, políticas, permisos, soporte, reportes, auditoría, suscripción y operación avanzada | Soporte asistido, actualizaciones, permisos nativos y diagnóstico | Alta y revocación sin SSH/Webmin; consentimiento, errores y recuperación probados |
| P2: evolución opcional | DNS avanzado, SSO/postura según validación, soporte extendido y respaldo/restauración | macOS/Linux/móviles según pruebas; backup de archivos si contratado | Compatibilidad real por plataforma y restauración desde instalación limpia |

La nomenclatura P0/P1/P2 sigue el catálogo de parámetros. Las fases de la definición de producto (descubrimiento, prueba técnica, producto inicial, piloto, evolución y respaldo) se corresponden por alcance, pero no se fusionan en una promesa de fechas.

## 12. Handoff para desarrollo

1. **Antes de construir:** identificar stack, rutas, componentes, tokens, librerías, API, permisos, compatibilidad y canales nativos de cada cliente. Si no existe repositorio, documentar decisiones y no atribuirles estado implementado.
2. **Contrato mínimo de cada pantalla:** `rol`, `empresa activa`, `recurso`, `capacidad contratada`, `permiso de acción`, `estado deseado`, `estado aplicado`, `estado observado`, `timestamp/fuente`, `errores` y acciones permitidas. Marcar campos inaplicables, no llenarlos con valores ficticios.
3. **Contrato de mutaciones:** `preview → validación → confirmación proporcional → operación con idempotencia → estado aplicado → prueba observada → error/reintento/rollback`. La UI no debe declarar éxito antes del acuse del agente y de la prueba correspondiente.
4. **Catálogo como fuente de campos:** mapear `ORG`, `NOD`, `VPN`, `NET`, `DNS`, `ACL`, `END`, `SUP`, `BAK` y `OPS` a pantallas, rol, fase e impacto. No crear formularios para categorías marcadas «Prohibido» o «Fuera».
5. **API y agente:** ambos hacen cumplir el tenant y la autorización. Los secretos nunca van a telemetría, logs, exportaciones o capturas diagnósticas. Solo operaciones tipadas e idempotentes; no comandos arbitrarios.
6. **Telemetría:** cada indicador muestra procedencia, hora y cobertura. Túneles/sesiones VPN no equivalen al número de dispositivos detrás de un gateway; consumo de backup y soporte se reporta aparte.
7. **Cambios con impacto:** marcar si una edición cambia perfiles, obliga reconexión o afecta a otros recursos. Ofrecer revisión de diffs, responsable, motivo y retorno antes de enviar.
8. **Recuperación de UI:** conservar borradores de formulario y filtros, evitar envíos duplicados, restaurar foco tras cierre de diálogo y mantener una referencia rastreable de la operación.

**Entregables esperados de diseño:** mapa de navegación, wireflows de F01–F07 y E1–E5, especificación de componentes/estados, sistema de tokens tras definir marca, prototipos de alta fidelidad para tareas críticas, copy aprobado y matriz de permisos. **Entregables de ingeniería:** contrato de datos, API/permiso por pantalla, componentes reales en el stack elegido, telemetría de estado y pruebas.

## 13. Verificación y criterios de aceptación

| ID | Escenario observable | Resultado exigido |
| --- | --- | --- |
| UX01 | Proveedor crea entorno en empresa A | Ve validación, solicitud, aplicación y prueba real como estados distintos; no puede seleccionar recurso de B por error |
| UX02 | Dos empresas con la misma LAN | Cada una ve solo su LAN y recursos; no se genera alerta falsa por CIDR entre tenants |
| UX03 | Técnico invita equipo con aprobación | Usuario ve empresa y estado pendiente; no accede a red hasta aprobarse |
| UX04 | Equipo directo frente a gateway | Interfaz explica que el equipo directo solo publica sus servicios; gateway publica redes detrás de él |
| UX05 | Falta ruta de retorno | Diagnóstico identifica router externo o SNAT; no declara sucursal operativa |
| UX06 | VPN conectada, ERP no responde | El cliente y portal informan fallo del recurso sin falsear estado del túnel |
| UX07 | Internet general desde endpoint | Ruta local conservada y no existe control para full tunnel; se rechazan rutas por defecto |
| UX08 | Soporte sin VPN contratada | Solicitud autorizada funciona según contrato; consentimiento y cierre quedan registrados |
| UX09 | Proveedor pide control remoto sin permiso | No se inicia sesión; se explica autorización empresarial necesaria sin exponer datos ajenos |
| UX10 | Suspensión de VPN | UI muestra efecto de VPN y estados independientes de soporte/backup según contrato |
| UX11 | Falla a mitad de un cambio | UI conserva configuración anterior, muestra operación parcial y permite reintento idempotente/retorno |
| UX12 | Invitar con token vencido o cupo agotado | Ningún acceso parcial; mensaje accionable sin perder contexto |
| UX13 | Reinstalar cliente o activar módulo nuevo | Identidad se recupera por flujo explícito o se crea una nueva; no duplica inscripción por simple reintento |
| UX14 | Navegación por teclado y lector de pantalla | Flujos críticos completos, foco visible, estados anunciados y diálogos manejables |
| UX15 | Portal con zoom, viewport estrecho y texto largo | Acciones críticas localizables, contenido íntegro y sin scroll horizontal accidental |
| UX16 | Backup de archivos opcional | UI distingue copia completada de restauración comprobada; muestra alcance de archivos y limitaciones |

**Estado de verificación al elaborar este archivo:** UX01–UX16 `NOT RUN`. No hay UI o runtime entregado para emitir resultados `PASS` o `FAIL`. Diseño accesible, responsive, permisos de API, integración nativa, latencia y comportamiento real deberán medirse en prototipos y builds.

## 14. Cobertura de la revisión y decisiones abiertas

| Dominio de Multimodal UI/UX Reviewer | Cobertura de esta especificación | Estado de auditoría visual |
| --- | --- | --- |
| Product UX | Tareas, estados, permisos, prevención y recuperación | `Not reviewed`: sin interfaz existente |
| Accesibilidad | Contratos de teclado, foco, semántica, avisos y zoom | `Not reviewed`: sin DOM/build |
| Layout | Arquitectura de información, densidad y viewports de prueba | `Not reviewed`: sin render |
| Writing | Terminología y mensajes de estados/errores | `Not reviewed`: sin copy final |
| Tipografía | Jerarquía y números operativos | `Not reviewed`: sin fuente/tokens |
| Color | Semántica y requisitos de contraste | `Not reviewed`: sin paleta |
| UI Polish | Componentes, movimiento y consistencia | `Not reviewed`: sin componentes |

**Preservar:** la separación proveedor/empresa/endpoint, identidad única por dispositivo, acceso a recursos privados, módulos independientes, consentimiento de soporte y estados solicitados/aplicados/observados. **No hay fortalezas visuales verificadas**, porque no se proporcionaron capturas ni producto ejecutable. No se asignan hallazgos HIGH/MEDIUM/LOW a una interfaz inexistente.

**Decisiones antes de cerrar pantallas finales:** marca y sistema visual; stack real; parámetros/roles delegables; comportamiento de políticas durante pérdida del control; motor de soporte y permisos efectivos; cobertura nativa de DNS por plataforma; reglas de retorno/NAT y diagnóstico; umbrales/tiempos de estados; alcance de backup/repositorio; copy legal/consentimiento; datos y cuotas reales. Resolver con prototipos de F01–F03 y E1–E3, pruebas moderadas con proveedor, técnico de cliente y usuario final, y medición de los criterios UX01–UX16.

**Veredicto del handoff:** `Needs changes` hasta diseñar, implementar y verificar las superficies. Es un documento de instrucciones listo para iniciar diseño y desarrollo; no es una aprobación de interfaces que todavía no se han observado.
