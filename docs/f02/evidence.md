# Evidencia F02 — preparación local, validación AWS y configuración autorizada

## Alcance y autoridad

Inicialmente el usuario autorizó preparar F02 sin apply. Posteriormente informó el laboratorio desplegado y autorizó una validación autenticada de solo lectura con el perfil `nexo-lab`, luego diagnóstico mediante SSM y finalmente, por separado, crear los roles PostgreSQL de migración/runtime, corregir permisos de archivos y configurar el servicio NEXO. Restore, producción, clientes/datos reales, OpenVPN, commits y push permanecen fuera de alcance.

## Herramientas

- OpenTofu 1.13.2 para Linux x64: tar oficial descargado localmente, SHA256 `ac05d9952662c7db28dd57e93f0a68018837bfdf9342384ec0987977c16a9645` verificado contra metadata del asset oficial GitHub y `SHA256SUMS`. Binario ejecutado sin instalación global. Firma independiente del tar: NOT RUN.
- AWS provider 6.69.0: `init -backend=false` descargó el provider y reportó firma con key ID `0C0AF313E5FD9F80`. Checksums/versiones registrados en `infra/aws/lab/.terraform.lock.hcl`.
- Durante la preparación inicial no se instaló AWS CLI ni se contactó AWS. Para la validación posterior ya existía AWS CLI y se usó exclusivamente el perfil autorizado `nexo-lab`; no se leyó ni mostró material secreto.

## Verificaciones ejecutadas

- **PASS:** `npm run check`: sintaxis/documentación, referencias de contrato, trazabilidad y hashes de las seis fuentes originales.
- **PASS:** `npm test`: compilación TypeScript por pretest y **28/28 pruebas**. Incluye cuatro guardias nuevas F02: exigir mocks/plan explícito, rechazar apply implícito/expreso, rechazar providers reales/módulos y coherencia de toolchain/lock. Después se reforzó la primera guardia con inspección de los `.tf` para comprobar que no se configuran key pair, perfil IAM de instancia ni reglas entrantes; se repitieron las cuatro pruebas F02 con **4/4 PASS** y `npm run check` con PASS.
- **PASS:** `tofu validate -no-color` sobre `infra/aws/lab`.
- **PASS:** comprobación de whitespace de los archivos nuevos F02.
- **FAIL inicial, conservado:** `npm run verify:f02`, reporte `artifacts/f02/nexo-f02-5ba76e58-658/report.json`. Formato, init y validate pasaron; test falló porque el provider mock generó strings arbitrarios para ARN calculados de KMS/IAM/CloudWatch. Se añadieron ARN sintéticos de formato válido dentro del mock, sin sustituir la identidad/AMI reales del futuro plan autenticado. El intento fallido no se convierte retroactivamente en PASS.
- **FAIL de fixture, conservado:** repetición `artifacts/f02/nexo-f02-cbd09944-e72/report.json`: cinco planes negativos PASS; el plan válido falló porque los campos AWS `key_name` e `iam_instance_profile` son Optional+Computed y el mock genera valores aleatorios si se omiten. El mock ahora representa su ausencia mediante strings vacíos y las guardias estáticas verifican que el HCL no los configura. Esto no prueba su estado efectivo en AWS.

**Repetición final local: PASS.** `npm run verify:f02` completó formato, inicialización sin backend con lock de solo lectura, validación y **6/6 planes mock**: configuración válida y rechazo de formato de cuenta, identidad distinta, región no revisada, AMI inválida y capacidad no revisada. Evidencia: `artifacts/f02/nexo-f02-5a41bec4-f50/report.json` y `test.txt`, desde `2026-10-22T01:48:00.284Z` hasta `2026-10-22T01:50:35.377Z` (UTC). El reporte confirma `F02_LOCAL_MOCK_PLAN_ONLY`, `aws: NOT CONTACTED`, `resourcesCreated: false` y plan real bloqueado por cuenta/perfil. No se ejecutó apply.

No se ejecutó de nuevo el laboratorio Docker/PostgreSQL F01 por estos cambios de infraestructura; su último PASS permanece como evidencia histórica F01.

## Límites y bloqueo real

Este era el bloqueo del corte local original: faltaban cuenta y perfil. Ya no aplica, porque ambos fueron identificados y el laboratorio fue desplegado por el usuario. **Apply de IaC, restauración, reconstrucción y PV12 permanecen NOT RUN**; metas RPO/RTO y exportador consistente del control siguen pendientes.

El uso propuesto de la política AWS administrada de backup incluye permisos de varios servicios fuera de EC2, aunque la selección del plan está limitada al ARN de este nodo. No es IAM mínimo por recurso: revisar/restringir o aceptar expresamente el riesgo antes de apply, especialmente si lab/prod compartirán cuenta. Flow Logs limita escritura a su grupo; `logs:DescribeLogGroups` requiere inventario con Resource `*`. Estas limitaciones son visibles, no se presentan como controles operativos ya verificados.

No se hicieron commits ni push. Este agente no ejecutó apply de IaC ni creó recursos de infraestructura; la configuración posterior autorizada del host se documenta al final de este archivo.

## Continuación autorizada: recuperación local sin AWS

El usuario pidió continuar F02 con el entorno local, sin acceso a AWS. Se añadió `infra/local/f02/` (Compose, SQL y configuración/HBA sintéticos), el runner `scripts/f02-local.mjs`, validación de manifiestos en `scripts/f02-backup.mjs` y regresiones en `tests/f02-backup.test.mjs`. Alcance y comandos completos: `local-lab.md`.

- **FAIL inicial conservado:** `artifacts/f02-local/nexo-f02-local-33f7b1de-798e-4c15-9e4b-6f47650cd2d1/report.json`. La copia y restauración pasaron; falló el rechazo de contraseña incorrecta por confianza TCP loopback de la configuración inicial de PostgreSQL. Limpieza PASS. Se sustituyó por HBA explícito SCRAM para todo TCP; no se debilitó la aserción ni se modificó el laboratorio F01 para ocultar el fallo.
- **PASS local posterior:** `npm run test:f02-local`, reporte `artifacts/f02-local/nexo-f02-local-30c97ed5-576a-472f-89ed-146109ce84c8/report.json`: **7/7 grupos**, limpieza PASS y backup íntegro conservado fuera de los volúmenes retirados. Recuperación en destino nuevo, datos anteriores al dump, configuración, restricciones/secuencia/ACL, contraseña incorrecta y recreación del contenedor aprobados. Medición local de arranque+restore: 12163 ms, sin interpretar como RTO/RPO aprobado.
- **PASS:** seis pruebas de manifiesto/HBA y cuatro guardias IaC, **10/10** mediante `node --test tests/f02-backup.test.mjs tests/f02-safety.test.mjs`.
- **Regresión integral, primer intento parcial:** `npm run verify` completó check, tipos, compilación y 33 pruebas (antes de añadir la regresión HBA), pero no llegó a arrancar el laboratorio F01: npm falló con `ENOENT uv_cwd` al lanzar `test:spikes`. Se comprobó que la ruta del proyecto seguía accesible y se repitió desde la ruta absoluta; no se atribuye una causa no demostrada ni se marca ese intento como PASS global.

**Repetición final del ensayo local: PASS**, reporte `artifacts/f02-local/nexo-f02-local-c226a384-8538-4c8f-ba55-86ff0100e130/report.json`, terminado en `2026-10-22T02:54:23.592Z` (UTC). **7/7 grupos** con comprobaciones adicionales del HBA efectivo y formato SCRAM de la credencial sintética. Restore local medido en 12339 ms (no SLA). Limpieza PASS; una verificación posterior por etiquetas confirmó ausencia de contenedores/redes/volúmenes propios y revalidó los hashes del backup preservado en el host.

**Regresión integral final: PASS.** `npm run verify` completó check documental/sintaxis, tipos, compilación, **34/34 pruebas automatizadas** y **36 grupos de integración PostgreSQL** (12 por candidato: NestJS/Fastify, CI4 y Go). Reporte comparativo: `artifacts/f01/nexo-f01-f94acd86-d6a/report.json`, terminado en `2026-10-22T02:59:30.378Z` (UTC). Limpieza PASS; inspección posterior por etiquetas confirmó ausencia de contenedores, red y volumen de ese proyecto. El fallo previo `uv_cwd` se conserva como intento separado, no como fallo funcional reproducido.

Estos ensayos locales no prueban aislamiento empresarial productivo, exportación/custodia de claves reales ni restauración del control completo. PV12 sigue NOT RUN y F02 permanece abierta.

## Validación AWS desplegada — 23 de octubre de 2026

### Autoridad y método

El usuario identificó el laboratorio ya desplegado y autorizó **solo lectura**. Se usó exclusivamente el perfil `nexo-lab` en `us-east-1`; STS confirmó la cuenta `423597267645` y el principal `arn:aws:iam::423597267645:user/nexo-lab-admin`. No se ejecutaron APIs de escritura, apply, sesión SSM, comandos remotos, descarga de objetos, restore ni instalación.

### Resultado por control

| Área | Estado | Evidencia observada |
| --- | --- | --- |
| Identidad y alcance | PASS | Cuenta, región, instancia `i-006cda6fdc86af7a5` y AMI `ami-0d6e34c14757a048b` coinciden con los outputs autorizados. |
| EC2 y salud | PASS | `running`; checks de sistema e instancia `ok`; AL2023 x86_64, `t3.small`. |
| EBS | PASS con riesgo regional | Raíz gp3 de 30 GiB cifrada y adjunta. Encryption-by-default regional está deshabilitado; el volumen actual sí está cifrado. |
| Red | PASS observado | VPC dedicada `10.240.0.0/20`, subred `10.240.0.0/24`, sin autoasignación de IP; instancia con IP pública dinámica. SG sin ingress y solo egress TCP/443. |
| IMDS | PASS con drift | Tokens v2 obligatorios; endpoint habilitado; IPv6/tags deshabilitados; hop limit real 2 frente a 1 en HCL. |
| Administración | PASS técnico / RIESGO | SSM Agent `3.3.5390.0` Online mediante perfil `nexo-lab-ssm`; no se inició sesión. El HCL declara que no hay perfil IAM. |
| Flow Logs | PASS | VPC Flow Log `ACTIVE`, entrega `SUCCESS`, tráfico `ALL`, stream existente y retención 14 días. Grupo sin KMS y sin alarma NEXO observada. |
| S3 | PASS básico | Bucket esperado, no público, Block Public Access completo a nivel bucket, BucketOwnerEnforced, versioning y SSE-KMS con bucket key; policy HTTPS-only. Contiene 1 objeto cuyo nombre y contenido no se leyeron. |
| KMS | PASS | Clave customer-managed habilitada, origen AWS_KMS, no multi-región, rotación anual activa. |
| AWS Backup configuración | PASS | Vault, plan diario 03:00 UTC, ventana 60/180 min, retención 14 días y selección exacta de la instancia. |
| AWS Backup operativo | PENDIENTE primer ciclo | Vault con 0 recovery points, lista de jobs vacía y 0 snapshots del volumen. El plan fue creado a las 03:23 UTC, después de la ejecución diaria de las 03:00 UTC; todavía no existe copia utilizable ni restore, pero tampoco un job fallido. |
| Restore/reconstrucción AWS | NOT RUN | No autorizado; no se creó destino, no se midió RPO/RTO y no se validó PostgreSQL/PKI. |
| CloudTrail persistente propio | FAIL de observabilidad | No se observó trail propio. Solo queda disponible el historial por defecto de AWS, que no sustituye un trail persistente configurado. |

Las alarmas Route 53 observadas pertenecen a recursos ajenos a NEXO y no se tocaron ni se atribuyen al laboratorio.

### Drift frente al HCL

1. `infra/aws/lab/main.tf` declara **sin perfil IAM**, pero EC2 usa `nexo-lab-ssm`.
2. El HCL fija `http_put_response_hop_limit = 1`; el runtime reporta 2.
3. La documentación/output histórico “sin acceso administrativo” está obsoleto: SSM está Online. No se deduce de ello que NEXO esté instalado; el host no fue inspeccionado.
4. El rol EC2 adjunta `AmazonSSMManagedInstanceCore` y una policy inline `nexo-s3-deploy`: Get/Put/List sobre el bucket de control y Decrypt/GenerateDataKey sobre su KMS. Esto amplía materialmente el alcance originalmente descrito.

No se ejecutó `tofu plan -refresh-only`: aunque normalmente es una lectura, podía producir efectos locales/refresh no necesarios y la comparación directa de HCL con APIs ya demostró el drift.

### Riesgos priorizados, sin remediar

1. **Crítico — acceso humano:** `nexo-lab-admin` tiene `AdministratorAccess`, ningún dispositivo MFA y una access key activa creada el 23 de octubre de 2026. Una clave de larga duración sin MFA concentra control total de cuenta.
2. **Alto — recuperación no demostrada:** 0 recovery points/jobs/snapshots; el primer ciclo aún no ocurrió, el vault no tiene lock y restore permanece NOT RUN.
3. **Alto — drift no gestionado:** IAM de instancia y hop limit no están representados por el HCL vigente; un apply futuro podría retirarlos o alterar acceso sin que la documentación lo anticipe.
4. **Medio — alcance del rol EC2:** la instancia puede escribir/leer todo el bucket de control y descifrar/generar data keys. Compromiso del host afecta copias del control.
5. **Medio — auditoría/alertas:** no hay CloudTrail propio persistente ni alarmas NEXO verificadas; Flow Logs retiene 14 días y no usa KMS.
6. **Medio — defensa S3/backup:** no hay Public Access Block a nivel cuenta, lifecycle, Object Lock, logging de bucket ni vault lock. Estas ausencias no vuelven público el bucket actual, pero reducen defensa en profundidad y retención inmutable.
7. **Bajo/condicional — cifrado EBS regional:** encryption-by-default está deshabilitado aunque el volumen NEXO actual está cifrado.

### Remediación propuesta — requiere nueva autorización

- **Inmediata:** migrar el acceso humano a credenciales temporales con MFA y mínimo privilegio; desactivar/eliminar la access key solo después de confirmar el reemplazo para no bloquear al usuario.
- **Antes de otro apply:** incorporar o retirar conscientemente SSM y hop limit en IaC, documentar la intención y revisar el mínimo privilegio de `nexo-s3-deploy`.
- **Antes de aceptar recuperación:** obtener un recovery point exitoso, alertar fallos, definir RPO/RTO/custodios y ejecutar restore aislado de fixtures con rotación de credenciales.
- **Antes de producción:** trail persistente protegido, alarmas/responsables, estrategia de inmutabilidad/retención, backup consistente PostgreSQL/PKI y separación de lab/prod.

Estado final de esta validación: **infraestructura base observada PASS con drift; seguridad administrativa y recuperación FAIL/PENDING; F02 abierta; PV12 NOT RUN**.

## Instalación posterior y validación SSM

El usuario comunicó que realizó directamente en AWS los pasos siguientes:

1. Instaló PostgreSQL 17 desde el repositorio oficial.
2. Instaló Node.js 22 LTS.
3. Creó el usuario y la base de datos de NEXO.
4. Empaquetó el código y lo subió al bucket de control.
5. Descargó y descomprimió el código en `/opt/nexo`.
6. Instaló dependencias y compiló el proyecto.
7. Aplicó como superusuario las seis migraciones L02–L06; reportó 43 tablas creadas.

El usuario autorizó posteriormente el uso de SSM. Se ejecutaron dos comandos `AWS-RunShellScript` no destructivos mediante Run Command: `f7c8e86f-49cc-4130-96c1-45fa725ac2e4` y `b1bb4277-b4fe-49f1-9c3f-2a82dce71e30`. Ambos terminaron `Success` con código 0. No se abrió shell interactiva, no se mostraron secretos o datos de negocio, no se descargaron objetos y no se modificaron archivos, servicios, paquetes o PostgreSQL.

### Controles confirmados

- Amazon Linux 2023.12; PostgreSQL `17.11` activo y habilitado mediante `postgresql.service`.
- Node.js `v22.23.4` y npm `10.9.9` instalados con NVM para `ssm-user`. El árbol npm de runtime devuelve estado 0.
- `/opt/nexo` existe, contiene `node_modules/` y `dist/` con 22 archivos.
- `package-lock.json` y las seis migraciones tienen hashes idénticos al checkout local. Las migraciones contienen las 43 tablas esperadas.
- Base `nexo`; 43 tablas públicas, 40 con RLS habilitada y forzada, 41 políticas. Las únicas tablas sin RLS son `permissions`, `control_security_state` y `security_reconciliation_events`, coherentes con las migraciones. Ninguna tabla con columna `tenant_id` carece de RLS.
- El rol `nexo` puede iniciar sesión y es `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` y `NOBYPASSRLS`.
- PostgreSQL escucha solo en `127.0.0.1:5432`. SSH escucha en `0.0.0.0:22` y `[::]:22`, pero el SG observado no permite ingress.

### Fallos y drift del despliegue

1. **BLOQUEANTE — runtime PostgreSQL:** las 43 tablas pertenecen a `postgres`; `nexo` tiene privilegio SELECT en 0/43 e INSERT en 0/43. `SET ROLE nexo; SELECT count(*) FROM tenants` falla con `permission denied`. La aplicación no puede usar actualmente su esquema.
2. **BLOQUEANTE — aplicación detenida:** no hay proceso Node/NEXO y `nexo.service` no existe o está inactivo. Compilar no equivale a desplegar un servicio saludable; TLS, endpoint de salud y arranque/reinicio siguen NOT RUN.
3. **ALTO — separación de funciones incompleta:** `nexo` es propietario de la base, mientras `postgres` posee las tablas. Deben separarse rol de migración/owner y rol runtime mínimo; no ejecutar la aplicación como `postgres` para sortear el fallo de grants.
4. **MEDIO — artefacto desactualizado:** el hash remoto de `package.json` (`b8f127…`) difiere del checkout actual (`95c6dd…`) y no contiene los scripts L08. `package-lock.json` y migraciones sí coinciden. El paquete parece anterior al cierre L08 y debe versionarse explícitamente antes de promoverlo.
5. **MEDIO — permisos de archivos:** `/opt/nexo` pertenece a `ssm-user`; `package.json` y `package-lock.json` tienen modo `775`, y el tar de despliegue permanece en el árbol con modo `664`. Los manifiestos no necesitan bit ejecutable ni escritura de grupo.
6. **MEDIO — runtime dependiente del perfil:** Node/npm solo aparecen bajo la ruta NVM de `ssm-user`, no en el PATH root de Run Command. Un futuro servicio systemd necesitará ruta absoluta o entorno explícito y un usuario de servicio dedicado.

Ese fue el estado del diagnóstico previo a la remediación: **esquema e integridad de migraciones PASS; ejecución de aplicación y permisos runtime FAIL/BLOCKED**. La corrección autorizada y su resultado se registran a continuación.

## Configuración autorizada de roles, archivos y servicio — 23 de octubre de 2026

### Cambios aplicados

- El rol anterior `nexo` se renombró a `nexo_migration` y quedó `NOLOGIN`, `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOREPLICATION` y `NOBYPASSRLS`.
- Se creó `nexo_runtime` como rol PostgreSQL `LOGIN` sin contraseña, superusuario, creación de bases/roles, replicación ni `BYPASSRLS`. La conexión local usa el HBA `peer` ya existente y el usuario Linux homónimo.
- La base, esquema y las 43 tablas pasaron a propiedad de `nexo_migration`. Runtime recibió grants explícitos: 38 tablas con SELECT, 36 con INSERT, 26 con UPDATE, 0 con DELETE y sin SELECT sobre `security_reconciliation_events`. El esquema actual no contiene secuencias.
- `/opt/nexo` quedó `root:nexo_runtime` con directorios `0750` y archivos ordinarios `0640`; el tar de despliegue, si existe, quedó `root:root` `0600`. Node y `nexo-issuer` se instalaron en `/usr/local/lib/nexo` como binarios root-owned no modificables por runtime.
- La clave de sellado se generó dentro del host en `/etc/nexo/seal.key` (`0640 root:nexo_runtime`). No se registró ni transfirió su valor.
- Se inicializó una CA local exclusiva del laboratorio en `/var/lib/nexo/ca`; directorio y clave quedaron `root:nexo_runtime` (`0750` y `0640`) para que runtime pueda leer pero no modificar la clave. El certificado autofirmado observado vence el **22 de noviembre de 2026** y no constituye PKI productiva.
- Se instaló y habilitó `nexo.service` con `User/Group=nexo_runtime`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, capabilities vacías y restricciones adicionales. La API usa HTTP únicamente en loopback; no se abrió ingress ni se expuso externamente.

El artefacto operativo se compiló/probó localmente y se transfirió como bundle verificado mediante S3 a `deploy/nexo-service-config-20261023.tar.gz`. SHA256 del bundle: `d17814825a3925620128970bce9579a0701bd3d32d68eaa759296045f361f3f3`; emisor: `6cf49aeb73eaf7c49880ac2c83f3a6e7f505df0ed7262cf3b6d8a0a0cceba4e3`; entrypoint: `1f5d585d08ddfdea9baf3b25e865324c8135da43bb879adc0bc065436d64c20d`. Las URL prefirmadas no se conservan como evidencia.

### Ejecuciones y resultado verificable

- `09226803-aa20-48eb-bbbd-ca8eaeb1b253`: **FAIL antes de escribir**, porque el despliegue remoto no incluía `product/agent/go.mod`.
- `eab749f4-31bf-4f62-ba52-fba98671eb87`: precheck **PASS**; confirmó que el intento anterior no había cambiado roles, servicio, clave ni CA.
- `aaceac53-b1fe-482e-a5e6-06384ec4a807`: **FAIL antes de escribir** por una ruta literal en la comprobación SHA.
- `d496eb37-303f-4b74-9e30-8062c5d0f3ef`: hashes **PASS**; se creó únicamente el usuario Linux `nexo_runtime` y luego abortó al no poder abrir el SQL desde el directorio temporal privado.
- `d446619e-57a6-42a4-ad1c-e86ca4c794a9`: aplicación idempotente **PASS**, código 0.
- `42ae71b5-f1d2-4e9f-8fa8-530dfdef3d68`: verificación independiente **PASS**, código 0.
- `3fbf65ff-89db-450d-ab39-19e2b83a3e22`: conteo adicional de UPDATE/secuencias **PASS**, código 0.
- `0d52bc8c-9ee1-4414-bceb-10def323eb11`: endurecimiento final de propiedad de la CA, reinicio y HTTP `200` **PASS**, código 0.
- `5cf45e6c-1a68-4d3a-a15f-45095cbb1464`: emisión efímera ejecutada como `nexo_runtime`, validación estructural y limpieza del material de prueba **PASS**, código 0.

La verificación final observó `nexo.service` **enabled/active**, HTTP `200` desde `127.0.0.1`, escucha exclusiva `127.0.0.1:3000`, conexión PostgreSQL efectiva como `nexo_runtime` mediante peer, rechazo de DELETE, rechazo de lectura de reconciliación, emisión funcional como runtime y ningún error de nivel `err` del servicio en los cinco minutos revisados. `npm run check`, build TypeScript y la regresión local **77/77** finalizaron PASS. Recuperación e invitaciones por correo conservan sinks no-op y **no deben considerarse operativas**.

Estado posterior: **roles, permisos mínimos comprobados, endurecimiento de archivos y servicio loopback PASS**. F02 sigue abierta por recuperación AWS, acceso humano/MFA, drift de IaC, alertas y controles productivos pendientes; PV12 y restore AWS permanecen NOT RUN.

## Revalidación de AWS Backup — 23 de octubre de 2026, 19:44 UTC

Una lectura posterior con el mismo principal `nexo-lab-admin` confirmó:

- vault `nexo-lab-423597267645-us-east-1-control`: 0 recovery points, sin Vault Lock;
- 0 backup jobs en los 30 días consultados y 0 recursos protegidos con copia completada;
- volumen `vol-0b949df2e40fd97b8`: 0 snapshots propias;
- plan y selección presentes, apuntando únicamente a `i-006cda6fdc86af7a5`;
- plan creado `2026-10-23T03:23:51Z` y selección creada `2026-10-23T03:24:00Z`, después del horario `cron(0 3 * * ? *)`.

La ausencia de job se reclasifica de fallo operativo a **PENDIENTE primer ciclo elegible**. El primer disparo esperado es el 24 de octubre de 2026 a las 03:00 UTC, sujeto a la ventana de inicio de 60 minutos y finalización de 180 minutos configuradas. Esto no constituye garantía de ejecución: se debe volver a consultar job, recovery point y snapshot después de esa ventana antes de autorizar un restore.
