# Responsabilidades, backlog y decisiones pendientes

El usuario confirmó «YO» como responsable humano de producto/autorizaciones y mantenimiento técnico/operación. Esto asigna responsabilidad, no acredita experiencia, disponibilidad permanente ni capacidad para un calendario concreto. El agente solo ejecuta trabajo asistido por fase autorizada; no opera de forma autónoma ni sustituye una revisión independiente.

| Función | Responsabilidad | Asignación |
| --- | --- | --- |
| Producto/propietario | Alcance, planes, permisos comerciales y aceptación | Usuario actual, confirmado |
| Responsable técnico | Stack, contratos, compatibilidad y mantenimiento | Usuario actual; agente como apoyo por trabajo autorizado |
| Plataforma/redes | AWS, IaC, aislamiento, secretos, recuperación e incidentes | Usuario actual responsable de operación; agente prepara/probará IaC solo con autorización |
| Backend | Tenancy, integridad, operaciones y auditoría | Bajo responsabilidad técnica del usuario; implementación asistida por el agente |
| Cliente nativo | Identidad, IPC, firma, instalación y permisos | Bajo responsabilidad técnica del usuario; implementación y validación por plataforma cuando se autoricen |
| Frontend/UX | Flujos, estados, accesibilidad y permisos visibles | Usuario acepta; agente apoya diseño técnico/implementación cuando se autoricen |
| QA funcional y automática | Evidencia, regresión y cumplimiento de puertas | Usuario acepta resultados; agente prepara/ejecuta pruebas autorizadas, sin presentarlas como revisión independiente |
| Seguridad independiente | Revisión adversarial de controles críticos antes de clientes reales | Por asignar antes de F12/F13; distinto del implementador |

## Backlog F01

- [x] Aceptar stack de API TypeScript modular y PostgreSQL: aprobación explícita del usuario tras el cierre técnico F01.
- [x] Definir framework: NestJS con adaptador Fastify. Ensayo local validado con NestJS `12.2.0` y Fastify `5.12.7`; evidencia en `evidence.md`, sin aprobación automática para producción.
- [x] Asignar responsables humanos de producto/autorizaciones y mantenimiento técnico/operación: usuario actual.
- [x] Aprobar la puerta G01 de forma explícita: usuario confirmó «G01 aceptado». F01 cerrada; no equivale a autorizar F02 ni AWS.
- Entregables verificables de ingeniería: entorno local, tres adaptadores, contrato experimental, migración, suite, pipeline, decisiones, amenazas, wireflows y trazabilidad. Su estado ejecutado vive en `evidence.md` y reportes, no se marca PASS de producto.

El usuario confirmó inicialmente estas asignaciones sin autorizar instalación, F02 ni AWS. Posteriormente autorizó integrar NestJS/Fastify y repetir el laboratorio, incluidas dependencias locales, y aceptó explícitamente G01 tras su validación. Después pidió iniciar F02 y preparar un plan real AWS: cuenta exclusiva para futura producción, región a recomendar y sin límite presupuestario fijado. La indicación más reciente es **continuar F02 en entorno local, sin acceso a AWS**; se permite el ensayo Docker sintético de copia/restore. El plan autenticado sigue pendiente de identificar cuenta/perfil y retomar explícitamente ese alcance. **Apply/despliegue no autorizado.** Detalle vigente en `../f02/README.md`. No se asumen contratación adicional, guardias ni despacho de subagentes.

## Puertas posteriores

| Gate | Entrada pendiente | Impide |
| --- | --- | --- |
| F02 | Alcance activo local sin AWS; plan real pendiente de retomar con ID/perfil, región/costos y aprobación separada de apply; sin límite presupuestario fijado | Crear infraestructura externa y cerrar F02 |
| F03–F05 | Identidad/sesiones, delegación, cuotas y política offline versionada | Cerrar contratos productivos correspondientes |
| F07/F12 | Raíz de identidad/firma, custodia, rotación y canales | Distribución confiable y actualizaciones reales |
| F10 | Autorización de proveedor y política desatendida; resultado de spike motor | Habilitar soporte |
| F12/F13 | Revisión de seguridad independiente y riesgo kernel/host compartido | Clientes/datos reales |
| F13 | Región/jurisdicción, privacidad, retención/eliminación, responsables y autorización piloto | Incorporar clientes reales |
| Migración | Inventario y autorización específicos, ensayo PV21 | Tocar OpenVPN anterior |
| F14 | Sistemas/arquitecturas/versiones y distribución probados | Publicar soporte multiplataforma |
| F15 | Demanda/carga/riesgo medidos; privacidad para grabación/SSO/postura si aplica | Ampliar topología o funciones P2 |
| F16 | Activación comercial, custodia/recuperación claves, retención, WORM y restore | Almacenar backups de clientes |

Las tareas futuras se estiman tras asignar responsables y medir carga. Un `NO APLICA` requiere condición, motivo, aprobador y gate futuro; no sirve para omitir un fallo crítico.

## Cierre por fase

Registrar fase, versión, entorno, entregables, pruebas, resultados PASS/FAIL/NOT RUN/NO APLICA, evidencia, regresión, retorno, riesgos y aprobador. Decisión explícita AVANZAR/BLOQUEAR. PV14 solo es requisito cuando se habilite backup comercial; PV12 siempre antes de clientes reales.
