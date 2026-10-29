# F08 — sucursales, gateways y recursos privados

El plano de control F08 y el **primer corte de runtime directo IPv4** están implementados. El 2026-10-28 se ejecutó un corte sintético Windows↔AWS: `18443` respondió y `18444` fue bloqueado realmente en el namespace VPN. Ese resultado es una aceptación acotada del fixture; no es aceptación general de F08 ni amplía F07.

## Contrato implementado

- Un perfil de red enlaza una sede existente con un entorno VPN y usa uno de dos trayectos tipados: `direct` o `gateway`.
- `direct` exige retorno `routed` y no acepta un gateway.
- `gateway` exige un agente gateway aprobado de la misma sede y permite retorno `routed` o `snat`. El SNAT queda limitado a los CIDR privados declarados para la sede; no se generan rutas por defecto.
- DNS `local` no cambia resolvedores ni sufijos. DNS `split` exige de uno a cuatro resolvedores privados y de uno a ocho sufijos explícitos.
- Los recursos son destinos cerrados (`ipv4` dentro de la sede o `hostname` bajo un sufijo split-DNS). No se aceptan URL, rutas, comandos ni destinos libres.
- Las políticas relacionan origen (`any_endpoint` o un endpoint aprobado), recurso, protocolo (`tcp`/`udp`) y rango de puertos. La ausencia de una regla activa produce `default_deny`; una denegación coincidente prevalece.
- Cada cambio de recurso o política incrementa la revisión del perfil y lo devuelve a `pending`.
- Un gateway obtiene únicamente perfiles asignados a su identidad. Un endpoint obtiene perfiles directos y no recibe políticas específicas de otros endpoints.
- El contrato deseado incluye los CIDR de sede (`siteNetworks`) para poder planificar rutas de retorno sin inventar agregados.
- El diagnóstico devuelve decisión de política, estado de configuración y siempre `connectivity: not_tested`. `policy_allows` no equivale a una prueba del recurso.

## Límites de seguridad

- IPv4 agregado con prefijo menor que `/16` e IPv6 con prefijo menor que `/48` se rechazan para F08. Esto incluye rutas por defecto y agregados privados amplios.
- Se preserva el aislamiento por `tenant_id` con RLS forzado en las cinco tablas F08.
- El rol runtime no recibe `DELETE`; el retorno previsto es una revisión posterior, no borrado de historial.
- El agente no recibe shell, URL, ejecutable ni directiva OpenVPN arbitraria.
- El runtime VPN acepta reglas node-scoped de destino IPv4 exacto, protocolo y puertos; empuja únicamente rutas `/32`, filtra por defecto y agrega retorno al pool VPN.
- La ruta de retorno no reemplaza rutas preexistentes: una ruta no acreditada como propia produce conflicto. Suspender o retirar elimina la ruta administrada; se conservan contadores de drops y no hay aceptación `established` genérica en el trayecto de datos que pueda mantener una autorización retirada.
- Las reglas `source_kind=device` no tienen traducción positiva en este corte; se omiten completamente (fail-closed). Reglas duplicadas/solapadas se rechazan en el agente y los rangos de política se normalizan antes de entregarlos.
- Solo se ejecuta el trayecto directo IPv4. Gateway, SNAT y split-DNS no se aplican por este runtime.

## Comandos locales

```bash
npm run verify:f08
npm run test:f08-postgres
npm run test:runtime-grants
npm test
```

La prueba Linux de nftables, si se ejecuta con `NEXO_F08_NFT_INTEGRATION=1` dentro de un contenedor aislado con privilegios `NET_ADMIN`, valida y aplica las tablas al kernel, y lee de vuelta el estado aplicado. No genera tráfico de prueba ni reemplaza la aceptación Windows↔AWS.

La interfaz mínima está en `/company/networks` y muestra por separado revisión solicitada, aplicada y estado observado.

## Estado de despliegue (2026-10-28)

El corte sintético F08 fue desplegado, probado y retirado. El endpoint Windows conectó al entorno `f081…0002` y `10.240.0.250:18443` devolvió `NEXO-F08-SYNTHETIC-ALLOW`; `18444` no obtuvo respuesta aunque el listener denegado estaba activo, porque el namespace VPN lo descartó en su cadena `forward` (contador `+3` paquetes/`+156` bytes). El recurso se ubicó en un network namespace aislado de la instancia, sin abrir 18443/18444 en el SG ni tocar rutas VPC.

La API y la migración aditiva 013 permanecen desplegadas en loopback; no se hizo rollback. El entorno, perfil, recurso, política, sitio, dispositivo y nodo sintéticos quedaron retirados/revocados; el nodo y el SG/S3/SSH temporales se limpiaron. Quedan residuales que requieren admin en Windows (`client.key`/`client.csr` presentes con credencial revocada, rutas DCO obsoletas, servicio `NexoEndpoint` instalado).

El P1 local posterior corrigió y probó la reemisión con historial (migración 016, PostgreSQL local), el reporte de observación de solo lectura y el reintento de cleanup. **Nada de eso está desplegado**: la base desplegada conserva el unique total hasta aplicar 016, el binario instalado `AADE7DD196A5A3C8AA02369E844445D1F926D999E77BC08133016E4B563E7CFB` conserva el bug de serial y la observación Windows live no se ejecutó. El build local `48eaa85d0f36299af391aa591363cd9e441e9d96976c6ea01e6a571167cd694e` no se instaló. El restore no se validó (`NOT RUN`); F07 (reconexión, multitenant de aceptación y rechazo CRL real) sigue `NOT RUN`; este corte no la amplía.

Evidencia detallada: [`evidence.md`](evidence.md). Estado local, límites y planes P0/P2/P3: [`p1-local.md`](p1-local.md). Registro de despliegue y retirada: [`deployment-plan.md`](deployment-plan.md).
