output "scope" {
  value = {
    environment = "lab"
    account_id  = var.account_id
    region      = var.region
    ami_id      = data.aws_ami.node.id
  }
}

output "node_id" {
  value = aws_instance.node.id
}

output "control_bucket" {
  value = aws_s3_bucket.control.id
}

output "recovery_limits" {
  value = "Snapshots no equivalen a backup consistente de PostgreSQL/PKI. Restore, RPO/RTO y reconstruccion NOT RUN. Sin software NEXO ni acceso administrativo."
}

# --- Lab multitenant M-VPN-05 ---

output "gateway_a_eip" {
  value = aws_eip.gateway_a.public_ip
}

output "gateway_b_eip" {
  value = aws_eip.gateway_b.public_ip
}

output "host_lan_a_private_ip" {
  value = aws_instance.host_lan_a.private_ip
}

output "host_lan_b_private_ip" {
  value = aws_instance.host_lan_b.private_ip
}

output "endpoint2_private_ip" {
  value = aws_instance.endpoint2.private_ip
}

output "multitenant_ids" {
  value = {
    gateway_a   = aws_instance.gateway_a.id
    gateway_b   = aws_instance.gateway_b.id
    host_lan_a  = aws_instance.host_lan_a.id
    host_lan_b  = aws_instance.host_lan_b.id
    endpoint2   = aws_instance.endpoint2.id
    vpc_a       = module.vpc_a.vpc_id
    vpc_b       = module.vpc_b.vpc_id
    vpc_a_cidr  = local.mt_cidr
    vpc_b_cidr  = local.mt_cidr
    no_peering  = true
    gateway_lan = local.mt_gateway_ip
    host_lan_ip = local.mt_host_ip
  }
}
