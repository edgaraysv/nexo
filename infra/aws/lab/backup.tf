resource "aws_kms_key" "control" {
  description             = "NEXO lab: copias del control, no backups comerciales de clientes"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "control" {
  name          = "alias/${local.name}-control"
  target_key_id = aws_kms_key.control.key_id
}

resource "aws_s3_bucket" "control" {
  bucket        = "${local.name}-control"
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "control" {
  bucket                  = aws_s3_bucket.control.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "control" {
  bucket = aws_s3_bucket.control.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "control" {
  bucket = aws_s3_bucket.control.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "control" {
  bucket = aws_s3_bucket.control.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.control.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_policy" "control" {
  bucket = aws_s3_bucket.control.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.control.arn, "${aws_s3_bucket.control.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

resource "aws_backup_vault" "control" {
  name        = "${local.name}-control"
  kms_key_arn = aws_kms_key.control.arn
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "control" {
  name = "${local.name}-control"
  rule {
    rule_name         = "daily-node-snapshot"
    target_vault_name = aws_backup_vault.control.name
    schedule          = "cron(0 3 * * ? *)"
    start_window      = 60
    completion_window = 180
    lifecycle {
      delete_after = 14
    }
  }
}

resource "aws_backup_selection" "node" {
  name         = "node-only"
  plan_id      = aws_backup_plan.control.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_instance.node.arn]
  depends_on   = [aws_iam_role_policy_attachment.backup]
}
