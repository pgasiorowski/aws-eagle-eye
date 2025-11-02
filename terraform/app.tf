##
# AppSync GraphQL API
##
resource "aws_appsync_graphql_api" "eagle_eye_api" {
  authentication_type = "API_KEY"
  name                = "eagle-eye-vpc-flow-api"

  schema = <<EOF
type VpcFlowSummary {
  id: ID!
  uuid: String!
  sequenceNumber: Float!
  sourceIp: String!
  destinationIp: String!
  sourcePort: Int
  destinationPort: Int
  protocol: String!
  totalBytes: Int!
  totalPackets: Int!
  connectionCount: Int!
  acceptedCount: Int!
  rejectedCount: Int!
  firstSeen: String!
  lastSeen: String!
  timestamp: String!
}

type Mutation {
  publishVpcFlowSummary(input: VpcFlowSummaryInput!): VpcFlowSummary
}

type Subscription {
  onVpcFlowSummary: VpcFlowSummary
    @aws_subscribe(mutations: ["publishVpcFlowSummary"])
}

type Query {
  getVpcFlowSummaries: [VpcFlowSummary]
}

input VpcFlowSummaryInput {
  uuid: String!
  sequenceNumber: Float!
  sourceIp: String!
  destinationIp: String!
  sourcePort: Int
  destinationPort: Int
  protocol: String!
  totalBytes: Int!
  totalPackets: Int!
  connectionCount: Int!
  acceptedCount: Int!
  rejectedCount: Int!
  firstSeen: String!
  lastSeen: String!
}
EOF
}

##
# AppSync API Key
##
resource "aws_appsync_api_key" "eagle_eye_api_key" {
  api_id  = aws_appsync_graphql_api.eagle_eye_api.id
  expires = "2025-12-31T23:59:59Z"
}

##
# Store AppSync API Key in Parameter Store
##
resource "aws_ssm_parameter" "appsync_api_key" {
  name  = "/eagle-eye/appsync/api-key"
  type  = "SecureString"
  value = aws_appsync_api_key.eagle_eye_api_key.key

  tags = {
    Environment = "eagle-eye"
    Purpose     = "appsync-authentication"
  }
}

##
# AppSync Data Source (None - for direct Lambda invocation)
##
resource "aws_appsync_datasource" "none_datasource" {
  api_id = aws_appsync_graphql_api.eagle_eye_api.id
  name   = "NoneDataSource"
  type   = "NONE"
}

##
# AppSync Resolver for Mutation
##
resource "aws_appsync_resolver" "publish_vpc_flow_summary" {
  api_id      = aws_appsync_graphql_api.eagle_eye_api.id
  field       = "publishVpcFlowSummary"
  type        = "Mutation"
  data_source = aws_appsync_datasource.none_datasource.name

  request_template = <<EOF
{
  "version": "2017-02-28",
  "payload": $util.toJson($context.arguments.input)
}
EOF

  response_template = <<EOF
$util.toJson($context.result)
EOF
}

##
# AppSync Resolver for Query (placeholder)
##
resource "aws_appsync_resolver" "get_vpc_flow_summaries" {
  api_id      = aws_appsync_graphql_api.eagle_eye_api.id
  field       = "getVpcFlowSummaries"
  type        = "Query"
  data_source = aws_appsync_datasource.none_datasource.name

  request_template = <<EOF
{
  "version": "2017-02-28",
  "payload": {}
}
EOF

  response_template = <<EOF
[]
EOF
}
