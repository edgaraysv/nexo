# F02 — laboratorio local de copia y recuperación

## Autorización y alcance

El usuario pidió continuar F02 **con el entorno local, sin acceso a AWS**. Este corte crea exclusivamente contenedores, redes y volúmenes Docker desechables de nombre único. No consulta identidades/perfiles, no utiliza AWS CLI ni crea recursos cloud; no instala PostgreSQL en el host ni usa bases de F01, OpenVPN o clientes reales.

Es un ensayo de recuperación con PostgreSQL real y datos/configuración sintéticos; **no es el control NEXO productivo**, un despliegue de la IaC AWS ni una prueba de PV12 productiva.

## Ejecutar

Requisitos: Node 22, Docker Desktop con motor Linux y Compose accesible desde esta distribución. Se reutiliza la imagen PostgreSQL 17.6 fijada por digest del laboratorio F01, sin asumir que esa versión se aprueba para producción. Si no está en caché, Docker puede descargarla del registry; no se usan APIs autenticadas AWS.

```bash
npm run test:f02-local
```

El runner `scripts/f02-local.mjs` no admite argumentos, rutas de dump, nombres de proyectos ni destinos externos. Cada ejecución crea `nexo-f02-local-<UUID>` y guarda evidencia en `artifacts/f02-local/<proyecto>/report.json`. `latest.json` contiene el resultado más reciente, incluido un intento fallido o bloqueado; comprobar siempre su estado.

`npm run verify:f02` sigue siendo la validación HCL con mocks. `npm run verify` ejecuta regresiones F01 y las pruebas unitarias nuevas, pero **no ejecuta este ensayo de recuperación**: los comandos permanecen separados para distinguir sus evidencias.

## Recorrido verificable

1. Validar Compose antes de crear recursos. Arrancar origen con esquema y dos empresas/equipos ficticios, sin datos productivos. Cada base usa una red `internal` distinta, sin puertos publicados ni acceso al socket Docker. Inspeccionar esos controles en el motor, no solo en YAML.
2. Generar `pg_dump --format=custom` de una única base y copiarlo junto a `node.fixture.json` fuera del contenedor/volumen de origen. La copia de configuración sintética es estática: este ensayo no resuelve consistencia atómica entre una configuración cambiante y la base.
3. Registrar manifiesto con alcance, proyecto, nombres fijos, tamaños y SHA256. Rechazar corrupción, archivos faltantes, nombres adicionales/path traversal o alcance/proyecto diferentes antes de importar. El runner solo restaura el dump que acaba de generar; no acepta SQL/archives de terceros. SHA256 detecta cambios accidentales si se conserva el manifiesto, **no autentica al emisor** frente a un atacante que modifica ambos.
4. Cambiar deliberadamente el origen después del dump y retirar su contenedor. Mantener el backup en el host como única fuente usada para el restore. El volumen original no se monta en el destino.
5. Arrancar destino con volumen nuevo, sin esquema de datos; verificar ausencia inicial y separación de volúmenes/redes. Restaurar transaccionalmente mediante `pg_restore --exit-on-error --single-transaction --no-owner` y recuperar la configuración en un volumen separado.
6. Comparar todos los registros sintéticos con el estado anterior a la copia: no deben aparecer los cambios posteriores al dump. Comprobar claves foráneas, secuencia identity, ACL del rol de solo lectura y rechazo de contraseña incorrecta. Los roles son creados desde `roles.sql` en ambas instancias; `pg_dump` no respalda roles globales ni sus contraseñas.
7. Recrear el contenedor de destino desde Compose sin reutilizar el contenedor anterior. Verificar persistencia de datos y configuración recuperados. Esto prueba reconstrucción del contenedor, **no** del host, EC2, namespaces o servicios VPN.
8. Retirar en `finally` únicamente el proyecto de esta ejecución, incluyendo sus volúmenes. Confirmar ausencia por etiquetas y volver a verificar que el backup externo y su manifiesto siguen íntegros. No borrar imágenes, cachés ni proyectos ajenos.

## Seguridad del ensayo

- Los passwords con prefijo `public-f02-...-fixture-only` son públicos y exclusivos del laboratorio. No son una plantilla de gestión de secretos. Los contenedores no reciben variables AWS ni montan archivos de credenciales.
- `pg_hba.conf` exige SCRAM-SHA-256 para todo TCP IPv4/IPv6, incluido loopback. Solo permite administración local por socket como `postgres`, mediante acceso al motor Docker; el resto de usuarios por socket se rechaza. Quien controla Docker sigue siendo administrador del ensayo.
- Un primer intento detectó que la configuración por defecto de la imagen confiaba en loopback aunque `POSTGRES_HOST_AUTH_METHOD` estuviera fijado. Se introdujo un HBA explícito y una regresión de autenticación; no se eliminó la prueba fallida para obtener PASS.
- `f02_reader` tiene SELECT/USAGE sobre las tablas sintéticas, sin superusuario, creación de bases/roles, replicación o bypass RLS. No implementa aislamiento multiempresa F03: puede consultar ambas empresas ficticias.
- Los dumps y configuraciones son **fixtures sin cifrar** en `artifacts/`, ignoradas por Git. Prohibido introducir datos o secretos reales. Cifrado, firmas/autenticidad, custodia y permisos efectivos Windows/WSL para backups reales quedan pendientes.
- Las conexiones del ensayo no usan TLS. La copia externa al contenedor sigue en el mismo host: perder ese host también puede perderla. Ni SCRAM ni una red Docker interna prueban cifrado de transporte o recuperación ante pérdida física.
- El reporte conserva fallos de arranque, prueba y limpieza por separado. Si Docker no está disponible, registra BLOCKED sin solicitar recursos. No reinicia automáticamente Docker Desktop ni WSL. Ante SIGKILL/corte no puede garantizarse `finally`: usar el proyecto exacto del reporte y aprobar una limpieza específica, nunca `prune` global.

## Interpretación de recuperación

Se mide tiempo local de arranque y restore, no un SLA ni RTO acordado. La escritura posterior al dump que no reaparece ejemplifica el límite del punto de copia; no prueba un RPO en horas o una estrategia PITR/WAL. Falta recuperar PostgreSQL y control reales, claves de emisión, secretos, estado IaC, políticas cambiantes y alertas con el RPO/RTO que acuerde el usuario.

AWS sigue pendiente: IAM mínimo/MFA, host endurecido y acceso de emergencia, red/puertos efectivos, IMDS desde runtime empresarial, S3/KMS/Backup, costos y alertas, reconstrucción EC2 y restore limpio del control. **F02 no se cierra por aprobar este laboratorio.**
