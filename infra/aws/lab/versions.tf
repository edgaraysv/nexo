terraform {
  required_version = "= 1.13.2"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.69.0"
    }
  }
  # Estado local provisional, ignorado por Git. No crear backend remoto sin permiso.
  backend "local" {}
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags {
    tags = {
      Project     = "NEXO"
      Environment = "lab"
      ManagedBy   = "OpenTofu"
      Phase       = "F02"
    }
  }
}
