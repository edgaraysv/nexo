# F01 — alcance y puerta de salida

> F01 está cerrada. Actualización posterior: el usuario autorizó iniciar F02 para preparación y plan real de AWS, no despliegue. La autoridad vigente y sus bloqueos están en `../f02/README.md`; los límites siguientes describen el alcance original F01.

## Resultado autorizado

Fundación local verificable: comparación acotada de adaptadores API con PostgreSQL, contratos experimentales, convenciones, trazabilidad y decisiones explícitas. No ejecutar F02, crear AWS, publicar repositorio, hacer push, cambiar producción o emitir credenciales reales.

## Hechos y límites

- Inicialmente solo existían seis documentos y un repositorio sin commits. Se preservan esos archivos.
- Docker Desktop se integró en Ubuntu WSL2 por el usuario; `hello-world` confirmó ejecución Linux. No se instaló un daemon adicional ni se cambiaron permisos del socket.
- Node/npm en host; PHP, Go y PostgreSQL en contenedores locales. Las versiones elegidas son versiones **del experimento**, no compromisos de soporte del producto.
- El laboratorio tiene una BD vacía por candidato, las mismas funciones SQL y el mismo contrato HTTP. Prueba transporte/driver y transacciones de ese corte, no dominio independiente ni un benchmark de frameworks.
- Fixture de identidad estática y pública: no implementar una autenticación productiva a partir de ella. No hay invitación nativa, VPN, worker de provisión real, agente, UI ni servicio privilegiado.

## Entregables y criterios

| Entregable | Verificación F01 | Límite |
| --- | --- | --- |
| Estructura y convenciones | `npm ci`, `check`, `typecheck`, `build` | Sin aplicación productiva |
| Trazabilidad | 11 RF + 21 PV + 16 UX + 114 IDs contra catálogo original | Cobertura del plan, no PASS de producto |
| Contrato compartido | Referencias, operaciones y esquemas comprobados; pruebas HTTP | Validación estructural propia, no certificación OpenAPI |
| Comparación API | Misma suite NestJS/Fastify (TypeScript)/CI4/Go y DB vacía por candidato | SQL compartido limita comparación; historial node:http separado |
| Recuperación local | Rollback transaccional sintético y limpieza de proyecto único | No restore control ni RPO/RTO de producto |
| CI | Workflow y orquestador local | Ejecución remota requiere repositorio publicado, no autorizado |
| Riesgos/responsables | Amenazas y registro de gates | Usuario confirmado para producto/técnica/operación; revisión independiente por asignar antes de F12/F13 |

## Puerta G01

Estados separados:

1. **Implementación técnica F01**: PASS local documentado en `evidence.md`; la repetición con NestJS/Fastify completó 24 pruebas automatizadas, los 12 grupos PostgreSQL de cada uno de los tres candidatos y limpieza. Repetirlo después de cambios.
2. **Decisión de stack**: API TypeScript modular/PostgreSQL y NestJS con adaptador Fastify aprobados por el usuario. El usuario es responsable humano de producto, mantenimiento técnico y operación. La integración NestJS `12.2.0`/Fastify `5.12.7` fue validada en el laboratorio; las versiones del experimento no se aprueban automáticamente para producción.
3. **G01 ACEPTADO / F01 CERRADA**: el usuario confirmó «G01 aceptado» después de revisar la validación local. La aceptación cierra F01; no autoriza crear recursos AWS ni iniciar F02. F02 requiere cuenta, región provisional, presupuesto y autorización propios. La revisión independiente se asignará antes de F12/F13.

No ampliar afirmaciones: los controles SQL/fixtures de F01 no son PV01/PV03/PV09 productivos aprobados. PV/UX conservan NOT RUN en `traceability.json`.

## Estimación y consumo

Hay un responsable humano confirmado, con ejecución asistida por agentes, pero no capacidad, disponibilidad, calendario ni región definidos. Comparar escenarios base/objetivo/estrés con el mismo conjunto de datos y registrar CPU, memoria, transferencia, almacenamiento, errores, duración y restauración antes de dimensionar. La suite F01 no genera un SLA ni permite comparar latencias de forma representativa: servicios secuenciales y entorno compartido no son un benchmark controlado.

Costos a presupuestar antes de F02: EC2/EBS, IP pública, transferencia, datos/backup del control, observabilidad y operación. Después, relay, distribución/firma de clientes y backup comercial si se habilitan. Ninguna cifra se inventa en F01.
