output "firehose_delivery_stream_arn" {
  description = "ARN of the Kinesis Firehose delivery stream"
  value       = aws_kinesis_firehose_delivery_stream.eagle_eye_vpc_logs.arn
}

output "cross_account_role_arn" {
  description = "ARN of the cross-account IAM role for VPC Flow Logs"
  value       = aws_iam_role.vpc_flow_logs_cross_account_role.arn
}
output "appsync_api_url" {
  description = "AppSync GraphQL API URL"
  value       = aws_appsync_graphql_api.eagle_eye_api.uris["GRAPHQL"]
}

output "appsync_api_key" {
  description = "AppSync API Key"
  value       = aws_appsync_api_key.eagle_eye_api_key.key
  sensitive   = true
}

output "appsync_api_id" {
  description = "AppSync API ID"
  value       = aws_appsync_graphql_api.eagle_eye_api.id
}

output "parameter_store_key_name" {
  description = "Parameter Store key name for AppSync API key"
  value       = aws_ssm_parameter.appsync_api_key.name
}