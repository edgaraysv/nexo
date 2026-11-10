data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "node" {
  owners = ["amazon"]
  filter {
    name   = "image-id"
    values = [var.ami_id]
  }
  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-kernel-6.1-x86_64"]
  }
  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  name                     = "nexo-lab-${var.account_id}-${var.region}"
  openvpn_client_cidr      = var.operator_egress_cidr
  openvpn_tunnel_ipv4_cidr = "10.247.43.0/24"
  openvpn_listener_port    = 21603
}

resource "aws_vpc" "lab" {
  cidr_block           = "10.240.0.0/20"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_subnet" "node" {
  vpc_id                  = aws_vpc.lab.id
  cidr_block              = "10.240.0.0/24"
  availability_zone       = sort(data.aws_availability_zones.available.names)[0]
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-node" }
}

resource "aws_internet_gateway" "lab" {
  vpc_id = aws_vpc.lab.id
}

resource "aws_route_table" "node" {
  vpc_id = aws_vpc.lab.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.lab.id
  }
}

resource "aws_route_table_association" "node" {
  subnet_id      = aws_subnet.node.id
  route_table_id = aws_route_table.node.id
}

resource "aws_security_group" "node" {
  name        = "${local.name}-node"
  description = "Sin entrada. No habilita API, SSH, VPN ni administracion remota."
  vpc_id      = aws_vpc.lab.id
  # Las reglas dedicadas de ingreso/egreso se declaran como recursos separados.

  tags = { Name = "NEXO" }
}

resource "aws_security_group" "web" {
  name        = "nexo-lab-f09-web-20261029"
  description = "Nexo lab F09 HTTPS ingress; temporary HTTP-01 and public TLS only"
  vpc_id      = aws_vpc.lab.id

  # Preservar ownership y fase existentes del grupo web de F09.
  tags = {
    ManagedBy   = "OpenCode"
    Project     = "NEXO"
    Environment = "lab"
    Phase       = "F09"
  }
}

resource "aws_vpc_security_group_ingress_rule" "webmin" {
  security_group_id = aws_security_group.node.id
  description       = "Webmin"
  cidr_ipv4         = var.webmin_admin_cidr
  ip_protocol       = "tcp"
  from_port         = 10000
  to_port           = 10000
}

resource "aws_vpc_security_group_ingress_rule" "openvpn_listener" {
  security_group_id = aws_security_group.node.id
  description       = "OpenVPN M-VPN-04 UDP/21603 desde el egress Windows confirmado"
  cidr_ipv4         = local.openvpn_client_cidr
  ip_protocol       = "udp"
  from_port         = local.openvpn_listener_port
  to_port           = local.openvpn_listener_port
}

resource "aws_vpc_security_group_ingress_rule" "openvpn_icmp" {
  security_group_id = aws_security_group.node.id
  description       = "ICMP desde el pool privado OpenVPN M-VPN-04"
  cidr_ipv4         = local.openvpn_tunnel_ipv4_cidr
  ip_protocol       = "icmp"
  from_port         = -1
  to_port           = -1
}

resource "aws_vpc_security_group_ingress_rule" "web_http" {
  security_group_id = aws_security_group.web.id
  description       = "ACME HTTP-01 and HTTP to HTTPS redirect"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
}

resource "aws_vpc_security_group_ingress_rule" "web_https" {
  security_group_id = aws_security_group.web.id
  description       = "Nexo lab HTTPS"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "https" {
  security_group_id = aws_security_group.node.id
  description       = "HTTPS del host para actualizaciones; no es salida de clientes VPN."
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "zeptomail_smtp" {
  security_group_id = aws_security_group.node.id
  description       = "Nexo transactional SMTP STARTTLS ZeptoMail"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 587
  to_port           = 587
}

resource "aws_instance" "node" {
  ami                         = data.aws_ami.node.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.node.id
  vpc_security_group_ids      = [aws_security_group.node.id, aws_security_group.web.id]
  associate_public_ip_address = true
  # Sin key_pair, perfil IAM, secretos, provisioner ni user_data.
  # IMDSv2 está habilitado y es obligatorio; conservar el hop limit observado en AWS.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
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
  lifecycle {
    precondition {
      condition     = data.aws_caller_identity.current.account_id == var.account_id
      error_message = "Identidad AWS distinta de la cuenta expresamente autorizada."
    }
  }
  tags = { Name = "${local.name}-node" }
}
