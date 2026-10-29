# L05 — registro e identidad de agentes

Estado: **corte local implementado y verificado**. No equivale a agente productivo ni a servicio Windows instalado.

## Recorrido implementado

1. Un administrador crea una invitación endpoint con expiración y usos limitados.
2. `nexo-agent` genera una clave P-256 local y envía solo la clave pública.
3. API resuelve empresa/sede desde la invitación, reserva cuota atómicamente y entrega un desafío fresco.
4. El agente firma el desafío; replay, clave diferente y audiencia `node` se rechazan.
5. El endpoint queda pendiente y no puede autenticarse hasta aprobación administrativa.
6. `nexo-issuer` emite un X.509 individual de 24 horas; la reclamación es de un solo uso.
7. La autenticación exige el certificado activo exacto y firma fresca; entrega una sesión opaca corta.
8. La renovación conserva el ID y rota el certificado. La revocación corta sesiones y autenticaciones posteriores.

## Componentes

- `product/agent/cmd/nexo-agent`: cliente Go de registro, reclamación, autenticación y renovación.
- `product/agent/cmd/nexo-issuer`: CA local de desarrollo y emisión X.509.
- `product/agent/internal/keystore`: DPAPI en Windows y adaptador `0600` en Linux local.
- `db/migrations/004_l05_device_identity.sql`: invitaciones, identidades, desafíos, certificados y sesiones con RLS.
- `product/api/device-repository.ts` y `postgres-device-repository.ts`.
- Portal `/company`: invitaciones, estado, aprobación y revocación.

## Límites honestos

- El agente se ejecutó realmente en Linux contra API/PostgreSQL y el almacén DPAPI se probó nativamente en Windows. No se instaló todavía como Windows Service.
- Linux `0600` no es garantía anticlón ni almacén de producción.
- La CA es desechable y de desarrollo; no hay CA productiva, HSM, TPM, CRL/OCSP ni mTLS.
- No existe operación sensible offline, VPN, soporte remoto, shell, telemetría ni worker de operaciones en L05.
- El bootstrap de un futuro nodo proveedor tendrá invitaciones, audiencia y credenciales separadas; una invitación endpoint ya se rechaza como `node`.
