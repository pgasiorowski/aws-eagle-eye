##
# DynamoDB Table
##
resource "aws_dynamodb_table" "argus_vpc_map" {
  name         = "aws-eagle-eye"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "vpc_id"
    type = "S"
  }

  attribute {
    name = "account_id"
    type = "S"
  }

  global_secondary_index {
    name            = "vpc_id_idx"
    hash_key        = "vpc_id"
    projection_type = "ALL"
  }

  global_secondary_index {
    name            = "account_id_idx"
    hash_key        = "account_id"
    projection_type = "ALL"
  }
}

##
# Lambda function for processing VPC Flow Logs
##
data "archive_file" "lambda_zip" {
  type        = "zip"
  output_path = "vpc_flow_processor.zip"
  source_file = "lambda.py"
  output_file_mode = "0666"
}

resource "aws_lambda_function" "vpc_flow_processor" {
  filename         = data.archive_file.lambda_zip.output_path
  function_name    = "eagle-eye-vpc-flow-processor"
  role             = aws_iam_role.lambda_execution_role.arn
  handler          = "lambda.handler"
  runtime          = "python3.11"
  timeout          = 300
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      APPSYNC_API_URL = aws_appsync_graphql_api.eagle_eye_api.uris["GRAPHQL"]
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.lambda_logs,
    aws_cloudwatch_log_group.lambda_logs,
  ]
}

resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/eagle-eye-vpc-flow-processor"
  retention_in_days = 14
}

resource "aws_lambda_permission" "allow_s3_invoke" {
  statement_id  = "AllowExecutionFromS3Bucket"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.vpc_flow_processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.eagle_eye_logs.arn
}

##
# Kinesis Firehose Delivery Stream (S3 destination with Lambda trigger)
##
resource "aws_kinesis_firehose_delivery_stream" "eagle_eye_vpc_logs" {
  name        = "eagle-eye-vpc-flow-logs"
  destination = "extended_s3"

  extended_s3_configuration {
    role_arn            = aws_iam_role.firehose_delivery_role.arn
    bucket_arn          = aws_s3_bucket.eagle_eye_logs.arn
    prefix              = "vpc-flow-logs/year=!{timestamp:yyyy}/month=!{timestamp:MM}/day=!{timestamp:dd}/hour=!{timestamp:HH}/"
    error_output_prefix = "vpc-flow-logs-error/!{firehose:error-output-type}/"

    # Low-latency configuration
    buffering_size     = 1  # 1 MB minimum
    buffering_interval = 15 # 0 seconds minimum

    compression_format = "GZIP"
  }

  tags = {
    LogDeliveryEnabled = "true"
  }
}
