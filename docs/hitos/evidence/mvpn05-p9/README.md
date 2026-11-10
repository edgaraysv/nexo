# P9 — Gateway operativo en portal (evidencia)

Estado: **ABIERTO — sin captura.** P9 no requiere el lab multitenant; requiere
una corrida efímera con el Windows del operador y su captura del portal.

## Bloqueos vigentes

1. La regla UDP/21603 del nodo solo admite `138.97.142.254/32`; el egress
   confirmado del operador el 2026-11-10 09:45 UTC es `190.120.26.242`
   (`../mvpn05-20261110/d5-egress.txt`). Sin actualizar esa regla, el cliente
   Windows no conecta.
2. La corrida de Capa D cerró con `gateway|revoked`
   (`../mvpn05-20261110/server-corroboration.txt`). Hay que enrolar y aprobar un
   gateway nuevo; no se reutiliza el revocado.

## Secuencia prevista

1. Montar el gateway efímero del fixture (`ns-gw-lab`, LAN `10.250.0.0/24`,
   listener TCP/9090, dnsmasq `corp.internal`).
2. Enrolar el gateway (audiencia `gateway`), aprobarlo y esperar
   `observed_state=active` con `applied_revision` igual a la revisión vigente.
3. Comprobar P4 (`ping` por nombre, ≥3/4 `Reply`).
4. Capturar `CompanySummaryPage` del portal mostrando: `device_kind=gateway`,
   `status=approved`, `observed_state=active`, `applied_revision` vigente y
   timestamp.
5. Guardar aquí la captura y la salida JSON equivalente
   (`GET /v1/company/agents?device_kind=gateway` y
   `GET /v1/company/network-profiles`).
6. Solo después, limpiar el fixture con el SQL de limpieza habitual.

## Criterio de cierre

La captura y el JSON deben coincidir en los cuatro campos y en la revisión.
Sin ambos, P9 sigue abierto.
