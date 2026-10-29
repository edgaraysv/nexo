# Decisiones de arquitectura F01

> Historial F01. El alcance posterior F02 (preparación y plan real, no apply) se documenta en `../f02/README.md`. No cambia retroactivamente las autorizaciones de F01.

Estado: **ADR-001 ACEPTADO para API TypeScript modular y PostgreSQL; ADR-006 ACEPTADO para NestJS con adaptador Fastify**. El usuario asumió producto, mantenimiento técnico y operación y después autorizó integrar el framework y repetir el laboratorio. Esta autorización es local y no incluye F02, AWS ni otros gates. El laboratorio no elige un stack por mayoría ni por velocidad de implementación.

## ADR-001 — API y persistencia

Decisión aprobada por el usuario en esta sesión: **API TypeScript modular y PostgreSQL**, como monolito modular con workers antes de microservicios. CodeIgniter 4/PHP y Go quedan como alternativas evaluadas, no como APIs a desarrollar en paralelo; MySQL fue alternativa no ensayada. Compartir contratos generados no sustituye validación del servidor.

La comparación implementa el mismo HTTP → driver → transacción PostgreSQL → outbox → ACK simulado. SQL común evita comparar reglas distintas, pero no demuestra cuál lenguaje mantiene mejor un dominio complejo. No hay ORM evaluado, RLS implementada ni pool multiempresa productivo. El rol de aplicación del experimento es no-superusuario sin lectura directa de tablas; la función autorizada aplica el contexto de la fixture del servidor.

Criterios de descarte: incumplir aislamiento del corte, cupo atómico, idempotencia, rollback total o error seguro; no poder reconstruir usando locks; carecer de responsable de mantenimiento. Desempate: experiencia del equipo y costo de operación comprobados, no latencias de esta suite. Si todos pasan, no existe evidencia para declarar superioridad de rendimiento.

**Aprobación registrada:** mensaje del usuario «se aprueba el stack», referido a la recomendación TypeScript/PostgreSQL del cierre F01. Posteriormente confirmó NestJS + Fastify y se asignó como responsable humano de producto, mantenimiento técnico y operación. El adaptador `node:http` del experimento no prueba NestJS; tampoco quedan aprobadas automáticamente las versiones del experimento para producción.

## ADR-002 — Contratos y consistencia

Operaciones tipadas, outbox en la misma transacción, entrega al menos una vez, idempotencia, revisión y reconciliación. No shell ni escrituras directas del navegador al motor. ACK aplicado no es conectividad observada. El laboratorio simula consumo outbox/ACK; no prueba redelivery, reloj de expiración ni transporte de agentes reales.

Enrollment productivo: invitación limitada + prueba de posesión de claves + aprobación si aplica. **El POST del laboratorio no implementa ese recorrido**, solo una reserva sintética para comparar la transacción. No adoptarlo como contrato productivo sin versionar y diseñar F03–F07.

## ADR-003 — Cliente, paneles y motores

- React/TypeScript para paneles: propuesta; SSR alternativa; validar UX y componentes antes de fijar librería visual.
- Go agente y servicio nativo, Tauri UI: propuestas; Electron/Rust/UI nativa alternativas. No se compilan clientes en F01.
- Kotlin/Swift móviles: candidatos solo VPN/diagnóstico; no remoto de pantalla.
- OpenVPN primero; WireGuard básico en P1 (F11); DCO corresponde OpenVPN. Malla y relay VPN en F15.
- MeshCentral/MeshAgent condicionado a permisos efectivos y revocación probados en motor.
- Restic/Kopia condicionado a restore y custodia probados en F16. Backup comercial opcional, backup control obligatorio.

Licencias de drivers, bibliotecas, empaquetado y redistribución deben revisarse por versión antes de distribución. No inferir compatibilidad de una licencia por nombre del protocolo. Las dependencias F01 se registran en locks y la evidencia de imágenes; no representan un SBOM de producto terminado.

## ADR-004 — Infraestructura y aislamiento

Infraestructura AWS nueva, EC2 compartida base piloto con aislamiento lógico por empresa. Kernel común no es EC2 dedicada ni HA. Separación física es alternativa a aprobar por riesgo/costo. Laboratorio y producción separados, preferentemente cuentas distintas. IaC HCL como propuesta frente CDK/CloudFormation; no se crean recursos AWS en F01.

Rol IAM de instancia no queda aislado automáticamente por usuario/namespace. Bloquear IMDS y probar privilegios; si se necesita IAM por runtime, definir mecanismo explícito o separar host. Privadas IPv4/IPv6 autorizadas, no ruta por defecto ni agregados equivalentes. Internet/DNS públicos permanecen locales.

## ADR-005 — Reversibilidad y recuperación

Revertir recursos concretos y usar migraciones expand-contract. Un restore global no revierte un cambio de tenant. Después de recuperar el control, comparar revisiones y preservar revocaciones; un nodo informa lo aplicado pero no autoriza reapertura por sí solo. Divergencias sensibles deben quedar bloqueadas.

Object Lock, borrado y destrucción de claves tienen efectos irreversibles. Región, stack y política offline son decisiones costosas de cambiar, no todas irreversibles. Laboratorio sin datos reales, sin WORM ni raíces productivas. Cualquier uso real necesita aprobación previa del gate correspondiente.

## ADR-006 — Framework de API y responsables

**ACEPTADO por el usuario:** NestJS con `FastifyAdapter`, manteniendo PostgreSQL y monolito modular. Alternativas consideradas: Fastify directamente (menos capas, más convenciones propias) y NestJS/Express (mayor compatibilidad con middleware Express, sin necesidad concreta identificada aquí).

Motivo: módulos y dependencias explícitas, estructura consistente de controladores/servicios y puntos comunes de validación, autorización y pruebas. El costo es configuración y código de estructura adicional. Los módulos y guards no sustituyen la autorización por empresa/recurso ni la integridad de la BD. No se presupone una mejora de rendimiento.

Antes de integrar: fijar versiones compatibles, comprobar el compilador TypeScript del repositorio y sus requisitos, usar plugins adecuados para Fastify y repetir el corte transaccional y sus pruebas de entrada, aislamiento, concurrencia y errores. NestJS usa Express por defecto: seleccionar explícitamente el adaptador Fastify y no incorporar middleware específico de Express por accidente.

**Implementación del ensayo:** NestJS/core/common/platform-fastify `12.2.0`, Fastify `5.12.7`, reflect-metadata `0.2.2` y RxJS `7.8.2`, fijados con lock npm. Se sustituyó el transporte `node:http` por módulo, controlador y proveedor de BD Nest, manteniendo las funciones SQL comunes. `experimentalDecorators` y `emitDecoratorMetadata` se habilitan y comprueban con el compilador existente; no se introduce ORM ni se convierten fixtures en código productivo.

La fábrica utiliza explícitamente Fastify, parser JSON seguro con rechazo de claves de prototipo, límite de 8192 bytes, respuestas saneadas y sin caché. El parser convierte errores de JSON a HTTP 422 antes de que Nest pierda el código de error de Fastify. Las peticiones `application/json` conservan sus entradas y respuestas; se documenta además el rechazo 415 a contenido no soportado. El proveedor cierra el pool mediante lifecycle de Nest; el ejecutable habilita SIGTERM/SIGINT. Las pruebas específicas usan un proveedor simulado, mientras que el laboratorio completo usa PostgreSQL real. El estado ejecutado se registra en `evidence.md`, separado de la aprobación arquitectónica.

**Validación técnica local: PASS.** `npm run verify` completó 24 pruebas automatizadas y los 12 grupos de PostgreSQL del candidato NestJS/Fastify, además de repetir CI4 y Go con 12 grupos cada uno. Reporte `artifacts/f01/nexo-f01-17ac7478-764/report.json`; versiones verificadas dentro de la imagen. No se otorga PASS a pruebas PV/UX productivas ni se aprueba G01 automáticamente.

**Responsabilidades confirmadas:** el usuario actual (seleccionó «YO») conserva producto/autorizaciones, mantenimiento técnico y operación. El agente de esta sesión apoya arquitectura, implementación, pruebas y documentación únicamente por fase autorizada; no asume guardias, mantenimiento continuo ni acceso autónomo a credenciales. La revisión independiente de seguridad sigue por asignar antes de F12/F13. No se delega automáticamente en otros agentes.

La confirmación inicial excluyó instalación, F02 y AWS. La solicitud posterior «Ejecuta la integración de NestJS/Fastify y repite las pruebas del laboratorio» autorizó dependencias y pruebas locales. Tras su validación, el usuario confirmó «G01 aceptado»: **G01 aceptado y F01 cerrada**. F02/AWS siguen excluidos hasta una autorización específica; no se deduce de este cierre aprobación de infraestructura o riesgos productivos.

## Baseline de fuente UX/UI — 2026-10-29

Se revisó `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md` y se acepta como fuente vigente de trazabilidad el SHA-256 `82a9eaa234c3be3333dabd6ca2dd988cc25497c399316e8c78cb812a8d6c2db3`, que sustituye explícitamente al hash anterior en `sources.json`. La especificación identifica la guía SYSMedia recibida el 28 de octubre y documenta la base visual en 10.1. Esta decisión fija los bytes revisados para que el gate sea reproducible; **no aprueba la guía para producción ni declara UX/accesibilidad verificada**: el documento conserva estado de propuesta y UX01–UX16 siguen `NOT RUN`.

## Fuentes oficiales consultadas

- https://codeigniter.com/user_guide/intro/requirements.html — requisitos PHP/extensiones y soporte PostgreSQL.
- https://repo.packagist.org/p2/codeigniter4/appstarter.json — release appstarter, dependencia y lock generado.
- https://nodejs.org/download/release/v22.17.0/docs/api/typescript.html — stripping no comprueba tipos; se usa compilación `tsc` separada.
- https://proxy.golang.org/github.com/jackc/pgx/v5/@latest — versión de driver contrastada al preparar el experimento.
- https://docs.docker.com/desktop/features/wsl/ — integración WSL2.
- https://docs.nestjs.com/modules — módulos y fronteras de proveedores.
- https://docs.nestjs.com/techniques/performance — adaptador Fastify y diferencias de compatibilidad con Express; contrastado con el contenido oficial `content/http/performance.md` del repositorio de documentación.
- https://fastify.dev/docs/latest/Reference/Encapsulation/ — encapsulación de plugins/hooks, no aislamiento de seguridad entre tenants.

La comprobación de requisitos no es una auditoría de seguridad ni una certificación de licencias.
