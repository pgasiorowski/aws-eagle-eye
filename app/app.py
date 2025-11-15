from flask import Flask, jsonify, send_from_directory
import os
import boto3
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource('dynamodb')

app = Flask(__name__, static_folder='.')

VPC_LIST_TABLE_NAME = os.environ.get('VPC_LIST_TABLE_NAME')
VPC_MAP_TABLE_NAME = os.environ.get('VPC_MAP_TABLE_NAME')

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

@app.route('/api/vpc', methods=['GET'])
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
