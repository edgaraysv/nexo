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
  mock_data "aws_iam_policy_document" {
    # Syntax-only fallback for negative plans; secure_lab_plan uses the
    # purpose-specific policy overrides below. This fixture is never applied.
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PlanOnlyMock\",\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"AWS\":\"arn:aws:iam::123456789012:root\"},\"Resource\":\"*\"}]}"
    }
  }
}

variables {
  account_id        = "123456789012"
  ami_id            = "ami-0123456789abcdef0"
  webmin_admin_cidr = "203.0.113.10/32"
}

run "secure_lab_plan" {
  command = plan
  # The mocked provider cannot synthesize aws_iam_policy_document.json. Use
  # valid, purpose-specific fixtures while testing the rest of the plan.
  override_data {
    target = data.aws_iam_policy_document.agent_release_signer_trust
    values = {
      json = <<-JSON
      {"Version":"2012-10-17","Statement":[{"Sid":"AllowCurrentLabOperatorToAssumeSignerRole","Effect":"Allow","Action":"sts:AssumeRole","Principal":{"AWS":"arn:aws:iam::123456789012:user/nexo-test-operator"}}]}
      JSON
    }
  }
  override_data {
    target = data.aws_iam_policy_document.agent_release_signing_key
    values = {
      json = <<-JSON
      {"Version":"2012-10-17","Statement":[{"Sid":"AccountRootKeyAdministrationWithoutSigning","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:root"},"Action":["kms:CancelKeyDeletion","kms:CreateAlias","kms:DeleteAlias","kms:DescribeKey","kms:DisableKey","kms:EnableKey","kms:GetKeyPolicy","kms:GetPublicKey","kms:GetKeyRotationStatus","kms:ListResourceTags","kms:PutKeyPolicy","kms:ScheduleKeyDeletion","kms:TagResource","kms:UntagResource","kms:UpdateAlias","kms:UpdateKeyDescription"],"Resource":"*"},{"Sid":"SignerRoleEd25519SignAndVerifyOnly","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::123456789012:role/nexo-lab-signer"},"Action":["kms:Sign","kms:Verify"],"Resource":"*","Condition":{"StringEquals":{"kms:SigningAlgorithm":"ED25519_SHA_512"}}}]}
      JSON
    }
  }
  override_data {
    target = data.aws_iam_policy_document.agent_release_signer_permissions
    values = {
      json = <<-JSON
      {"Version":"2012-10-17","Statement":[{"Sid":"SignAndVerifyOnlyWithLabReleaseKey","Effect":"Allow","Action":["kms:Sign","kms:Verify"],"Resource":"arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111","Condition":{"StringEquals":{"kms:SigningAlgorithm":"ED25519_SHA_512"}}}]}
      JSON
    }
  }
  assert {
    condition     = aws_instance.node.root_block_device[0].encrypted && aws_instance.node.metadata_options[0].http_endpoint == "enabled" && aws_instance.node.metadata_options[0].http_tokens == "required" && aws_instance.node.metadata_options[0].http_put_response_hop_limit == 2
    error_message = "Disco cifrado e IMDSv2 son obligatorios y el hop limit debe ser 2 (valor observado en AWS que se conserva para no recrear la instancia)."
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
  expect_failures = [aws_instance.node, aws_instance.gateway_a, aws_instance.gateway_b]
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
