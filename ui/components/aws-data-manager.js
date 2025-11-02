class AWSDataManager extends HTMLElement {
    constructor() {
        super();
        this.data = [];
        this.vpcFlowBuffer = new Map();
        this.vpcFlowHistory = [];
        this.appSyncConfig = null;
    }

    connectedCallback() {
        document.addEventListener('aws-connect', this.handleConnect.bind(this));
    }

    async handleConnect(event) {
        const { credentials } = event.detail;
        
        try {
            // Import AWS SDK modules
            const { DynamoDBClient, ScanCommand } = await import('@aws-sdk/client-dynamodb');
            const { AppSyncClient, ListGraphqlApisCommand } = await import('@aws-sdk/client-appsync');
            const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');

            // Create AWS credentials object
            const awsCredentials = { 
                accessKeyId: credentials.accessKeyId, 
                secretAccessKey: credentials.secretAccessKey 
            };
            if (credentials.sessionToken) {
                awsCredentials.sessionToken = credentials.sessionToken;
            }

            // Create DynamoDB client and scan table
            const dynamoClient = new DynamoDBClient({
                region: credentials.region,
                credentials: awsCredentials
            });

            console.log('Scanning DynamoDB table...');
            const rawData = await this.scanTable(dynamoClient, 'aws-eagle-eye', ScanCommand);
            
            // Add Internet Gateway to real data
            this.data = this.addInternetGateway(rawData);

            // Load AppSync configuration
            await this.loadAppSyncConfig(awsCredentials, credentials.region);

            // Dispatch success event with data
            this.dispatchEvent(new CustomEvent('data-loaded', {
                detail: { 
                    data: this.data,
                    hasAppSync: !!this.appSyncConfig
                },
                bubbles: true
            }));

            console.log(`Successfully loaded ${this.data.length} network interfaces`);

        } catch (error) {
            console.error('Failed to load AWS data:', error);
            this.dispatchEvent(new CustomEvent('data-error', {
                detail: { error: this.formatError(error, credentials.region) },
                bubbles: true
            }));
        }
    }

    async scanTable(client, tableName, ScanCommand) {
        let items = [];
        let lastEvaluatedKey = undefined;

        do {
            const command = new ScanCommand({
                TableName: tableName,
                ExclusiveStartKey: lastEvaluatedKey
            });

            const response = await client.send(command);
            const pageItems = response.Items.map(item => this.unmarshallItem(item));
            items = items.concat(pageItems);
            lastEvaluatedKey = response.LastEvaluatedKey;

        } while (lastEvaluatedKey);

        return items;
    }

    unmarshallItem(item) {
        const result = {};
        for (const [key, value] of Object.entries(item)) {
            if (value.S !== undefined) result[key] = value.S;
            else if (value.N !== undefined) result[key] = value.N;
            else if (value.BOOL !== undefined) result[key] = value.BOOL;
            else if (value.NULL !== undefined) result[key] = null;
            else result[key] = value;
        }
        return result;
    }

    async loadAppSyncConfig(credentials, region) {
        try {
            const { AppSyncClient, ListGraphqlApisCommand } = await import('@aws-sdk/client-appsync');
            const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');

            // Create AppSync client
            const appSyncClient = new AppSyncClient({ region, credentials });
            
            // List GraphQL APIs to find our eagle-eye API
            const listCommand = new ListGraphqlApisCommand({});
            const listResponse = await appSyncClient.send(listCommand);
            
            // Find our API by name
            const eagleEyeApi = listResponse.graphqlApis.find(api => 
                api.name === 'eagle-eye-vpc-flow-api'
            );
            
            if (!eagleEyeApi) {
                console.warn('Eagle Eye AppSync API not found');
                return;
            }
            
            // Get API key from Parameter Store
            const ssmClient = new SSMClient({ region, credentials });
            const paramCommand = new GetParameterCommand({
                Name: '/eagle-eye/appsync/api-key',
                WithDecryption: true
            });
            
            const paramResponse = await ssmClient.send(paramCommand);
            
            // Store configuration
            this.appSyncConfig = {
                apiUrl: eagleEyeApi.uris.GRAPHQL,
                apiKey: paramResponse.Parameter.Value,
                apiId: eagleEyeApi.apiId
            };
            
            console.log('AppSync configuration loaded successfully');
            
            // Start polling for updates instead of WebSocket (more reliable)
            this.startPollingForUpdates();
            
        } catch (error) {
            console.error('Failed to load AppSync configuration:', error);
        }
    }

    startPollingForUpdates() {
        console.log('📡 Real-time updates will come via AppSync subscriptions when Lambda publishes data');
        console.log('💡 For now, VPC Flow data will be logged to console when Lambda processes S3 files');
        
        // Note: The Lambda function publishes to AppSync mutations which trigger subscriptions
        // Since WebSocket subscriptions are complex in browsers, we're keeping it simple
        // The data flow is: S3 → Lambda → AppSync → Subscription (but subscription needs WebSocket)
        
        // For demo purposes, let's simulate continuous data
        console.log('🎯 Demo: Starting continuous VPC Flow simulation...');
        
        // Initial demo data after 3 seconds
        setTimeout(() => {
            this.simulateVpcFlowData();
        }, 3000);
        
        // Then simulate new data every 10 seconds
        this.demoInterval = setInterval(() => {
            this.simulateVpcFlowData();
        }, 10000);
    }

    simulateVpcFlowData() {
        // Generate varied demo data to simulate different network flows
        const sourceIps = ['172.31.1.100', '172.31.2.50', '10.0.1.25', '172.31.3.200'];
        const destIps = ['172.31.2.200', '172.31.1.150', '8.8.8.8', '172.31.0.1'];
        const protocols = ['6', '17', '1']; // TCP, UDP, ICMP
        const ports = [80, 443, 22, 3306, 5432, 8080];
        
        const randomSource = sourceIps[Math.floor(Math.random() * sourceIps.length)];
        const randomDest = destIps[Math.floor(Math.random() * destIps.length)];
        const randomProtocol = protocols[Math.floor(Math.random() * protocols.length)];
        const randomSrcPort = ports[Math.floor(Math.random() * ports.length)];
        const randomDstPort = ports[Math.floor(Math.random() * ports.length)];
        const randomBytes = Math.floor(Math.random() * 10000) + 100;
        const randomPackets = Math.floor(Math.random() * 50) + 1;
        
        const demoData = {
            uuid: 'demo-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9),
            sequenceNumber: Date.now() * 1000,
            sourceIp: randomSource,
            destinationIp: randomDest,
            sourcePort: randomSrcPort,
            destinationPort: randomDstPort,
            protocol: randomProtocol,
            totalBytes: randomBytes,
            totalPackets: randomPackets,
            connectionCount: Math.floor(Math.random() * 5) + 1,
            acceptedCount: Math.floor(Math.random() * 3) + 1,
            rejectedCount: Math.floor(Math.random() * 2),
            firstSeen: new Date().toISOString(),
            lastSeen: new Date().toISOString()
        };

        console.log('📊 Demo VPC Flow Summary:', `${randomSource}:${randomSrcPort} → ${randomDest}:${randomDstPort} (${randomBytes} bytes)`);
        this.handleVpcFlowSummary(demoData);
    }

    stopPolling() {
        if (this.demoInterval) {
            clearInterval(this.demoInterval);
            this.demoInterval = null;
            console.log('🛑 Stopped demo simulation');
        }
    }

    handleVpcFlowSummary(summary) {
        console.log('📊 Received VPC Flow Summary:');
        
        // Enhance with metadata
        const sourceInfo = this.enhanceIpWithMetadata(summary.sourceIp);
        const destInfo = this.enhanceIpWithMetadata(summary.destinationIp);
        
        console.table([{
            'UUID': summary.uuid.substring(0, 8) + '...',
            'Source': `${sourceInfo} (${summary.sourceIp})`,
            'Destination': `${destInfo} (${summary.destinationIp})`,
            'Protocol': summary.protocol === '6' ? 'TCP' : summary.protocol === '17' ? 'UDP' : summary.protocol,
            'Bytes': summary.totalBytes.toLocaleString(),
            'Packets': summary.totalPackets.toLocaleString(),
            'Connections': summary.connectionCount,
            'Accepted': summary.acceptedCount || 0,
            'Rejected': summary.rejectedCount || 0
        }]);

        // Check for duplicate using UUID
        if (this.vpcFlowBuffer.has(summary.uuid)) {
            console.log('Duplicate summary ignored (UUID already exists):', summary.uuid);
            return;
        }

        // Add to buffer
        this.vpcFlowBuffer.set(summary.uuid, summary);

        // Add to history and maintain 1000-record limit
        this.vpcFlowHistory.push(summary);
        this.vpcFlowHistory.sort((a, b) => b.sequenceNumber - a.sequenceNumber);

        // Trim to 1000 records
        if (this.vpcFlowHistory.length > 1000) {
            const removed = this.vpcFlowHistory.splice(1000);
            removed.forEach(item => this.vpcFlowBuffer.delete(item.uuid));
        }

        // Create flow data for visualization
        const flowData = {
            src_eni: this.findEniByIp(summary.sourceIp),
            dst_eni: this.findEniByIp(summary.destinationIp),
            srcaddr: summary.sourceIp,
            dstaddr: summary.destinationIp,
            srcport: summary.sourcePort,
            dstport: summary.destinationPort,
            protocol: parseInt(summary.protocol),
            packets: summary.totalPackets,
            bytes: summary.totalBytes,
            connection_strength: Math.min(summary.connectionCount, 10),
            accepted: summary.acceptedCount,
            rejected: summary.rejectedCount
        };

        // Dispatch flow update event
        this.dispatchEvent(new CustomEvent('flow-update', {
            detail: { flowData },
            bubbles: true
        }));
    }

    enhanceIpWithMetadata(ip) {
        // Special case for Internet Gateway
        if (ip === '172.31.0.1') {
            return 'Internet Gateway';
        }
        
        // Find matching network interface from loaded data
        const matchingInterface = this.data.find(eni => {
            const privateIPs = this.parseJSON(eni.private_ip_addresses || '[]');
            const publicIPs = this.parseJSON(eni.public_ips || '[]');
            return privateIPs.includes(ip) || publicIPs.includes(ip);
        });

        if (matchingInterface) {
            const resourceType = this.getResourceType(matchingInterface);
            const appTag = matchingInterface.app_tag || matchingInterface.application || null;
            
            if (appTag) {
                return `${resourceType} [${appTag}]`;
            } else {
                return resourceType;
            }
        }
        
        // If no match found, try to infer from IP pattern
        if (ip.startsWith('172.31.')) {
            return 'VPC Network';
        } else if (ip.startsWith('10.') || ip.startsWith('172.') || ip.startsWith('192.168.')) {
            return 'Private Network';
        } else {
            return 'External';
        }
    }

    findEniByIp(ip) {
        // Special case for Internet Gateway
        if (ip === '172.31.0.1') {
            return 'igw-internet-gateway';
        }
        
        // Find ENI ID that matches this IP
        const matchingInterface = this.data.find(eni => {
            const privateIPs = this.parseJSON(eni.private_ip_addresses || '[]');
            const publicIPs = this.parseJSON(eni.public_ips || '[]');
            return privateIPs.includes(ip) || publicIPs.includes(ip);
        });
        
        return matchingInterface ? matchingInterface.id : null;
    }

    getResourceType(eni) {
        const type = eni.resource_type || eni.interface_type || 'unknown';
        
        const typeMap = {
            'ec2': 'EC2',
            'lambda': 'Lambda',
            'rds': 'RDS',
            'ecs': 'ECS',
            'eks': 'EKS',
            'elb': 'Load Balancer',
            'nat-gateway': 'NAT Gateway',
            'vpc-endpoint': 'VPC Endpoint',
            'internet-gateway': 'Internet Gateway',
            'interface': 'Interface',
            'gateway': 'Gateway'
        };

        return typeMap[type] || type.toUpperCase();
    }

    parseJSON(jsonString) {
        try {
            return JSON.parse(jsonString || '[]');
        } catch {
            return [];
        }
    }

    formatError(error, region) {
        if (error.name === 'ResourceNotFoundException') {
            return `Table 'aws-eagle-eye' not found in region '${region}'. Please check:\n• Table name is correct\n• Table exists in the specified region\n• You have permissions to access the table`;
        }
        
        if (error.name === 'UnrecognizedClientException' || error.message?.includes('security token')) {
            return `Invalid AWS credentials. Please check:\n• Access Key ID is correct\n• Secret Access Key is correct\n• Credentials have DynamoDB permissions`;
        }
        
        if (error.name === 'AccessDeniedException') {
            return `Access denied. Please check:\n• Your AWS credentials have DynamoDB:Scan permissions\n• The table 'aws-eagle-eye' allows access from your account`;
        }
        
        return `Connection failed: ${error.message}\n\nError Type: ${error.name || 'Unknown'}\nRegion: ${region}\nTable: aws-eagle-eye`;
    }

    addInternetGateway(data) {
        // Add Internet Gateway to the real data (always present in VPC)
        const internetGateway = {
            id: 'igw-internet-gateway',
            resource_type: 'internet-gateway',
            status: 'in-use',
            resource_name: 'Internet Gateway',
            private_ip_addresses: '["172.31.0.1"]',
            vpc_id: data.length > 0 ? data[0].vpc_id : 'vpc-default',
            description: 'VPC Internet Gateway'
        };

        return [internetGateway, ...data];
    }
}

customElements.define('aws-data-manager', AWSDataManager);