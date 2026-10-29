# Runbook local — incidente

1. Aislar el componente afectado: pausar despacho, bloquear enrollment o mantener el control restaurado en cuarentena según el incidente.
2. Preservar timestamps, IDs opacos, época, versión y resultado; no copiar contraseñas, claves, tokens, certificados privados ni payloads completos a logs.
3. Revocar sesiones/credenciales comprometidas y elevar la época cuando corresponda. No restaurar una credencial retirada para recuperar disponibilidad.
4. Comparar el último snapshot con el checkpoint autenticado y registrar brechas posteriores conocidas.
5. Recuperar en destino nuevo, ejecutar pruebas de aislamiento y documentar qué información no pudo reconstruirse.
6. Retirar fixtures, usuarios, servicios y contenedores temporales; conservar solo reportes saneados autorizados.

Un administrador local o pérdida total del host supera las garantías del corte local y requiere el procedimiento productivo aún no definido.
