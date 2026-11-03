# F13-A v2 — A0 Prerrequisitos

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local revisada:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **EC2:** `i-006cda6fdc86af7a5`, `us-east-1`, IP revalidada `3.226.252.132`

## Evidencia de solo lectura

- EC2 continúa `running`.
- SSM command `e3e4105c-7ef2-473e-a290-a5eb24024024` terminó `Success`:
  - `nexo-node-agent.service`: unidad `loaded`, estado `inactive`, habilitación `disabled`.
  - `/var/lib/nexo-node/identity/state.json`: **ausente**.
  - `/usr/local/lib/nexo/nexo-agent`: binario presente.
  - `net.ipv4.ip_forward = 0`.
  - Una consulta `count(*)` bajo el rol `nexo_runtime` devolvió `0`; por RLS no se toma ese resultado como inventario global de entornos.
- El unit file local `infra/aws/lab/nexo-node-agent.service` declara `ConditionPathExists=/var/lib/nexo-node/identity/state.json`. Sin esa identidad systemd no iniciará el reconciliador. Si arrancara con identidad válida, el servicio opera como root con `CAP_NET_ADMIN`/`CAP_SYS_ADMIN` y reconcilia estado VPN persistido.
- `docs/f06/evidence.md` registra que la identidad ficticia fue eliminada y la unidad deshabilitada al terminar la campaña anterior. El plan F06 exige respaldo/retorno, identidad de nodo, preparación de fixtures y revisión del runner antes de la aceptación mutante.

## Decisión de seguridad

- No se intentó iniciar la unidad: falta su precondición de identidad y no se obtuvo una sesión autenticada para comprobar el nodo o los entornos que pudiera reconciliar.
- No se cambió `ip_forward`. El valor correcto sería `1`, pero el `=1d` del prompt es inválido; además, cambiar forwarding es una modificación global de red y el plan F06 lo ubica después de backup, despliegue, identidad y autorización separada. No se aplicó el cambio sin esas precondiciones.
- No se creó ni enroló una identidad de nodo; el usuario pidió arrancar el servicio, no se inventó un token/invitación ni una nueva identidad.

## Bloqueantes y acción recomendada

1. **Identidad de nodo ausente:** registrar y aprobar una identidad sintética por el flujo autorizado; validar que su `state.json` corresponde al nodo aprobado antes de arrancar el servicio.
2. **Forwarding deshabilitado:** después de verificar identidad, backup/retorno y autorización del cambio global, habilitarlo con el valor correcto y documentar/restaurar según el plan aprobado.
3. **Gate F06 sigue abierto:** completar fixtures y cleanup reanudable y revisar el runner mutante antes de iniciar aceptación.
4. **Autenticación:** dos intentos de login respondieron HTTP 401 (el segundo reportó `unauthorized`). Se alcanzó la regla de detención de v2; no se realizaron más intentos ni acciones autenticadas.
