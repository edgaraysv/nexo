# Nexo Dashboard UX/UI v2.1 — handoff del prototipo aislado

**Estado:** entregable de revisión UX, no implementación de producto. El prototipo en `prototype/` consume fixtures locales, no llama APIs, no modifica permisos y no cambia UI productiva. No se desplegó ni se publicó.

## 1. Evidencia y límites

- Verificación reproducible: `node docs/ux/nexo-dashboard-v2.1/prototype/verify.mjs`.
- Última ejecución: **393/393 checks PASS; 89 capturas** (Chromium headless, 4 de noviembre de 2026). `screenshots/after/verification.json` conserva el resultado y los detalles por aserción.
- Matriz: UX-01…UX-14 × 320/768/1440 px × light/dark (84 capturas) y cinco estados adicionales a 1440/light (vacío, carga, error, stale, forbidden). No hay overflow horizontal de página en los tamaños probados.
- Las capturas son estado **después** del concepto; `screenshots/before/original-1440-light.png` es la referencia anterior disponible. No se creó un antes por tarea, porque la pantalla fuente es un único HTML demostrativo, no catorce implementaciones equivalentes.
- Pruebas de teclado automatizadas en Chromium: skip link; apertura del menú con Enter; Tab dentro del menú; activación del enlace Dispositivos con Enter; Escape y restauración de foco; foco/escape/restauración de la ficha; Tab/Enter del wizard y validación de usos. No sustituyen revisión con lector de pantalla ni pruebas manuales.
- Pruebas de datos: cambio de ámbito borra `q`/`kind`; operador asignado no recibe selector global; Empresa B no muestra fixtures A; filtro, contador, URL y CSV local coinciden; `company.admin` no obtiene export por defecto y el fixture `auditorExport` sí representa un grant separado.
- Chromium no registró excepciones JS ni solicitudes HTTP(S) externas en esa ejecución. `localStorage` se usa únicamente para el tema visual. Los formularios, navegación de persona y resultados operativos son simulados.
- Contraste: medición aritmética de combinaciones representativas del prototipo, no de cada estado/componente y **no una certificación WCAG**. Se usa fuente del sistema; no se cargan Manrope/Inter remotamente.
- No probados: 1920 px, zoom/reflow al 200 %, orientación tablet, NVDA/VoiceOver, cliente Windows/Tauri real, API/DB/agente, navegador adicional, privacidad/retención productiva ni pruebas con usuarios. No afirmar conformidad WCAG ni aceptación de producción.

### Combinaciones de contraste medidas

| Combinación del prototipo | Ratio |
|---|---:|
| Light: texto primario/surface blanca | 14.18:1 |
| Light: texto secundario/surface blanca | 5.85:1 |
| Light: texto secundario/canvas | 5.29:1 |
| Light: blanco/sidebar navy | 11.32:1 |
| Light: texto de botón/acción primaria | 5.37:1 |
| Light: warning/fondo warning | 5.09:1 |
| Light: success/fondo success | 4.86:1 |
| Dark: texto primario/surface | 14.62:1 |
| Dark: texto secundario/surface | 10.00:1 |
| Dark: texto secundario/canvas | 11.12:1 |
| Dark: acción secundaria/surface | 8.06:1 |
| Dark: acción secundaria/fondo informativo | 6.82:1 |
| Dark: texto de botón/acción primaria | 5.37:1 |

Los tokens son locales a `prototype/styles.css`; no se han cambiado `design/nexo-ui/nexo-tokens.css` ni los estilos de producción. La paleta institucional continúa siendo la especificada para SYSMedia/Nexo; dark y `action-text` son decisiones de este artefacto sujetas a aprobación.

## 2. Contexto común para desarrollo

### Roles y ámbitos simulados

El selector “Persona de prueba · no autentica” cambia fixtures, no sesión ni privilegios. Los perfiles se inspiran en la matriz de `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md` y en `product/api/authorization.ts`:

| Perfil en prototipo | Pantallas y alcance representado |
|---|---|
| Proveedor · propietario | Resumen, empresas, VPN y auditoría; puede cambiar entre fixtures asignados A/B. Crear/actualizar se muestra como owner-only, sin enviar. |
| Proveedor · operador asignado | Lectura limitada a Empresa demo A; sin selector de otros tenants. |
| Proveedor · auditor asignado | Lectura asignada; no se inventa auditoría global. |
| Empresa demo A/B · administrador | Shell de un tenant; sin cambio de tenant. Export no se infiere del rol. |
| Empresa demo A · técnico delegado | Vista de dispositivos/redes/diagnóstico y previews locales; los grants por recurso reales siguen siendo obligatorios. |
| Empresa demo A · auditor | Lectura y auditoría; export deshabilitado por defecto. |
| Empresa demo A · auditor + grant export | Fixture específico para representar `company.report.export`, no un nuevo rol del producto. |
| Usuario endpoint · Windows | Vista local simulada; no ejecuta agente ni cliente VPN. |

`permissionsForCompanyRole()` excluye expresamente `company.report.export` de los permisos implícitos de admin, técnico y auditor. En el producto, un permiso de rol no reemplaza membresía, tenant, grant vigente, recurso ni entitlement; el servidor debe volver a autorizarlos en cada petición.

### Estados comunes del prototipo

El disclosure **Estados para revisión · solo demostración** permite revisar estos estados sin backend:

| Estado | Representación y contrato recomendado al integrar |
|---|---|
| Normal | Fixture identificado; fuente, alcance/cobertura y corte indicados donde hay indicadores. |
| Empty | Sin registros para el alcance/filtros; explica siguiente acción solo si el permiso simulado la permite. |
| Loading | Placeholder con `aria-busy`; no inventa resultados. |
| Error recuperable | Aviso `role=alert`, conserva contexto y ofrece reintento local; una mutación real requiere reconciliar si pudo aplicarse. |
| Stale | Advierte observación vencida; no convierte valor viejo en estado verde. En producción mostrar `observed_at`, fuente y regla de frescura. |
| Forbidden | Estado de revisión 403 ilustrativo, sin presentar una respuesta del servidor. El servidor debe filtrar datos antes de enviarlos. |

`Parcial`, `capacidad no contratada` y `aplicada pero pendiente de verificación` no se modelan como contrato transversal completo; definirlos por entidad antes de integrar. Soporte remoto y respaldos aparecen sin CTA operativa.

### Reglas de contrato que cruzan todas las pantallas

- Mantener separados `rol`, tenant activo, recurso, capacidad/entitlement, permiso, estado deseado, aplicado y observado, timestamp/fuente, cobertura, error y acción permitida. Un campo no disponible se omite o se marca como no observado; no se fabrica.
- No inferir acceso a aplicación a partir de agente o túnel. `NetworkDiagnostic.connectivity` es literalmente `'not_tested'` en `product/api/private-network-repository.ts`.
- Mutaciones reales: preview/validación/confirmación proporcional y respuesta del servidor; estado aplicado y prueba observada se muestran por separado. No afirmar idempotencia o `operation_id` donde el endpoint no los ofrece.
- El logo oficial no está en los assets inspeccionados; se deja placeholder. Nexo es el producto y SYSMedia la marca institucional.

## 3. Handoff por tarea UX

### UX-01 — Arquitectura de ámbitos

- **Antes → después:** el concepto original cambiaba el texto del selector de empresa pero mantenía la misma colección (`H02`). El shell aislado separa navegación por superficie/rol, muestra el contexto y limpia filtro/tipo al cambiar el fixture de tenant. Operador/auditor solo ve su empresa asignada simulada; owner puede seleccionar fixtures asignados.
- **Flujo/roles:** owner proveedor → resumen/empresa A o B; operador y auditor proveedor → A asignada; admin/técnico/auditor empresa → tenant fijo; endpoint → su propia vista. Cambio de persona reinicia filtros y pantalla.
- **Contrato y seguridad:** proveedor: `GET /v1/provider/companies`; creación/asignación exige `providerIdentity(..., true)` (`product/api/application.ts`). Empresa: membresía/scope y `companyIdentity`; la selección de demo no autentica ni autoriza. En producto también invalidar selección, cache y solicitudes del tenant anterior.
- **Estados/aceptación:** los seis estados comunes son estados de prototipo. PASS en prueba de aislamiento fixture A/B, borrado de filtros al cambiar scope y selector oculto para operador asignado. Para producción falta comprobar sesión, assignments, cache/abort y acceso cruzado en API.
- **Capturas:** [320/L](screenshots/after/UX-01-320-light.png) · [320/D](screenshots/after/UX-01-320-dark.png) · [768/L](screenshots/after/UX-01-768-light.png) · [768/D](screenshots/after/UX-01-768-dark.png) · [1440/L](screenshots/after/UX-01-1440-light.png) · [1440/D](screenshots/after/UX-01-1440-dark.png).

### UX-02 — Menú móvil y navegación semántica

- **Antes → después:** el sidebar original desaparecía por debajo de 850 px sin sustituto (`H01`) y solo marcaba clase activa (`H07`). Ahora se presenta “Menú” y un `<dialog>` nativo, con enlaces, `aria-current`, nombres accesibles, `aria-expanded`, skip link y un `h1` por vista.
- **Flujo/roles:** navegación se reconstruye desde las pantallas autorizadas del perfil simulado; a 320/768 px abrir menú, recorrer enlaces y elegir ruta; a escritorio queda sidebar persistente.
- **Contrato y seguridad:** navegación semántica del cliente; no concede permisos. API vuelve a validar sesión, tenant y ruta/acción.
- **Estados/aceptación:** PASS en 320/768/1440, ambos temas, overflow de página, no superposición de contexto/selector, skip link, apertura con Enter, Tab dentro del diálogo, Enter sobre “Dispositivos”, Escape y foco de retorno. Capturas móviles comprueban que enlaces no heredan el blanco del sidebar. Lector de pantalla y 1920 px pendientes.
- **Capturas:** [320/L](screenshots/after/UX-02-320-light.png) · [320/D](screenshots/after/UX-02-320-dark.png) · [768/L](screenshots/after/UX-02-768-light.png) · [768/D](screenshots/after/UX-02-768-dark.png) · [1440/L](screenshots/after/UX-02-1440-light.png) · [1440/D](screenshots/after/UX-02-1440-dark.png).

### UX-03 — Semántica de telemetría y KPIs

- **Antes → después:** el prototipo previo dibujaba series sintéticas sin unidad/fuente/tiempo y mezclaba una muestra de cinco filas con agregados distintos (`H08`, `H11`). El nuevo resumen evita gráficas sin contrato; cada KPI dice qué cuenta, explicación, fuente, corte y cobertura sintética.
- **Flujo/roles:** admin empresa ve señales prioritarias y luego los cuatro indicadores del fixture; el botón lleva a dispositivos o diagnóstico según permiso simulado. No se exporta estado global desde la vista.
- **Contrato y seguridad:** al integrar, cada indicador necesita unidad/denominador, `source`, `generated_at`/`observed_at`, freshness/cobertura, tenant y destino. Las rutas actuales ofrecen metadatos distintos para summary, heartbeats, inventario y perfiles; no asumir que todos los campos ya existen en un solo endpoint.
- **Estados/aceptación:** PASS visual y de estados común. El corte `18:35 CST` es literal de fixture, no hora de producción. Prohibido derivar health score o disponibilidad real del valor simulado.
- **Capturas:** [320/L](screenshots/after/UX-03-320-light.png) · [320/D](screenshots/after/UX-03-320-dark.png) · [768/L](screenshots/after/UX-03-768-light.png) · [768/D](screenshots/after/UX-03-768-dark.png) · [1440/L](screenshots/after/UX-03-1440-light.png) · [1440/D](screenshots/after/UX-03-1440-dark.png). [Estados compartidos](screenshots/after/states/).

### UX-04 — Contraste y tipografía

- **Antes → después:** había texto pequeño y combinaciones de contraste débiles (`H05`), y el dark theme no tenía una revisión integral (`H14`). El prototipo usa tamaños base de 13–15 px para labels/meta/tablas, una escala tipográfica de sistema y tokens por superficie/estado/tema.
- **Flujo/roles:** todos los perfiles, controles, tablas, badges y diálogos comparten tokens light/dark; foco usa indicador no dependiente solo del color.
- **Contrato visual:** referencia aislada a `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md` §10.1 y `design/nexo-ui/nexo-tokens.css`. Manrope/Inter no se descargan; el placeholder no se representa como logo maestro.
- **Estados/aceptación:** mediciones representativas arriba (mínimo medido 4.86:1); verificación visual en 3 anchos y 2 temas. No equivale a WCAG AA ni cubre cada combinación, foco, disabled, hover, alto contraste o lector de pantalla. La auditoría completa de componentes productivos queda pendiente.
- **Capturas:** [320/L](screenshots/after/UX-04-320-light.png) · [320/D](screenshots/after/UX-04-320-dark.png) · [768/L](screenshots/after/UX-04-768-light.png) · [768/D](screenshots/after/UX-04-768-dark.png) · [1440/L](screenshots/after/UX-04-1440-light.png) · [1440/D](screenshots/after/UX-04-1440-dark.png).

### UX-05 — Drawer/modal y ficha

- **Antes → después:** el concepto abría modal/drawer por clase CSS y no gestionaba foco inicial, trampa/restauración ni fondo (`H06`). Ficha de equipo y wizard usan `<dialog>.showModal()` con foco interno; menú móvil sigue el mismo elemento nativo.
- **Flujo/roles:** técnico delegado abre ficha desde inventario, consulta estados independientes y sale con Escape o botón cerrar; las acciones de diagnóstico solo se presentan con permiso simulado.
- **Contrato y seguridad:** ficha compone campos de inventario/identidad, heartbeat y perfil con fuente/tiempo separado. API real: `GET /v1/company/agents` y grants para `company.agent.read`; diagnóstico requiere `company.network.diagnose` y resource grant de `device_identity`.
- **Estados/aceptación:** PASS foco de apertura y restauración tras Escape en desktop/tablet/móvil, Tab atrapado en diálogo nativo y `aria-live` del contexto. Falta prueba manual de lector de pantalla, scroll de página en móvil y detalles de lector táctil.
- **Capturas:** [320/L](screenshots/after/UX-05-320-light.png) · [320/D](screenshots/after/UX-05-320-dark.png) · [768/L](screenshots/after/UX-05-768-light.png) · [768/D](screenshots/after/UX-05-768-dark.png) · [1440/L](screenshots/after/UX-05-1440-light.png) · [1440/D](screenshots/after/UX-05-1440-dark.png).

### UX-06 — Dashboard orientado a incidentes

- **Antes → después:** la jerarquía anterior ponía tarjetas/gráficas por delante de señales accionables. Ahora el resumen antepone pendientes y “siguiente paso”, después métricas y capacidades. No se usa health score.
- **Flujo/roles:** admin/técnico con permiso navega a diagnóstico; solo lectura lleva al inventario. El detalle distingue agente, túnel, ruta, DNS, política y aplicación.
- **Contrato y seguridad:** la UI mezcla únicamente fixtures identificados; no existe en esta vista una colección real de incidentes consolidada. Para integrar, acordar fuente, freshness, prioridad, tenant, recurso, permiso y acción; no inferir de `/summary` una prueba de aplicación.
- **Estados/aceptación:** PASS en render, prioridades y estados comunes. La advertencia de retorno y el CTA son instrucciones de muestra, no incidentes ni conectividad reales.
- **Capturas:** [320/L](screenshots/after/UX-06-320-light.png) · [320/D](screenshots/after/UX-06-320-dark.png) · [768/L](screenshots/after/UX-06-768-light.png) · [768/D](screenshots/after/UX-06-768-dark.png) · [1440/L](screenshots/after/UX-06-1440-light.png) · [1440/D](screenshots/after/UX-06-1440-dark.png).

### UX-07 — Inventario, filtros y export

- **Antes → después:** la exportación del original filtraba por tipo pero ignoraba la búsqueda (`H04`). Ahora una función selector alimenta tabla, cards, contador, query local `q`/`kind` y CSV; hay estrategia de tarjetas en móvil.
- **Flujo/roles:** Empresa demo A auditor solo lee; fixture auditor+grant puede descargar el CSV local; admin no recibe export por ser admin. Restablecer limpia ambos filtros.
- **Contrato y seguridad:** lectura actual: `GET /v1/company/agents` o rutas de inventario según superficie, con paginación, búsqueda/tipo/status y resource grant de identidad. Export actual de empresa es `GET /v1/company/report/export.csv?dataset=summary|audit`; valida `company.report.export` y permiso adicional del dataset. **No hay dataset de dispositivos en esa ruta**: la exportación de dispositivos que se ve aquí es local al prototipo y requiere contrato/API autorizado antes de producción. No conectarla como si ya existiera.
- **Estados/aceptación:** PASS filtros/contador/URL en una fila, reset, aislamiento de tenant, grant separado y contenido CSV igual al filtro (incluye protección contra fórmulas CSV). No se implementa rango temporal para inventario en esta demo.
- **Capturas:** [320/L](screenshots/after/UX-07-320-light.png) · [320/D](screenshots/after/UX-07-320-dark.png) · [768/L](screenshots/after/UX-07-768-light.png) · [768/D](screenshots/after/UX-07-768-dark.png) · [1440/L](screenshots/after/UX-07-1440-light.png) · [1440/D](screenshots/after/UX-07-1440-dark.png).

### UX-08 — Ficha unificada de dispositivo

- **Antes → después:** “VPN conectada” podía dominar el chip aunque el recurso no estuviera probado (`H12`). La ficha agrega agente/fuente, último heartbeat, túnel, ruta/retorno, tenant y estado de aplicación “No comprobada”, sin colapsarlos a una sola salud.
- **Flujo/roles:** técnico abre la ficha del endpoint o gateway; el acceso a diagnóstico se condiciona en la demo al permiso. Un auditor conserva solo lectura.
- **Contrato y seguridad:** inventario/heartbeat y `GET /v1/company/agents`; diag `POST /v1/company/network-diagnostics` con `source_device_id`, `resource_id`, `protocol`, `port`. La respuesta disponible tiene `decision`, `reason`, `connectivity: 'not_tested'`, revisión y modos path/return/DNS; nunca llamarla prueba de aplicación. API requiere scope y resource grant vigente.
- **Estados/aceptación:** PASS apertura/cierre y foco, y diferenciación textual de estados. Los datos visibles son fixtures congelados; “señal reciente” no es un umbral productivo.
- **Capturas:** [320/L](screenshots/after/UX-08-320-light.png) · [320/D](screenshots/after/UX-08-320-dark.png) · [768/L](screenshots/after/UX-08-768-light.png) · [768/D](screenshots/after/UX-08-768-dark.png) · [1440/L](screenshots/after/UX-08-1440-light.png) · [1440/D](screenshots/after/UX-08-1440-dark.png).

### UX-09 — Wizards de equipo directo y sucursal

- **Antes → después:** las secciones originales eran tarjetas ilustrativas (`H10`). Se propone preview local con alcance, validación, paso de revisión, volver/cancelar, conservación de borrador y error recuperable; nunca hay botón que ejecute API.
- **Flujo/roles:** técnico delegado con `company.agent.invite` revisa invitación endpoint (`site_id`, `uses`); el nombre/clave llegan en enrollment. Técnico con `company.network.manage` revisa un perfil de gateway ligado a una sede, entorno y gateway aprobados, con retorno `routed|snat` y DNS `local|split`. Política tiene origen/recurso/protocolo/puertos/efecto/estado.
- **Contrato y seguridad:** invitación real `POST /v1/company/device-invitations` recibe `device_kind`, `uses` y opcional `site_id`; devuelve token de audiencia endpoint con `expires_in: 900`, que se muestra una sola vez en un flujo real. Enrollment recoge nombre y clave pública; aprobación posterior requiere `company.agent.approve`. Perfil real `POST /v1/company/network-profiles` incluye `site_id`, `vpn_environment_id`, `path_mode`, `gateway_device_id`, `return_mode`, `dns_mode`, DNS servers/suffixes y validación tenant/gateway/sede. Política real `POST /v1/company/network-policies` usa `source_kind`, `source_device_id`, `resource_id`, `protocol`, puertos, efecto y estado. Este prototipo no cubre alta completa de sede/CIDR/recursos ni envía mutación.
- **Estados/aceptación:** PASS validación de `uses` (>0), Tab/Enter a revisión, cancelación sin aplicar, error accesible y borrador conservado. La comprobación de sede/gateway solo usa IDs sintéticos. El backlog de producción de idempotencia/resultado observado **no está satisfecho**: el endpoint de invitación inspeccionado no recibe `idempotency_key`; definir contrato antes de prometer reintento sin duplicados u operation ID.
- **Capturas:** [320/L](screenshots/after/UX-09-320-light.png) · [320/D](screenshots/after/UX-09-320-dark.png) · [768/L](screenshots/after/UX-09-768-light.png) · [768/D](screenshots/after/UX-09-768-dark.png) · [1440/L](screenshots/after/UX-09-1440-light.png) · [1440/D](screenshots/after/UX-09-1440-dark.png).

### UX-10 — Actividad y auditoría

- **Antes → después:** la página previa era un espacio ilustrativo sin campos/flujo verificable (`H10`). La tabla del concepto ahora se limita a fecha, actor disponible, acción y recurso/ID; incluye filtro de acción/búsqueda y nota de límites.
- **Flujo/roles:** auditor empresa ve su tenant; admin/técnico no recibe auditoría si no tiene permiso; operador proveedor ve solo asignación; global provider audit es owner-only. El fixture auditorExport no hereda globalidad.
- **Contrato y seguridad:** empresa: `GET /v1/company/audit` y campos `id`, `actor_user_id?`, `action`, `resource_type`, `resource_id?`, `created_at`, metadata de fuente/frescura/cobertura. Proveedor: `GET /v1/provider/companies/:tenantId/audit` y owner-only `GET /v1/provider/audit`, que además modelan `actor_kind`/`actor_id`. Export de auditoría requiere `company.report.export` **y** `company.audit.read`; mismos filtros y límites server-side. No se inventan `diff`, resultado, `correlation_id` u `operation_id` si no los proporciona el contrato.
- **Estados/aceptación:** PASS filtros de fixture y permiso de export separado. La auditoría enriquecida objetivo (resultado/diff/correlación/origen detallado) queda bloqueada por contrato/datos, no se resuelve en UI.
- **Capturas:** [320/L](screenshots/after/UX-10-320-light.png) · [320/D](screenshots/after/UX-10-320-dark.png) · [768/L](screenshots/after/UX-10-768-light.png) · [768/D](screenshots/after/UX-10-768-dark.png) · [1440/L](screenshots/after/UX-10-1440-light.png) · [1440/D](screenshots/after/UX-10-1440-dark.png).

### UX-11 — Centro VPN y certificados

- **Antes → después:** faltaba una ficha operativa que diferenciara solicitado/aplicado/observado. El concepto presenta esos tres estados/revisiones y aclara que un recurso aún puede no estar verificado; no muestra claves, PEM ni tokens.
- **Flujo/roles:** propietario proveedor revisa entornos; cambios de estado, creación y operación WireGuard son acciones owner-only. Operador/auditor no recibe controles de mutación.
- **Contrato y seguridad:** lectura `GET /v1/provider/vpn-environments`; creación `POST` y `PUT .../:id/state` exigen owner; estado usa `desired_state` y `expected_revision`. Cambios WireGuard usan preview y confirmación por digest. Inventario de proveedor/agents puede exponer estado y `not_before`/`not_after` de certificado; material secreto no es contenido de UI. La tabla de este prototipo solo ilustra la separación y no consume esos endpoints.
- **Estados/aceptación:** PASS visual de desired/applied/observed sintéticos. No se implementan rotación/revocación, vencimiento calculado ni detalle completo de certificados: requiere wireflow/contrato con estados reales antes de integración.
- **Capturas:** [320/L](screenshots/after/UX-11-320-light.png) · [320/D](screenshots/after/UX-11-320-dark.png) · [768/L](screenshots/after/UX-11-768-light.png) · [768/D](screenshots/after/UX-11-768-dark.png) · [1440/L](screenshots/after/UX-11-1440-light.png) · [1440/D](screenshots/after/UX-11-1440-dark.png).

### UX-12 — Endpoint Windows: estados coherentes

- **Antes → después:** la demo anterior cambiaba copy/acción pero podía conservar IP, duración y símbolo de conectado (`H09`). La máquina local deriva juntos estado, acción, IP/duración y error para conectado, desconectado, conectando y error recuperable.
- **Flujo/roles:** usuario endpoint puede “simular conexión/desconexión” o reintentar el error sintético; VPN, aplicación, soporte y respaldo permanecen separados.
- **Contrato y seguridad:** no existe vínculo entre este estado local y una VPN real. `GET /v1/device/me`, heartbeat, renovación de certificado y challenge de autenticación no demuestran que el túnel o ERP estén accesibles. Soporte requiere consentimiento/permisos y `/open` en servidor normal devuelve `503 support_transport_disabled`; respaldos se muestran sin controles operativos.
- **Estados/aceptación:** PASS consistencia visual y transiciones sintéticas en 3 anchos/2 temas; `demoEndpointError=1` permite revisar error. No se prueban Tauri, servicio Windows, ciclo de vida real ni conexión a recurso.
- **Capturas:** [320/L](screenshots/after/UX-12-320-light.png) · [320/D](screenshots/after/UX-12-320-dark.png) · [768/L](screenshots/after/UX-12-768-light.png) · [768/D](screenshots/after/UX-12-768-dark.png) · [1440/L](screenshots/after/UX-12-1440-light.png) · [1440/D](screenshots/after/UX-12-1440-dark.png).

### UX-13 — Preferencias y dark mode

- **Antes → después:** el dark mode previo recoloreaba fondos pero no verificaba una matriz amplia (`H14`). El prototipo aplica tokens de superficie, texto, bordes, estados, menú y acción secundaria; respeta `prefers-reduced-motion`.
- **Flujo/roles:** cualquiera de los perfiles alterna tema; queda guardado solo en `localStorage` bajo una clave propia del prototipo. Borrar esa clave restablece light. No es preferencia de cuenta.
- **Contrato y seguridad:** no llamar endpoint ni persistir en servidor; el tema local no debe incluir contexto de usuario/tenant. Fuente del sistema y placeholder de marca.
- **Estados/aceptación:** PASS renders en light/dark, foco y combinaciones de contraste listadas. Pruebas de preferencia del sistema OS, lector de pantalla, high contrast y todas las combinaciones/estados están pendientes.
- **Capturas:** [320/L](screenshots/after/UX-13-320-light.png) · [320/D](screenshots/after/UX-13-320-dark.png) · [768/L](screenshots/after/UX-13-768-light.png) · [768/D](screenshots/after/UX-13-768-dark.png) · [1440/L](screenshots/after/UX-13-1440-light.png) · [1440/D](screenshots/after/UX-13-1440-dark.png).

### UX-14 — Telemetría UX de tareas críticas

- **Antes → después:** no había medición de resultado por tarea/etapa. La vista presenta fixtures de eventos permitidos y funciones locales que agregan eventos a memoria de la pestaña.
- **Flujo/roles:** empresa admin revisa tarea, resultado, duración, etapa y razón; la acción “Añadir evento sintético” solo muta el array en memoria.
- **Contrato y privacidad:** allowlist local: `task_id`, `surface`, `outcome`, `duration_ms`, `step`, `reason_code`. No incluir user ID/email, tenant ID, equipo, IP, formulario, token, contenido de auditoría ni secretos. No hay `fetch`/persistencia remota; los tres eventos iniciales son datos fijos, no resultados de investigación ni métricas de producción. Antes de telemetría real, aprobar propósito/base legal, consentimiento si aplica, minimización, muestreo, retención, acceso y eliminación.
- **Estados/aceptación:** PASS render y ausencia de llamadas externas. Las duraciones iniciales son ilustrativas; no derivar tasa de éxito ni benchmark a partir de n=3 fixtures.
- **Capturas:** [320/L](screenshots/after/UX-14-320-light.png) · [320/D](screenshots/after/UX-14-320-dark.png) · [768/L](screenshots/after/UX-14-768-light.png) · [768/D](screenshots/after/UX-14-768-dark.png) · [1440/L](screenshots/after/UX-14-1440-light.png) · [1440/D](screenshots/after/UX-14-1440-dark.png).

## 4. Aceptación y siguientes gates

### Cerrado para revisión del prototipo

- Se creó una alternativa visual/interactiva aislada para UX-01…UX-14, con fixtures explícitos, tres superficies y perfiles separados.
- Las capturas, los seis estados transversales de demo, los contratos observados y los checks automatizados están vinculados en este handoff.
- Sin cambios API, RBAC, UI productiva, despliegue, commit o push dentro de este entregable.

### No equivale a aceptación de producto

1. Obtener revisión/aprobación UX/brand y prueba con usuarios representativos antes de integrar.
2. Acordar contratos que faltan: exportación de inventario; auditoría enriquecida/correlación si se requiere; idempotencia y estado observado de invitaciones; datos completos de KPI/incidentes; detalle de vencimiento/rotación de certificados.
3. Reusar permisos reales: servidor aplica tenant/scope, acción, entitlement y resource grant en cada lectura/escritura; no usar el selector de demos como modelo de autorización.
4. Integrar de forma gradual y reversible en el stack real, con pruebas de API/RBAC/aislamiento, responsive (incluido 1920 px y zoom), lector de pantalla, visual regression y plataforma Windows cuando aplique.
5. Ejecutar pruebas formativas con los perfiles recomendados en la auditoría fuente; reportar tamaño de muestra y resultados, no presentar las metas iniciales como métricas logradas.

## 5. Archivos

- Prototipo: [`prototype/index.html`](prototype/index.html), [`prototype/styles.css`](prototype/styles.css), [`prototype/app.js`](prototype/app.js).
- Verificación reproducible: [`prototype/verify.mjs`](prototype/verify.mjs).
- Resultado por assertion: [`screenshots/after/verification.json`](screenshots/after/verification.json).
- Referencia previa disponible: [`screenshots/before/original-1440-light.png`](screenshots/before/original-1440-light.png).
- Fuente de backlog: [`NEXO_Auditoria_UX_UI_Full_v2_a_v2.1.md`](../../../NEXO_Auditoria_UX_UI_Full_v2_a_v2.1.md); reglas visuales y de permisos: [`Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`](../../../Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md).
