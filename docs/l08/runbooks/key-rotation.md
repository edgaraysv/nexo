# Runbook local — rotación de claves

1. Crear una generación nueva con identificador único y 32 bytes aleatorios; nunca derivarla del ID, hostname o contraseña humana.
2. Usarla para snapshots nuevos sin reescribir silenciosamente archivos antiguos.
3. Probar un backup de la generación anterior y uno de la nueva con sus claves correspondientes; comprobar que las claves cruzadas fallan.
4. Mantener el mapa backup → generación bajo permisos mínimos y separado del archivo cifrado.
5. Retirar una generación solo cuando ningún backup retenido la necesite y exista evidencia de restore con las generaciones restantes.
6. Si una clave se compromete, no llamarlo rotación normal: aislar, generar nueva época, reevaluar backups y tratarlo como incidente.

Este corte no implementa HSM, custodia multipartita ni escrow externo.
