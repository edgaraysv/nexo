# F02 — obtener un plan real sin desplegar

## Entradas bloqueantes

El usuario debe indicar **ID de la cuenta dedicada (12 dígitos)** y **nombre del perfil local/SSO autorizado**, y confirmar dónde está configurado (esta distribución WSL o Windows). No explorar otras cuentas, elegir `default` ni copiar credenciales de Windows a WSL implícitamente. No compartir claves, secretos, cookies o tokens en el chat. Se recomienda sesión SSO temporal y permisos de lectura para planificar; el agente no crea usuarios, políticas ni roles de acceso sin autorización adicional.

AWS CLI no estaba instalado y no se detectó configuración AWS en la ubicación Linux predeterminada durante el preflight inicial. La instalación/configuración o uso de otra ubicación se resolverá explícitamente al identificar el perfil. No hay identidad AWS verificada ni plan autenticado todavía.

## Secuencia permitida cuando se identifiquen las entradas

1. Usar un entorno limpio de credenciales ambientales, `AWS_ENDPOINT_URL*`, `TF_CLI_ARGS*`, `TF_VAR_*` y configuraciones CLI ajenas. Establecer **solo el perfil autorizado**, su configuración y sesión SSO en este entorno. No usar claves del root ni permisos de administrador como solución automática a AccessDenied.
2. Ejecutar `aws sts get-caller-identity --profile PERFIL --region us-east-1`. Verificar que Account coincide exactamente con el ID autorizado y revisar el ARN del rol, sin publicar material de sesión. Parar si difiere.
3. Consultar una AMI Amazon Linux 2023 `x86_64`, HVM, EBS, kernel 6.1, disponible en esa región, propiedad de Amazon. Registrar ID, nombre, fecha y arquitectura obtenidos realmente. El HCL vuelve a filtrar propietario/nombre/arquitectura; no copiar la AMI ficticia de `lab.example.tfvars`.
4. Crear un tfvars **ignorado por Git** con `account_id`, `ami_id`, `region` y `instance_type`. Ningún secreto debe ser una variable IaC. Usar estado y artefactos de esta cuenta/lab exclusivamente; no importar recursos existentes.
5. Ejecutar con el binario fijado (rutas de ejemplo desde la raíz; sustituir todos los valores y preparar directorio privado):

```bash
artifacts/tools/opentofu-1.13.2/tofu -chdir=infra/aws/lab init -input=false -lockfile=readonly
AWS_PROFILE=PERFIL artifacts/tools/opentofu-1.13.2/tofu -chdir=infra/aws/lab plan -input=false -detailed-exitcode -var-file=lab.tfvars -out=../../../artifacts/f02/plan-real.tfplan
```

El primer comando prepara **backend local**, no crea bucket de estado remoto. Ejecutar `plan` solo después de los controles 1–4; el ejemplo no sanea por sí mismo todo el entorno. La ruta `out` es relativa a `infra/aws/lab`. La cuenta se limita adicionalmente con `allowed_account_ids` y precondición de identidad. `-detailed-exitcode`: 0 sin cambios, 2 con cambios propuestos, 1 error. **No usar `-refresh=false`, `-target`, mocks o credenciales falsas para simular un plan real.**

6. Inspeccionar el plan con `tofu show`, revisar todas las acciones, versión del provider/AMI, identidad, región, ausencia de importaciones, provisioners y borrados de recursos ajenos. En una cuenta vacía se esperan altas de este laboratorio, pero no se publicará una cifra como real antes de ejecutarlo. La disponibilidad de un tipo de instancia y cuotas se comprueban aparte: plan no reserva capacidad.
7. Presentar resumen, supuestos y costos al usuario y esperar autorización separada. El plan puede leer APIs, pero **no valida permisos de creación ni aplica cambios**. No ejecutar apply, ni siquiera sobre un plan guardado.

## Estado, planes y datos sensibles

Estado local inicial: `infra/aws/lab/terraform.tfstate`, excluido por Git. No es una solución de colaboración/producción ni backup de estado; antes de apply se debe acordar custodia y recuperación del estado o aprobar bootstrap separado de backend remoto con cifrado/versionado/bloqueo. No crear backend implícitamente durante un plan.

Plan binario, JSON de `tofu show`, tfvars, logs, identidad y estado son artefactos privados. Pueden contener datos sensibles aunque el HCL no declare secretos. Usar almacenamiento local privado, `umask 077` y permisos efectivos también en Windows/NTFS si el repositorio está en `/mnt/c`; no basta confiar en `chmod` sobre DrvFS. No adjuntarlos públicamente ni subirlos a Git. Guardar preferentemente los planes reales en una ubicación privada acordada fuera del montaje compartido. Renovar el plan tras cambios o expiración de sesión; no tratarlo como una aprobación permanente.

## Costos que hay que cotizar, no inventar

Preparar una estimación con precios vigentes y supuestos medidos antes de apply: EC2 encendida (aprox. 730 horas/mes como supuesto), EBS gp3 30 GiB, una IPv4 pública por hora, snapshots y tasa de cambio de bloques, S3 versiones/requests, KMS clave/requests, CloudWatch ingesta/retención y transferencia a Internet. No asumir free tier, descuentos ni precio cero de recursos sin tráfico. No hay NAT Gateway, ALB, RDS, EIP reservada, relay o backup comercial en este corte.

El usuario no fijó tope mensual. Falta elegir destinatario y umbrales de alerta; no se crea una alerta ficticia ni un presupuesto silencioso. AWS Budgets y alertas no son un corte automático de gasto. Créditos t3 `standard` evitan cargos por CPU unlimited pero pueden limitar rendimiento. El costo total sigue abierto y no se deduce del número de recursos del plan.
