##
# Policy for application IAM User/Role
##
resource "aws_iam_policy" "app" {
  name = "aws-eagle-eye-app"
  path = "/"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:Query",
          "dynamodb:Scan"
        ]
        Resource = [
          "${aws_dynamodb_table.vpcs.arn}",
          "${aws_dynamodb_table.nics.arn}"
        ]
      }
    ]
  })
}


##
# IAM Role for Lambda execution
##
resource "aws_iam_role" "lambda_execution_role" {
  name = "eagle-eye-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_s3_ssm_policy" {
  name = "eagle-eye-lambda-s3-ssm-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = [
          "${aws_s3_bucket.eagle_eye_logs.arn}",
          "${aws_s3_bucket.eagle_eye_logs.arn}/*"
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter"
        ]
        Resource = "arn:aws:ssm:*:*:parameter/eagle-eye/appsync/api-key"
      }
    ]
  })
}

##
# IAM Role for Kinesis Firehose
##
resource "aws_iam_role" "firehose_delivery_role" {
  name = "eagle-eye-firehose-delivery-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "firehose.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "firehose_s3_policy" {
  name = "eagle-eye-firehose-s3-policy"
  role = aws_iam_role.firehose_delivery_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:GetBucketLocation",
          "s3:GetObject",
          "s3:ListBucket",
          "s3:ListBucketMultipartUploads",
          "s3:PutObject"
        ]
        Resource = [
          aws_s3_bucket.eagle_eye_logs.arn,
          "${aws_s3_bucket.eagle_eye_logs.arn}/*"
        ]
      }
    ]
  })
}

##
# Cross-Account IAM Role for VPC Flow Logs
##
resource "aws_iam_role" "vpc_flow_logs_cross_account_role" {
  name = "AWSLogDeliveryFirehoseCrossAccountRole-eagle-eye"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS     = aws_iam_role.log_delivery_service_role.arn
          Service = "delivery.logs.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      },
      {
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "vpc_flow_logs_firehose_policy" {
  name = "eagle-eye-vpc-flow-logs-firehose-policy"
  role = aws_iam_role.vpc_flow_logs_cross_account_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "firehose:PutRecord",
          "firehose:PutRecordBatch"
        ]
        Resource = aws_kinesis_firehose_delivery_stream.eagle_eye_vpc_logs.arn
      }
    ]
  })
}

##
# IAM Role for Lambda to publish to AppSync
##
resource "aws_iam_role_policy" "lambda_appsync_policy" {
  name = "eagle-eye-lambda-appsync-policy"
  role = aws_iam_role.lambda_execution_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "appsync:GraphQL"
        ]
        Resource = "${aws_appsync_graphql_api.eagle_eye_api.arn}/*"
      }
    ]
  })
}
