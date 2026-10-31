# F10 — consentimiento para soporte asistido

Estado al 31 de octubre de 2026: **ciclo de consentimiento y motor sintético local implementados; no habilita una sesión remota real.** MeshCentral continúa como candidato de evaluación, no está adoptado ni integrado.

## Invariantes del corte

- Nexo mantiene la autoridad de autorización: membresía activa, permiso `company.support.start`, `resource_grant` F03 vigente para el `device_identity` exacto, endpoint aprobado y entitlement/módulo activo se verifican antes de insertar una solicitud y se revalidan al abrir el transporte.
- Solo se admite `mode: "assisted"`. El soporte desatendido está rechazado por API y sigue sin política aprobada.
- La decisión autenticada del endpoint requiere el nonce vigente de un solo uso; solo se almacena `nonce_hash`. Cada consulta de pendientes entrega un nonce nuevo e invalida el anterior.
- El timeout transiciona en una transacción a `support_consent.status='rejected'` con `decision_origin='timeout'`; no hay aceptación implícita.
- Rechazo, timeout, revocación, grant vencido/revocado, endpoint revocado o módulo deshabilitado cierran el gate.
- `support_sessions` registra `engine_session_id`, proveedor sintético, intentos y estado de terminación. La revocación cierra el gate primero, persiste el outbox y hace un intento de terminación con límite de cinco segundos; fallos quedan pendientes para reconciliación/reintento.
- `POST .../transport-authorization` solo evalúa el gate y responde `transport_started:false`. `POST .../open` requiere un adaptador inyectado; el servidor normal no lo configura y responde `support_transport_disabled`.
- `SyntheticSupportTransport` solo se habilita con opt-in explícito de pruebas. No existe una implementación de transporte real ni integración MeshCentral.
- El origen `endpoint_api` acredita identidad del endpoint, **no una acción humana**. El prompt nativo y su evidencia siguen pendientes; no se habilitan sesiones reales.

## API local

| Método y ruta | Función |
| --- | --- |
| `POST /v1/company/support/sessions` | Solicita soporte asistido para un endpoint aprobado; recibe `device_id`, capacidades permitidas, `mode: "assisted"` y timeout de consentimiento de 1–120 s (60 s por defecto). |
| `GET /v1/company/support/sessions/:id` | Consulta el estado de la solicitud creada por el mismo usuario. |
| `DELETE /v1/company/support/sessions/:id` | Revoca la solicitud/sesión lógica del solicitante. |
| `POST /v1/company/support/sessions/:id/transport-authorization` | Reevalúa gates y consentimiento; no inicia transporte (`transport_started: false`). |
| `POST /v1/company/support/sessions/:id/open` | Abre por el adaptador inyectado; en el servidor normal está deshabilitado. Reintenta fallos definitivos hasta 3 veces, con la misma sesión, consentimiento y clave idempotente. |
| `GET /v1/device/support/sessions/pending` | Lista solicitudes pendientes para la identidad autenticada del endpoint. |
| `POST /v1/device/support/sessions/:id/consent` | Registra `accepted` o `rejected`, vinculado al endpoint y al `consent_nonce` vigente; decisión de una sola vez. |
| `POST /v1/device/support/sessions/:id/revoke` | Revoca el estado lógico usando la identidad del endpoint. |

Capacidades aceptadas actualmente: `screen`, `terminal`, `files` y `clipboard`. Su presencia en el modelo no significa que el transporte o las funciones estén disponibles. Un fallo definitivo de apertura se audita por intento; después de 3 intentos el estado queda `open_failed` y requiere una solicitud/consentimiento nuevos. Si el resultado de `open()` es ambiguo, Nexo consulta la misma clave idempotente; si no logra resolverlo, queda `opening_unknown` y bloquea otra apertura a ciegas.

## Persistencia y perfil

La migración `020_f10_support_consent.sql` permanece inmutable. `021_f10_support_lifecycle.sql` normaliza `session_id`, `operator_id`, `device_id`, `status`, `accepted_at`, `decision_origin` y el nonce hasheado, y añade `engine_session_id`, intentos, RLS y `support_session_outbox`. `f10-local` aplica `001–015 + 017 + 019 + 020 + 021` solo en PostgreSQL desechable y loopback; no debe aplicarse a AWS ni a una base persistente.

## Fuera de alcance y criterios pendientes

1. Implementar y probar un prompt nativo real con aceptación, rechazo, timeout y denegación, demostrando identidad del usuario que responde.
2. Seleccionar e integrar un transporte manteniendo Nexo como autoridad y realizar E2E en un laboratorio efímero.
3. Verificar revocación ≤5 s y ausencia de acciones posteriores al cierre contra el motor seleccionado; la prueba sintética no acredita ese SLA remoto.
4. Definir y aprobar por separado la política de soporte desatendido; no está autorizado en este corte.
5. No usar clientes ni datos reales, no desplegar y no inferir preparación para producción o piloto F13.
