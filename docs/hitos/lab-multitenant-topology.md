# Lab AWS multitenant — M-VPN-05 (P7 / P9)

Estado: **APLICADO el 2026-11-10** (48 recursos nuevos + 1 regla actualizada).
Sin datos de producto creados en el nodo.

## Resultado del apply

| Salida | Valor |
|---|---|
| `gateway_a_eip` | `54.198.131.185` |
| `gateway_b_eip` | `100.28.58.184` |
| `host_lan_a_private_ip` | `10.250.0.68` |
| `host_lan_b_private_ip` | `10.250.0.68` |
| `endpoint2_private_ip` | `10.240.0.14` |

Instancias: `gateway_a` = `i-0c23589d00439a62d`, `gateway_b` =
`i-08ad5939ce6bd5064`, `host_lan_a` = `i-0ba636b1464179333`, `host_lan_b` =
`i-004d32fd26ed6b83e`, `endpoint2` = `i-0d438d2bb29aafcc9`. VPC-A =
`vpc-088e8230faa9476f3`, VPC-B = `vpc-0bc091a499c6f69c7`, ambas `10.250.0.0/24`,
0 conexiones de peering.

Evidencia: `evidence/mvpn05-lab/apply-20261110.txt`.

**Desviación del brief:** el host LAN quedó en `10.250.0.68`, no `.65`. AWS
reserva las cuatro primeras direcciones de la subred (`.64` red, `.65` router,
`.66` DNS, `.67` futuro), así que `.65` es inválido en `10.250.0.64/26`. El
`apply` lo rechazó y se corrigió antes de completar.

- Cuenta: `423597267645` · Región: `us-east-1` · AZ: `us-east-1a`
- Raíz Terraform: `infra/aws/lab` (estado local existente, sin backend remoto)
- Nodo reutilizado: `i-006cda6fdc86af7a5` (`10.240.0.78`, EIP `44.223.165.66`)
- Commit base del hito: `57a5de6`

## Topología

```
                       Internet
                          |
        +-----------------+------------------+
        |                                    |
  EIP-A (gateway A)                    EIP-B (gateway B)
        |                                    |
  +-----+------------------+          +------+-----------------+
  | VPC-A  10.250.0.0/24   |          | VPC-B  10.250.0.0/24   |
  |                        |          |                        |
  | subred wan             |          | subred wan             |
  | 10.250.0.0/26          |          | 10.250.0.0/26          |
  |   gateway-a .10        |          |   gateway-b .10        |
  |       | default route  |          |       | default route  |
  | subred lan             |          | subred lan             |
  | 10.250.0.64/26         |          | 10.250.0.64/26         |
  |   host-lan-a .65       |          |   host-lan-b .65       |
  |   listener TCP/9090    |          |   listener TCP/9090    |
  +------------------------+          +------------------------+
        \  tunel OpenVPN                    /  tunel OpenVPN
         \  UDP/21603 (Gamma)              /   UDP/21604 (tenant B)
          +--------------+----------------+
                         |
              +----------+----------+
              | Nodo EC2 10.240.0.78|
              |  OpenVPN, API,      |
              |  node-agent, dnsmasq|
              +----------+----------+
                         | subred 10.240.0.0/24
                  endpoint-2 (sin IP publica)
```

- VPC-A y VPC-B comparten CIDR (`10.250.0.0/24`) y **no** tienen peering: solo
  se alcanzan entrando por el túnel del nodo.
- La ruta por defecto de cada LAN apunta a la ENI de su gateway
  (`10.250.0.10`), así que la salida de la LAN pasa por el túnel y la prueba
  mide el camino VPN, no la ruta de la VPC.
- El gateway hace SNAT (`masquerade`) del pool del túnel hacia `10.250.0.0/24`.
- El host LAN no tiene IP pública ni ruta propia a Internet.

## Recursos nuevos

| Tipo | Nombre | Notas |
|---|---|---|
| VPC | `nexo-lab-mt-a`, `nexo-lab-mt-b` | DNS support/hostnames, subredes wan+lan, IGW, tablas |
| ENI | `gateway-a-eni`, `gateway-b-eni` | IP privada fija `10.250.0.10` |
| EIP | `gateway-a-eip`, `gateway-b-eip` | asociadas a la ENI, no a la instancia |
| EC2 | `gateway-a`, `gateway-b` | `t3.nano`, AL2023 `ami-0d6e34c14757a048b` |
| EC2 | `host-lan-a`, `host-lan-b` | `t3.nano`, IP fija `10.250.0.68` |
| EC2 | `endpoint2` | `t3.nano`, VPC del nodo, sin IP pública |
| SG | `endpoint2` | solo egreso |
| Ruta | `lan-a-default`, `lan-b-default` | `0.0.0.0/0` → ENI del gateway |
| Reglas SG del nodo | UDP/21603 desde EIP-A, UDP/21604 desde EIP-B y desde la IP del operador | aditivas, `/32`, nunca `0.0.0.0/0` |

Sin `user_data`, sin par de claves, sin IAM nuevo (perfil `nexo-lab-ssm`
reutilizado), IMDSv2 obligatorio y volumen raíz cifrado.

## Plan de referencia

```
terraform validate   -> Success! The configuration is valid.
terraform plan       -> Plan: 48 to add, 1 to change, 0 to destroy.
terraform apply      -> 48 created; host LAN rechazado por IP reservada
terraform plan (post) -> 2 to add, 0 to change, 0 to destroy
terraform apply      -> 2 created
terraform plan (post) -> No changes. Your infrastructure matches the configuration.
```

El plan base previo (sin este cambio) era «No changes». El único recurso
existente modificado es la regla UDP/21603 del nodo, que pasó de
`138.97.142.254/32` a `190.120.26.242/32` **en el mismo apply autorizado**. No
se destruyó ni reemplazó nada.

Aviso no bloqueante: el provider 6.69 marca `network_interface` como obsoleto en
`aws_instance` a favor de `primary_network_interface`. Se deja como está para no
provocar reemplazos; se migrará en un cambio aparte.

## Comandos de verificación (tras el apply)

```bash
# 1. Datos de salida
terraform output gateway_a_eip
terraform output gateway_b_eip
terraform output host_lan_a_private_ip
terraform output host_lan_b_private_ip
terraform output endpoint2_private_ip

# 2. Sin peering: describe y confirma que no hay conexiones
aws ec2 describe-vpc-peering-connections --filters Name=status-code,Values=active

# 3. Reglas del SG del nodo (solo /32)
aws ec2 describe-security-groups --group-ids sg-0cc6a1e19439c3e89 \
  --query 'SecurityGroups[0].IpPermissions[?FromPort==`21604` || FromPort==`21603`]'

# 4. Estado de las instancias
aws ec2 describe-instances --instance-ids <ids de multitenant_ids> \
  --query 'Reservations[].Instances[].{id:InstanceId,state:State.Name,ip:PrivateIpAddress,eip:PublicIpAddress}'
```

## Harness del gateway (manual, vía SSM, no es producto)

En cada gateway del lab:

```bash
# cliente OpenVPN con la credencial gateway emitida por el nodo
# (audiencia gateway, no endpoint)
systemctl status openvpn-client@tenant-a   # o el nombre que se use

sysctl -w net.ipv4.ip_forward=1            # persistir en /etc/sysctl.d
ip route add 10.247.43.0/24 dev tun0       # pool de Gamma en gateway A
ip route add 10.247.44.0/24 dev tun0       # pool del tenant B en gateway B

nft add table ip nexo-snat
nft add chain ip nexo-snat post { type nat hook postrouting priority srcnat \; }
nft add rule ip nexo-snat post ip saddr 10.247.43.0/24 ip daddr 10.250.0.0/24 masquerade
```

En cada host LAN: `systemctl` con un listener TCP/9090
(`python3 -m http.server 9090` es suficiente para la prueba) y comprobar que
`ip route` muestra la ruta por defecto hacia `10.250.0.10`.

**Límite declarado:** el rol de gateway sigue siendo harness, no un daemon
empaquetado del producto. El `ccd`/`iroute`, el SNAT y el split-DNS del producto
son los que valida la ficha M-VPN-05, no este harness.

## Entorno OpenVPN del tenant B (en el nodo, no en Terraform)

- Puerto UDP `21604` (Gamma usa `21603`)
- Pool `10.247.44.0/24` (Gamma usa `10.247.43.0/24`)
- Regla de SG ya provisionada desde la EIP-B y desde la IP del operador

El entorno, la empresa B, el gateway aprobado y el endpoint B se crean por API
durante la ventana de lab. No se crean datos en este paso.

## Coste estimado

5 × `t3.nano` (~$0.0052/h) + 2 EIP asociadas (gratuitas mientras estén
asociadas) ≈ **$0.63/día** de cómputo si se dejan encendidas; el EBS gp3 de
30 GB por instancia añade ~$0.08/día cada uno. Rango observado: $0.70–1.20/día.

## Hallazgo que bloqueaba P9 (resuelto)

La regla vigente del nodo permitía UDP/21603 solo desde `138.97.142.254/32`, que
era el egress del operador durante la ventana D1–D5. El CGNAT rotó después y la
relectura de las 09:45:43 UTC dio `190.120.26.242`
(`evidence/mvpn05-20261110/d5-egress.txt`). Con autorización del responsable, el
mismo apply actualizó la regla a ese `/32`; `var.operator_egress_cidr` es ahora
la única fuente para el egress del operador.

Además, la corrida de Capa D terminó con `gateway|revoked`, así que P9 necesita
un gateway efímero nuevo; no se puede reutilizar el de esa ventana.

## Siguientes pasos (sin autorizar todavía)

1. Instalar el harness del gateway en `gateway_a` y `gateway_b` por SSM.
2. Crear el entorno OpenVPN del tenant B (UDP/21604, `10.247.44.0/24`) y la
   empresa B por API, durante la ventana de lab.
3. Enrolar `endpoint2` y el endpoint Windows del tenant A.
4. P9 con el gateway efímero (ver `evidence/mvpn05-p9/README.md`).
5. Migrar `network_interface` a `primary_network_interface` en un cambio aparte.

## Incidente 2026-11-10 23:09Z — reglas SG eliminadas y config revertida

- Las cinco instancias se detuvieron (`stopped`) y las dos EIP se conservaron
  asociadas a sus ENI.
- Las tres reglas UDP creadas por este modulo ya **no existen** en el SG del
  nodo. Quedaron solo: UDP/21603 desde `138.97.142.254/32` (descripcion
  «rotado 2026-11-10T22:45Z»), ICMP desde `10.247.43.0/24` y TCP/10000 desde
  `190.5.151.74/32`. Las alteró algo fuera de Terraform, no este apply.
- `infra/aws/lab/multitenant.tf`, `modules/tenant-vpc/` y los cambios en
  `main.tf`/`variables.tf`/`outputs.tf` desaparecieron del arbol de trabajo sin
  commit. Con la configuracion reescrita, `terraform plan` vuelve a proponer
  **3 to add, 1 to change, 0 to destroy**: reponer las tres reglas y alinear el
  `/32` de 21603 con el vigente (`138.97.142.254/32`).
- Sin la configuracion restaurada, un `plan` habria propuesto destruir los 48
  recursos por estar en el estado y no en el codigo. No se aplico nada.
- Restauracion aplicada el 2026-11-10 con autorizacion: **3 to add, 1 to change,
  0 to destroy**. Las seis reglas de ingreso del nodo quedan como se declaran,
  salvo la regla preexistente de Webmin, que otra sesion movio a
  `138.97.142.254/32` con descripcion nueva; el plan quiere devolverla a
  `190.5.151.74/32` y no se toco sin autorizacion.
- Commit local `45ed66b` con `multitenant.tf`, `modules/tenant-vpc/`, los
  ajustes de `main.tf`/`variables.tf`/`outputs.tf` y la guardia F02 acotada.
  Sin push.
