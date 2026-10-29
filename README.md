# NEXO — laboratorio y baseline reproducible

Nexo es una plataforma multiempresa de conectividad **privada**, gestión de equipos y módulos independientes. El repositorio contiene especificaciones, laboratorios, infraestructura y componentes locales de API, portal, agente Windows y VPN. Su existencia en código o su validación sintética no equivale a despliegue ni aceptación productiva. **El estado vigente es NO-GO para producción y pilotos con clientes; solo puede continuar el laboratorio con datos sintéticos.** Consultar `docs/f02/README.md` y el plan maestro para gates y evidencia.

## Empezar

Requisitos para la verificación local: Node.js `>=22.17 <23`, npm y Docker con acceso al daemon. Las pruebas PostgreSQL inician instancias efímeras. El CI también valida módulos Go, el cliente nativo Windows/Tauri y Terraform 1.13.2.

```bash
npm ci --ignore-scripts
npm run verify
```

`verify` ejecuta el gate de trazabilidad, typecheck, compilación, pruebas automatizadas y el corte F01. Las pruebas de PostgreSQL posteriores se ejecutan por sus comandos `test:*postgres`. Todo lo local usa fixtures sintéticas; estos comandos no validan AWS ni autorizan producción.

Si esta sesión WSL conserva grupos anteriores a la integración Docker, el runner abre un proceso nuevo en la misma distribución y usuario. No modifica permisos, grupos ni el contexto Docker. Tras reiniciar normalmente la terminal no hace falta esa compatibilidad.

Comandos independientes:

```bash
npm run check
npm run typecheck
npm test
npm run build
npm run test:spikes
npm run verify:l01
npm run verify:l02
npm run test:l02-postgres
npm run verify:l03
npm run test:l03-postgres
npm run verify:l04
npm run test:l04-postgres
npm run verify:l05
npm run test:l05-postgres
npm run verify:l06
npm run test:l06-postgres
npm run test:l06-restore
npm run verify:l07
npm run test:l07-flow
npm run verify:l08
npm run test:l08-recovery
npm run verify:f03
npm run test:f03-postgres
npm run verify:f04
npm run test:f04-postgres
npm run verify:f05
npm run test:f05-postgres
npm run test:runtime-grants
npm run test:f07-postgres
npm run test:f08-postgres
npm run test:f09-postgres
npm run test:ga01-postgres
npm run db:migrate -- --profile f09-local --dry-run
```

Evidencia generada en `artifacts/f01/` (ignorada por Git): resultados por candidato, versiones e inventario de imágenes. La ejecución local de CI no publica ni hace push. Los resultados de F01 **no equivalen a PASS de PV/UX de producto**.

## Mapa

- `docs/f01/`: alcance, decisiones, riesgos, responsabilidades y trazabilidad.
- `docs/l01/`: baseline exacta de trazabilidad y decisiones mínimas para el siguiente corte local.
- `docs/l02/`: decisiones y límites del corte local de identidad, MFA, persistencia y RLS.
- `docs/f02/`: preparación AWS, procedimiento de plan real y pruebas de recuperación pendientes.
- `docs/f03/`: autorización empresarial por acción/recurso, roles y evidencia local de aislamiento.
- `docs/f04/`: planes, módulos independientes, cuotas, excepciones vigentes y pagos manuales.
- `docs/f05/`: revisiones, worker separado, redelivery, reconciliación y contrato de desconexión.
- `docs/f06/`: entornos OpenVPN aislados, reconciliador Linux y evidencia AWS PV15–PV20.
- `docs/f07/`: contrato y plan del cliente Windows integrado con F06.
- `docs/f08/` y `docs/f09/`: red privada, perfiles VPN, reportes y evidencia acotada.
- `docs/migrations/`: perfiles permitidos, ledger y límites de adopción.
- `docs/release/`: manifiesto, SBOM y attestations de procedencia del workflow.
- `infra/aws/lab/`: IaC de laboratorio AWS y pruebas con provider simulado; sin despliegue autorizado. Validar por separado con `npm run verify:f02`.
- `infra/local/f02/`: laboratorio PostgreSQL sintético de copia, restauración y reconstrucción local, sin AWS. Ejecutar por separado con `npm run test:f02-local`; alcance en `docs/f02/local-lab.md`.
- `contracts/f01.openapi.json`: contrato experimental compartido, no API productiva.
- `spikes/api/`: adaptadores NestJS/Fastify (TypeScript), CodeIgniter 4 y Go, migración común y fixtures sintéticas.
- `scripts/`: validación, ejecución segura del laboratorio y recopilación de evidencia.
- `tests/`: regresiones de documentación/contrato y pruebas del transporte NestJS/Fastify con un proveedor de BD simulado. `npm test` compila primero mediante `pretest`.
- `.github/workflows/`: CI local/release para TypeScript, PostgreSQL, Go, Windows, migraciones e IaC. No se ha ejecutado remotamente mientras no haya push autorizado.

## Fuentes preservadas

`Analisis_Tecnico_Proyecto_Nexo.docx` v1.2, `Definicion_de_Producto_Nexo.docx`, `Nexo_Contexto_para_Agentes_IA.md`, `Nexo_Catalogo_de_Parametros_Administrables.md`, `design.md` y `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`. Los dos documentos UX se solapan; cualquier divergencia se registra, no se resuelve por orden de archivo.

## Límites

El código incluye identidad/MFA, permisos multiempresa, operaciones, UI administrativa, cliente Tauri/Windows y flujos VPN de laboratorio. No implica una operación productiva: siguen pendientes, entre otros, F12, restauración/PV12, F10/F11, notificaciones reales, carga, endurecimiento operativo y revisión independiente. Invitaciones y recuperación de cuenta no tienen un canal real configurado. F06 y los ensayos AWS son evidencia del laboratorio, no disponibilidad, alta disponibilidad ni prueba de producción. No usar cuentas ni datos reales.

La API TypeScript usa NestJS `12.2.0`, `FastifyAdapter` y Fastify `5.12.7`; los contratos de F01 son experimentales. Consultar la evidencia por fase para distinguir pruebas unitarias, PostgreSQL, laboratorio AWS y criterios aún `NOT RUN`.

Terraform `1.13.2` y AWS provider `6.69.0` están fijados en `infra/aws/lab/`; `terraform test` usa provider simulado. Un plan AWS real/authenticated requiere presentar alcance y autorización por separado. **No ejecutar `apply`.** Las firmas de GitHub Actions son attestations Sigstore de procedencia; no sustituyen Authenticode ni habilitan distribución productiva.

Consultar [alcance F01](docs/f01/README.md), [decisiones](docs/f01/decisions.md), [evidencia F01](docs/f01/evidence.md), [estado F02](docs/f02/README.md), [runner PostgreSQL](docs/migrations/README.md) y [baseline de release](docs/release/README.md). Se autoriza baseline Git/tag local; no se hará push.
