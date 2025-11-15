from flask import Flask, jsonify, send_from_directory, request
import os
import sys
import json
import subprocess
import tempfile
import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

dynamodb = boto3.resource('dynamodb')
sts_client = boto3.client('sts')

app = Flask(__name__, static_folder='.')

VPC_LIST_TABLE_NAME = os.environ.get('VPC_LIST_TABLE_NAME')
VPC_MAP_TABLE_NAME = os.environ.get('VPC_MAP_TABLE_NAME')
IAM_CROSS_ACCOUNT_ROLE = os.environ.get('IAM_CROSS_ACCOUNT_ROLE')

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/js/<path:path>')
def serve_js(path):
    return send_from_directory('js', path)

@app.route('/css/<path:path>')
def serve_css(path):
    return send_from_directory('css', path)

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)

@app.route('/api/vpc', methods=['GET', 'POST'])
def vpcs():
    if request.method == 'GET':
        return get_vpcs()
    elif request.method == 'POST':
        return add_vpc()

def get_vpcs():
    try:
        if not VPC_LIST_TABLE_NAME:
            return jsonify({'error': 'VPC_LIST_TABLE_NAME not configured'}), 500

        table = dynamodb.Table(VPC_LIST_TABLE_NAME)
        response = table.scan()
        items = response.get('Items', [])
        
        print(f"Scanned {len(items)} items from {VPC_LIST_TABLE_NAME}")
        
        # Format the response
        vpcs = []
        for item in items:
            vpc_id = item.get('id', '')
            vpc_name = item.get('name', '')
            enabled = item.get('enabled', True)
            
            print(f"VPC: id={vpc_id}, name={vpc_name}, enabled={enabled}")
            
            vpcs.append({
                'id': vpc_id,
                'name': vpc_name,
                'enabled': enabled
            })
        
        return jsonify(vpcs)
    except Exception as e:
        print(f"Error in get_vpcs: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

def add_vpc():
    try:
        if not VPC_LIST_TABLE_NAME or not VPC_MAP_TABLE_NAME:
            return jsonify({'error': 'Database tables not configured'}), 500
        
        if not IAM_CROSS_ACCOUNT_ROLE:
            return jsonify({'error': 'IAM_CROSS_ACCOUNT_ROLE not configured'}), 500

        # Get JSON data from request
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        
        vpc_id = data.get('vpc_id', '').strip()
        account = data.get('account', '').strip()
        region = data.get('region', '').strip()
        
        # Validate required fields
        if not vpc_id or not account or not region:
            return jsonify({'error': 'vpc_id, account, and region are required'}), 400
        
        vpc_list_table = dynamodb.Table(VPC_LIST_TABLE_NAME)
        vpc_map_table = dynamodb.Table(VPC_MAP_TABLE_NAME)
        
        # Check if VPC already exists
        try:
            response = vpc_list_table.get_item(Key={'id': vpc_id})
            if 'Item' in response:
                return jsonify({'error': f'VPC {vpc_id} already exists'}), 409
        except ClientError as e:
            print(f"Error checking VPC existence: {e}")
            return jsonify({'error': 'Failed to check VPC existence'}), 500
        
        # Step 1: Assume cross-account role
        print(f"Assuming role {IAM_CROSS_ACCOUNT_ROLE} in account {account}")
        role_arn = f"arn:aws:iam::{account}:role/{IAM_CROSS_ACCOUNT_ROLE}"
        
        try:
            assumed_role = sts_client.assume_role(
                RoleArn=role_arn,
                RoleSessionName=f"vpc-discovery-{vpc_id}"
            )
            credentials = assumed_role['Credentials']
            print(f"Successfully assumed role in account {account}")
        except ClientError as e:
            print(f"Error assuming role: {e}")
            return jsonify({'error': f'Failed to assume role in account {account}: {str(e)}'}), 403
        
        # Step 2: Call gather.py with assumed credentials
        print(f"Gathering VPC data for {vpc_id} in {region}")
        
        # Create temporary file for output
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=False) as tmp_file:
            tmp_output = tmp_file.name
        
        try:
            # Set environment variables for the subprocess
            # Use assumed role credentials for reading VPC data
            env = os.environ.copy()
            env['AWS_ACCESS_KEY_ID'] = credentials['AccessKeyId']
            env['AWS_SECRET_ACCESS_KEY'] = credentials['SecretAccessKey']
            env['AWS_SESSION_TOKEN'] = credentials['SessionToken']
            env['AWS_DEFAULT_REGION'] = region
            # Don't set VPC_MAP_TABLE_NAME - we'll handle DynamoDB writes here with original credentials
            
            # Run gather.py with --dry-run to skip DynamoDB writes and --vpc-id to filter
            gather_script = os.path.join(os.path.dirname(__file__), 'gather.py')
            result = subprocess.run(
                [sys.executable, gather_script, '--dry-run', '--vpc-id', vpc_id, '--output', tmp_output],
                env=env,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            
            if result.returncode != 0:
                print(f"gather.py failed with return code {result.returncode}")
                print(f"STDOUT: {result.stdout}")
                print(f"STDERR: {result.stderr}")
                
                # Extract first error line from stderr for user-friendly message
                error_lines = result.stderr.strip().split('\n') if result.stderr else []
                error_msg = error_lines[-1] if error_lines else 'Unknown error'
                
                return jsonify({'error': f'Failed to gather VPC data: {error_msg}'}), 500
            
            print(f"gather.py completed successfully")
            
            # Step 3: Read the gathered data
            with open(tmp_output, 'r') as f:
                gather_data = json.load(f)
            
            # All interfaces should already be filtered for the VPC by gather.py
            vpc_interfaces = gather_data.get('network_interfaces', [])
            print(f"Found {len(vpc_interfaces)} network interfaces for VPC {vpc_id}")
            
            if not vpc_interfaces:
                return jsonify({'error': f'No network interfaces found for VPC {vpc_id}'}), 404
            
            # Step 4: Store data in VPC_MAP_TABLE_NAME using original credentials
            # (not the assumed role, which doesn't have access to our DynamoDB)
            print(f"Storing {len(vpc_interfaces)} interfaces in DynamoDB using original credentials")
            saved_count = 0
            
            for eni_data in vpc_interfaces:
                try:
                    # vpc_map_table uses the original dynamodb resource with original credentials
                    vpc_map_table.put_item(Item=eni_data)
                    saved_count += 1
                except ClientError as e:
                    print(f"Error saving ENI {eni_data.get('id')}: {e}")
            
            print(f"Successfully saved {saved_count} interfaces to DynamoDB")
            
            # Step 5: Get VPC name from VPC tags using assumed role
            vpc_name = vpc_id
            try:
                # Create EC2 client with assumed role credentials
                ec2_client = boto3.client(
                    'ec2',
                    region_name=region,
                    aws_access_key_id=credentials['AccessKeyId'],
                    aws_secret_access_key=credentials['SecretAccessKey'],
                    aws_session_token=credentials['SessionToken']
                )
                
                # Describe the VPC to get its tags
                vpc_response = ec2_client.describe_vpcs(VpcIds=[vpc_id])
                if vpc_response['Vpcs']:
                    vpc_tags = {tag['Key']: tag['Value'] for tag in vpc_response['Vpcs'][0].get('Tags', [])}
                    vpc_name = vpc_tags.get('Name', vpc_id)
                    print(f"Found VPC name from tags: {vpc_name}")
            except ClientError as e:
                print(f"Could not get VPC name from tags: {e}")
                vpc_name = f'{account}/{region}/{vpc_id}'
            
            # Step 6: Save VPC record in VPC_LIST_TABLE_NAME
            vpc_item = {
                'id': vpc_id,
                'name': vpc_name,
                'account_id': account,
                'region': region,
                'enabled': True  # Enable since we have data
            }
            
            vpc_list_table.put_item(Item=vpc_item)
            print(f"Saved VPC record: {vpc_id} with name '{vpc_name}'")
            
            return jsonify({
                'message': f'VPC {vpc_id} added successfully with {len(vpc_interfaces)} interfaces',
                'vpc': vpc_item
            }), 201
            
        finally:
            # Clean up temporary file
            try:
                os.unlink(tmp_output)
            except:
                pass
        
    except subprocess.TimeoutExpired:
        print(f"Timeout gathering VPC data")
        return jsonify({'error': 'Timeout gathering VPC data'}), 504
    except Exception as e:
        print(f"Error in add_vpc: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/vpc/<vpc_id>/refresh', methods=['POST'])
def refresh_vpc(vpc_id):
    """Refresh VPC data by re-gathering from AWS and updating DynamoDB."""
    try:
        if not VPC_LIST_TABLE_NAME or not VPC_MAP_TABLE_NAME:
            return jsonify({'error': 'Database tables not configured'}), 500
        
        if not IAM_CROSS_ACCOUNT_ROLE:
            return jsonify({'error': 'IAM_CROSS_ACCOUNT_ROLE not configured'}), 500
        
        vpc_list_table = dynamodb.Table(VPC_LIST_TABLE_NAME)
        vpc_map_table = dynamodb.Table(VPC_MAP_TABLE_NAME)
        
        # Get VPC record to find account and region
        try:
            response = vpc_list_table.get_item(Key={'id': vpc_id})
            if 'Item' not in response:
                return jsonify({'error': f'VPC {vpc_id} not found'}), 404
            
            vpc_record = response['Item']
            account = vpc_record.get('account_id')
            region = vpc_record.get('region')
            
            if not account or not region:
                return jsonify({'error': 'VPC record missing account_id or region'}), 500
        except ClientError as e:
            print(f"Error fetching VPC record: {e}")
            return jsonify({'error': 'Failed to fetch VPC record'}), 500
        
        # Assume cross-account role
        print(f"Refreshing VPC {vpc_id}: Assuming role {IAM_CROSS_ACCOUNT_ROLE} in account {account}")
        role_arn = f"arn:aws:iam::{account}:role/{IAM_CROSS_ACCOUNT_ROLE}"
        
        try:
            assumed_role = sts_client.assume_role(
                RoleArn=role_arn,
                RoleSessionName=f"vpc-refresh-{vpc_id}"
            )
            credentials = assumed_role['Credentials']
        except ClientError as e:
            print(f"Error assuming role: {e}")
            return jsonify({'error': f'Failed to assume role: {str(e)}'}), 403
        
        # Call gather.py
        print(f"Gathering fresh data for VPC {vpc_id}")
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.json', delete=False) as tmp_file:
            tmp_output = tmp_file.name
        
        try:
            env = os.environ.copy()
            env['AWS_ACCESS_KEY_ID'] = credentials['AccessKeyId']
            env['AWS_SECRET_ACCESS_KEY'] = credentials['SecretAccessKey']
            env['AWS_SESSION_TOKEN'] = credentials['SessionToken']
            env['AWS_DEFAULT_REGION'] = region
            
            gather_script = os.path.join(os.path.dirname(__file__), 'gather.py')
            result = subprocess.run(
                [sys.executable, gather_script, '--dry-run', '--vpc-id', vpc_id, '--output', tmp_output],
                env=env,
                capture_output=True,
                text=True,
                timeout=300
            )
            
            if result.returncode != 0:
                print(f"gather.py failed: {result.stderr}")
                error_lines = result.stderr.strip().split('\n') if result.stderr else []
                error_msg = error_lines[-1] if error_lines else 'Unknown error'
                return jsonify({'error': f'Failed to gather VPC data: {error_msg}'}), 500
            
            # Read gathered data
            with open(tmp_output, 'r') as f:
                gather_data = json.load(f)
            
            new_interfaces = gather_data.get('network_interfaces', [])
            print(f"Gathered {len(new_interfaces)} interfaces for VPC {vpc_id}")
            
            if not new_interfaces:
                return jsonify({'error': f'No network interfaces found for VPC {vpc_id}'}), 404
            
            # Delete old records and insert new ones using batch operations
            print(f"Deleting old records for VPC {vpc_id}")
            
            # Query existing records
            gsi_name = os.environ.get('VPC_MAP_GSI_NAME', 'vpc_id_idx')
            existing_response = vpc_map_table.query(
                IndexName=gsi_name,
                KeyConditionExpression=Key('vpc_id').eq(vpc_id)
            )
            existing_items = existing_response.get('Items', [])
            print(f"Found {len(existing_items)} existing records to delete")
            
            # Delete existing records in batches
            # Note: Table only has 'id' as primary key, not 'vpc_id'
            deleted_count = 0
            with vpc_map_table.batch_writer() as batch:
                for item in existing_items:
                    try:
                        batch.delete_item(Key={'id': item['id']})
                        deleted_count += 1
                    except Exception as e:
                        print(f"Error deleting item {item.get('id')}: {e}")
            
            print(f"Deleted {deleted_count} old records")
            
            # Insert new records in batches
            print(f"Inserting {len(new_interfaces)} new records")
            saved_count = 0
            with vpc_map_table.batch_writer() as batch:
                for eni_data in new_interfaces:
                    try:
                        batch.put_item(Item=eni_data)
                        saved_count += 1
                    except Exception as e:
                        print(f"Error saving ENI {eni_data.get('id')}: {e}")
            
            print(f"Saved {saved_count} new records")
            
            # Update VPC name if it changed
            try:
                ec2_client = boto3.client(
                    'ec2',
                    region_name=region,
                    aws_access_key_id=credentials['AccessKeyId'],
                    aws_secret_access_key=credentials['SecretAccessKey'],
                    aws_session_token=credentials['SessionToken']
                )
                
                vpc_response = ec2_client.describe_vpcs(VpcIds=[vpc_id])
                if vpc_response['Vpcs']:
                    vpc_tags = {tag['Key']: tag['Value'] for tag in vpc_response['Vpcs'][0].get('Tags', [])}
                    vpc_name = vpc_tags.get('Name', vpc_id)
                    
                    # Update VPC record with new name
                    vpc_list_table.update_item(
                        Key={'id': vpc_id},
                        UpdateExpression='SET #name = :name',
                        ExpressionAttributeNames={'#name': 'name'},
                        ExpressionAttributeValues={':name': vpc_name}
                    )
                    print(f"Updated VPC name to: {vpc_name}")
            except Exception as e:
                print(f"Could not update VPC name: {e}")
            
            return jsonify({
                'message': f'VPC {vpc_id} refreshed successfully',
                'deleted': deleted_count,
                'added': saved_count
            }), 200
            
        finally:
            try:
                os.unlink(tmp_output)
            except:
                pass
    
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'Timeout refreshing VPC data'}), 504
    except Exception as e:
        print(f"Error in refresh_vpc: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/vpc/<vpc_id>', methods=['GET'])
def get_vpc_details(vpc_id):
    try:
        if not VPC_MAP_TABLE_NAME:
            return jsonify({'error': 'VPC_MAP_TABLE_NAME not configured'}), 500

        gsi_name = os.environ.get('VPC_MAP_GSI_NAME', 'vpc_id_idx')
        
        table = dynamodb.Table(VPC_MAP_TABLE_NAME)
        response = table.query(
            IndexName=gsi_name,
            KeyConditionExpression=Key('vpc_id').eq(vpc_id)
        )

        print('-------')
        print(response)
        
        items = response.get('Items', [])
        
        if not items:
            return jsonify({'error': 'VPC not found'}), 404
        
        # Return in the expected format with network_interfaces array
        result = {
            'vpc_id': vpc_id,
            'network_interfaces': items,
            'metadata': {
                'count': len(items),
                'vpc_id': vpc_id
            }
        }
        
        return jsonify(result)
    except Exception as e:
        print(f"Error in get_vpc_details for {vpc_id}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
