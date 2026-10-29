# Evidencia F01

La evidencia de ejecución se genera en `artifacts/f01/<proyecto-unico>/report.json`. `latest.json` apunta al último resultado completo. Se excluye por defecto de Git para no confundir una ejecución local con una garantía permanente.

## Comandos reproducibles

```bash
npm ci --ignore-scripts
npm run verify
```

El orquestador detiene el avance al primer comando fallido. La suite comparativa construye los tres adaptadores, inicializa una DB vacía por candidato, ejecuta comprobaciones HTTP/SQL y retira sus propios contenedores/red/volumen en `finally`. Imágenes y cachés de compilación permanecen como caché local; no se ejecuta prune ni se toca otro proyecto.

El reporte incluye inventario de dependencias y licencias declaradas de npm/Composer, manifiesto Go e imágenes. No es una revisión legal ni un SBOM completo del producto. Ante un corte del sistema o SIGKILL no puede garantizarse `finally`: usar el nombre único impreso y retirar **solo ese proyecto**, nunca un prune global.

## Qué se comprueba

- Fixtures inexistentes/vencidas y roles sin permiso.
- JSON, tipos, longitud, campos desconocidos e intento de establecer tenant desde cliente.
- Idempotencia, conflicto de payload y cuotas.
- Aislamiento por recurso y mismo identificador en empresas distintas.
- ACK tipado/revisión, nodo ajeno y confirmación repetida; observado sigue null.
- Veinte solicitudes por el último cupo y doce replays concurrentes.
- Fallo inyectado después de escrituras: endpoint, operación, outbox y cupo se revierten juntos.
- Rol de runtime sin lectura directa de tablas sensibles.
- Documentación/contrato: casos negativos que omiten, duplican o inventan referencias y desplazan P1 a P2.
- Gate de tipos: compilación de una fixture intencionalmente incorrecta; debe fallar con TS2322, no por herramienta ausente.
- Baseline SHA-256 de los seis documentos originales: cualquier cambio obliga a revisar y actualizar explícitamente decisiones y trazabilidad.

## Interpretación

PASS solo acredita esas comprobaciones **del corte sintético**. No acredita login/MFA, invitaciones reales, entrega de worker, RLS, VPN, aislamiento de kernel, UI, PKI, actualización, restauración de control ni PV/UX productivos. No comparar `elapsedMs` como benchmark: incluye aserciones Docker y ejecución secuencial.

El pipeline remoto en `.github/workflows/f01.yml` es configuración entregada, estado **NOT RUN** mientras no se publique y ejecute con autorización. Sus acciones están fijadas por SHA comprobado contra sus tags oficiales. Los locks npm/Composer/Go fijan dependencias de código y las seis imágenes base están fijadas por digest contrastado con el registro. Los repositorios apt siguen siendo variables y el resultado no se presenta como un build bit a bit reproducible ni como cadena de suministro productiva auditada.

Los cierres y decisiones que siguen son históricos. Consultar la última sección para distinguir la validación vigente del framework de los resultados iniciales con `node:http`. La autorización de F02 sigue separada y pendiente.

## Incidencias observadas durante la verificación

Los reportes fallidos se conservan, no se sustituyen por afirmaciones de éxito:

- La primera migración detectó conflicto con el identificador SQL `authorization`; el argumento pasó a `auth_header`.
- El adaptador CI4 necesitó normalizar el cuerpo vacío y la ruta, configurar charset PostgreSQL y usar variables de entorno con guiones bajos. Se comprobó por separado que la misma función SQL respondía desde el driver nativo y desde el bootstrap CLI del framework.
- La prueba de reinicio detectó que Docker puede reasignar el puerto efímero; el harness consulta el puerto de nuevo antes de comprobar persistencia.

Estas correcciones solo se dan por validadas cuando pasa la suite completa posterior. No se descarta un lenguaje por un error de configuración del experimento.

## Cierre técnico de ejecución

Ejecución completa: **PASS** de `npm run verify`, proyecto `nexo-f01-39561924-1b6`, desde `2026-10-21T04:07:27.965Z` hasta `2026-10-21T04:08:48.359Z` (UTC). Fuente: `artifacts/f01/nexo-f01-39561924-1b6/report.json`.

| Verificación local | Resultado |
| --- | --- |
| Sintaxis JavaScript y baseline de seis fuentes originales | PASS |
| Cobertura de plan: 11 RF, 21 PV, 16 UX, 114 IDs de catálogo | PASS de cobertura, no aceptación de producto |
| Contrato experimental: cuatro operaciones y referencias | PASS estructural |
| TypeScript: comprobación de tipos y compilación | PASS |
| Tests de fundación, contrato y defecto de tipos intencional | 12/12 PASS |
| Adaptador TypeScript + PostgreSQL | 12 grupos de integración PASS |
| Adaptador PHP/CodeIgniter 4 + PostgreSQL | 12 grupos de integración PASS |
| Adaptador Go + PostgreSQL | 12 grupos de integración PASS |
| Limpieza y comprobación posterior de contenedores/red/volumen del proyecto | PASS |
| Inventario npm/Composer/Go e imágenes en reporte | PASS de recopilación, no auditoría legal |
| Workflow remoto | NOT RUN |
| Pruebas PV/UX productivas | NOT RUN |

Runtimes contrastados: Node del contenedor `v22.20.0`, PHP `8.4.26`, CodeIgniter `4.7.5`, compilador Go `go1.26.3 linux/amd64`; imagen PostgreSQL `17.6-bookworm` fijada por digest. Son versiones del experimento, no la política de soporte productiva.

**Conclusión comparativa:** los tres adaptadores satisfacen este corte. No se descarta ninguno por corrección ni se ordenan por `elapsedMs`. La propuesta API TypeScript/PostgreSQL se mantiene por validar con responsable y aceptación del usuario; no existe evidencia de superioridad general del lenguaje. SQL compartido limita el alcance de esa conclusión.

**G01: pendiente de aceptación de stack y responsabilidades. F02 no iniciada.** Los documentos originales se preservaron; no se hicieron commits, push, cambios AWS o cambios al OpenVPN anterior. Las imágenes/cachés descargadas o compiladas permanecen locales; no se ejecutó limpieza global de Docker.

## Aprobación posterior al cierre técnico

El usuario confirmó «se aprueba el stack»: **API TypeScript modular y PostgreSQL quedan aceptados** en ADR-001. Esta decisión no cambia los resultados históricos del experimento ni implica superioridad de rendimiento. Siguen pendientes responsable técnico, framework de API, aprobación de G01 y autorización específica de F02/AWS.

## Definición posterior de framework y responsabilidades

El usuario confirmó en el formulario **NestJS + Fastify** y «YO» para producto/autorizaciones y mantenimiento técnico/operación. Queda registrado en ADR-006 y `roles-and-gates.md`. El agente de esta sesión apoya el trabajo por fase autorizada; la revisión independiente de seguridad queda pendiente antes de F12/F13.

La selección no transforma el PASS de `node:http` en evidencia de NestJS/Fastify: **integración NOT RUN** hasta implementar y repetir las pruebas. No se instalaron dependencias, no se inició F02 ni se autorizó AWS. G01 conserva su aceptación explícita pendiente.

## Integración NestJS/Fastify — trabajo autorizado posteriormente

El usuario pidió implementar el framework y repetir el laboratorio. Se instalaron versiones exactas NestJS/common/core/platform-fastify `12.2.0`, Fastify `5.12.7`, reflect-metadata `0.2.2` y RxJS `7.8.2`; se conserva `pg` y la lógica SQL de fixtures. No se inicia F02.

**Primera verificación de integración: parcial / BLOCKED por entorno**, no aceptación global. `npm run verify` ejecutó check, typecheck, compilación y **24/24 pruebas PASS** (las 12 previas y 12 específicas del framework). El laboratorio PostgreSQL no pudo arrancar porque Docker Desktop no ofrecía su motor Linux ni el socket WSL, aunque la interfaz estaba abierta y Ubuntu permanecía configurado para integración. Reporte: `artifacts/f01/nexo-f01-bc7a7750-666/report.json`, estado `BLOCKED`, limpieza `NOT REQUIRED`: no se habían solicitado recursos Compose. El runner ahora conserva el reporte incluso cuando el motor está ausente y no intenta retirar recursos que no creó.

Las pruebas específicas verifican el adaptador Fastify real de Nest con proveedor de BD simulado, conservación de 202 y headers, cuerpo null/array y campos desconocidos sin coerción, normalización de cuerpo vacío, JSON malformado y claves de prototipo (422), límite de cuerpo (413), contenido no soportado (415), rutas/ACK, errores sin secretos y liberación del proveedor al cerrar. Se comprobó también que el arranque sin DATABASE_URL rechaza configuración implícita.

Una prueba inicial detectó que Nest mapea `FastifyError` a `HttpException` y pierde el código de error de parsing; se normalizó ese error a 422 en la frontera del parser, conservando el contrato previo. Las 24 pruebas pasaron después de corregirlo. La sintaxis de decoradores y su metadata compilan con TypeScript `7.0.2`; no se cambió el compilador.

El usuario autorizó reiniciar únicamente Docker Desktop para recuperar el motor; no autorizó reiniciar WSL, otros servicios ni AWS. El resultado de la repetición del laboratorio se registrará aparte, sin convertir este intento bloqueado en un PASS retroactivo.

## Cierre de integración NestJS/Fastify — estado vigente PASS local

Tras fallar el reinicio normal de Docker Desktop por procesos de interfaz atascados, el usuario autorizó expresamente su cierre forzado. Solo se cerraron los seis procesos `Docker Desktop.exe` cuya ruta se verificó y se abrió Docker Desktop con su CLI oficial. El motor volvió a responder como `29.5.2` desde Ubuntu. No se reinició WSL ni se eliminaron recursos Docker ajenos.

**`npm run verify`: PASS**, con check documental/sintaxis, typecheck, compilación (`pretest`), **24/24 pruebas automatizadas** y laboratorio completo PostgreSQL. Ejecución del laboratorio `nexo-f01-17ac7478-764`, desde `2026-10-21T10:57:03.356Z` hasta `2026-10-21T10:58:29.545Z` (UTC). Reporte: `artifacts/f01/nexo-f01-17ac7478-764/report.json`.

| Candidato con PostgreSQL real | Grupos | Resultado |
| --- | --- | --- |
| NestJS/Fastify (TypeScript) | 12/12 | PASS |
| PHP/CodeIgniter 4 | 12/12 | PASS |
| Go | 12/12 | PASS |

Se repitieron autenticación/roles fixture, entrada estricta y límites, enrollment/outbox/idempotencia, aislamiento de recursos, cuotas y duplicados, integridad compuesta, ACK/revisión y observación honesta, carreras del último cupo, replay concurrente, rollback completo ante fallo, permisos de runtime y persistencia al reiniciar cada adaptador. El SQL común no se modificó para integrar NestJS. El reporte identifica explícitamente NestJS/Fastify para no confundir este resultado con el baseline histórico `node:http`.

La consulta posterior dentro de la imagen confirmó Node `v22.20.0`, NestJS/core `12.2.0`, platform-fastify `12.2.0` y Fastify `5.12.7`. `npm ls` confirmó una única versión deduplicada del framework/transportes y sus peers reflect-metadata/RxJS. Los decoradores/metadata compilaron con TypeScript `7.0.2` tanto en host como en imagen.

**Limpieza: PASS**, confirmada después por etiqueta del proyecto: sin contenedores, red ni volumen restantes de ese laboratorio. Imágenes y cachés se conservan. El intento anterior `BLOCKED` permanece como evidencia independiente; el runner también quedó protegido para registrar fallos de preflight, logs y limpieza sin perder el reporte original.

**Límites:** es aceptación del corte de laboratorio, no login/MFA productivo, RLS, provisión VPN, restauración de control, prueba de rendimiento ni certificación de seguridad. PV/UX de producto y CI remoto siguen NOT RUN. No se modificaron las seis fuentes originales, ni se hicieron commits, push o acciones AWS. **G01 listo para aceptación explícita del usuario; F02 no iniciada.**

## Aceptación formal G01

El usuario confirmó **«G01 aceptado»** tras la validación de NestJS/Fastify. **G01 ACEPTADO; F01 CERRADA.** Los resultados y límites anteriores se conservan: no se eleva ninguna prueba productiva a PASS ni se acepta riesgo de producción por este cierre.

**F02 no iniciada ni autorizada.** Sus entradas y autorización de AWS se resolverán por separado. No se ejecutaron nuevas pruebas de integración por este registro exclusivamente documental; la evidencia técnica sigue siendo la ejecución `nexo-f01-17ac7478-764`.

Actualización posterior: el usuario pidió iniciar F02 y preparar un plan real AWS. La preparación local está en curso; el plan autenticado requiere identificar cuenta/perfil y no se autorizó apply. Consultar `../f02/README.md`; este cambio de alcance no altera los resultados F01 anteriores.
