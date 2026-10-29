# Nexo — instrucciones para agentes

## UX/UI y frontend

- Antes de diseñar o modificar una pantalla, leer `Nexo_Instrucciones_UX_UI_Panel_y_Endpoint.md`, en especial sus invariantes de producto y la sección **10.1 Base visual SYSMedia para Nexo**.
- SYSMedia es la marca institucional y Nexo el producto. Aplicar la paleta y tokens de esa sección; no inventar logotipos, colores de marca, fuentes disponibles, capacidades, datos, clientes ni claims.
- No se encontró logo maestro ni archivos de fuentes en el repositorio. Mantener placeholders identificados hasta recibir assets aprobados; no dibujar el logo con CSS ni cargar fuentes externamente sin autorización.
- Los colores funcionales y las fuentes Manrope/Inter están propuestos: verificar contraste, disponibilidad y licencia antes de tratarlos como aprobados para producción. No afirmar conformidad WCAG sin pruebas.
- Preservar prioridades, flujos, permisos server-side y limitaciones de capacidades de Nexo. Una guía visual no autoriza cambios de producto, producción, seguridad, dependencias ni infraestructura.
- Al cambiar un token o patrón base, documentar el cambio en la especificación Nexo y verificar estados, teclado/foco y viewports pertinentes.
