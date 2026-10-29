# Evidencia L03

## Verificaciones ejecutadas

- `npm run verify:l03`: **PASS**, 6/6 pruebas específicas del contexto proveedor.
- `npm run test:l03-postgres`: **PASS**, migraciones L02/L03, RLS, identidad y recorrido proveedor sobre PostgreSQL `17.6-bookworm` desechable.
- `npm test`: **PASS**, 51/51 pruebas de regresión.
- `npm run check` y `npm run verify:l01`: **PASS**.

## Controles cubiertos

- Sesión tenant no accede a rutas proveedor.
- Propietario crea empresa, plan y suscripción; revisión obsoleta se rechaza.
- Tres reservas concurrentes contra límite dos producen dos éxitos y un rechazo.
- Configuración `secret_ref` solo devuelve estado configurado, nunca la referencia.
- Asignación de operador: solo ve empresas asignadas y no puede autoasignarse.
- La configuración AWS es local y no ejecuta llamadas externas.

AWS, producción y datos/clientes reales: **NOT RUN**.
