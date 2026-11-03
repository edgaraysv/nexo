# Gate S3 — Reporte de cierre (v3)

**Fecha:** 2026-11-03  
**Instancia AWS:** i-006cda6fdc86af7a5  
**Resultado:** **PASS**

## Criterios y resultados

| Historia | Descripción | Resultado |
|----------|-------------|-----------|
| A0 | Prerrequisitos: ip_forward=1, nexo-node-agent=active | PASS |
| A1 | Enrolamiento dispositivo: invitación → start (201) → prove (202) → resource_grants → approve (204) → claim cert → device auth | PASS |
| A2 | Dos VPN environments activos (Alpha + Beta) con nodo único | PASS (verificado en FASE 1) |
| A3 | WireGuard peer: register → provider preview/confirm → reconciliación → wg show → revoke | PASS |
| A4 | Partial failure: suspend Alpha → Beta unaffected → restore Alpha → active | PASS |
| A5 | Cleanup completo: device revoked, sessions deleted | PASS |

## Incidencias encontradas y resueltas en sesión

### I1 — `resource_grants` sin privilegios para `nexo_runtime`
- **Síntoma:** `POST /v1/company/resource-grants` devolvía HTTP 500 `internal_error`
- **Causa:** `nexo-runtime.sql` listan `resource_grants` en los GRANT, pero en esta instancia EC2 el script fue ejecutado antes de que migration 019 crease la tabla, o migration 019 se ejecutó después del script de runtime. Resultado: `SELECT/INSERT/UPDATE` faltantes para `nexo_runtime`.
- **Verificación:** `SELECT has_table_privilege('nexo_runtime','resource_grants','INSERT')` → `f`; `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee='nexo_runtime' AND table_name='resource_grants'` → 0 filas.
- **Solución:** `GRANT SELECT, INSERT, UPDATE ON TABLE resource_grants TO nexo_runtime` via SSM/psql superuser.
- **Defecto de infraestructura:** migration 019 debería incluir los GRANTs de runtime (como hace migration 022 para WireGuard).

### I2 — `quota_counters.used` no decrementado al eliminar dispositivos vía SQL directo
- **Síntoma:** enrollment start devolvía 409 (`invitation_or_quota_unavailable`) aunque no había dispositivos activos.
- **Causa:** `revoke()` en el repo device sí decrementa el contador, pero `DELETE FROM device_identities` directo no lo hace. Las corridas fallidas previas acumularon `used=5 (== limit_value=5)`.
- **Solución:** `UPDATE quota_counters SET used=0` y `DELETE FROM device_identities` para limpiar dispositivos pendientes.
- **Defecto de infraestructura:** las corridas de prueba deben limpiar siempre vía API (revoke) para mantener consistencia en `quota_counters`.

### I3 — `desired_state` devuelto en camelCase (`desiredState`) no snake_case
- **Síntoma:** A4 fallaba con `field_missing:.desired_state`
- **Causa:** `PUT /v1/provider/vpn-environments/:id/state` devuelve `VpnEnvironmentView` serializado directamente con los keys de TypeScript (camelCase). El script usaba `.desired_state`.
- **Solución:** corregir a `.desiredState` en el script.

## Estado de defecto de producción: migration 019

Migration 019 crea `resource_grants` pero **no aplica los GRANTs de runtime**. En contraste, migration 022 incluye explícitamente:
```sql
EXECUTE 'GRANT SELECT, INSERT ON TABLE ... TO nexo_runtime';
```

**Acción recomendada:** Añadir a migration 019 (o a una nueva migration de parche) los GRANTs equivalentes:
```sql
GRANT SELECT, INSERT, UPDATE ON TABLE resource_grants TO nexo_runtime;
```

Esto evita que cualquier deploy futuro en entorno limpio reproduzca el bug.
