# F02 — preparación de AWS y puerta de despliegue

## Resultado y autorización vigente

F01 cerrada con G01 aceptado. El laboratorio F02 fue desplegado posteriormente por el usuario en la cuenta `423597267645`, región `us-east-1`. El 23 de octubre de 2026 el usuario autorizó primero una **validación de solo lectura**, después diagnóstico por SSM y, por separado, crear roles PostgreSQL de migración/runtime, corregir permisos y configurar el servicio NEXO. El 29 de octubre de 2026 autorizó crear el commit y tag **solo localmente** para la baseline `v0.1.0`; **push sigue sin autorización**. No se autorizan apply de IaC, restore, producción, clientes/datos reales ni migración de OpenVPN.

La identidad observada fue `arn:aws:iam::423597267645:user/nexo-lab-admin`, en la cuenta esperada. La lectura efectiva y sus límites se registran en [evidence.md](evidence.md). El laboratorio local de PostgreSQL/copia/restore se documenta en [local-lab.md](local-lab.md); no sustituye un restore AWS.

Región propuesta: **us-east-1 (N. Virginia)**. Es una hipótesis de disponibilidad de servicios y operación, no una prueba de mejor latencia o menor costo. Confirmar ubicación de usuarios, residencia/jurisdicción y medir latencia antes del despliegue. La ausencia de límite de gasto no significa gasto autorizado ni protección automática frente a sobrecostos.

## Corte implementado

`infra/aws/lab/` es una raíz independiente de laboratorio. Producción necesitará otra raíz, estado, nombres, CIDR y revisión de permisos/costos; **no promover lab renombrándolo**. La cuenta dedicada puede compartirse por decisión del usuario, pero comparte cuotas, IAM y dominio administrativo. No se crean recursos globales de cuenta ni se modifican VPC/roles/servicios existentes.

- VPC nueva `10.240.0.0/20`, una subred `10.240.0.0/24`, IGW y tabla propia. El CIDR es provisional: revisar solapamientos antes de añadir redes empresariales, peering u otros entornos.
- Una EC2 `t3.small`, EBS gp3 de 30 GiB cifrado, créditos CPU `standard`. Hipótesis local, sin prueba de carga ni compromiso productivo. No es HA.
- IP pública dinámica para salida del host; **sin reglas de entrada** SSH/API/VPN y con egress del security group limitado a TCP/443. SSM observó SSH escuchando en todas las interfaces y PostgreSQL solo en `127.0.0.1:5432`; el SG bloquea actualmente el ingreso externo. No se abrió una sesión interactiva.
- IMDSv2 está habilitado con tokens obligatorios y hop limit 2. La instancia tiene el perfil `nexo-lab-ssm`; SSM la reporta Online. Esto contradice el HCL vigente, que declara ausencia de perfil y hop limit 1.
- VPC Flow Logs a CloudWatch está `ACTIVE` con entrega `SUCCESS`, tráfico `ALL`, stream observado y retención de 14 días. El grupo no usa KMS y no se observaron alarmas propias de NEXO.
- Bucket S3 **solo para copias del control**, fuera del nodo, con un objeto no inspeccionado, versionado, cifrado SSE-KMS, BucketOwnerEnforced, bloqueo público completo a nivel bucket, estado no público y denegación de transporte sin TLS. No tiene lifecycle, Object Lock ni access logging; tampoco hay Public Access Block a nivel cuenta.
- AWS Backup: selección explícita de esta EC2, snapshot diario a las 03:00 UTC y retención de 14 días. El plan se creó a las 03:23 UTC del 23 de octubre, después del horario diario; por ello seguía con **0 jobs, 0 recovery points y 0 snapshots** a las 19:44 UTC. El primer ciclo elegible es el 24 de octubre; el vault no está bloqueado y restore AWS permanece NOT RUN.
- Clave KMS con rotación y ventana de eliminación de 30 días; `prevent_destroy` en clave, bucket y vault, y `force_destroy = false`. Son protecciones de IaC, no WORM ni protección frente a un administrador de AWS. Un `destroy` completo quedará bloqueado: no retirar estas protecciones sin aprobación de retención y custodia.

SSM confirmó PostgreSQL 17.11 activo, Node.js 22.23.4, dependencias coherentes, `dist/` presente, las seis migraciones con hashes idénticos al repositorio y 43 tablas. También confirmó 40 tablas con RLS habilitada/forzada, 41 políticas y ninguna tabla con `tenant_id` sin RLS. El bloqueo inicial se corrigió con autorización separada: `nexo_migration` es owner `NOLOGIN`, `nexo_runtime` conecta por peer con grants explícitos y sin DELETE, y `nexo.service` está enabled/active en `127.0.0.1:3000`. Detalle y comandos SSM: [evidence.md](evidence.md).

No se promete backup consistente de PostgreSQL, custodia de emisión, RPO/RTO, alta disponibilidad, aislamiento productivo ni recuperación hasta ejecutar sus pruebas. **Backup del control obligatorio ≠ backup comercial de clientes (F16)**.

## Cobertura frente al sprint maestro

Este es un corte preparatorio, no todo el entregable F02. El ensayo local cubre instalación/reconstrucción PostgreSQL en Docker y copia/restore sintéticos. Siguen pendientes del sprint en el destino AWS: PostgreSQL privado y su instalación reproducible; IAM mínimo (la política administrada de backup propuesta es más amplia), MFA/acceso temporal del operador y custodia de secretos; hardening y mantenimiento del sistema operativo; canal seguro de administración/emergencia; alertas y responsables; estimación de costos; reconstrucción y restauración del control real probadas. No se instala una base con credenciales de laboratorio F01 ni se promueven sus fixtures. Ninguna de estas obligaciones se traslada silenciosamente a F03.

## Herramientas y validación local

Versiones fijadas en `infra/toolchain.json` y `versions.tf`: OpenTofu **1.13.2**, provider AWS **6.69.0**. El runner descarga el tar oficial para Linux x64 y verifica SHA256 antes de extraer solo `tofu`; no instala nada globalmente ni usa Docker. El digest se contrastó con el asset de GitHub y `SHA256SUMS` oficiales; no se verificó una firma independiente del editor. El lock del provider debe conservarse y revisarse al actualizar. La inicialización verifica sus checksums, no la seguridad funcional del provider.

```bash
npm run verify:f02
```

Ejecuta `fmt -check`, `init -backend=false -lockfile=readonly`, `validate` y `test`, con HOME vacío y sin heredar credenciales, variables AWS/TF, perfiles ni endpoints. Requiere Node 22, red para descargar distribución/provider y `tar` en Linux x64. Guarda evidencia en `artifacts/f02/<ejecución>/report.json`. Las pruebas usan `mock_provider "aws"` y **cada run declara `command = plan`**: el valor predeterminado de `tofu test` es apply, por eso no se omite. La suite general F01 permanece separada; un PASS local F02 nunca significa un plan real ni un despliegue exitoso.

Estado y procedimiento para el plan autenticado: [plan-real.md](plan-real.md). Verificación posterior a un despliegue autorizado: [recovery.md](recovery.md).

Resultados de ejecución y límites: [evidence.md](evidence.md).

## Puertas pendientes

1. Sustituir el usuario IAM administrativo de larga duración por acceso humano temporal con MFA y mínimo privilegio; requiere autorización separada.
2. Resolver el drift de perfil IAM/hop limit y decidir si `nexo-lab-ssm` forma parte del HCL. Su policy inline permite Get/Put/List del bucket y Decrypt/GenerateDataKey con la KMS.
3. Confirmar región/residencia, CIDR, capacidad, administración segura, alarmas/responsables, retención y presupuesto operativo.
4. Verificar después de la ventana del 24 de octubre de 2026 que existan job exitoso, recovery point y snapshot; luego autorizar separadamente un restore en destino nuevo con fixtures sintéticos.
5. Diseñar backup consistente PostgreSQL/PKI, RPO/RTO y custodia. Sin reconstrucción y restore comprobados, **F02 permanece abierta** y PV12 NOT RUN.

## Fuentes oficiales

- [OpenTofu 1.13.2 y assets](https://github.com/opentofu/opentofu/releases/tag/v1.13.2).
- [OpenTofu test: plan, mocks y apply por defecto](https://opentofu.org/docs/cli/commands/test/).
- [OpenTofu plan y sensibilidad de planes guardados](https://opentofu.org/docs/cli/commands/plan/).
- [Provider AWS 6.69.0](https://github.com/hashicorp/terraform-provider-aws/releases/tag/v6.69.0).
- [AWS regiones y endpoints](https://docs.aws.amazon.com/general/latest/gr/rande.html).
- [Cifrado AWS Backup por tipo de recurso](https://docs.aws.amazon.com/aws-backup/latest/devguide/encryption.html).
- [IAM de VPC Flow Logs y protección confused deputy](https://docs.aws.amazon.com/vpc/latest/userguide/flow-logs-iam-role.html).
