# Lab multitenant de M-VPN-05 (P7/P9).
#
# Solo recursos NUEVOS. No modifica, reemplaza ni recrea el nodo, Gamma, el
# bucket de control ni sus reglas vigentes. Las unicas adiciones sobre recursos
# existentes son reglas de ingreso en el SG del nodo (UDP/21603 desde EIP-A y
# UDP/21604 desde EIP-B y desde el egress del operador), declaradas como
# recursos propios para no reescribir el security group.
#
# Topologia: VPC-A y VPC-B con el mismo CIDR 10.250.0.0/24 y sin peering.
# El host LAN de cada tenant solo alcanza Internet por su gateway (ruta por
# defecto hacia la ENI del gateway), de modo que la prueba mide el tunel.
#
# NOTA: el host LAN usa 10.250.0.68 y no .65 porque AWS reserva .64-.67 en
# 10.250.0.64/26 (red, router, DNS, futuro).

locals {
  mt_az          = sort(data.aws_availability_zones.available.names)[0]
  mt_cidr        = "10.250.0.0/24"
  mt_public_cidr = "10.250.0.0/26"
  mt_lan_cidr    = "10.250.0.64/26"
  mt_gateway_ip  = "10.250.0.10"
  mt_host_ip     = "10.250.0.68"

  mt_gamma_pool    = "10.247.43.0/24"
  mt_tenant_b_pool = "10.247.44.0/24"
  mt_tenant_b_port = 21604
}

# Perfil ya existente en la cuenta; se reutiliza, no se crea IAM nuevo.
data "aws_iam_instance_profile" "ssm" {
  name = "nexo-lab-ssm"
}

module "vpc_a" {
  source = "./modules/tenant-vpc"

  name               = "nexo-lab-mt-a"
  cidr_block         = local.mt_cidr
  public_cidr        = local.mt_public_cidr
  lan_cidr           = local.mt_lan_cidr
  availability_zone  = local.mt_az
  gateway_private_ip = local.mt_gateway_ip
  vpn_pool_cidr      = local.mt_gamma_pool

  tags = { Component = "multitenant-lab", Tenant = "A", Milestone = "M-VPN-05" }
}

module "vpc_b" {
  source = "./modules/tenant-vpc"

  name               = "nexo-lab-mt-b"
  cidr_block         = local.mt_cidr
  public_cidr        = local.mt_public_cidr
  lan_cidr           = local.mt_lan_cidr
  availability_zone  = local.mt_az
  gateway_private_ip = local.mt_gateway_ip
  vpn_pool_cidr      = local.mt_tenant_b_pool

  tags = { Component = "multitenant-lab", Tenant = "B", Milestone = "M-VPN-05" }
}

# --- ENI-WAN de los gateways (IP privada fija) y sus EIP ---

resource "aws_network_interface" "gateway_a" {
  subnet_id       = module.vpc_a.public_subnet_id
  private_ips     = [local.mt_gateway_ip]
  security_groups = [module.vpc_a.gateway_security_group_id]
  tags            = { Name = "nexo-lab-mt-a-gateway-eni", Tenant = "A" }
}

resource "aws_network_interface" "gateway_b" {
  subnet_id       = module.vpc_b.public_subnet_id
  private_ips     = [local.mt_gateway_ip]
  security_groups = [module.vpc_b.gateway_security_group_id]
  tags            = { Name = "nexo-lab-mt-b-gateway-eni", Tenant = "B" }
}

resource "aws_eip" "gateway_a" {
  domain = "vpc"
  tags   = { Name = "nexo-lab-mt-a-gateway-eip", Tenant = "A" }
}

resource "aws_eip" "gateway_b" {
  domain = "vpc"
  tags   = { Name = "nexo-lab-mt-b-gateway-eip", Tenant = "B" }
}

resource "aws_eip_association" "gateway_a" {
  allocation_id        = aws_eip.gateway_a.id
  network_interface_id = aws_network_interface.gateway_a.id
}

resource "aws_eip_association" "gateway_b" {
  allocation_id        = aws_eip.gateway_b.id
  network_interface_id = aws_network_interface.gateway_b.id
}

# --- Ruta por defecto de cada LAN hacia su gateway ---

resource "aws_route" "lan_a_default" {
  route_table_id         = module.vpc_a.lan_route_table_id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_network_interface.gateway_a.id
}

resource "aws_route" "lan_b_default" {
  route_table_id         = module.vpc_b.lan_route_table_id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_network_interface.gateway_b.id
}

# --- Instancias ---

resource "aws_instance" "gateway_a" {
  ami                  = data.aws_ami.node.id
  instance_type        = var.multitenant_instance_type
  key_name             = var.key_name == "" ? null : var.key_name
  iam_instance_profile = data.aws_iam_instance_profile.ssm.name

  network_interface {
    device_index         = 0
    network_interface_id = aws_network_interface.gateway_a.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = "standard"
  }

  # Sin user_data: AL2023 trae el agente SSM; el harness se instala por SSM
  # durante la ventana de lab, no en el arranque.
  tags = { Name = "nexo-lab-mt-a-gateway", Tenant = "A", Role = "gateway-harness" }

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Identidad AWS distinta de la cuenta expresamente autorizada."
    }
  }
}

resource "aws_instance" "gateway_b" {
  ami                  = data.aws_ami.node.id
  instance_type        = var.multitenant_instance_type
  key_name             = var.key_name == "" ? null : var.key_name
  iam_instance_profile = data.aws_iam_instance_profile.ssm.name

  network_interface {
    device_index         = 0
    network_interface_id = aws_network_interface.gateway_b.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "nexo-lab-mt-b-gateway", Tenant = "B", Role = "gateway-harness" }

  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Identidad AWS distinta de la cuenta expresamente autorizada."
    }
  }
}

resource "aws_instance" "host_lan_a" {
  ami                         = data.aws_ami.node.id
  instance_type               = var.multitenant_instance_type
  key_name                    = var.key_name == "" ? null : var.key_name
  subnet_id                   = module.vpc_a.lan_subnet_id
  private_ip                  = local.mt_host_ip
  vpc_security_group_ids      = [module.vpc_a.lan_host_security_group_id]
  associate_public_ip_address = false
  iam_instance_profile        = data.aws_iam_instance_profile.ssm.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "nexo-lab-mt-a-host-lan", Tenant = "A", Role = "lan-resource" }
}

resource "aws_instance" "host_lan_b" {
  ami                         = data.aws_ami.node.id
  instance_type               = var.multitenant_instance_type
  key_name                    = var.key_name == "" ? null : var.key_name
  subnet_id                   = module.vpc_b.lan_subnet_id
  private_ip                  = local.mt_host_ip
  vpc_security_group_ids      = [module.vpc_b.lan_host_security_group_id]
  associate_public_ip_address = false
  iam_instance_profile        = data.aws_iam_instance_profile.ssm.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "nexo-lab-mt-b-host-lan", Tenant = "B", Role = "lan-resource" }
}

# --- Endpoint 2: mismo tenant A, en la VPC del nodo, sin ruta a las LAN ---

resource "aws_security_group" "endpoint2" {
  name        = "nexo-lab-mvpn05-endpoint2"
  description = "Endpoint 2 del lab multitenant: sin ingreso, solo salida"
  vpc_id      = aws_vpc.lab.id
  tags        = { Name = "nexo-lab-mvpn05-endpoint2", Role = "endpoint" }
}

resource "aws_vpc_security_group_egress_rule" "endpoint2_all" {
  security_group_id = aws_security_group.endpoint2.id
  description       = "OpenVPN (UDP al nodo) y HTTPS de SSM"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

resource "aws_instance" "endpoint2" {
  ami                         = data.aws_ami.node.id
  instance_type               = var.multitenant_instance_type
  key_name                    = var.key_name == "" ? null : var.key_name
  subnet_id                   = aws_subnet.node.id
  vpc_security_group_ids      = [aws_security_group.endpoint2.id]
  associate_public_ip_address = false
  iam_instance_profile        = data.aws_iam_instance_profile.ssm.name

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    volume_size           = 30
    delete_on_termination = true
  }

  credit_specification {
    cpu_credits = "standard"
  }

  tags = { Name = "nexo-lab-mvpn05-endpoint2", Tenant = "A", Role = "endpoint" }
}

# --- Reglas nuevas en el SG del nodo (aditivas, no reescriben el grupo) ---

resource "aws_vpc_security_group_ingress_rule" "openvpn_gateway_a" {
  security_group_id = aws_security_group.node.id
  description       = "OpenVPN M-VPN-05 tenant A UDP/21603 desde la EIP del gateway A"
  cidr_ipv4         = "${aws_eip.gateway_a.public_ip}/32"
  ip_protocol       = "udp"
  from_port         = local.openvpn_listener_port
  to_port           = local.openvpn_listener_port
}

resource "aws_vpc_security_group_ingress_rule" "openvpn_tenant_b" {
  security_group_id = aws_security_group.node.id
  description       = "OpenVPN M-VPN-05 tenant B UDP/21604 desde la EIP del gateway B"
  cidr_ipv4         = "${aws_eip.gateway_b.public_ip}/32"
  ip_protocol       = "udp"
  from_port         = local.mt_tenant_b_port
  to_port           = local.mt_tenant_b_port
}

resource "aws_vpc_security_group_ingress_rule" "openvpn_tenant_b_home" {
  security_group_id = aws_security_group.node.id
  description       = "OpenVPN tenant B UDP/21604 desde el egress confirmado del operador"
  cidr_ipv4         = var.operator_egress_cidr
  ip_protocol       = "udp"
  from_port         = local.mt_tenant_b_port
  to_port           = local.mt_tenant_b_port
}
