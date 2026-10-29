resource "aws_cloudwatch_log_group" "network" {
  name              = "/nexo/lab/vpc-flow"
  retention_in_days = 14
}

resource "aws_iam_role" "flow_logs" {
  name = "${local.name}-flow-logs"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "vpc-flow-logs.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:ec2:${var.region}:${var.account_id}:vpc-flow-log/*" }
      }
    }]
  })
}

resource "aws_iam_role_policy" "flow_logs" {
  role = aws_iam_role.flow_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
        Resource = [aws_cloudwatch_log_group.network.arn, "${aws_cloudwatch_log_group.network.arn}:*"]
      },
      {
        # Esta API de inventario no admite limitar por ARN de log group.
        Effect   = "Allow"
        Action   = "logs:DescribeLogGroups"
        Resource = "*"
      }
    ]
  })
}

resource "aws_flow_log" "lab" {
  vpc_id               = aws_vpc.lab.id
  traffic_type         = "ALL"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.network.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
  depends_on           = [aws_iam_role_policy.flow_logs]
}
