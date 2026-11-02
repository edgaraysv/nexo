# F12 — perfil de carga local básica

## Perfil acordado

La carga se ejecuta solo en loopback con un proceso API local y datos sintéticos.
El tramo de 10 usuarios aprobado es: 1 minuto de calentamiento y 9 minutos
sostenidos. Se usa `GET /v1/company/summary` con una sesión sintética ya
autenticada y repositorios en memoria; el think-time fijo es 100 ms por usuario.

La línea base a 1 usuario usa 15 segundos de calentamiento y 60 segundos de
medición. Criterios de aceptación para el tramo sostenido: error rate ≤1%, p95
≤1 segundo y p95 ≤2× el p95 de la línea base. Parada temprana: cinco respuestas
5xx consecutivas o error rate >1% una vez observadas al menos 100 solicitudes.

## Límites

Este perfil no prueba PostgreSQL, SMTP, AWS, Windows, OpenVPN/dataplane, red
externa, recuperación ni capacidad productiva. No autoriza producción ni F13.
El script es `scripts/f12-load.mjs`; se ejecuta con `npm run test:f12-load`.

## Resultado

Ejecución local del 2026-11-01: **PASS**. No se activó ninguna condición de
parada.

| Fase | Usuarios | Calentamiento | Medición | Solicitudes | Errores | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 1 | 15 s | 60 s | 575 | 0 (0%) | 7,03 ms |
| Sostenida | 10 | 60 s | 540 s | 52 687 | 0 (0%) | 4,32 ms |

La fase sostenida cumplió p95 ≤1 s y ≤2× baseline (límite relativo: 14,06 ms;
observado: 4,32 ms, 0,61× baseline), además de error rate ≤1%. Las diez VU
compartieron una sesión sintética; el resultado solo caracteriza este recorrido
local sobre repositorios en memoria. No se envía tráfico a AWS ni a proveedores
externos y no se infiere capacidad productiva.
