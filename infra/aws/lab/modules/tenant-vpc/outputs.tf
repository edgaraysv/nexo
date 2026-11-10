output "vpc_id" {
  value = aws_vpc.this.id
}

output "public_subnet_id" {
  value = aws_subnet.public.id
}

output "lan_subnet_id" {
  value = aws_subnet.lan.id
}

output "lan_route_table_id" {
  value = aws_route_table.lan.id
}

output "gateway_security_group_id" {
  value = aws_security_group.gateway.id
}

output "lan_host_security_group_id" {
  value = aws_security_group.lan_host.id
}
