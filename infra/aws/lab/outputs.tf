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
