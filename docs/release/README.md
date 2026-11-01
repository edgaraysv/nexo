# Artefactos de baseline

El workflow `Nexo baseline` valida TypeScript/Node, PostgreSQL y migraciones, Go, Windows/Tauri y Terraform. Para tags `v*`, genera un archivo fuente, agente Windows, instalador NSIS, SBOM CycloneDX, `manifest.json` y `SHA256SUMS`.

El manifiesto vincula cada artefacto al commit etiquetado y guarda su tamaño y SHA-256. GitHub Actions crea attestations de procedencia Sigstore para los archivos listados y para `SHA256SUMS`; se publican como artefactos del run de Actions, no como una GitHub Release. La firma es **provenance**, no firma Authenticode del ejecutable/instalador ni una aprobación para producción. La verificación de attestations requiere que el repositorio GitHub tenga habilitada esa función.

El SBOM enumera componentes detectables en los archivos de lock/build; no es una revisión legal de licencias ni una certificación de seguridad. La baseline y sus artefactos siguen siendo de laboratorio: el plan maestro mantiene bloqueado el uso con clientes/datos reales hasta cerrar sus gates.

El commit `9665e03` de `master` se publicó en `origin/master`; ese push no publicó un tag `v*` ni generó attestations de release. Estas solo existirán cuando el workflow se ejecute en GitHub sobre un tag publicado y bajo una configuración que permita attestations.
