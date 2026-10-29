# Evidencia L04

## Resultado

- `npm run verify:l04`: **PASS**, 6/6 pruebas específicas.
- `npm run test:l04-postgres`: **PASS** sobre PostgreSQL `17.6-bookworm` desechable.
- `npm test`: **PASS**, 57/57 pruebas de regresión.
- `npm run typecheck`: **PASS** como parte de `verify:l04`.

## Controles demostrados

- Una sesión proveedor no puede usar el portal empresarial y una sesión tenant no puede usar rutas proveedor.
- Las mutaciones requieren `company.admin`; `company.viewer` y `company.technician` no pueden mutar.
- RLS y el contexto transaccional impiden que Empresa B lea las sedes de Empresa A.
- Se rechazan CIDR públicos, redes privadas solapadas y sedes ajenas al declarar dispositivos.
- La invitación solo puede aceptarla el correo autenticado esperado, una única vez.
- Tras aceptar, la nueva membresía permite seleccionar la empresa invitante sin confiar en un `tenant_id` arbitrario.
- Las políticas rechazan una revisión obsoleta y actualizan el resumen del portal.
- Los contenedores de prueba se eliminan al finalizar incluso ante error.

AWS, producción, correo real, clientes/datos reales, certificados de dispositivo y motor de políticas: **NOT RUN**.
