# Decisiones de producto y alcance v1

**Fecha:** 6 de noviembre de 2026

**Estado:** aceptadas por el responsable de producto

**Alcance:** dirección comercial, piloto y límites de la primera versión. No autoriza por sí sola despliegues, uso de datos reales ni omitir los gates técnicos y de seguridad vigentes.

## Decisiones aceptadas

### 1. Nexo es un producto SaaS multiempresa

Nexo se desarrollará como producto comercial repetible para las tres empresas actuales y futuros clientes, no como una herramienta interna limitada a los clientes existentes.

Implicaciones:

- El aislamiento, la configuración, la auditoría, la operación y los costos se modelan por `tenant`.
- El piloto no autoriza a prometer alta disponibilidad, aislamiento físico ni niveles de servicio todavía no probados.
- Las tres empresas actuales son candidatas a migración gradual, no excepciones permanentes fuera del producto.

### 2. Aislamiento híbrido por plan

La oferta base acepta aislamiento lógico en infraestructura compartida, con controles por tenant y entornos de red separados. El aislamiento dedicado se ofrecerá como opción de pago independiente.

- **Plan compartido:** puede compartir host y kernel. Un fallo del host puede afectar a varios tenants; este límite debe informarse y aceptarse.
- **Plan dedicado:** infraestructura separada según el diseño aprobado para ese plan. La topología exacta —EC2, VPC o cuenta separada— se definirá y costeará antes de ofrecerlo.
- Ningún plan puede depender sólo de namespaces: API, base de datos, secretos, archivos, procesos, red y auditoría también deben aplicar aislamiento y autorización.

### 3. Cliente existente primero; cliente propio después

La v1 podrá usar un cliente VPN existente aprobado. El cliente universal propio no bloquea el piloto ni la primera migración. Tauri, el servicio Go y la protección con DPAPI/TPM quedan como evolución posterior, condicionada a costo, firma, licencias, plataformas y mantenimiento.

La selección exacta del cliente existente por plataforma sigue sujeta a prueba. No se debe afirmar que AWS VPN Client u OpenVPN Connect cubren una plataforma o flujo hasta verificarlo. Una instalación existente no elimina la exigencia de identidad, revocación, configuración segura y soporte operativo.

### 4. Soporte remoto fuera de v1

La primera versión no incluye soporte remoto integrado. No se construirá un motor propio dentro de este alcance. MeshCentral, RustDesk u otro servicio independiente podrán evaluarse después, sin bloquear VPN ni migración.

La interfaz no debe presentar soporte remoto como capacidad operativa de v1. El código y los spikes existentes se conservan como evidencia técnica, no como compromiso comercial.

### 5. Backup de clientes después de la primera migración

El servicio de backup de datos de clientes queda fuera de v1 y se evaluará después de completar la primera migración real. El orden es:

1. VPN y recorrido de punta a punta.
2. Migración controlada y reversión.
3. Operación estable del piloto.
4. Evaluación separada del producto de backup.

Esta decisión no elimina los backups operativos del plano de control, PostgreSQL, PKI, configuración e infraestructura necesarios para recuperar Nexo.

### 6. Techo de costo y precio inicial

- **Techo mensual inicial de AWS:** USD 100.
- **Precio base por empresa:** desde USD 45 mensuales.
- **Variable comercial principal declarada:** número de sucursales conectadas.
- **Aislamiento dedicado:** se cotiza y cobra aparte.

El precio no constituye todavía una tarifa completa. Antes de facturar se deben definir moneda y tributos, qué incluye la base, tramos o precio por sucursal, tratamiento de usuarios móviles/endpoints sin sucursal, excesos y margen mínimo. Deben configurarse presupuestos y alertas; no se prometerá una topología cuyo costo observado exceda el techo sin nueva aprobación.

### 7. Piloto: Disamed y acceso móvil

La empresa piloto es **Disamed**. Su caso inicial no depende de sucursales: vendedores fuera de la oficina se conectan desde laptop, tablet o smartphone para acceder a recursos privados autorizados.

Vertical slice mínimo:

1. Inventariar plataformas, cantidades, identidad de usuarios, recursos privados y red de retorno.
2. Emitir una invitación o configuración limitada para un usuario piloto.
3. Configurar un cliente VPN existente aprobado en al menos una plataforma prioritaria.
4. Conectar mediante Nexo sin enviar la navegación general a Internet.
5. Acceder únicamente al recurso privado autorizado.
6. Registrar estado, actor y resultado en auditoría.
7. Revocar el acceso y comprobar que deja de funcionar.
8. Probar reversión al servicio OpenVPN anterior antes de ampliar el grupo.

Laptop, tablet y smartphone describen el caso de uso objetivo; no prueban compatibilidad de todas las plataformas. La primera plataforma y el tamaño del grupo piloto se fijarán después del inventario.

### 8. Cancelación: exportación, retención de 30 días y eliminación

Al cancelar, el cliente podrá recibir una exportación utilizable. Los datos operativos se conservarán durante 30 días y después se eliminarán mediante un proceso verificable. La operación de exportación y la eliminación deben dejar evidencia auditable.

La exportación será, en principio, un archivo ZIP con formatos documentados y datos útiles para consulta o futura reactivación: parámetros, configuraciones y demás información portable aprobada. No se incluirán secretos activos, claves privadas ni credenciales reutilizables sin un mecanismo específico y seguro.

Antes de incorporar datos reales deben definirse:

- inventario exacto de datos exportables y formato/versionado;
- momento de inicio del plazo y tratamiento de copias de seguridad;
- responsables y verificación de la eliminación;
- período legal u operativo de conservación de la evidencia de auditoría;
- procedimiento de reactivación, que no implica conservar credenciales vencidas ni garantizar restauración automática.

## Efecto sobre el alcance v1

La v1 queda centrada en SaaS multiempresa, portal y control VPN, cliente VPN existente y migración real de Disamed. Quedan fuera del camino crítico: cliente universal propio, soporte remoto, backup comercial, alta disponibilidad no probada y soporte simultáneo de todas las plataformas.

## Parámetros pendientes, sin reabrir las decisiones

1. Fórmula de precio por sucursal y por usuario/endpoint móvil.
2. Cliente y primera plataforma exactos del piloto Disamed.
3. Tamaño del primer grupo y recurso privado usado para la prueba.
4. Topología y precio del plan dedicado.
5. Esquema y contenido versionado del ZIP de salida.
6. Retención de auditoría posterior a la eliminación de datos operativos.
