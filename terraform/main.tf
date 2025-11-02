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
