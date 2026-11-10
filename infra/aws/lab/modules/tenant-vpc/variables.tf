variable "name" {
  description = "Prefijo de nombres y etiqueta Name de los recursos del tenant."
  type        = string
  nullable    = false
}

variable "cidr_block" {
  description = "CIDR de la VPC. Se repite deliberadamente entre tenant A y B: sin peering no colisionan."
  type        = string
  nullable    = false
}

variable "public_cidr" {
  description = "Subred publica (ENI-WAN del gateway)."
  type        = string
  nullable    = false
}

variable "lan_cidr" {
  description = "Subred de la LAN simulada del tenant (host LAN, sin IP publica)."
  type        = string
  nullable    = false
}

variable "availability_zone" {
  description = "AZ de ambas subredes; debe soportar el tipo de instancia elegido."
  type        = string
  nullable    = false
}

variable "gateway_private_ip" {
  description = "IP privada fija de la ENI del gateway en la subred publica (destino de la ruta LAN y origen del SNAT)."
  type        = string
  nullable    = false
}

variable "vpn_pool_cidr" {
  description = "Pool del entorno OpenVPN del tenant. Se mantiene 10.247.43.0/24 y 10.247.44.0/24."
  type        = string
  nullable    = false
}

variable "tags" {
  description = "Etiquetas adicionales."
  type        = map(string)
  default     = {}
}
