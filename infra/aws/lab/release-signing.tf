data "aws_iam_policy_document" "agent_release_signer_trust" {
  statement {
    sid     = "AllowCurrentLabOperatorToAssumeSignerRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [data.aws_caller_identity.current.arn]
    }
  }
}

resource "aws_iam_role" "agent_release_signer" {
  name                 = "nexo-lab-signer"
  assume_role_policy   = data.aws_iam_policy_document.agent_release_signer_trust.json
  max_session_duration = 3600

  tags = {
    Name    = "nexo-lab-signer"
    Phase   = "F12"
    Purpose = "AgentReleaseSigning"
  }
}

data "aws_iam_policy_document" "agent_release_signing_key" {
  statement {
    sid    = "AccountRootKeyAdministrationWithoutSigning"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }

    actions = [
      "kms:CancelKeyDeletion",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:DescribeKey",
      "kms:DisableKey",
      "kms:EnableKey",
      "kms:GetKeyPolicy",
      "kms:GetPublicKey",
      "kms:GetKeyRotationStatus",
      "kms:ListResourceTags",
      "kms:PutKeyPolicy",
      "kms:ScheduleKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:UpdateAlias",
      "kms:UpdateKeyDescription",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "SignerRoleEd25519SignAndVerifyOnly"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:role/nexo-lab-signer"]
    }

    actions   = ["kms:Sign", "kms:Verify"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ED25519_SHA_512"]
    }
  }
}

resource "aws_kms_key" "agent_release_signing" {
  description              = "NEXO lab F12 release-signing key; Ed25519 only; not for production"
  customer_master_key_spec = "ECC_NIST_EDWARDS25519"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.agent_release_signing_key.json

  depends_on = [aws_iam_role.agent_release_signer]

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    Name    = "nexo-lab-agent-release-signing"
    Phase   = "F12"
    Purpose = "AgentReleaseSigning"
  }
}

resource "aws_kms_alias" "agent_release_signing" {
  name          = "alias/${local.name}-agent-release-signing"
  target_key_id = aws_kms_key.agent_release_signing.key_id
}

data "aws_iam_policy_document" "agent_release_signer_permissions" {
  statement {
    sid       = "SignAndVerifyOnlyWithLabReleaseKey"
    effect    = "Allow"
    actions   = ["kms:Sign", "kms:Verify"]
    resources = [aws_kms_key.agent_release_signing.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:SigningAlgorithm"
      values   = ["ED25519_SHA_512"]
    }
  }
}

resource "aws_iam_role_policy" "agent_release_signer" {
  name   = "nexo-lab-signer-ed25519-sign-verify"
  role   = aws_iam_role.agent_release_signer.name
  policy = data.aws_iam_policy_document.agent_release_signer_permissions.json
}

output "agent_release_signing_key_arn" {
  description = "Lab-only Ed25519 release-signing KMS key ARN."
  value       = aws_kms_key.agent_release_signing.arn
}

output "agent_release_signing_key_alias" {
  description = "Lab-only Ed25519 release-signing KMS alias."
  value       = aws_kms_alias.agent_release_signing.name
}

output "agent_release_signer_role_arn" {
  description = "Lab-only role allowed to sign and verify with the release KMS key."
  value       = aws_iam_role.agent_release_signer.arn
}
