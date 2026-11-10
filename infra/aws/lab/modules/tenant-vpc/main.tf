# VPC aislada por tenant para el lab multitenant de M-VPN-05.
# No peering, no rutas compartidas: A y B solo se alcanzan por el tunel OpenVPN del nodo.

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge({ Name = var.name }, var.tags)
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.public_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false
  tags                    = merge({ Name = "${var.name}-wan" }, var.tags)
}

resource "aws_subnet" "lan" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = var.lan_cidr
  availability_zone       = var.availability_zone
  map_public_ip_on_launch = false
  tags                    = merge({ Name = "${var.name}-lan" }, var.tags)
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge({ Name = var.name }, var.tags)
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge({ Name = "${var.name}-wan" }, var.tags)
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Tabla de la LAN: la ruta por defecto la anade el modulo raiz, apuntando a la ENI
# del gateway del mismo tenant. Aqui solo se declara la tabla y su asociacion.
resource "aws_route_table" "lan" {
  vpc_id = aws_vpc.this.id
  tags   = merge({ Name = "${var.name}-lan" }, var.tags)
}

resource "aws_route_table_association" "lan" {
  subnet_id      = aws_subnet.lan.id
  route_table_id = aws_route_table.lan.id
}

# Gateway: sin ingreso desde Internet. Solo recibe trafico de su propia LAN y
# salida completa (OpenVPN al nodo, HTTPS de SSM, DNS).
resource "aws_security_group" "gateway" {
  name        = "${var.name}-gateway"
  description = "Gateway de sucursal: sin ingreso publico, solo LAN propia"
  vpc_id      = aws_vpc.this.id
  tags        = merge({ Name = "${var.name}-gateway" }, var.tags)
}

resource "aws_vpc_security_group_ingress_rule" "gateway_from_lan" {
  security_group_id = aws_security_group.gateway.id
  description       = "Trafico de la LAN del tenant hacia su gateway (retorno SNAT)"
  cidr_ipv4         = var.lan_cidr
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "gateway_all" {
  security_group_id = aws_security_group.gateway.id
  description       = "OpenVPN al nodo, HTTPS de SSM y DNS; no expone ingreso"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# Host LAN: solo habla con su gateway. El unico servicio publicado es TCP/9090
# y solo se acepta desde la IP del gateway (tras el SNAT) o desde el pool del tunel.
resource "aws_security_group" "lan_host" {
  name        = "${var.name}-lan-host"
  description = "Host LAN: listener 9090 alcanzable solo por gateway y pool VPN"
  vpc_id      = aws_vpc.this.id
  tags        = merge({ Name = "${var.name}-lan-host" }, var.tags)
}

resource "aws_vpc_security_group_ingress_rule" "lan_host_9090" {
  security_group_id = aws_security_group.lan_host.id
  description       = "Listener del recurso privado desde el gateway del tenant"
  cidr_ipv4         = "${var.gateway_private_ip}/32"
  ip_protocol       = "tcp"
  from_port         = 9090
  to_port           = 9090
}

resource "aws_vpc_security_group_ingress_rule" "lan_host_icmp_vpn_pool" {
  security_group_id = aws_security_group.lan_host.id
  description       = "Sonda ICMP desde el pool del tunel (sin SNAT en el camino de ida)"
  cidr_ipv4         = var.vpn_pool_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_egress_rule" "lan_host_all" {
  security_group_id = aws_security_group.lan_host.id
  description       = "Retorno al gateway y HTTPS de SSM"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
