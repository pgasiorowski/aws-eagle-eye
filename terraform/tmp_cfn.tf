##
# Temporary CloudFormation role for Log Delivery Service
# This role allows the Log Delivery Service to assume the cross-account role
##
resource "aws_iam_role" "log_delivery_service_role" {
  name = "LogDeliveryServiceRole-eagle-eye-temp"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "delivery.logs.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "log_delivery_service_policy" {
  name = "LogDeliveryServicePolicy-eagle-eye-temp"
  role = aws_iam_role.log_delivery_service_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "sts:AssumeRole"
        ]
        Resource = aws_iam_role.vpc_flow_logs_cross_account_role.arn
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogDelivery",
          "logs:GetLogDelivery",
          "logs:UpdateLogDelivery",
          "logs:DeleteLogDelivery",
          "logs:ListLogDeliveries",
          "logs:PutResourcePolicy",
          "logs:DescribeResourcePolicies",
          "logs:DescribeLogGroups"
        ]
        Resource = "*"
      }
    ]
  })
}

##
# Output the temporary role ARN for CloudFormation usage
##
output "log_delivery_service_role_arn" {
  description = "ARN of the temporary Log Delivery Service role for CloudFormation"
  value       = aws_iam_role.log_delivery_service_role.arn
}
