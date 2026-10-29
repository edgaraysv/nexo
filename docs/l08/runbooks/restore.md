# Runbook local — restore y reconciliación

1. Crear un PostgreSQL **nuevo y aislado**; nunca restaurar encima del origen.
2. Verificar disponibilidad de la generación de clave y autenticar el bundle antes de escribir SQL, configuración o material de emisión.
3. Restaurar base, roles mínimos y archivos con permisos restrictivos. Validar esquema, integridad, RLS y separación de tenant.
4. Verificar el checkpoint HMAC desde custodia separada y exigir una época no inferior a la esperada.
5. Mantener `quarantined=true`; reaplicar revocaciones conocidas, revocar sesiones y registrar operaciones posteriores ausentes como brechas, sin inventar contenido o resultados.
6. Ejecutar regresión completa. La salida de cuarentena requiere revisión explícita de membresías, credenciales, revocaciones y brechas.

Clave ausente/incorrecta, bundle alterado, checkpoint inválido/obsoleto o pérdida total de custodia detienen el restore. No existe fallback sin cifrado.
