# Todas las ejecuciones son planes con provider simulado. Nunca apply.
mock_provider "aws" {
  # Los atributos calculados aleatorios no son ARN validos para el schema AWS.
  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111"
      key_id = "11111111-1111-4111-8111-111111111111"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = { arn = "arn:aws:logs:us-east-1:123456789012:log-group:/nexo/lab/vpc-flow" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/nexo-lab-fixture-only" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::nexo-lab-123456789012-us-east-1-control" }
  }
  mock_resource "aws_instance" {
    # AWS representa como strings vacios estos campos Optional+Computed ausentes.
    # Una asignacion explicita en la configuracion prevalece sobre estos defaults.
    defaults = {
      arn                  = "arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0"
      iam_instance_profile = ""
      key_name             = ""
    }
  }
  mock_resource "aws_security_group" {
    defaults = { ingress = [], egress = [] }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-east-1a", "us-east-1b"] }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0" }
  }
}

variables {
  account_id        = "123456789012"
  ami_id            = "ami-0123456789abcdef0"
  webmin_admin_cidr = "203.0.113.10/32"
}

run "secure_lab_plan" {
  command = plan
  assert {
    condition     = aws_instance.node.root_block_device[0].encrypted && aws_instance.node.metadata_options[0].http_endpoint == "enabled" && aws_instance.node.metadata_options[0].http_tokens == "required" && aws_instance.node.metadata_options[0].http_put_response_hop_limit == 1
    error_message = "Disco cifrado, IMDSv2 y hop limit 1 son obligatorios en esta declaración de laboratorio."
  }
  assert {
    condition     = aws_vpc.lab.cidr_block == "10.240.0.0/20" && !aws_subnet.node.map_public_ip_on_launch
    error_message = "Red propia, no default ni infraestructura anterior."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.control.block_public_acls && aws_s3_bucket_public_access_block.control.block_public_policy && aws_s3_bucket_public_access_block.control.ignore_public_acls && aws_s3_bucket_public_access_block.control.restrict_public_buckets
    error_message = "Bloquear todo acceso publico al repositorio."
  }
  assert {
    condition     = aws_s3_bucket_versioning.control.versioning_configuration[0].status == "Enabled" && aws_kms_key.control.enable_key_rotation && !aws_s3_bucket.control.force_destroy
    error_message = "Preservar versiones, rotacion y proteccion de datos."
  }
  assert {
    condition     = aws_instance.node.credit_specification[0].cpu_credits == "standard" && one(aws_backup_plan.control.rule).lifecycle[0].delete_after == 14
    error_message = "No habilitar creditos unlimited ni retencion implicita."
  }
  assert {
    condition     = aws_vpc_security_group_egress_rule.https.ip_protocol == "tcp" && aws_vpc_security_group_egress_rule.https.from_port == 443 && aws_vpc_security_group_egress_rule.https.to_port == 443
    error_message = "La unica salida declarada del host es HTTPS, no trafico de clientes VPN."
  }
  assert {
    condition     = aws_flow_log.lab.traffic_type == "ALL" && aws_cloudwatch_log_group.network.retention_in_days == 14
    error_message = "Declarar logs de red con retencion acotada."
  }
}

run "reject_account_format" {
  command = plan
  variables { account_id = "not-an-account" }
  expect_failures = [var.account_id]
}

run "reject_wrong_identity" {
  command = plan
  variables { account_id = "999999999999" }
  expect_failures = [aws_instance.node]
}

run "reject_region" {
  command = plan
  variables { region = "eu-west-1" }
  expect_failures = [var.region]
}

run "reject_ami" {
  command = plan
  variables { ami_id = "latest" }
  expect_failures = [var.ami_id]
}

run "reject_unreviewed_capacity" {
  command = plan
  variables { instance_type = "m7i.48xlarge" }
  expect_failures = [var.instance_type]
}
