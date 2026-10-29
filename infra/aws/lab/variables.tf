variable "account_id" {
  description = "Cuenta dedicada autorizada. Nunca inferir del perfil por defecto."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id debe contener exactamente 12 dígitos."
  }
}

variable "region" {
  description = "Propuesta provisional; confirmar residencia y latencia antes del despliegue."
  type        = string
  default     = "us-east-1"
  nullable    = false
  validation {
    condition     = var.region == "us-east-1"
    error_message = "Este corte solo ha sido diseñado para us-east-1; revisar antes de cambiar región."
  }
}

variable "webmin_admin_cidr" {
  description = "IPv4 /32 aprobado para acceder a Webmin en el laboratorio."
  type        = string
  nullable    = false
  validation {
    condition     = can(cidrnetmask(var.webmin_admin_cidr)) && can(regex("/32$", var.webmin_admin_cidr))
    error_message = "webmin_admin_cidr debe ser un único CIDR IPv4 /32 aprobado."
  }
}

variable "ami_id" {
  description = "AMI Amazon Linux 2023 x86_64 concreta, verificada en la región antes del plan real."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.ami_id))
    error_message = "Proporcionar un ID AMI explícito de 17 caracteres hexadecimales."
  }
}

variable "instance_type" {
  description = "Hipótesis de laboratorio, no dimensionamiento productivo ni garantía de capacidad."
  type        = string
  default     = "t3.small"
  nullable    = false
  validation {
    condition     = contains(["t3.small", "t3.medium"], var.instance_type)
    error_message = "Usar t3.small o t3.medium hasta medir capacidad."
  }
}
