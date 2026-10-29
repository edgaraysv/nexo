# Wireflows de referencia — no interfaz implementada

Este entregable F01 define estados y puntos de prueba; no son prototipos visuales, copy final ni una aprobación de accesibilidad. Los prototipos interactivos y componentes corresponden a sus cortes posteriores. No se impone marca ni biblioteca visual.

| Flujo | Recorrido | Fallo/recuperación a diseñar | Fase |
| --- | --- | --- | --- |
| F01 Empresa/entorno | Empresa activa → nodo/motor/red → preview → confirmar → operación → ACK → prueba real | Conflicto/cupo/fallo parcial: entorno bloqueado, reintento idempotente o revisión anterior | F04/F06 |
| F02 Equipo | Técnico autorizado → invitación limitada → instalación → clave local → registro → aprobación → políticas | Token expirado/cupo/reintento: sin acceso parcial, misma identidad lógica | F07 |
| F03 Recurso/sucursal | Elegir directo/gateway → CIDR/recursos → retorno o SNAT → política → prueba bidireccional | Solapamiento interno/retorno ausente: no declarar sucursal operativa | F08 |
| F04 Política | Origen → destino → protocolo/puerto → preview → confirmar → revisión → prueba | Cambio de empresa descarta selección anterior; deny por defecto | F08/F09 |
| F05 Diagnóstico | Agente → túnel → ruta → DNS → firewall → recurso | Señal antigua o recurso caído no equivale túnel desconectado; informe saneado | F08/F09 |
| F06 Soporte | Contrato/rol/recurso/autorización → modalidad → consentimiento/política previa → token → sesión → cierre | Rechazo/caducidad/revocación cierra motor, no solo ventana | F10 |
| F07 Backup | Capacidad → carpetas/horario/retención/cuota → copia → versión → restaurar → verificar | Parcial/corrupción/claves: conservar recuperación, no prometer imagen/VM | F16 |
| E1 Instalación | Empresa visible → código → registro → pendiente/activo → módulos | Recuperación explícita de reinstalación, clones sin identidad | F07 |
| E2 VPN | Recursos autorizados → conectar → túnel → prueba recurso | Internet local; desconexión y causa por separado | F07/F08 |
| E3 Asistencia | Técnico/alcance visible → aceptar/rechazar → sesión → terminar | Usuario puede finalizar; conservar auditoría sin pantalla por defecto | F10 |
| E4 Nuevo módulo | Contrato/política → permiso nativo o update firmado → habilitado → prueba | Sin reinstalar manualmente ni nuevo registro; no confundir disponible/operativo | F10/F14/F16 |
| E5 Offline | Última política válida → señal antigua → vigencia → restricción/recuperación | Expiración y reconciliación sin reapertura automática de revocados | F05/F12 |

Todas las pantallas futuras muestran empresa activa, alcance, estado deseado/aplicado/observado, fuente, hora/frescura y siguiente acción autorizada. Probar navegación por teclado, lector, foco, zoom y textos largos en cada superficie real antes de aceptar UX14/UX15.
