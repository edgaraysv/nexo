# L08 — recuperación, endurecimiento y aceptación local

Estado: **corte local implementado y verificado**. No equivale a recuperación productiva, continuidad de negocio ni operación con clientes reales.

## Alcance

- D07 aceptada para recuperación de volumen, RPO en el snapshot y objetivo local de restore ≤10 minutos.
- Bundle autenticado AES-256-GCM con PostgreSQL, configuración, roles mínimos y material de emisión autorizado.
- Generaciones de clave separadas del archivo, checkpoint HMAC posterior al backup y restore obligatorio en destino nuevo.
- Cuarentena, revocaciones posteriores y registro explícito de operaciones ausentes.
- Runbooks locales de instalación, backup, restore, actualización, incidente y rotación.
- Compatibilidad verificada con API/PostgreSQL, agentes Go, servicio/IPC Windows y cliente Tauri.
- El servicio desacopla la lógica continua de la salida CLI; SCM no depende de un `stdout` interactivo para completar enrollment, claim u operaciones.

## Límites

- El archivo, claves y checkpoint permanecen en el mismo equipo: pérdida total del host **NOT RUN**.
- El fixture funcional mínimo no es una prueba de carga productiva ni un SLA.
- AWS, producción, clientes reales, PITR/WAL, HSM, WORM, HA y custodia multipartita permanecen fuera del corte.
- El paquete NSIS fue regenerado con el agente endurecido; Authenticode y distribución productiva permanecen **NOT RUN**.
