# F06 — contrato de validación AWS

Estado: **validado en la EC2 de laboratorio el 26-10-2026: PV15–PV20 `PASS`**.

Evidencia redactada: `s3://nexo-lab-423597267645-us-east-1-control/f06/evidence/202610260002/nexo-f06-acceptance.tar.gz`, SHA-256 `33eb4ca8e3a925c8ead9b171f6c261c9e6c11f1be2bd33831b005403e44d270a`.

Evidencia redactada PV17: `s3://nexo-lab-423597267645-us-east-1-control/f06/evidence/pv17-202610260114/nexo-pv17-reboot-recovery.tar.gz`, SHA-256 `0ca35b552b3180c6adb5a9dbb1c07ef495c268ba95c31dfc7b79892a5755382f`.

## Alcance de la sonda

`scripts/f06-aws-lab.mjs --review` imprime este contrato sin contactar AWS. La única fase ejecutable es `preflight`: usa un comando SSM fijo y de lectura para comprobar herramientas, TUN, forwarding, systemd, cgroup v2, disco, migración 010 y recursos NEXO existentes. No crea namespaces, veth, tablas, procesos, credenciales ni reglas; no consulta IMDS y no cambia servicios o kernel.

La fase `acceptance` está bloqueada en código aunque se proporcionen sus guards. No debe autorizarse hasta resolver sus prerrequisitos y revisar nuevamente el diff.

## Criterios de aceptación

| ID | Escenario exigido | Evidencia mínima para PASS |
| --- | --- | --- |
| PV15 | Dos entornos con la misma LAN | Dos clientes/gateways y dos destinos privados homónimos; acceso solo al destino del contexto; capturas de rutas y ausencia de respuestas cruzadas |
| PV16 | Reinicio o retirada de un entorno | Sondas continuas del segundo entorno sin pérdida fuera del umbral; inventario antes/después que pruebe limpieza exclusiva |
| PV17 | Reinicio completo EC2 | Evidencia separada antes/durante/después; puertos denegados durante preparación; mismos IDs, revisiones, PKI y políticas tras reconciliar |
| PV18 | Fallo a mitad de creación | Interrupción identificada por checkpoint; cero namespace, veth, tabla, unidad o proceso huérfano; reintento converge una sola vez |
| PV19 | Carga en una empresa | Límites systemd observados, carga real por túnel y degradación del otro entorno dentro de un umbral aprobado previamente |
| PV20 | Acceso desde VPN a host/otra empresa | Intentos IPv4/IPv6 desde clientes reales contra API, PostgreSQL, SSH/SSM, IMDS y destino de la otra empresa; todos denegados, manteniendo el destino autorizado |

Un proceso OpenVPN activo, dos namespaces o dos pools iguales no bastan para aprobar PV15 o PV20. Cada resultado debe conservar timestamps, revisión deseada/aplicada, identidad del entorno, comandos exactos, códigos de salida y evidencia negativa acotada por timeout.

## Resultado de la ejecución 202610260002

- PV15 **PASS**: ambos clientes obtuvieron `10.90.0.2` en namespaces separados y alcanzaron la misma IP `10.77.0.10`; los marcadores fueron exclusivamente `NEXO-F06-A` y `NEXO-F06-B`.
- PV16 **PASS**: 60/60 sondas de B durante el reinicio de A, cero pérdidas y PID del cliente B estable.
- PV17 **PASS**: preparación fail-closed con `0/2` listeners, reinicio EC2 autorizado y `boot_id` cambiado; los dos entornos reconciliaron con los mismos IDs, revisión `1` y hashes exactos de PKI/configuración, políticas nftables y unidades systemd.
- PV18 **PASS**: el fallo real R5 durante configuración de `tun0` limpió namespaces, veth, tabla y unidad; R6 convergió sin huérfanos.
- PV19 **PASS** al nivel fijo de un flujo HTTP continuo en A: 200/200 sondas en B, p95 base `1.514 ms`, p95 bajo carga `2.359 ms`, límites `250 ms CPU/s`, `96 MiB`, `64` tareas. Los niveles de 8 y 16 workers se conservan como intentos FAIL (`30.507 ms` y `52.389 ms`).
- PV20 **PASS**: 7/7 intentos denegados contra host/API, PostgreSQL, SSH/443, IMDS, entorno B e IPv6; el destino permitido A continuó disponible.
- Cleanup **PASS**: fixtures de base y filesystem eliminados, cero namespaces/unidades de prueba, agente ficticio deshabilitado y forwarding restaurado a `0`.

## Prerrequisitos abiertos para repetir la ejecución

1. Implementar y probar localmente dos fixtures internos efímeros de cliente/gateway con claves exclusivas y dos destinos que publiquen la misma LAN dentro de la EC2 autorizada. Esta topología fue seleccionada para F06 y no añade rutas productivas al API; no usa clientes ni datos reales.
2. Implementar cleanup reanudable por `run_id` y pruebas de cada checkpoint de fallo antes de desbloquear la fase mutante.
3. Protocolo PV17 en dos fases; el reinicio EC2 requiere autorización específica y no puede declararse PASS desde el mismo comando que lo inicia.
4. Inventario SSM de paquetes y rutas reales en AL2023 mediante el preflight autorizado.

Umbral PV19 aprobado para este laboratorio: cero desconexiones en B, al menos 99 % de sondas exitosas y p95 no superior a 2 veces la línea base ni a línea base + 50 ms. Deben cumplirse simultáneamente ambos límites de p95.

## Limpieza y fallo seguro de la futura fase mutante

- Capturar un inventario basal antes de crear recursos.
- Usar un `run_id` en todos los nombres de prueba y mantener un diario local y remoto de cada alta confirmada.
- Instalar traps `EXIT`, `INT` y `TERM`, pero no depender solo de ellos: una fase de cleanup independiente debe poder reanudar desde el diario.
- Limpiar en orden: procesos/clientes, unidades de prueba, reglas/tablas de prueba, namespaces y veth, credenciales efímeras y fixtures de destino.
- Nunca borrar por prefijo amplio. Verificar identidad y `run_id` exactos antes de cada baja.
- Restaurar forwarding y cualquier ajuste únicamente si la sonda los cambió y el valor actual sigue siendo el escrito por ella.
- Si una baja falla, continuar con las demás, registrar el residuo y terminar `FAIL_CLEANUP`; nunca emitir `PASS` con residuos.
- Comparar el inventario final con el basal. PKI y estado persistente del agente se conservan salvo que PV16 pruebe explícitamente el retiro de ese entorno.

## Gates antes de autorizar aceptación

- Preflight PASS y artefactos/binarios identificados por hash.
- Backup y retorno verificados.
- SG UDP limitado a los dos puertos y CIDR acordados.
- Integración de clientes/rutas de laboratorio revisada y probada localmente.
- Umbral PV19 configurado exactamente como fue aprobado.
- Runner mutante implementado con cleanup reanudable y pruebas locales de cada punto de fallo.
- Autorizaciones separadas para despliegue, cambios de red/forwarding, ejecución de aceptación y reinicio EC2.
