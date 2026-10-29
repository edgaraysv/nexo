# D07 — metas y custodia del cierre local

Estado: **aceptada por el usuario para L08 el 23 de octubre de 2026**.

## Decisión

- El corte demuestra **recuperación de volumen** en un destino PostgreSQL nuevo y aislado; no demuestra pérdida total del equipo.
- El RPO local es el punto exacto del snapshot. No hay PITR/WAL continuo ni se promete una ventana temporal de pérdida.
- Objetivo de aceptación: restaurar los fixtures locales completos en **10 minutos o menos** en esta estación. Es una medición reproducible, no un SLA ni una proyección productiva.
- Perfil de carga: fixture funcional mínimo de dos empresas, dos usuarios, una identidad endpoint y las seis migraciones vigentes. No es un benchmark de capacidad ni autoriza extrapolar throughput o volumen productivo.
- El archivo cifrado se separa de las claves de cifrado y del checkpoint de seguridad. En este corte siguen en el mismo equipo y, por tanto, comparten dominio de fallo físico.
- El checkpoint autenticado posterior al backup es la fuente local para revocaciones y brechas conocidas. Si falta, es inválido o no es fresco, el control restaurado permanece en cuarentena.
- La restauración siempre usa un destino nuevo; no sobrescribe el origen ni reabre sesiones, credenciales u operaciones antiguas.

## Límites

- Pérdida total del host, medio externo, custodia por varias personas, WORM, PITR, alta disponibilidad y recuperación regional: **NOT RUN**.
- La meta de 10 minutos solo aplica a fixtures y herramientas observadas en el ensayo local.
- Perder todas las generaciones de claves hace el backup irrecuperable; no existe bypass ni clave embebida en el archivo.
