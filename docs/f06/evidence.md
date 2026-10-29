# Evidencia F06 — corte local

Fecha: 2026-10-24.

## Resultado local

| Verificación | Resultado | Evidencia |
| --- | --- | --- |
| TypeScript, API y guardas AWS | PASS | `npm run verify:f06`: 5 pruebas API y 3 pruebas del contrato/guardas de la sonda |
| Agente Go | PASS | Todos los paquetes pasan; build Linux del agente y contrato autenticado agente/API pasan |
| Reconciliador nativo | PASS local | Validación cerrada, colisiones, PKI idempotente, limpieza best-effort, veth huérfana, deriva de firewall y reconstrucción de estado efímero probadas con runner controlado; no equivale a AL2023 real |
| PostgreSQL 17.6 | PASS | Entitlement, RLS operator, puerto por nodo, revisión, reporte node-bound y retiro monotónico |
| Privilegios runtime | PASS | 10 migraciones, 49 tablas, ownership de migración, sin DELETE ni BYPASSRLS |
| Regresión general | PASS | `npm test`: 97/97 |
| Regresión PostgreSQL F04/F05 | PASS | Cuotas/RLS y confiabilidad del worker sin regresiones |
| Recuperación local | PASS | 10 migraciones restauradas en un destino nuevo; 17.071 s |
| OpenVPN local | PASS | Dos procesos OpenVPN 2.x operativos en contenedores separados |
| Pool VPN superpuesto | PASS local | Ambos entornos usan `10.90.0.0/24` sin compartir namespace; no demuestra PV15 porque aún no hay LAN protegida ni tráfico extremo a extremo |
| Archivos y credenciales | PASS | Directorios/PKI separados; bootstrap local `0600`; CA preservada tras recreación |
| Firewall | PASS | nftables por namespace, forwarding denegado e IMDS `169.254.169.254` bloqueado explícitamente |
| IPv6 | PASS | Deshabilitado por sysctl; renderer no admite habilitarlo |
| Límites | PASS local parcial | 0.25 CPU, 96 MiB y 64 PIDs verificados por inspección Docker; carga sintética en A no detuvo B, pero no satisface el umbral PV19 aún no acordado |
| Ciclo de vida | PASS local parcial | Suspensión/recreación/reinicio/retiro del runtime A sin detener el proceso B; PV16 exige además conectividad continua real |
| Provisión interrumpida | PASS local parcial | Configuración ausente falla cerrada, el contenedor desechable no permanece y el agente cubre fallos inyectados; PV18 requiere repetirlo en AL2023 |
| Limpieza del harness | PASS | Sin contenedores, volúmenes PKI ni directorios temporales F06 tras finalizar |
| Gate documental/sintáctico | PASS | `npm run check`; `git diff --check` sin errores |

Salida estructurada del harness:

```json
{"phase":"F06-local","openvpn":"PASS","isolatedNamespaces":"PASS","overlappingTunnelCidr":"PASS","separateFilesAndCredentials":"PASS","ipv4Firewall":"PASS","ipv6Disabled":"PASS","metadataBlockedByPolicy":"PASS","resourceLimits":"PASS","suspendRestartRetire":"PASS","interruptedProvisionCleanup":"PASS","hostRestart":"NOT_RUN","awsLaboratory":"NOT_RUN"}
```

## Límites de esta evidencia

- Docker proporciona namespaces y cgroups reales, pero no reproduce la EC2 ni su red completa.
- `metadataBlockedByPolicy` verifica la regla nftables local; no prueba el servicio IMDS real.
- No se validaron reinicio EC2, systemd, exposición UDP del Security Group, IAM de instancia ni aislamiento frente al host AWS.
- El harness comprueba procesos OpenVPN, namespaces y políticas, pero todavía no acredita un handshake de cliente ni tráfico extremo a extremo. PV15–PV20 necesitarán credenciales de cliente exclusivas y efímeras para las dos empresas ficticias, sin incorporarlas al API de control.
- `systemd-analyze verify` pudo analizar la unidad propuesta, pero no completar dependencias/rutas en WSL porque allí no existen `postgresql.service` ni el binario desplegado; además el montaje Windows no representa permisos AL2023.
- La PKI del harness es efímera y exclusiva de pruebas; no es una CA de producción.

## Inventario AWS de solo lectura

Consultado mediante APIs AWS de lectura en la cuenta `423597267645`, región `us-east-1`; no se envió ningún comando SSM:

- EC2 `i-006cda6fdc86af7a5`: `running`, checks `ok`, `t3.small`, Amazon Linux 2023 x86_64, IP privada `10.240.0.78` y dirección pública presente.
- IMDS: endpoint habilitado, tokens requeridos, hop limit 2, IPv6 y tags deshabilitados.
- EBS: gp3 cifrado de 30 GiB. CPU media de 24 h cercana a 0.93 %, crédito mínimo cercano a 528.8 y sin surplus cobrado en la ventana observada.
- Subred `10.240.0.0/24` con ruta a IGW, NACL predeterminada abierta y `SourceDestCheck=true`.
- SG `sg-0cc6a1e19439c3e89`: ingress TCP 3000 y 10000 desde `190.5.151.74/32`, sin UDP; egress únicamente TCP/443.
- Perfil `nexo-lab-ssm`: `AmazonSSMManagedInstanceCore` y policy inline para S3 Get/Put/List y KMS Decrypt/GenerateDataKey. SSM Agent `3.3.5390.0` aparece Online.
- Hay drift respecto al HCL local: el runtime tiene ingress no declarado, hop limit 2 frente a 1 y perfil IAM no representado por `main.tf`.

La presencia y rutas reales de `openvpn`, `ip`, `nft` y el comportamiento de systemd no se inspeccionaron porque eso requiere SSM, todavía no autorizado.

## Estado AWS

| Prueba | Estado |
| --- | --- |
| PV15 | **PASS AWS** — dos clientes reales, misma IP protegida `10.77.0.10`, marcadores A/B sin cruce |
| PV16 | **PASS AWS** — 60/60 sondas de B durante reinicio de A; PID B estable |
| PV17 | **PASS AWS** — fail-closed antes del reinicio; `boot_id` cambió; 2/2 runtimes reconciliados con IDs, revisión, PKI, nftables y unidades idénticos |
| PV18 | **PASS AWS** — fallo R5 tras creación parcial, cero huérfanos y convergencia R6 |
| PV19 | **PASS AWS** — 200/200; p95 `1.514 → 2.359 ms`; intentos de saturación de 8/16 workers conservados como FAIL |
| PV20 | **PASS AWS** — 7/7 accesos sensibles denegados; destino autorizado conservado |
| Reinicio de EC2 | **PASS** — `RebootInstances` autorizado sobre `i-006cda6fdc86af7a5`; checks EC2 y SSM recuperados |
| IMDS real desde entorno | **PASS** — acceso denegado en PV20 |
| Migración 010 / despliegue remoto | **PASS** |
| Instalación o cambio OpenVPN/nftables remoto | **PASS** |

Evidencia AWS redactada: campaña PV15/PV16/PV18/PV19/PV20 en `s3://nexo-lab-423597267645-us-east-1-control/f06/evidence/202610260002/nexo-f06-acceptance.tar.gz` (SHA-256 `33eb4ca8e3a925c8ead9b171f6c261c9e6c11f1be2bd33831b005403e44d270a`) y PV17 en `s3://nexo-lab-423597267645-us-east-1-control/f06/evidence/pv17-202610260114/nexo-pv17-reboot-recovery.tar.gz` (SHA-256 `0ca35b552b3180c6adb5a9dbb1c07ef495c268ba95c31dfc7b79892a5755382f`). El cleanup final dejó cero fixtures, namespaces y runtimes, forwarding en `0`, agente ficticio inactivo/deshabilitado y el SG sin ingress UDP.

## Propuesta previa a cualquier cambio remoto

Secuencia, cada bloque detenido ante fallo: (1) preflight SSM fijo de lectura; (2) implementar y probar los fixtures internos seleccionados y su cleanup reanudable; (3) respaldo verificable de base/configuración y artefactos actuales; (4) instalación de paquetes solo si faltan; (5) migración 010 y grants runtime; (6) despliegue atómico de API y binario Go; (7) enrolamiento de una identidad de nodo de laboratorio; (8) instalación de la unidad propuesta; (9) habilitación persistente de IPv4 forwarding; (10) ingress UDP limitado a dos puertos de prueba y a un CIDR de origen confirmado; (11) revisar y desbloquear el runner mutante; (12) dos empresas ficticias y PV15–PV20 con el umbral aprobado; (13) reinicio EC2 únicamente con autorización específica.

Riesgos principales: `CAP_SYS_ADMIN`/`CAP_NET_ADMIN` del reconciliador privilegiado, ampliación de superficie al habilitar forwarding y UDP, interacción de nftables con reglas existentes, compatibilidad de rutas/paquetes AL2023, coordinación entre migración y binarios, capacidad limitada de `t3.small` y pérdida temporal de acceso durante un reinicio. No se propone cambiar IAM, IMDS, `SourceDestCheck`, IP pública, EBS ni la topología VPC.

Coste incremental fijo esperado: ninguno si se reutilizan EC2/EBS/IP actuales y solo se cambia el SG. Pueden existir costes variables por transferencia de datos, uso ya existente de la IPv4 pública y almacenamiento de un respaldo/snapshot si se autoriza. Deben confirmarse antes de ejecutar.

Retorno: bloquear primero los puertos UDP; detener/deshabilitar `nexo-node-agent`; retirar solo unidades, namespaces, veth y tablas `nexo-*`/`nx_*`; restaurar los binarios/configuración previos; devolver forwarding a su valor anterior si ningún otro servicio lo necesita. La migración es aditiva: ante fallo transaccional se revierte automáticamente; después de un despliegue exitoso se prefiere dejar el esquema inactivo en vez de borrar tablas, salvo autorización destructiva separada. La desinstalación de paquetes y cualquier limpieza S3 quedan fuera del retorno automático.
