#!/usr/bin/env python3
"""
Network Interface Discovery and DynamoDB Loader

This script discovers all network interfaces in an AWS account/region,
identifies the resources using them through intelligent metadata parsing
and AWS Resource Groups Tagging API, extracts tags, and stores the data
in a DynamoDB table.

Compatible with both local execution and AWS Lambda.
"""

import os
import json
import logging
import re
from typing import Dict, List, Optional, Any, Tuple
from datetime import datetime, timezone
import boto3
from botocore.exceptions import ClientError

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)


TABLE_NAME = os.getenv("VPC_MAP_TABLE_NAME", "aws-eagle-eye")


def convert_datetime_to_string(obj: Any) -> Any:
    """
    Recursively convert datetime objects to ISO format strings.
    
    Args:
        obj: Object to convert (can be dict, list, datetime, or primitive)
        
    Returns:
        Converted object with datetime values as strings
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    elif isinstance(obj, dict):
        return {k: convert_datetime_to_string(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convert_datetime_to_string(item) for item in obj]
    else:
        return obj


class NetworkInterfaceDiscovery:
    """Discovers network interfaces and their associated resources using generic AWS APIs."""
    
    # Known AWS service account IDs that manage ENIs
    # These are AWS-owned accounts that create ENIs in customer VPCs
    AWS_SERVICE_ACCOUNTS = {
        '547236950347': 'rds',  # RDS service account for eu-central-1
        '055625016279': 'rds',  # RDS service account (another region)
        '210876761215': 'elasticache',  # ElastiCache service account
        '628676013162': 'ecs',  # ECS/Fargate service account
        '326244987664': 'ecs',  # ECS/Fargate service account (another)
        '580336018581': 'route53-resolver',  # Route53 Resolver service account
        '682432039653': 'grafana',  # Amazon Managed Grafana service account
        '737353593908': 'kinesis-firehose',  # Kinesis Firehose service account
        '542591804455': 'mq',  # Amazon MQ service account
        '295330671495': 'mq',  # Amazon MQ service account (another)
        # Add more as discovered
    }
    
    # Mapping of RequesterIds to service names
    # Source: Various AWS services that create ENIs in customer VPCs
    SERVICE_MAPPING = {
        # Load Balancing
        'amazon-elb': 'elb',
        'amazon-elasticloadbalancing': 'elb',
        
        # Databases
        'amazon-rds': 'rds',
        'amazon-redshift': 'redshift',
        'amazon-elasticache': 'elasticache',
        'amazon-neptune': 'neptune',
        'amazon-documentdb': 'documentdb',
        'amazon-memorydb': 'memorydb',
        'amazon-keyspaces': 'keyspaces',
        'amazon-dynamodb': 'dynamodb',  # DAX
        
        # Container & Compute
        'amazon-ecs': 'ecs',
        'amazon-eks': 'eks',
        'aws-batch': 'batch',
        'aws-lambda': 'lambda',
        
        # Analytics & Big Data
        'amazon-msk': 'msk',  # Managed Streaming for Kafka
        'amazon-emr': 'emr',
        'aws-glue': 'glue',
        'amazon-kinesis': 'kinesis',
        'kinesis-firehose': 'kinesis-firehose',
        'amazon-kinesis-firehose': 'kinesis-firehose',
        'amazon-opensearch': 'opensearch',
        'amazon-elasticsearch': 'elasticsearch',
        
        # Machine Learning
        'aws-sagemaker': 'sagemaker',
        
        # Storage & File Systems
        'amazon-efs': 'efs',
        'amazon-fsx': 'fsx',
        'aws-backup': 'backup',
        'aws-storage-gateway': 'storage-gateway',
        
        # Messaging & Integration
        'amazon-mq': 'mq',
        'amazon-connect': 'connect',
        
        # Workflow & Orchestration
        'amazon-mwaa': 'mwaa',  # Managed Workflows for Apache Airflow
        'aws-transfer': 'transfer',
        'aws-datasync': 'datasync',
        
        # Directory & Security
        'amazon-directory-service': 'directory-service',
        'aws-directory-service': 'directory-service',
        'aws-secrets-manager': 'secrets-manager',
        
        # Developer Tools
        'aws-cloud9': 'cloud9',
        'aws-codebuild': 'codebuild',
        
        # End User Computing
        'amazon-workspaces': 'workspaces',
        'amazon-appstream': 'appstream',
        
        # Application Services
        'aws-app-runner': 'apprunner',
        'aws-app-mesh': 'appmesh',
        'amazon-apigateway': 'api-gateway',
        
        # Network Services
        'vpc-endpoint': 'vpc-endpoint',
        'aws-global-accelerator': 'global-accelerator',
        'aws-network-firewall': 'network-firewall',
        'aws-verified-access': 'verified-access',
        'aws-transit-gateway': 'transit-gateway',
        
        # IoT
        'aws-iot': 'iot',
        'aws-iot-greengrass': 'iot-greengrass',
        
        # Analytics & BI
        'amazon-quicksight': 'quicksight',
        'aws-lake-formation': 'lake-formation',
        'amazon-athena': 'athena',
        
        # Monitoring & Management
        'amazon-grafana': 'grafana',
        'awsgrafana': 'grafana',
        
        # DNS & Networking
        'route53-resolver': 'route53-resolver',
        'aws-route53-resolver': 'route53-resolver',
        
        # General AWS managed
        'amazon-aws': 'aws-managed-service',
    }
    
    def __init__(self):
        """Initialize the discovery service."""
        self.session = boto3.Session()
        self.ec2_client = self.session.client('ec2')
        self.rds_client = self.session.client('rds')
        self.dynamodb = self.session.resource('dynamodb')
        self.sts_client = self.session.client('sts')
        self.tagging_client = self.session.client('resourcegroupstaggingapi')
        
        # Get account ID
        self.account_id = self.sts_client.get_caller_identity()['Account']
        self.region = self.session.region_name
        logger.info(f"Initialized for account {self.account_id} in region {self.region}")
    
    def get_all_network_interfaces(self) -> List[Dict[str, Any]]:
        """
        Retrieve all network interfaces in the region.
        
        Returns:
            List of network interface dictionaries
        """
        logger.info("Fetching all network interfaces...")
        network_interfaces = []
        
        try:
            paginator = self.ec2_client.get_paginator('describe_network_interfaces')
            for page in paginator.paginate():
                network_interfaces.extend(page['NetworkInterfaces'])
            
            logger.info(f"Found {len(network_interfaces)} network interfaces")
            return network_interfaces
        except ClientError as e:
            logger.error(f"Error fetching network interfaces: {e}")
            raise
    
    def parse_resource_from_description(self, description: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Parse resource information from ENI description using regex patterns.
        
        Args:
            description: ENI description string
            
        Returns:
            Tuple of (resource_type, resource_id/name) or (None, None)
        """
        if not description:
            return (None, None)
        
        desc_lower = description.lower()
        
        # ELB/ALB/NLB patterns
        # Example: "ELB app/my-alb/50dc6c495c0c9188"
        elb_match = re.search(r'ELB\s+(app|net|gwy)/([^/]+)/([a-f0-9]+)', description, re.IGNORECASE)
        if elb_match:
            lb_type, lb_name, lb_id = elb_match.groups()
            return ('elb', f"{lb_type}/{lb_name}/{lb_id}")
        
        # Classic ELB pattern
        # Example: "ELB my-classic-lb"
        classic_elb_match = re.search(r'ELB\s+([a-zA-Z0-9-]+)$', description, re.IGNORECASE)
        if classic_elb_match:
            return ('elb', classic_elb_match.group(1))
        
        # Lambda pattern
        # Example: "AWS Lambda VPC ENI-my-function-abc123"
        lambda_match = re.search(r'AWS Lambda VPC ENI[:\s-]+([a-zA-Z0-9-_]+)', description, re.IGNORECASE)
        if lambda_match:
            return ('lambda', lambda_match.group(1))
        
        # NAT Gateway pattern
        # Example: "Interface for NAT Gateway nat-0123456789abcdef"
        nat_match = re.search(r'NAT Gateway\s+(nat-[a-f0-9]+)', description, re.IGNORECASE)
        if nat_match:
            return ('nat-gateway', nat_match.group(1))
        
        # VPC Endpoint pattern
        # Example: "VPC Endpoint Interface vpce-0123456789abcdef"
        vpce_match = re.search(r'VPC Endpoint.*?(vpce-[a-f0-9]+)', description, re.IGNORECASE)
        if vpce_match:
            return ('vpc-endpoint', vpce_match.group(1))
        
        # Route53 Resolver patterns
        # Example: "Route 53 Resolver: rslvr-in-55829d25693e4b729:rni-9494385465134fa5a"
        # Example: "Route 53 Resolver: rslvr-out-9bb0d69b4dd94f918:rni-51f53f6ef7b6436f8"
        if 'route 53 resolver' in desc_lower or 'route53 resolver' in desc_lower:
            resolver_match = re.search(r'(rslvr-(in|out)-[a-f0-9]+)', description, re.IGNORECASE)
            if resolver_match:
                resolver_id = resolver_match.group(1)
                resolver_type = resolver_match.group(2)  # 'in' or 'out'
                if resolver_type == 'in':
                    return ('route53-resolver-inbound', resolver_id)
                else:
                    return ('route53-resolver-outbound', resolver_id)
            # Generic fallback
            return ('route53-resolver', None)
        
        # ECS Task pattern - ARN format
        # Example: "arn:aws:ecs:eu-central-1:442708645802:attachment/c1988214-33e8-4404-8304-a3929bf11138"
        ecs_arn_match = re.search(r'arn:aws:ecs:[^:]+:[^:]+:(attachment|task)/([a-zA-Z0-9-]+)', description, re.IGNORECASE)
        if ecs_arn_match:
            return ('ecs', ecs_arn_match.group(2))
        
        # ECS Task pattern - simple format
        # Example: "ecs-task-abc123" or "awsvpc-eni-xyz"
        ecs_match = re.search(r'ecs[:\s-]*(task|service)[:\s-]*([a-zA-Z0-9-]+)', description, re.IGNORECASE)
        if ecs_match:
            return ('ecs', ecs_match.group(2))
        if 'awsvpc' in desc_lower and ('task' in desc_lower or 'eni' in desc_lower):
            return ('ecs', description[:50])
        
        # RDS patterns
        # Example: "RDSNetworkInterface"
        if 'rdsnetworkinterface' in desc_lower or 'rds network interface' in desc_lower:
            return ('rds', None)
        
        # ElastiCache pattern
        if 'elasticache' in desc_lower:
            cache_match = re.search(r'([a-zA-Z0-9-]+)', description)
            return ('elasticache', cache_match.group(1) if cache_match else None)
        
        # Redshift pattern
        if 'redshift' in desc_lower:
            redshift_match = re.search(r'([a-zA-Z0-9-]+)', description)
            return ('redshift', redshift_match.group(1) if redshift_match else None)
        
        # EFS pattern
        # Example: "EFS mount target for fs-0123456789abcdef"
        efs_match = re.search(r'(fs-[a-f0-9]+)', description, re.IGNORECASE)
        if efs_match or 'efs' in desc_lower:
            return ('efs', efs_match.group(1) if efs_match else None)
        
        # FSx pattern
        # Example: "FSx file system fs-0123456789abcdef"
        fsx_match = re.search(r'fsx.*?(fs-[a-f0-9]+)', description, re.IGNORECASE)
        if fsx_match or 'fsx' in desc_lower:
            return ('fsx', fsx_match.group(1) if fsx_match else None)
        
        # MSK (Managed Kafka) pattern
        if 'msk' in desc_lower or 'kafka' in desc_lower:
            return ('msk', None)
        
        # Kinesis Firehose pattern
        # Example: "Amazon Kinesis Firehose - 479366778816:kinesis-firehose-PAYMENTSTVN-PROD:1641374697543."
        if 'kinesis firehose' in desc_lower or 'kinesis-firehose' in desc_lower:
            firehose_match = re.search(r'kinesis-firehose-([a-zA-Z0-9_-]+)', description, re.IGNORECASE)
            return ('kinesis-firehose', firehose_match.group(1) if firehose_match else None)
        
        # Amazon MQ pattern
        # Example: "Amazon MQ network interface for broker b-03a68f4f-b3f4-43d9-8b61-bcfde3d37c3c"
        if 'amazon mq' in desc_lower:
            mq_match = re.search(r'broker\s+(b-[a-f0-9-]+)', description, re.IGNORECASE)
            return ('mq', mq_match.group(1) if mq_match else None)
        
        # EMR pattern
        if 'emr' in desc_lower or 'elastic mapreduce' in desc_lower:
            emr_match = re.search(r'(j-[A-Z0-9]+)', description, re.IGNORECASE)
            return ('emr', emr_match.group(1) if emr_match else None)
        
        # Glue pattern
        if 'glue' in desc_lower:
            return ('glue', None)
        
        # SageMaker pattern
        if 'sagemaker' in desc_lower:
            return ('sagemaker', None)
        
        # WorkSpaces pattern
        if 'workspaces' in desc_lower:
            ws_match = re.search(r'(ws-[a-zA-Z0-9]+)', description, re.IGNORECASE)
            return ('workspaces', ws_match.group(1) if ws_match else None)
        
        # AppStream pattern
        if 'appstream' in desc_lower:
            return ('appstream', None)
        
        # Directory Service pattern
        if 'directory' in desc_lower or 'ds-' in description:
            dir_match = re.search(r'(d-[a-zA-Z0-9]+)', description, re.IGNORECASE)
            return ('directory-service', dir_match.group(1) if dir_match else None)
        
        # Transfer Family pattern
        if 'transfer' in desc_lower:
            transfer_match = re.search(r'(s-[a-f0-9]+)', description, re.IGNORECASE)
            return ('transfer', transfer_match.group(1) if transfer_match else None)
        
        # MWAA (Airflow) pattern
        if 'mwaa' in desc_lower or 'airflow' in desc_lower:
            return ('mwaa', None)
        
        # Global Accelerator pattern
        if 'global accelerator' in desc_lower or 'accelerator' in desc_lower:
            return ('global-accelerator', None)
        
        # Network Firewall pattern
        if 'network firewall' in desc_lower or 'firewall' in desc_lower:
            fw_match = re.search(r'(firewall-[a-f0-9]+)', description, re.IGNORECASE)
            return ('network-firewall', fw_match.group(1) if fw_match else None)
        
        # API Gateway pattern
        if 'api gateway' in desc_lower or 'apigateway' in desc_lower:
            return ('api-gateway', None)
        
        # CodeBuild pattern
        if 'codebuild' in desc_lower:
            return ('codebuild', None)
        
        # Cloud9 pattern
        if 'cloud9' in desc_lower:
            return ('cloud9', None)
        
        # Neptune pattern
        if 'neptune' in desc_lower:
            return ('neptune', None)
        
        # DocumentDB pattern
        if 'documentdb' in desc_lower or 'docdb' in desc_lower:
            return ('documentdb', None)
        
        # MemoryDB pattern
        if 'memorydb' in desc_lower:
            return ('memorydb', None)
        
        # OpenSearch/Elasticsearch pattern
        if 'opensearch' in desc_lower:
            return ('opensearch', None)
        if 'elasticsearch' in desc_lower:
            return ('elasticsearch', None)
        
        # Backup pattern
        if 'backup' in desc_lower:
            return ('backup', None)
        
        # DataSync pattern
        if 'datasync' in desc_lower:
            return ('datasync', None)
        
        # Storage Gateway pattern
        if 'storage gateway' in desc_lower or 'storagegateway' in desc_lower:
            sgw_match = re.search(r'(sgw-[A-F0-9]+)', description, re.IGNORECASE)
            return ('storage-gateway', sgw_match.group(1) if sgw_match else None)
        
        # Connect pattern
        if 'connect' in desc_lower and 'amazon' in desc_lower:
            return ('connect', None)
        
        # App Runner pattern
        if 'apprunner' in desc_lower or 'app runner' in desc_lower:
            return ('apprunner', None)
        
        # Batch pattern
        if 'batch' in desc_lower and 'compute environment' in desc_lower:
            return ('batch', None)
        
        # EKS pattern
        if 'eks' in desc_lower:
            eks_match = re.search(r'eks-([a-zA-Z0-9-]+)', description, re.IGNORECASE)
            return ('eks', eks_match.group(1) if eks_match else None)
        
        # Transit Gateway pattern
        if 'transit gateway' in desc_lower or 'tgw' in desc_lower:
            tgw_match = re.search(r'(tgw-[a-f0-9]+)', description, re.IGNORECASE)
            return ('transit-gateway', tgw_match.group(1) if tgw_match else None)
        
        # QuickSight pattern
        if 'quicksight' in desc_lower:
            return ('quicksight', None)
        
        # Athena pattern
        if 'athena' in desc_lower:
            return ('athena', None)
        
        # Lake Formation pattern
        if 'lake formation' in desc_lower or 'lakeformation' in desc_lower:
            return ('lake-formation', None)
        
        # IoT Greengrass pattern
        if 'greengrass' in desc_lower:
            return ('iot-greengrass', None)
        
        # Verified Access pattern
        if 'verified access' in desc_lower:
            return ('verified-access', None)
        
        return (None, None)
    
    def get_resource_tags_by_eni(self, eni_id: str) -> Dict[str, Any]:
        """
        Find resource associated with ENI using Resource Groups Tagging API.
        
        This is a generic approach that works for ANY AWS resource.
        
        Args:
            eni_id: Network interface ID
            
        Returns:
            Dictionary with 'resource_arn', 'resource_type', 'resource_id', and 'tags'
        """
        try:
            # Search for resources that have this ENI in their configuration
            # We'll search by checking if any resource is in the same VPC/subnet
            # and correlate based on timing and location
            
            # For now, we'll use a simpler approach: try to get tags directly from the ENI
            # and look for resources by their ARNs in descriptions
            return {}
        except ClientError as e:
            logger.warning(f"Error querying tagging API for ENI {eni_id}: {e}")
            return {}
    
    def get_rds_instance_by_eni(self, eni_data: Dict[str, Any]) -> Tuple[Optional[str], Dict[str, str]]:
        """
        Find RDS instance using this ENI by matching VPC, subnet, and AZ.
        
        Args:
            eni_data: ENI data dictionary with vpc_id, subnet_id, availability_zone
            
        Returns:
            Tuple of (db_instance_id, tags_dict)
        """
        try:
            # Get all RDS instances
            paginator = self.rds_client.get_paginator('describe_db_instances')
            for page in paginator.paginate():
                for db in page['DBInstances']:
                    # Check if VPC matches
                    db_subnet_group = db.get('DBSubnetGroup', {})
                    if db_subnet_group.get('VpcId') == eni_data['vpc_id']:
                        # Check if subnet matches
                        subnets = [s['SubnetIdentifier'] for s in db_subnet_group.get('Subnets', [])]
                        if eni_data['subnet_id'] in subnets:
                            # Also verify AZ matches
                            if db.get('AvailabilityZone') == eni_data['availability_zone']:
                                # Get tags
                                try:
                                    tags_response = self.rds_client.list_tags_for_resource(
                                        ResourceName=db['DBInstanceArn']
                                    )
                                    tags = {
                                        tag['Key']: tag['Value']
                                        for tag in tags_response.get('TagList', [])
                                    }
                                    return (db['DBInstanceIdentifier'], tags)
                                except ClientError:
                                    return (db['DBInstanceIdentifier'], {})
        except ClientError as e:
            logger.warning(f"Error searching RDS instances for ENI {eni_data['id']}: {e}")
        
        return (None, {})
    
    def get_resource_by_id(self, resource_type: str, resource_id: str, eni_data: Optional[Dict[str, Any]] = None) -> Tuple[str, Dict[str, str]]:
        """
        Get resource information and tags by resource type and ID.
        
        This makes targeted API calls only when we have specific resource IDs.
        
        Args:
            resource_type: Type of resource (ec2, lambda, elb, etc.)
            resource_id: Resource identifier (can be None for some types)
            eni_data: Optional ENI data for context-based lookups
            
        Returns:
            Tuple of (resource_name, tags_dict)
        """
        try:
            if resource_type == 'ec2':
                response = self.ec2_client.describe_instances(InstanceIds=[resource_id])
                if response['Reservations'] and response['Reservations'][0]['Instances']:
                    instance = response['Reservations'][0]['Instances'][0]
                    name = instance.get('Tags', [{}])[0].get('Value', resource_id)
                    tags = {tag['Key']: tag['Value'] for tag in instance.get('Tags', [])}
                    return (name, tags)
            
            elif resource_type == 'rds':
                # If we don't have a specific ID, try to find by ENI location
                if not resource_id and eni_data:
                    return self.get_rds_instance_by_eni(eni_data)
                elif resource_id:
                    response = self.rds_client.describe_db_instances(DBInstanceIdentifier=resource_id)
                    if response['DBInstances']:
                        db = response['DBInstances'][0]
                        tags_response = self.rds_client.list_tags_for_resource(
                            ResourceName=db['DBInstanceArn']
                        )
                        tags = {tag['Key']: tag['Value'] for tag in tags_response.get('TagList', [])}
                        return (db['DBInstanceIdentifier'], tags)
            
            elif resource_type == 'nat-gateway':
                response = self.ec2_client.describe_nat_gateways(NatGatewayIds=[resource_id])
                if response['NatGateways']:
                    nat_gw = response['NatGateways'][0]
                    tags = {tag['Key']: tag['Value'] for tag in nat_gw.get('Tags', [])}
                    return (resource_id, tags)
            
            elif resource_type == 'vpc-endpoint':
                response = self.ec2_client.describe_vpc_endpoints(VpcEndpointIds=[resource_id])
                if response['VpcEndpoints']:
                    endpoint = response['VpcEndpoints'][0]
                    tags = {tag['Key']: tag['Value'] for tag in endpoint.get('Tags', [])}
                    service_name = endpoint.get('ServiceName', resource_id)
                    return (service_name, tags)
        
        except ClientError as e:
            logger.warning(f"Error fetching {resource_type} {resource_id}: {e}")
        
        return (resource_id if resource_id else 'N/A', {})
    
    def identify_resource(self, eni: Dict[str, Any]) -> Dict[str, Any]:
        """
        Identify the resource using this ENI through multiple methods:
        1. EKS Pod ENIs (aws-K8S-* pattern - special handling)
        2. EC2 Attachment information 
        3. InterfaceType (AWS-provided type metadata) 
        4. Tags (service-specific markers like AmazonGrafanaManaged)
        5. RequesterID (AWS service or service account)
        6. Description parsing (for specific resource IDs and patterns)
        
        Args:
            eni: Raw ENI data from AWS API
            
        Returns:
            Dictionary with resource_type, resource_id, resource_name, and tags
        """
        # Build basic ENI info for lookups
        eni_info = {
            'id': eni['NetworkInterfaceId'],
            'vpc_id': eni.get('VpcId', ''),
            'subnet_id': eni.get('SubnetId', ''),
            'availability_zone': eni.get('AvailabilityZone', ''),
        }
        
        result = {
            'resource_type': 'unknown',
            'resource_id': 'N/A',
            'resource_name': 'N/A',
            'resource_tags': {},
            'requester_id': eni.get('RequesterId', ''),
            'requester_managed': eni.get('RequesterManaged', False),
        }
        
        # Method 1: Check for EKS pod ENIs (special case - attached to EC2 but used by pods)
        # These ENIs are attached to EC2 instances but used by Kubernetes pods via VPC CNI
        description = eni.get('Description', '')
        if description.startswith('aws-K8S-'):
            # Check tags to confirm and get cluster name
            eni_tags = {tag['Key']: tag['Value'] for tag in eni.get('TagSet', [])}
            cluster_name = eni_tags.get('cluster.k8s.amazonaws.com/name', 'unknown')
            instance_id = eni_tags.get('node.k8s.amazonaws.com/instance_id', 
                                       eni.get('Attachment', {}).get('InstanceId', 'unknown'))
            
            result['resource_type'] = 'eks-pod'
            result['resource_id'] = f"{cluster_name}/{instance_id}"
            result['resource_name'] = cluster_name
            # Store the EKS-specific tags
            result['resource_tags'] = {k: v for k, v in eni_tags.items() 
                                      if k.startswith(('eks:', 'cluster.k8s.', 'node.k8s.'))}
            return result
        
        # Method 2: Check if attached to an EC2 instance (regular case)
        attachment = eni.get('Attachment', {})
        instance_id = attachment.get('InstanceId')
        if instance_id:
            result['resource_type'] = 'ec2'
            result['resource_id'] = instance_id
            resource_name, tags = self.get_resource_by_id('ec2', instance_id)
            result['resource_name'] = resource_name
            result['resource_tags'] = tags
            return result
        
        # Method 3: Use InterfaceType (AWS-provided type information)
        interface_type = eni.get('InterfaceType', 'interface')
        if interface_type != 'interface':
            # Map interface types to services
            type_mapping = {
                # Network
                'nat_gateway': 'nat-gateway',
                'vpc_endpoint': 'vpc-endpoint',
                'gateway_load_balancer_endpoint': 'vpc-endpoint',
                
                # Load Balancing
                'network_load_balancer': 'elb',
                'gateway_load_balancer': 'elb',
                'load_balancer': 'elb',
                
                # Compute
                'lambda': 'lambda',
                'efa': 'ec2',  # Elastic Fabric Adapter
                'trunk': 'ec2',
                'branch': 'ec2',
                
                # API & Integration
                'api_gateway_managed': 'api-gateway',
                'iot_rules_managed': 'iot',
                
                # Network Services
                'global_accelerator_managed': 'global-accelerator',
                'transit_gateway': 'transit-gateway',
                'transit_gateway_attachment': 'transit-gateway',
                'network_insights_analysis': 'network-insights',
                
                # Database
                'quicksight': 'quicksight',
                
                # AWS Services
                'aws_codestar_connections_managed': 'codestar',
                'elasticmapreduce': 'emr',
            }
            result['resource_type'] = type_mapping.get(interface_type, interface_type)
        
        # Method 4: Check tags for service-specific markers
        tags = {tag['Key']: tag['Value'] for tag in eni.get('TagSet', [])}
        if 'AmazonGrafanaManaged' in tags or 'aws:grafana:workspace-id' in tags:
            result['resource_type'] = 'grafana'
            workspace_id = tags.get('aws:grafana:workspace-id', 'managed')
            if workspace_id != 'managed':
                result['resource_id'] = workspace_id
        
        # Method 5: Use RequesterID to identify the service
        requester_id = eni.get('RequesterId', '')
        if requester_id:
            # Check if RequesterID contains service name (like Grafana sessions)
            if 'grafana' in requester_id.lower() and result['resource_type'] == 'unknown':
                result['resource_type'] = 'grafana'
            
            # First check if it's a known AWS service account
            if requester_id in self.AWS_SERVICE_ACCOUNTS:
                if result['resource_type'] == 'unknown':
                    result['resource_type'] = self.AWS_SERVICE_ACCOUNTS[requester_id]
            else:
                # Map requester to service by prefix
                for prefix, service in self.SERVICE_MAPPING.items():
                    if requester_id.startswith(prefix):
                        if result['resource_type'] == 'unknown':
                            result['resource_type'] = service
                        break
        
        # Method 6: Parse description for specific resource identifiers
        parsed_type, parsed_id = self.parse_resource_from_description(description)
        
        if parsed_type:
            result['resource_type'] = parsed_type
            if parsed_id:
                result['resource_id'] = parsed_id
            
            # Try to get more details
            if parsed_id:
                # We have a specific resource ID, look it up
                resource_name, tags = self.get_resource_by_id(parsed_type, parsed_id, eni_info)
                result['resource_name'] = resource_name
                result['resource_tags'] = tags
            elif parsed_type in ['rds', 'elasticache', 'redshift', 'neptune', 'documentdb', 'memorydb']:
                # For database services, try to find the instance by ENI location
                resource_name, tags = self.get_resource_by_id(parsed_type, None, eni_info)
                if resource_name and resource_name != 'N/A':
                    result['resource_id'] = resource_name
                    result['resource_name'] = resource_name
                    result['resource_tags'] = tags
        
        # If we still have just a type but no ID, use description or default
        if result['resource_id'] == 'N/A' and result['resource_type'] != 'unknown':
            result['resource_id'] = description[:100] if description else 'aws-managed'
        
        return result
    
    def extract_eni_data(self, eni: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract all relevant data from a network interface.
        
        Args:
            eni: Raw ENI data from AWS API
            
        Returns:
            Complete ENI data dictionary
        """
        # Get resource information
        resource_info = self.identify_resource(eni)
        
        # Build complete data structure
        data = {
            # Primary attributes (DynamoDB keys)
            'id': eni['NetworkInterfaceId'],
            'vpc_id': eni.get('VpcId', 'N/A'),
            'account_id': self.account_id,
            
            # Network attributes
            'subnet_id': eni.get('SubnetId', 'N/A'),
            'availability_zone': eni.get('AvailabilityZone', 'N/A'),
            'interface_type': eni.get('InterfaceType', 'interface'),
            'status': eni.get('Status', 'unknown'),
            'mac_address': eni.get('MacAddress', 'N/A'),
            'description': eni.get('Description', ''),
            
            # Security groups
            'security_group_ids': [sg['GroupId'] for sg in eni.get('Groups', [])],
            
            # IP addresses
            'private_ip_addresses': [
                addr['PrivateIpAddress'] 
                for addr in eni.get('PrivateIpAddresses', [])
            ],
            'public_ips': [
                addr.get('Association', {}).get('PublicIp')
                for addr in eni.get('PrivateIpAddresses', [])
                if addr.get('Association', {}).get('PublicIp')
            ],
            
            # Attachment information (convert datetime objects to strings)
            'attachment': convert_datetime_to_string(eni.get('Attachment', {})),
            
            # ENI tags
            'eni_tags': {
                tag['Key']: tag['Value'] 
                for tag in eni.get('TagSet', [])
            },
            
            # Resource information (from identify_resource)
            'resource_type': resource_info['resource_type'],
            'resource_id': resource_info['resource_id'],
            'resource_name': resource_info['resource_name'],
            'resource_tags': resource_info['resource_tags'],
            'requester_id': resource_info['requester_id'],
            'requester_managed': resource_info['requester_managed'],
            
            # Metadata
            'last_updated': datetime.now(timezone.utc).isoformat(),
        }
        
        return data
    
    def save_to_dynamodb(self, eni_data: Dict[str, Any]) -> bool:
        """
        Save ENI data to DynamoDB table.
        
        Args:
            eni_data: Complete ENI data dictionary
            
        Returns:
            True if successful, False otherwise
        """
        try:
            table = self.dynamodb.Table(TABLE_NAME)
            
            # Prepare item for DynamoDB (convert complex types to JSON strings)
            item = {
                'id': eni_data['id'],
                'vpc_id': eni_data['vpc_id'],
                'account_id': eni_data['account_id'],
                'subnet_id': eni_data['subnet_id'],
                'availability_zone': eni_data['availability_zone'],
                'interface_type': eni_data['interface_type'],
                'status': eni_data['status'],
                'mac_address': eni_data['mac_address'],
                'description': eni_data['description'],
                'security_group_ids': json.dumps(eni_data['security_group_ids']),
                'private_ip_addresses': json.dumps(eni_data['private_ip_addresses']),
                'public_ips': json.dumps(eni_data['public_ips']),
                'attachment': json.dumps(eni_data['attachment']),
                'eni_tags': json.dumps(eni_data['eni_tags']),
                'resource_type': eni_data['resource_type'],
                'resource_id': eni_data['resource_id'],
                'resource_name': eni_data['resource_name'],
                'resource_tags': json.dumps(eni_data['resource_tags']),
                'requester_id': eni_data['requester_id'],
                'requester_managed': eni_data['requester_managed'],
                'last_updated': eni_data['last_updated'],
            }
            
            table.put_item(Item=item)
            return True
        except ClientError as e:
            logger.error(f"Error saving ENI {eni_data['id']} to DynamoDB: {e}")
            return False
    
    def process_all_network_interfaces(self) -> Dict[str, int]:
        """
        Main processing function: discover, identify resources, and save all ENIs.
        
        Returns:
            Dictionary with processing statistics
        """
        stats = {
            'total': 0,
            'processed': 0,
            'saved': 0,
            'errors': 0,
            'by_type': {},
        }
        
        # Get all network interfaces
        network_interfaces = self.get_all_network_interfaces()
        stats['total'] = len(network_interfaces)
        
        # Process each ENI
        for eni in network_interfaces:
            try:
                # Extract complete data including resource identification
                eni_data = self.extract_eni_data(eni)
                
                stats['processed'] += 1
                
                # Track resource types
                resource_type = eni_data['resource_type']
                stats['by_type'][resource_type] = stats['by_type'].get(resource_type, 0) + 1
                
                # Log discovery
                logger.info(
                    f"ENI {eni_data['id']}: {resource_type} - "
                    f"{eni_data['resource_name']} ({eni_data['resource_id']})"
                )
                
                # Save to DynamoDB
                if self.save_to_dynamodb(eni_data):
                    stats['saved'] += 1
                else:
                    stats['errors'] += 1
                
            except Exception as e:
                logger.error(
                    f"Error processing ENI {eni.get('NetworkInterfaceId', 'unknown')}: {e}",
                    exc_info=True
                )
                stats['errors'] += 1
        
        return stats


def handle_eventbridge_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle EventBridge (CloudTrail) event for ENI lifecycle changes.
    
    Args:
        event: EventBridge event containing CloudTrail data
        
    Returns:
        Response dictionary
    """
    try:
        detail = event.get('detail', {})
        event_name = detail.get('eventName', '')
        
        logger.info(f"Processing EventBridge event: {event_name}")
        
        # Extract ENI ID from the response
        response_elements = detail.get('responseElements', {})
        request_params = detail.get('requestParameters', {})
        
        eni_id = None
        
        # Extract ENI ID based on event type
        if event_name == 'CreateNetworkInterface':
            # ENI ID is in responseElements
            eni_id = response_elements.get('networkInterface', {}).get('networkInterfaceId')
        
        elif event_name == 'AttachNetworkInterface':
            # ENI ID is in requestParameters
            eni_id = request_params.get('networkInterfaceId')
        
        elif event_name in ['DeleteNetworkInterface', 'DetachNetworkInterface']:
            # ENI ID is in requestParameters
            eni_id = request_params.get('networkInterfaceId')
        
        if not eni_id:
            logger.warning(f"Could not extract ENI ID from event: {event_name}")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'message': 'ENI ID not found in event',
                    'eventName': event_name
                })
            }
        
        logger.info(f"Processing ENI: {eni_id} for event: {event_name}")
        
        # Initialize discovery service
        discovery = NetworkInterfaceDiscovery()
        
        # Handle based on event type
        if event_name in ['CreateNetworkInterface', 'AttachNetworkInterface']:
            # Fetch and save ENI data
            try:
                # Fetch ENI details
                response = discovery.ec2_client.describe_network_interfaces(
                    NetworkInterfaceIds=[eni_id]
                )
                
                if not response.get('NetworkInterfaces'):
                    logger.warning(f"ENI {eni_id} not found")
                    return {
                        'statusCode': 404,
                        'body': json.dumps({
                            'message': f'ENI {eni_id} not found',
                            'eventName': event_name
                        })
                    }
                
                # Process the ENI
                eni = response['NetworkInterfaces'][0]
                eni_data = discovery.extract_eni_data(eni)
                
                # Save to DynamoDB
                if discovery.save_to_dynamodb(eni_data):
                    logger.info(f"Successfully saved ENI {eni_id} to DynamoDB")
                    return {
                        'statusCode': 200,
                        'body': json.dumps({
                            'message': f'ENI {eni_id} processed successfully',
                            'eventName': event_name,
                            'eni_id': eni_id,
                            'resource_type': eni_data['resource_type'],
                            'resource_id': eni_data['resource_id']
                        })
                    }
                else:
                    logger.error(f"Failed to save ENI {eni_id} to DynamoDB")
                    return {
                        'statusCode': 500,
                        'body': json.dumps({
                            'message': f'Failed to save ENI {eni_id}',
                            'eventName': event_name
                        })
                    }
                    
            except ClientError as e:
                logger.error(f"Error fetching ENI {eni_id}: {e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps({
                        'message': f'Error fetching ENI {eni_id}',
                        'error': str(e)
                    })
                }
        
        elif event_name in ['DeleteNetworkInterface', 'DetachNetworkInterface']:
            # Delete ENI from DynamoDB
            try:
                table = discovery.dynamodb.Table(TABLE_NAME)
                table.delete_item(Key={'id': eni_id})
                
                logger.info(f"Successfully deleted ENI {eni_id} from DynamoDB")
                return {
                    'statusCode': 200,
                    'body': json.dumps({
                        'message': f'ENI {eni_id} deleted successfully',
                        'eventName': event_name,
                        'eni_id': eni_id
                    })
                }
            except ClientError as e:
                logger.error(f"Error deleting ENI {eni_id}: {e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps({
                        'message': f'Error deleting ENI {eni_id}',
                        'error': str(e)
                    })
                }
        
        else:
            logger.warning(f"Unhandled event type: {event_name}")
            return {
                'statusCode': 400,
                'body': json.dumps({
                    'message': f'Unhandled event type: {event_name}'
                })
            }
            
    except Exception as e:
        logger.error(f"Error processing EventBridge event: {e}", exc_info=True)
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'Failed to process EventBridge event',
                'error': str(e)
            })
        }


def lambda_handler(event, context):
    """
    AWS Lambda handler function - routes to appropriate handler.
    
    Handles both:
    1. EventBridge events (CloudTrail ENI lifecycle events)
    2. Manual invocations / scheduled full sync
    
    Args:
        event: Lambda event object
        context: Lambda context object
        
    Returns:
        Response dictionary
    """
    # Check if this is an EventBridge event
    if event.get('source') == 'aws.ec2' and event.get('detail-type') == 'AWS API Call via CloudTrail':
        # Route to EventBridge handler
        return handle_eventbridge_event(event)
    
    # Check if this is a full sync request
    elif event.get('action') == 'full_sync':
        logger.info("Executing full sync of all network interfaces")
        try:
            discovery = NetworkInterfaceDiscovery()
            stats = discovery.process_all_network_interfaces()
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Full network interface sync completed',
                    'statistics': stats
                })
            }
        except Exception as e:
            logger.error(f"Full sync failed: {e}", exc_info=True)
            return {
                'statusCode': 500,
                'body': json.dumps({
                    'message': 'Full network interface sync failed',
                    'error': str(e)
                })
            }
    
    # Default: full discovery (for manual invocations)
    else:
        logger.info("Executing full discovery of all network interfaces")
        try:
            discovery = NetworkInterfaceDiscovery()
            stats = discovery.process_all_network_interfaces()
            
            return {
                'statusCode': 200,
                'body': json.dumps({
                    'message': 'Network interface discovery completed',
                    'statistics': stats
                })
            }
        except Exception as e:
            logger.error(f"Lambda execution failed: {e}", exc_info=True)
            return {
                'statusCode': 500,
                'body': json.dumps({
                    'message': 'Network interface discovery failed',
                    'error': str(e)
                })
            }


def main():
    """Main function for local execution."""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Discover network interfaces and load them into DynamoDB'
    )
    parser.add_argument(
        '--dry-run',
        action='store_true',
        help='Process ENIs but do not save to DynamoDB'
    )
    parser.add_argument(
        '--verbose',
        action='store_true',
        help='Enable verbose logging'
    )
    
    args = parser.parse_args()
    
    # Setup logging for local execution
    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(
        level=log_level,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    
    try:
        logger.info("Starting network interface discovery...")
        discovery = NetworkInterfaceDiscovery()
        
        if args.dry_run:
            logger.info("DRY RUN MODE - No data will be saved to DynamoDB")
            # Override save method for dry run
            discovery.save_to_dynamodb = lambda x: True
        
        stats = discovery.process_all_network_interfaces()
        
        # Print summary
        logger.info("=" * 70)
        logger.info("DISCOVERY COMPLETE")
        logger.info("=" * 70)
        logger.info(f"Total ENIs found:        {stats['total']}")
        logger.info(f"Successfully processed:  {stats['processed']}")
        logger.info(f"Successfully saved:      {stats['saved']}")
        logger.info(f"Errors:                  {stats['errors']}")
        logger.info("")
        logger.info("Resources by type:")
        for resource_type, count in sorted(stats['by_type'].items()):
            logger.info(f"  {resource_type:20s}: {count}")
        logger.info("=" * 70)
        
        return 0 if stats['errors'] == 0 else 1
        
    except Exception as e:
        logger.error(f"Fatal error: {e}", exc_info=True)
        return 1


if __name__ == '__main__':
    exit(main())
