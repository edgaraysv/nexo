# F13-A3 — Rutas VPN split-tunnel

- **Fecha:** 2026-11-02
- **Resultado:** **BLOCKER**
- **Versión local:** `a589aa38888400515e5a66164779cacfe0e33c78`
- **EC2:** `3.226.252.132`

## Evidencia

- En el Windows local, PowerShell encontró `OpenVPN Data Channel Offload` y `OpenVPN Connect DCO Adapter`, ambas **Disconnected**; no encontró rutas IPv4 `10.*` asociadas a adaptadores VPN.
- Las consultas de salida hechas desde el entorno WSL, no desde una sesión VPN activa, devolvieron valores distintos: `ifconfig.me` → `190.120.26.244`; `api.ipify.org` → `138.97.142.254`. Esta discrepancia no permite tomar una IP de salida como resultado estable del cliente.
- No se observó un adaptador NEXO activo ni una ruta de túnel; por ello la condición «con VPN activa» no se cumplió. No se declara PASS aunque las IP observadas no coincidan con la IP EC2.

## Bloqueantes y acción recomendada

1. **Cliente VPN desconectado:** no existe una ruta de túnel activa desde la que comprobar split-tunnel.
2. **Observación de egress no concluyente:** los dos proveedores de IP pública dieron resultados distintos desde WSL y no representan una medición con VPN activa.
3. **Acción recomendada:** después de resolver los gates de autenticación y lab, conectar un endpoint Windows sintético aprobado, capturar rutas activas y repetir las consultas de egress desde ese endpoint con timestamp y resultados concordantes.

## Actualización F13-A v2

- A3 no se repitió: el segundo login respondió HTTP 401 y se aplicó la condición de detención total de v2. La observación anterior de adaptadores OpenVPN desconectados y rutas ausentes sigue siendo el último resultado.
- No hubo cambios de red ni pruebas adicionales.
