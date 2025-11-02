import json
import boto3
import gzip
import base64
from datetime import datetime
from collections import defaultdict
import os
import uuid
import hashlib
import urllib.parse
import ipaddress

# Initialize AWS clients
s3_client = boto3.client('s3')
ssm_client = boto3.client('ssm')

# Environment variables
APPSYNC_API_URL = os.environ.get('APPSYNC_API_URL')

# VPC CIDR configuration
VPC_CIDR = ipaddress.IPv4Network('172.31.0.0/16')
INTERNET_GATEWAY_IP = '172.31.0.1'

# Global variable for API key (loaded once)
APPSYNC_API_KEY = None

def get_appsync_api_key():
    """Retrieve AppSync API key from Parameter Store"""
    global APPSYNC_API_KEY
    
    if APPSYNC_API_KEY is None:
        try:
            response = ssm_client.get_parameter(
                Name='/eagle-eye/appsync/api-key',
                WithDecryption=True
            )
            APPSYNC_API_KEY = response['Parameter']['Value']
            print("AppSync API key retrieved from Parameter Store")
        except Exception as e:
            print(f"Failed to retrieve AppSync API key: {e}")
            APPSYNC_API_KEY = ""
    
    return APPSYNC_API_KEY

def normalize_ip_address(ip_str):
    """
    Normalize IP addresses based on VPC CIDR.
    If IP is outside VPC CIDR (172.31.0.0/16), replace with Internet Gateway IP (172.31.0.1)
    """
    try:
        ip = ipaddress.IPv4Address(ip_str)
        
        # Check if IP is within VPC CIDR
        if ip in VPC_CIDR:
            return str(ip)  # Keep original IP if within VPC
        else:
            return INTERNET_GATEWAY_IP  # Replace with Internet Gateway IP if outside VPC
            
    except ipaddress.AddressValueError:
        print(f"Invalid IP address: {ip_str}")
        return ip_str  # Return original if invalid

def handler(event, context):
    print(f"Received S3 event: {json.dumps(event)}")
    
    try:
        total_summaries = 0
        published_count = 0
        failed_count = 0
        
        # Process each S3 record
        for record in event['Records']:
            bucket = record['s3']['bucket']['name']
            encoded_key = record['s3']['object']['key']
            
            # URL decode the key to handle Hive partitioning (year%3D2025 -> year=2025)
            key = urllib.parse.unquote(encoded_key)
            
            print(f"Processing file: s3://{bucket}/{key}")
            
            # Download and process the VPC Flow Log file
            summaries = process_vpc_flow_log_file(bucket, key)
            total_summaries += len(summaries)
            
            # Send summaries to AppSync with batch tracking
            for summary in summaries:
                success = publish_to_appsync(summary)
                if success:
                    published_count += 1
                else:
                    failed_count += 1
            
            # Delete the processed file (use decoded key)
            delete_s3_file(bucket, key)
        
        # Summary log
        print(f"Processing complete: {total_summaries} summaries processed, {published_count} published, {failed_count} failed")
            
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': f'Processed {len(event["Records"])} files successfully',
                'summaries_processed': total_summaries,
                'published': published_count,
                'failed': failed_count
            })
        }
        
    except Exception as e:
        print(f"Error processing VPC Flow Logs: {str(e)}")
        raise e

def process_vpc_flow_log_file(bucket, key):
    """Download, decompress, and process VPC Flow Log file"""
    
    # Download file from S3
    response = s3_client.get_object(Bucket=bucket, Key=key)
    
    # Decompress if it's gzipped
    if key.endswith('.gz'):
        content = gzip.decompress(response['Body'].read()).decode('utf-8')
    else:
        content = response['Body'].read().decode('utf-8')
    
    # Parse VPC Flow Logs and create summaries
    summaries = {}
    processed_lines = 0
    skipped_lines = 0
    
    for line in content.strip().split('\n'):
        if not line.strip():
            continue  # Skip empty lines
            
        # Handle JSON format (Kinesis Firehose might wrap in JSON)
        actual_log_line = line
        try:
            if line.startswith('{') and '"message"' in line:
                json_data = json.loads(line)
                actual_log_line = json_data.get('message', line)
        except json.JSONDecodeError:
            # Not JSON, use the line as-is
            pass
        
        # Skip version headers and empty lines
        if actual_log_line.startswith('version') or not actual_log_line.strip():
            continue
            
        fields = actual_log_line.split(' ')
        if len(fields) < 13:  # Minimum required fields (version through action)
            skipped_lines += 1
            continue
            
        # Parse VPC Flow Log fields (version 2 format)
        # Format: version account-id interface-id srcaddr dstaddr srcport dstport protocol packets bytes windowstart windowend action flowlogstatus
        try:
            version = fields[0]
            account_id = fields[1]
            interface_id = fields[2]
            srcaddr = fields[3]
            dstaddr = fields[4]
            srcport = fields[5]
            dstport = fields[6]
            protocol = fields[7]
            packets = fields[8]
            bytes_transferred = fields[9]
            windowstart = fields[10]
            windowend = fields[11]
            action = fields[12]
            flowlogstatus = fields[13] if len(fields) > 13 else 'OK'
            
            # Skip NODATA records (indicated by dashes in critical fields)
            if (srcaddr == '-' or dstaddr == '-' or 
                windowstart == '-' or windowend == '-' or 
                action == '-' or flowlogstatus == 'NODATA'):
                skipped_lines += 1
                continue
            
            # Convert numeric fields, handling dashes
            try:
                srcport_int = int(srcport) if srcport != '-' else 0
                dstport_int = int(dstport) if dstport != '-' else 0
                packets_int = int(packets) if packets != '-' else 0
                bytes_int = int(bytes_transferred) if bytes_transferred != '-' else 0
                windowstart_int = int(windowstart)
                windowend_int = int(windowend)
            except ValueError as ve:
                print(f"Error converting numeric fields in line: {actual_log_line}, error: {ve}")
                print(f"Field values - srcport: '{srcport}', dstport: '{dstport}', packets: '{packets}', bytes: '{bytes_transferred}', windowstart: '{windowstart}', windowend: '{windowend}'")
                skipped_lines += 1
                continue
            
            # Create connection tuple key
            tuple_key = f"{srcaddr}:{srcport_int}->{dstaddr}:{dstport_int}:{protocol}"
            
            # Aggregate by connection tuple
            if tuple_key not in summaries:
                summaries[tuple_key] = {
                    'sourceIp': srcaddr,
                    'destinationIp': dstaddr,
                    'sourcePort': srcport_int,
                    'destinationPort': dstport_int,
                    'protocol': protocol,
                    'totalBytes': 0,
                    'totalPackets': 0,
                    'connectionCount': 0,
                    'acceptedCount': 0,
                    'rejectedCount': 0,
                    'firstSeen': windowstart_int,
                    'lastSeen': windowend_int
                }
            
            # Update aggregated values
            summary = summaries[tuple_key]
            summary['totalBytes'] += bytes_int
            summary['totalPackets'] += packets_int
            summary['connectionCount'] += 1
            summary['firstSeen'] = min(summary['firstSeen'], windowstart_int)
            summary['lastSeen'] = max(summary['lastSeen'], windowend_int)
            
            # Track accepted/rejected actions
            if action == 'ACCEPT':
                summary['acceptedCount'] += 1
            elif action == 'REJECT':
                summary['rejectedCount'] += 1
            
            processed_lines += 1
            
        except (ValueError, IndexError) as e:
            print(f"Error parsing line: {actual_log_line}, error: {e}")
            skipped_lines += 1
            continue
    
    print(f"Processed {processed_lines} lines, skipped {skipped_lines} lines")
    
    # Process summaries without DynamoDB enrichment
    processed_summaries = []
    for summary in summaries.values():
        # Convert timestamps to ISO format
        summary['firstSeen'] = datetime.fromtimestamp(summary['firstSeen']).isoformat()
        summary['lastSeen'] = datetime.fromtimestamp(summary['lastSeen']).isoformat()
        summary['timestamp'] = datetime.utcnow().isoformat()
        
        # Create deterministic ID for idempotency
        connection_key = f"{summary['sourceIp']}:{summary['sourcePort']}->{summary['destinationIp']}:{summary['destinationPort']}:{summary['protocol']}"
        summary['id'] = connection_key
        
        # Generate UUID for this specific summary (includes timestamp for uniqueness)
        uuid_input = f"{connection_key}:{summary['timestamp']}:{summary['totalBytes']}:{summary['totalPackets']}"
        summary['uuid'] = str(uuid.uuid5(uuid.NAMESPACE_DNS, uuid_input))
        
        # Add sequence number based on timestamp for sorting
        summary['sequenceNumber'] = int(datetime.fromisoformat(summary['timestamp'].replace('Z', '+00:00')).timestamp() * 1000000)
        
        processed_summaries.append(summary)
    
    return processed_summaries



def publish_to_appsync(summary):
    """Publish summary to AppSync GraphQL API"""
    try:
        import urllib3
        import urllib.parse
        
        mutation = '''
        mutation PublishVpcFlowSummary($input: VpcFlowSummaryInput!) {
            publishVpcFlowSummary(input: $input) {
                id
                sourceIp
                destinationIp
                totalBytes
                totalPackets
                connectionCount
                timestamp
            }
        }
        '''
        
        variables = {
            'input': {
                'uuid': summary['uuid'],
                'sequenceNumber': summary['sequenceNumber'],
                'sourceIp': summary['sourceIp'],
                'destinationIp': summary['destinationIp'],
                'sourcePort': summary['sourcePort'],
                'destinationPort': summary['destinationPort'],
                'protocol': summary['protocol'],
                'totalBytes': summary['totalBytes'],
                'totalPackets': summary['totalPackets'],
                'connectionCount': summary['connectionCount'],
                'acceptedCount': summary['acceptedCount'],
                'rejectedCount': summary['rejectedCount'],
                'firstSeen': summary['firstSeen'],
                'lastSeen': summary['lastSeen']
            }
        }
        
        payload = {
            'query': mutation,
            'variables': variables
        }
        
        # Use urllib3 for HTTP requests (available in Lambda runtime)
        http = urllib3.PoolManager()
        
        headers = {
            'Content-Type': 'application/json',
            'x-api-key': get_appsync_api_key()
        }
        
        response = http.request(
            'POST',
            APPSYNC_API_URL,
            body=json.dumps(payload),
            headers=headers
        )
        
        if response.status == 200:
            return True
        else:
            print(f"Error publishing to AppSync: {response.status} - {response.data}")
            return False
            
    except Exception as e:
        print(f"Error publishing to AppSync: {e}")
        return False

def delete_s3_file(bucket, key):
    """Delete processed file from S3"""
    try:
        s3_client.delete_object(Bucket=bucket, Key=key)
        print(f"Deleted processed file: s3://{bucket}/{key}")
    except Exception as e:
        print(f"Error deleting S3 file: {e}")
