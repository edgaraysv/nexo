# Nexo — catálogo de parámetros y operaciones administrables

**Versión:** 1.0 · 20 de octubre de 2026  
**Estado:** especificación propuesta para incorporar a la definición de producto y al plan de implementación. No representa funciones implementadas.  
**Base interna:** `Analisis_Tecnico_Proyecto_Nexo.docx` v1.2 y `Definicion_de_Producto_Nexo.docx` v1.0.  
**Referencias comparadas:** documentación oficial de NetBird y Pritunl al final de este archivo.

## 1. Resultado exigido

Una vez instalado el nodo Nexo, **toda operación rutinaria** de empresas, VPN, redes, equipos, accesos, soporte y, cuando exista, respaldo, se ejecutará desde el panel y la API. El proveedor no deberá entrar por SSH ni usar Webmin para crear clientes, cambiar rutas, renovar credenciales, ajustar los parámetros admitidos o recuperar un entorno VPN fallido. El panel registra estado deseado; el agente del nodo valida y aplica cambios; la interfaz distingue **solicitado**, **aplicado**, **operativo** y **error**.

La primera instalación del host, parches del sistema operativo/kernel, reparación si control y agente están caídos, incidentes del hipervisor/EC2 y recuperación de emergencia conservan procedimientos de infraestructura. El panel puede mostrar su estado y coordinar tareas seguras, pero no ofrecerá terminal root ni un editor de comandos arbitrarios.

## 2. Convenciones de alcance

| Marca | Entrega | Responsable por defecto |
| --- | --- | --- |
| P0 | Laboratorio funcional en EC2 nueva y dos empresas ficticias. | Proveedor (PR) salvo lectura delegada. |
| P1 | Producto inicial y piloto real controlado. | Proveedor (PR), administrador de empresa (AE) o técnico delegado (TE) según campo. |
| P2 | Evolución validada por demanda. El respaldo de clientes pertenece a esta fase opcional. | Permiso específico por módulo. |

**Cambios:** `B` bajo riesgo y aplicables en caliente; `M` pueden interrumpir un módulo o exigir reconexión; `A` afectan rutas, identidad, cifrado, alcance o datos y requieren vista previa, confirmación reforzada y plan de retorno. Estas clases son propuestas de diseño, no una garantía universal: cada adaptador debe declarar su impacto real por plataforma y versión.

En las tablas, **PR** administra infraestructura; **AE** sólo su empresa; **TE** sólo acciones delegadas; **RO** es lectura dentro de su ámbito. Ninguna vista editable sustituye autorización en API y agente. Los campos derivados, como versión efectiva o bytes medidos, son de lectura.

## 3. Modelo de configuración y guardas comunes

Cada parámetro administrable tendrá `id`, empresa/entorno/endpoint propietario, tipo, valor permitido, valor predeterminado, ámbito, rol, servicio contratado, fase, versión de esquema, secreto o dato público, impacto, revisión deseada y revisión aplicada. Las modificaciones guardarán actor, motivo, instante, diferencias, resultado y vínculo a la operación. La API validará rangos, CIDR, puertos, conflictos, cuota, permisos y compatibilidad antes de publicar una revisión. El agente sólo ejecutará operaciones tipadas e idempotentes.

El panel debe ofrecer **vista previa del cambio**, dependencias afectadas, aviso si habrá reconexión o nuevo perfil, confirmación según riesgo, estado por nodo, error legible, reintento seguro y reversión hacia la última revisión válida. Pritunl advierte que ciertas modificaciones de servidor obligan a actualizar perfiles de cliente; Nexo debe detectar esto antes de aplicar el cambio y distribuir configuración mediante el cliente universal. [P1]

## 4. Organización, contrato y permisos

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| ORG01 | Nombre, identificador visible, estado y datos de contacto de empresa | PR | P1 | `tenant_id` inmutable; el nombre puede cambiar sin mover identidades. |
| ORG02 | Plan y módulos contratados por empresa | PR | P1 | VPN, remoto y backup con capacidades y estados separados. |
| ORG03 | Cupos de endpoints, gateways, redes, técnicos, sesiones y almacenamiento | PR | P1 | Reserva atómica; reducción no elimina recursos automáticamente. |
| ORG04 | Vigencia, gracia, suspensión y cancelación por módulo | PR | P1 | Mostrar estado solicitado y aplicado; conservar historial según política. |
| ORG05 | Grupos, etiquetas y sede de usuarios/equipos | AE/TE | P1 | Pertenencia y políticas siempre dentro del tenant. |
| ORG06 | Membresías, invitación de usuarios, roles y permisos delegados | AE | P1 | Alcance por recurso y acción; un usuario multiempresa selecciona contexto. |
| ORG07 | MFA, caducidad/revocación de sesión y recuperación de cuenta | PR/AE | P1 | MFA exigida a administradores y técnicos. |
| ORG08 | Autorización de soporte del proveedor: alcance, modalidad y vencimiento | AE | P1 | Ser operador del proveedor no concede acceso por defecto. |
| ORG09 | Excepciones temporales a cupo o políticas | PR | P1 | Motivo, responsable y vencimiento obligatorios. |
| ORG10 | Federación SSO y sincronización de grupos | PR/AE | P2 | Mapear identidades y roles sin ampliar acceso implícitamente. |

**Inspiración:** grupos y políticas de NetBird; organizaciones, usuarios y grupos de Pritunl. Nexo usará sus propias entidades de empresa y endpoint. [N1] [P2]

## 5. Nodos de infraestructura y entornos VPN

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| NOD01 | Nombre, etiquetas, región y descripción del nodo | PR | P0 | Región y EC2 real se observan, no se inventan desde la aplicación. |
| NOD02 | Dirección pública o FQDN publicado para clientes | PR | P0 | Validar DNS/TLS; avisar impacto sobre perfiles. |
| NOD03 | Capacidades del nodo: motores, versión, puertos libres y capacidad | RO/PR | P0 | Versiones y salud obtenidas del agente. |
| NOD04 | Inventario de entornos por nodo y reservas de puerto | PR | P0 | Puerto único por entorno y motor en la IP pública correspondiente. |
| NOD05 | Crear, iniciar, detener, suspender, reiniciar o retirar un entorno | PR | P0 | Sólo afecta ese entorno; retirada revoca y limpia recursos. |
| NOD06 | Límites de CPU, memoria, procesos, disco y ancho de banda por entorno | PR | P1 | Controles efectivos medidos; sin prometer aislamiento físico. |
| NOD07 | Revisión deseada/aplicada, estado del agente, motor y último error | RO/PR | P0 | Estado observado independiente de la aceptación de una solicitud. |
| NOD08 | Diagnóstico controlado y descarga temporal de logs saneados | PR | P1 | Sin claves privadas, tokens ni comandos arbitrarios. |
| NOD09 | Programación de mantenimiento y actualización firmada del agente | PR | P1 | Por grupos; compatibilidad y reversión verificadas. |
| NOD10 | Trasladar una empresa a otro nodo | PR | P2 | Reservar destino, probar, reconectar y retirar origen; no prometer failover automático. |
| NOD11 | Nivel de alerta y umbrales de salud/capacidad por nodo | PR | P1 | Medir CPU, memoria, disco, túneles, errores y saturación. |
| NOD12 | Estado de copia y restauración del plano de control | PR | P1 | Verificación desde instalación limpia; no confundir con backup de clientes. |

La topología inicial es una EC2 nueva compartida con un entorno VPN lógico por empresa. `namespace` de red, rutas, firewall y credenciales son propios de cada empresa, con controles adicionales de procesos y archivos. El proveedor controla el host; el cliente nunca edita namespaces ni puertos directamente.

## 6. Motor VPN y perfil técnico por entorno

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| VPN01 | Nombre, descripción, nodo y empresa propietarios del entorno | PR | P0 | Una empresa puede tener varios dominios de red explícitos. |
| VPN02 | Motor OpenVPN Community o WireGuard, habilitación y versión | PR | P0/P1 | OpenVPN primero; WireGuard según adaptador probado. Cambio de motor es migración, no un toggle ciego. |
| VPN03 | Protocolo y puerto del listener | PR | P0 | UDP por defecto; validar exposición de red y conflictos. |
| VPN04 | Pool VPN IPv4, capacidad y reservas | PR | P0 | Prohibir conflicto dentro del entorno; permitir CIDR idéntico en empresas aisladas. |
| VPN05 | Política IPv6, pool y rutas IPv6 | PR | P0/P1 | Denegación segura y pruebas IPv6; no habilitar sin soporte integral. |
| VPN06 | MTU/MSS y diagnóstico de fragmentación | PR | P1 | Perfil recomendado primero, ajuste avanzado validado por motor. |
| VPN07 | Perfil criptográfico aprobado y versión mínima de protocolo | PR | P1 | Opciones seguras predefinidas; no permitir algoritmos obsoletos o texto libre. |
| VPN08 | Tiempo de sesión, keepalive, ping/timeout y reconexión | PR | P1 | Rangos acotados; diferenciar OpenVPN de WireGuard. |
| VPN09 | Máximo de peers/sesiones y límite por entorno | PR | P1 | No equivale al total de equipos detrás de gateways. |
| VPN10 | Comunicación endpoint a endpoint | PR/AE | P1 | Desactivada por defecto; abrir sólo por política de origen/destino. |
| VPN11 | Administración de certificados, CA, emisión, renovación y revocación | PR | P0/P1 | Claves protegidas fuera del proceso web; rotación con continuidad controlada. |
| VPN12 | Peers WireGuard: clave pública, AllowedIPs derivados, keepalive y clave adicional opcional | PR | P1 | Claves privadas generadas localmente; AllowedIPs coherente con política y rutas. |
| VPN13 | Política de descarga y sincronización de configuración cliente | PR | P1 | Avisar cuando un cambio obliga a reconectar o actualizar perfil. |
| VPN14 | Perfil de diagnóstico temporal | PR | P1 | Tiempo limitado y logs saneados; nunca dejar depuración verbosa indefinida. |
| VPN15 | Modo Internet por VPN o ruta `0.0.0.0/0`, `::/0` | Ninguno | Prohibido | Nexo ofrece acceso sólo a recursos privados; rechazar también agregados equivalentes. |
| VPN16 | Modo puente L2 y directivas OpenVPN/WireGuard arbitrarias | Ninguno | Fuera | No exponer editor libre; integrar una opción sólo tras modelarla, validarla y probarla. |

Pritunl documenta puerto, protocolo, red virtual, WireGuard, DNS, cifrado, ping, máximo de clientes y comunicación entre clientes. El catálogo de Nexo conserva esas categorías con valores seguros y alcance acotado. Pritunl incluye por defecto una ruta de salida general a Internet, que **Nexo debe rechazar** por definición de producto. [P1] [P3]

## 7. Sucursales, gateways, redes y recursos privados

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| NET01 | Nombre, ubicación y responsable de la sucursal | AE/TE | P1 | Sede pertenece a una sola empresa. |
| NET02 | CIDR LAN IPv4/IPv6 y descripción de red | AE/TE | P0/P1 | Validar solapamiento dentro del dominio; entre empresas puede repetirse. |
| NET03 | Gateway asignado, prioridad y estado | PR/AE | P0/P1 | Identidad individual y dispositivo apto para operación continua. |
| NET04 | Redes y recursos publicados: IP, CIDR o FQDN | AE/TE | P1 | El FQDN exige resolución consistente y límites de destino; empezar con IP/CIDR en piloto. |
| NET05 | Nombre y grupo lógico de recursos | AE/TE | P1 | Permite reglas por aplicación o servidor, no sólo toda la LAN. |
| NET06 | Distribución de rutas a grupos de endpoints | AE/TE | P1 | Sólo rutas aprobadas y asociadas a una política de acceso. |
| NET07 | Ruta de retorno declarada en router LAN | AE/TE | P0 | Mostrar prueba y estado; Nexo no puede modificar routers ajenos sin integración. |
| NET08 | SNAT/masquerade privado por red | PR/AE | P0/P1 | Habilitar sólo cuando no haya ruta de retorno; mostrar pérdida de IP origen. |
| NET09 | Comunicación de LAN a LAN y dirección permitida | AE/TE | P1 | Prueba en ambos sentidos; no crear enlaces entre empresas. |
| NET10 | Prioridad y failover entre gateways | PR/AE | P2 | Requiere salud y pruebas, no basta con añadir otro gateway. |
| NET11 | Salud de recursos: TCP, ICMP o sonda permitida | AE/TE | P1 | Frecuencia limitada; distinguir caída de túnel de caída de aplicación. |
| NET12 | Traducción/renumeración para LAN superpuestas dentro de una empresa | PR | P2 | Plan explícito antes de activar; sin rutas ambiguas en cliente. |
| NET13 | Exposición de servicios del gateway mismo | PR/AE | P1 | Política distinta de la que autoriza tráfico a recursos detrás del gateway. |
| NET14 | Publicar recursos en Internet mediante reverse proxy | Ninguno | Fuera inicial | Es un producto distinto; no inferirlo de la VPN privada. |

NetBird separa el recurso accesible, el routing peer y la política de acceso; también diferencia tráfico **a través** del gateway del tráfico **hacia** el propio gateway. Pritunl documenta rutas y NAT, y advierte que el acceso inverso a una LAN requiere rutas en el router. [N2] [P3] [P4]

## 8. DNS privado

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| DNS01 | Dominio interno y sufijo de búsqueda por empresa/grupo | AE/TE | P1 | Verificar conflicto con DNS local y sufijos de otras empresas. |
| DNS02 | Resolvers internos primario/secundario para dominios concretos | AE/TE | P1 | Deben ser alcanzables y autorizados por ruta/política. |
| DNS03 | Política de DNS dividido por dominio | PR/AE | P1 | Sólo consultas de dominios internos van al resolver privado; las demás conservan DNS local. |
| DNS04 | Registro de nombre del endpoint/gateway y alias | AE/TE | P1/P2 | Unicidad por empresa y permisos para crear alias. |
| DNS05 | Zona privada y registros A/AAAA/CNAME | AE | P2 | Si se decide alojar DNS en Nexo; evitar prometerlo en primera etapa. |
| DNS06 | Excepción para dispositivos cuyo DNS gestiona otra solución | PR/AE | P1 | Registrar modo y efecto por endpoint; no asumir mismo comportamiento en todos los SO. |
| DNS07 | Prueba de resolución por endpoint y gateway | TE/RO | P1 | Mostrar servidor consultado y destino resultante, sin secretos. |
| DNS08 | Forzar todo DNS/Internet por VPN | Ninguno | Prohibido | Contradice navegación local; sólo evaluar una excepción con cambio formal de producto. |

La guía de NetBird documenta nameservers por grupos, dominios coincidentes, DNS dividido y zonas internas; Nexo adopta la capacidad de DNS privado sin redirigir la navegación pública. [N3]

## 9. Políticas de acceso

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| ACL01 | Grupo origen de usuarios, equipos o sedes | AE/TE | P1 | El grupo nunca contiene miembros de otra empresa por accidente. |
| ACL02 | Grupo o recurso destino | AE/TE | P1 | IP/CIDR/FQDN y gateway asociados al mismo tenant y dominio. |
| ACL03 | Protocolo y puertos TCP/UDP/ICMP | AE/TE | P1 | Rangos válidos; evitar `ALL` si un servicio permite alcance menor. |
| ACL04 | Dirección de inicio de conexión | AE/TE | P1 | Unidireccional o bidireccional según escenario; revisar retorno stateful. |
| ACL05 | Estado de política, vigencia y versión | AE/TE | P1 | Denegar por defecto; cambios auditados y aplicados con revisión. |
| ACL06 | Vista previa de quién puede llegar a qué destino | AE/TE | P1 | Simulación de reglas y prueba después de aplicar. |
| ACL07 | Excepción temporal por usuario/endpoint/recurso | AE | P1 | Justificación, aprobación y expiración. |
| ACL08 | Condiciones de postura del dispositivo | PR/AE | P2 | Agente, SO, versión, certificado o integración EDR, sujeto a verificación real. |
| ACL09 | Horarios de acceso por política | AE | P2 | Definir zona horaria y comportamiento sin conexión al control. |
| ACL10 | Política abierta para todos los peers | Ninguno | Prohibido por defecto | No replicar la política inicial permisiva de NetBird; sólo autorizaciones explícitas. |

NetBird aporta el patrón de grupos, destino, protocolo/puerto, dirección y postura, pero su documentación también señala una política inicial muy permisiva para cuentas nuevas. Nexo debe iniciar cada empresa sin accesos entre peers salvo las reglas necesarias para el recorrido de alta. [N1] [N4]

## 10. Registro e inventario de equipos

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| END01 | Invitación: empresa, sede, grupo y rol de endpoint/gateway | AE/TE | P0/P1 | El permiso de gateway es adicional al de equipo normal. |
| END02 | Token de un uso o reutilizable con límite, vencimiento y SO permitido | AE/TE | P0/P1 | Un uso por defecto; hash en servidor, una sola vista del secreto. |
| END03 | Aprobación manual antes de habilitar red | AE/TE | P1 | Endpoint pendiente sin acceso a recursos; reglas de aprobación definidas. |
| END04 | Identificador inmutable, nombre visible, usuario y grupo | AE/TE | P0/P1 | No basar identidad en hostname, IP o MAC. |
| END05 | Plataformas, versión de agente y módulos disponibles/habilitados/operativos | RO | P1 | Compatibilidad por plataforma probada. |
| END06 | Reserva de IP VPN por equipo | PR/AE | P1 | Sólo dentro del pool y sin colisión. |
| END07 | Acciones conectar/desconectar, suspender, reactivar, retirar | AE/TE | P1 | Revocar credenciales cuando corresponde; confirmar efecto en el motor. |
| END08 | Rotación de certificado/clave y recuperación de identidad | PR/AE | P1 | Reinstalación/compromiso mediante flujo explícito; no reutilizar clave antigua. |
| END09 | Autoasignación de grupos desde la invitación | AE/TE | P1 | Sólo al alta; cambios posteriores requerirán operación propia. |
| END10 | Modo efímero para workloads temporales | PR/AE | P2 | Caducidad y limpieza definidas; no aplicarlo a gateways siempre activos. |
| END11 | Límite de dispositivos por persona | PR/AE | P1 | Cada dispositivo tiene identidad propia; no compartir certificado. |
| END12 | Actualización firmada, canal y ventana de despliegue | PR | P1 | Gradual con reversión y conservación de identidad. |
| END13 | Diagnóstico local: conexión, DNS, ruta, política y versión | TE/RO | P1 | Datos mínimos y acceso controlado, sin secretos. |

NetBird proporciona como referencia claves de alta de un uso o reutilizables, caducidad, límite de usos, grupos automáticos, peers efímeros y aprobación. Esas ideas se implementan en Nexo sin depender de una función comercial de NetBird. [N5] [N6]

## 11. Soporte remoto opcional

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| SUP01 | Capacidad contratada, equipos y técnicos habilitados | PR/AE | P1 | Puede existir sin VPN activa. |
| SUP02 | Acceso proveedor: empresas, equipos, motivo y caducidad | AE | P1 | Autorización separada y revocable. |
| SUP03 | Modalidad asistida o desatendida por grupo de equipos | AE | P1 | Asistida pide consentimiento; desatendida requiere política previa. |
| SUP04 | Permisos por sesión: pantalla, terminal, archivos, portapapeles | AE/TE | P1 | Mínimo necesario; token temporal y autorización del motor. |
| SUP05 | Tiempo máximo, inactividad y reconexión de sesión | AE/PR | P1 | Cierre por expiración y revocación. |
| SUP06 | Aprobación visible y botón local para finalizar | Usuario/AE | P1 | Mostrar identidad del técnico y resultado. |
| SUP07 | Registro de participante, inicio, fin, motivo y resultado | RO | P1 | Sin grabar pantalla ni secretos por defecto. |
| SUP08 | Grabación, retención y acceso a grabación | PR/AE | P2 | Requiere decisión de privacidad, almacenamiento y consentimiento. |
| SUP09 | Relay, selección de transporte y cuota | PR | P1/P2 | Medir tráfico; no prometer E2EE en modos no verificados. |
| SUP10 | Control remoto móvil Android/iOS | Ninguno | Fuera | Móviles mantienen alcance VPN. |

## 12. Respaldo empresarial opcional

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| BAK01 | Activación comercial por empresa y asignación de endpoints | PR/AE | P2 | Reutiliza instalación e identidad del agente. |
| BAK02 | Carpetas, patrones de inclusión/exclusión y archivos ocultos | AE/TE | P2 | Vista previa de cobertura; permisos de lectura comprobados. |
| BAK03 | Frecuencia, ventana, reintentos y comportamiento offline | AE/TE | P2 | Sin saturar red ni CPU. |
| BAK04 | Retención por versiones, tiempo y cuota | PR/AE | P2 | Política clara de eliminación y límites. |
| BAK05 | Límite de ancho de banda, CPU y disco temporal | PR/AE | P2 | Independiente del túnel VPN. |
| BAK06 | Repositorio externo, credenciales y claves por empresa | PR | P2 | Fuera de EC2 VPN; los equipos no pueden destruir la última copia protegida. |
| BAK07 | Estado, última copia válida, errores, omisiones y versiones | RO | P2 | Completada no significa recuperable. |
| BAK08 | Solicitud de restauración, versión y destino original/alternativo | AE/TE | P2 | Autorización por tenant y verificación de contenido/metadatos. |
| BAK09 | Prueba periódica de restauración desde instalación limpia | PR/AE | P2 | Evidencia y resultado independiente de tareas de copia. |
| BAK10 | Inmutabilidad y S3 Object Lock | PR | P2 | Evaluar compatibilidad de retención, borrado y mantenimiento del motor. |
| BAK11 | Backup de bases de datos, imagen de equipo y VM | Ninguno | Posterior | Alcance y consistencia distintos del respaldo inicial de archivos. |

## 13. Observabilidad, operación y automatización

| ID | Parámetro u operación | Rol | Fase | Regla principal |
| --- | --- | --- | --- | --- |
| OPS01 | Estado por nodo, entorno, gateway, endpoint y módulo | RO | P0/P1 | Fuente, fecha y calidad de señal visibles. |
| OPS02 | Conexiones, desconexiones, bytes, tasas y latencia | RO | P1 | Diferenciar VPN, soporte y backup; evitar doble conteo. |
| OPS03 | Auditoría de cambios, invitaciones, accesos y sesiones | RO | P1 | Actor, empresa, recurso, antes/después y resultado; sin secretos. |
| OPS04 | Retención y exportación de eventos y métricas | PR/AE | P1 | Ámbito del tenant y cuota; UTC almacenado, zona local mostrada. |
| OPS05 | Alertas por caída, saturación, expiración y fallo de aplicación | PR/AE | P1 | Canales configurables y escalamiento; no alertar por cada heartbeat perdido. |
| OPS06 | Diagnóstico guiado: ruta, DNS, firewall, handshake y recurso | TE/PR | P1 | Resultados observados y trazables; nunca ejecutar shell libre. |
| OPS07 | Reintentar, revertir y reconciliar operación | PR/AE | P0/P1 | Idempotencia, revisión y alcance por empresa. |
| OPS08 | API versionada y tokens para automatización | PR/AE | P1/P2 | Mismos permisos que el panel, expiración y alcance por recurso. |
| OPS09 | Webhooks y streaming de auditoría/SIEM | PR | P2 | Firmados, con reintentos y sin datos innecesarios. |
| OPS10 | Restauración del control y verificación de copia externa | PR | P0/P1 | Ensayo real antes de cliente productivo. |

NetBird documenta auditoría de cambios a peers, grupos y políticas, y Pritunl permite ver logs desde su consola. Nexo debe reunir ambos patrones con estados de aplicación y calidad de medición. [N7] [P5]

## 14. Pantallas propuestas

| Superficie | Vista | Acciones principales |
| --- | --- | --- |
| Proveedor | Empresas y planes | Crear empresa, activar módulos, cuotas, gracia y suspensión. |
| Proveedor | Nodos | Salud, capacidad, puertos, versiones, logs saneados, mantenimiento y copia del control. |
| Proveedor | Entornos VPN | Crear, editar con vista previa, aplicar, reiniciar, revertir, retirar y probar. |
| Empresa | Sucursales y recursos | Gateways, CIDR, recursos, rutas de retorno, DNS y pruebas. |
| Empresa | Equipos | Invitaciones, aprobación, grupos, módulos, conexión y revocación. |
| Empresa | Accesos | Matriz origen-destino, puertos, permisos y simulación. |
| Empresa | Soporte | Técnicos, autorizaciones, sesiones activas e historial. |
| Empresa | Respaldos (P2) | Políticas, versiones, alertas y restauración. |
| Proveedor y empresa | Operaciones y reportes | Estado real, impacto, errores, reintento, consumo y auditoría. |

El panel puede ofrecer vista **Simple** con tareas frecuentes y vista **Avanzada** con parámetros aprobados. Ambas llaman a la misma API y validaciones. Nunca mostrar un campo sólo porque existe una directiva en OpenVPN o una clave en WireGuard: cada opción debe tener un significado de producto, compatibilidad declarada y una forma de verificarla.

## 15. Decisiones del catálogo que deben cerrarse antes de implementar

1. Qué parámetros de motor cambian en caliente, cuáles desconectan usuarios y cuáles obligan a redistribuir configuración en cada plataforma.
2. Valores mínimos/máximos de pools, puertos, keepalive, MTU, sesión, cupos y retenciones, ligados a pruebas de carga y compatibilidad.
3. Qué operaciones delegará el proveedor a administradores y técnicos de empresa, y qué cambios de alto impacto requerirán doble aprobación.
4. Formato de políticas y simulador de acceso; tratamiento de CIDR idénticos entre empresas y superposiciones dentro de una empresa.
5. Alcance de DNS privado en Windows, macOS, Linux y móviles, evitando desviar consultas públicas.
6. Motor final de soporte y contrato de permisos reales del motor; transporte directo/relay y advertencias de cifrado.
7. Motor y repositorio de backup, custodia/recuperación de claves, retención e inmutabilidad.
8. Grado de automatización de EC2, security groups, snapshots y actualizaciones del host; credenciales mínimas y procedimiento de emergencia.

## 16. Pruebas de aceptación del panel

- Crear una empresa, entorno, sucursal, gateway y equipo **sin SSH ni Webmin**, con una operación visible de extremo a extremo.
- Editar puerto, pool, DNS y rutas con vista previa; mostrar reconexiones necesarias y confirmar aplicación real.
- Rechazar `0.0.0.0/0`, `::/0` o un agregado que convierta Nexo en salida general a Internet; mantener la ruta local.
- Configurar dos empresas con LAN idéntica y probar aislamiento de datos, rutas, DNS, motor remoto y auditoría.
- Revocar un endpoint y suspender un servicio mientras está activo; verificar que el motor aplica el cambio y que otros módulos siguen según contrato.
- Reiniciar un entorno, luego toda la EC2; reconstruir políticas sin abrir accesos mientras se recupera.
- Interrumpir una aplicación de cambio; reintentar sin duplicar rutas, peers, certificados ni puertos; revertir a la última revisión válida.
- Activar soporte en un endpoint ya registrado sin reinstalarlo; comprobar autorización, consentimiento y cierre de sesión.
- Si existe backup, activarlo en el agente existente y restaurar datos desde instalación limpia con metadatos verificados.

## Referencias oficiales consultadas

- **[N1] NetBird — Groups and Access Policies:** https://docs.netbird.io/manage/access-control/manage-network-access
- **[N2] NetBird — Networks, Resources and Routing Peers:** https://docs.netbird.io/manage/networks
- **[N3] NetBird — Internal DNS Servers:** https://docs.netbird.io/manage/dns/internal-dns-servers
- **[N4] NetBird — Posture Checks:** https://docs.netbird.io/manage/access-control/posture-checks
- **[N5] NetBird — Setup Keys:** https://docs.netbird.io/manage/peers/register-machines-using-setup-keys
- **[N6] NetBird — Peer Approval:** https://docs.netbird.io/manage/peers/approve-peers
- **[N7] NetBird — Audit Events Logging:** https://docs.netbird.io/manage/activity
- **[P1] Pritunl — Server Configuration:** https://docs.pritunl.com/kb/vpn/servers/configuration
- **[P2] Pritunl — User Groups:** https://docs.pritunl.com/kb/vpn/users/groups
- **[P3] Pritunl — Routes:** https://docs.pritunl.com/kb/vpn/servers/routing
- **[P4] Pritunl — Network Links:** https://docs.pritunl.com/kb/vpn/tutorials/network-links-1
- **[P5] Pritunl — Logging:** https://docs.pritunl.com/kb/vpn/system/logging

Las referencias documentan funciones de otros productos. Este catálogo es una **recomendación de diseño para Nexo**; no afirma equivalencia funcional ni traslada licencias, configuraciones predeterminadas o resultados de rendimiento de esos sistemas.
