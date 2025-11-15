from flask import Flask, jsonify, send_from_directory
import os
import boto3
from boto3.dynamodb.conditions import Key

app = Flask(__name__, static_folder='.')

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('.', path)

@app.route('/api/vpc', methods=['GET'])
def get_vpcs():
    try:
        table_name = os.environ.get('VPC_LIST_TABLE_NAME')
        if not table_name:
            return jsonify({'error': 'VPC_LIST_TABLE_NAME not configured'}), 500
        
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(table_name)
        
        response = table.scan()
        items = response.get('Items', [])
        
        # Format the response
        vpcs = []
        for item in items:
            vpcs.append({
                'id': item.get('vpc_id', ''),
                'name': item.get('name', ''),
                'enabled': item.get('enabled', True)
            })
        
        return jsonify(vpcs)
    except Exception as e:
        print(e)
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)
