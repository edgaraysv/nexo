# F06 — entornos OpenVPN aislados

Estado: **implementado y validado en la EC2 de laboratorio; PV15–PV20 `PASS`**.

## Alcance local

- Control multiempresa en `vpn_environments` y registro inmutable en `vpn_environment_revisions`.
- Estado deseado (`active`, `suspended`, `retired`) separado del observado; revisiones monotónicas y reporte ligado al nodo autenticado propietario.
- OpenVPN Community sobre UDP únicamente, pool IPv4 privado `/16`–`/30`, IPv6 deshabilitado y puerto único por nodo mientras el entorno no esté retirado.
- Validación comercial de módulo VPN activo y validación técnica de nodo aprobado.
- RLS: owner proveedor ve todo; operator solo empresas asignadas; el contexto de worker solo permite el reporte técnico que además filtra `node_id` y revisión.
- Renderer cerrado sin shell, URL, ruta, destino, directiva OpenVPN ni ruta por defecto aportados por la API.
- El nodo autenticado obtiene un snapshot declarativo filtrado por su `node_id`; PostgreSQL vuelve a imponer ese vínculo mediante RLS. El agente rechaza identidades, estados, puertos, CIDR, namespaces, colisiones y campos operativos fuera del contrato antes de mutar el host.
- El reconciliador Linux usa únicamente `ip`, `nft`, `systemctl` y `sysctl` con argumentos generados internamente. Crea por entorno un namespace, veth, tabla nftables, PKI y unidad transitoria; no ejecuta shell ni acepta rutas, comandos, URLs o directivas desde la API.
- El estado persistente reside bajo `/var/lib/nexo-node`; el estado efímero de `/run` se reconstruye de forma idempotente. Un fallo parcial retira namespace, firewall y unidad antes del siguiente intento, conservando la PKI.
- IPv4 forwarding es una precondición explícita: si está deshabilitado el agente falla cerrado con `forwarding_disabled` y no lo cambia por sí mismo.
- Archivos atómicos, credencial bootstrap `0600`, configuración por entorno y digest SHA-256.
- Harness Docker desechable con namespace de red por entorno, PKI separada, nftables, bloqueo explícito de IMDS, raíz de solo lectura y límites de 0.25 CPU, 96 MiB y 64 PIDs.
- Interfaz mínima en `/provider/vpn` para crear, listar, activar/reiniciar, suspender y retirar.

## Contratos HTTP

- `GET /v1/provider/vpn-environments`
- `POST /v1/provider/vpn-environments` (owner)
- `PUT /v1/provider/vpn-environments/:id/state` (owner y revisión esperada)
- `POST /v1/node/vpn-environments/:id/report` (identidad de nodo)
- `POST /v1/node/vpn-environments/reconcile` (identidad de nodo, cuerpo vacío y respuesta filtrada por nodo)

El cliente no aporta `namespace_name`, estado observado, IPv6, rutas, archivos ni comandos. El `tenant_id` de una petición no concede acceso: PostgreSQL decide visibilidad mediante el contexto autenticado y RLS.

## Ciclo de vida

- **Crear:** persiste revisión 1 en estado solicitado `active`; el estado observado comienza `pending`.
- **Suspender/reiniciar:** crea una nueva revisión y conserva archivos y credenciales.
- **Retirar:** es monotónico y no borra historial; libera el puerto para un reemplazo sin reactivar el entorno retirado.
- **Interrupción:** el runtime nativo elimina recursos efímeros parcialmente creados y reintenta desde el estado deseado; el harness Docker elimina su contenedor fallido.
- **Limpieza:** se intenta retirar todos los recursos aunque falle una baja individual, incluida la veth que puede quedar si la interrupción ocurre antes de mover su peer al namespace. Cualquier residuo produce error y el siguiente ciclo vuelve a reconciliar.
- **Reinicio del host:** cobertura unitaria y PV17 con reinicio EC2 real; el runtime se reconstruyó con IDs, revisiones, PKI, reglas y unidades idénticos.

## Verificación local

```bash
npm run verify:f06
npm run test:f06-postgres
npm run test:f06-local
npm run test:runtime-grants
npm run probe:f06-aws # solo imprime el contrato; no contacta AWS
```

El harness permite dos pools VPN con `10.90.0.0/24` porque cada uno usa un namespace independiente. La campaña AWS añadió clientes reales, LAN protegidas homónimas, tráfico extremo a extremo, IMDS y reinicio del host.

El agente verifica también el contenido persistido, direcciones y reglas nftables vivas antes de considerar saludable un entorno; una tabla vacía con el nombre esperado fuerza reconstrucción. Los archivos atómicos se sincronizan antes y después del rename para reducir estados ambiguos tras pérdida de energía.

`infra/aws/lab/nexo-node-agent.service` fue validada con systemd, OpenVPN y Amazon Linux 2023 en el host autorizado. Tras la campaña, la identidad ficticia fue eliminada y la unidad quedó deshabilitada.

## Estado AWS

- Migración 010, API y agente desplegados en laboratorio.
- PV15–PV20 `PASS`, incluido reinicio EC2 autorizado e IMDS real denegado desde VPN.
- Cleanup final `PASS`: cero fixtures, namespaces y entornos; forwarding `0`; agente ficticio deshabilitado; SG sin ingress UDP.

Consulte [aws-validation-plan.md](aws-validation-plan.md) y [evidence.md](evidence.md).
