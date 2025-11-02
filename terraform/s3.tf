##
# S3 Bucket for Firehose destination
##
resource "aws_s3_bucket" "eagle_eye_logs" {
  bucket = "eagle-eye-vpc-logs"
}

resource "aws_s3_bucket_lifecycle_configuration" "eagle_eye_logs_lifecycle" {
  bucket = aws_s3_bucket.eagle_eye_logs.id

  rule {
    id     = "delete_vpc_flow_logs"
    status = "Enabled"

    expiration {
      days = 1
    }

    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

resource "aws_s3_bucket_notification" "vpc_logs_notification" {
  bucket = aws_s3_bucket.eagle_eye_logs.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.vpc_flow_processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "vpc-flow-logs/"
    filter_suffix       = ".gz"
  }

  depends_on = [aws_lambda_permission.allow_s3_invoke]
}
