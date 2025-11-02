class NetworkVisualization extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.data = [];
        this.flowLogs = [];
        this.interfacePositions = new Map();
        this.showFlows = false;
    }

    connectedCallback() {
        this.render();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 100%;
                    height: 100%;
                    position: relative;
                    background: #000000;
                    overflow: hidden;
                }

                .layer-title {
                    position: absolute;
                    top: 0.5rem;
                    left: 1rem;
                    font-size: 0.8rem;
                    color: #00cc33;
                    text-transform: uppercase;
                    z-index: 10;
                }

                .network-interfaces {
                    position: relative;
                    width: 100%;
                    height: 100%;
                    padding-top: 2rem;
                }

                .network-svg {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                    background: radial-gradient(circle at center, rgba(0, 26, 0, 0.3), transparent 70%);
                }

                @keyframes flowDash {
                    to { stroke-dashoffset: -10; }
                }
            </style>

            <div class="layer-title">Application Network Interfaces</div>
            <div class="network-interfaces" id="applicationInterfaces">
                <svg class="network-svg" id="networkSvg">
                    <!-- Flow connections will be drawn here -->
                </svg>
                <!-- Network interface nodes will be positioned here -->
            </div>
        `;
    }

    setData(data) {
        this.data = data;
        this.renderInterfaces();
    }

    addFlowLog(flowData) {
        this.flowLogs.push(flowData);
        
        // Keep only recent flows (last 50)
        if (this.flowLogs.length > 50) {
            this.flowLogs = this.flowLogs.slice(-50);
        }

        // Auto-enable flows when we receive real data
        if (!this.showFlows) {
            this.showFlows = true;
        }
        
        this.renderFlowConnections();
    }

    renderInterfaces() {
        if (!this.data.length) return;

        const container = this.shadowRoot.getElementById('applicationInterfaces');
        const containerRect = container.getBoundingClientRect();
        
        const width = containerRect.width;
        const height = containerRect.height;
        const centerX = width / 2;
        const centerY = height / 2;
        const radius = Math.min(width, height) / 2 - 100;

        // Clear existing visualization
        const svg = d3.select(this.shadowRoot.getElementById('networkSvg'))
            .attr('width', width)
            .attr('height', height);

        svg.selectAll('*').remove();

        // Create main group centered
        const g = svg.append('g')
            .attr('transform', `translate(${centerX},${centerY})`);

        // Draw concentric circles (background rings)
        const numRings = 5;
        for (let i = 1; i <= numRings; i++) {
            g.append('circle')
                .attr('r', (radius / numRings) * i)
                .attr('fill', 'none')
                .attr('stroke', '#00ff41')
                .attr('stroke-width', 0.5)
                .attr('opacity', 0.1 + (i * 0.02));
        }

        // Draw radial lines
        const numLines = 36;
        for (let i = 0; i < numLines; i++) {
            const angle = (i / numLines) * 2 * Math.PI;
            g.append('line')
                .attr('x1', 0)
                .attr('y1', 0)
                .attr('x2', Math.cos(angle) * radius)
                .attr('y2', Math.sin(angle) * radius)
                .attr('stroke', '#00ff41')
                .attr('stroke-width', 0.3)
                .attr('opacity', 0.05);
        }

        // Position nodes around the circle
        this.interfacePositions.clear();
        const angleStep = (2 * Math.PI) / this.data.length;

        this.data.forEach((eni, i) => {
            const angle = i * angleStep - Math.PI / 2;
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;

            // Store position
            this.interfacePositions.set(eni.id, { 
                x: x + centerX, 
                y: y + centerY, 
                angle: angle,
                resourceType: eni.resource_type 
            });

            // Draw node
            const color = this.getResourceColor(eni.resource_type);
            
            const nodeGroup = g.append('g')
                .attr('transform', `translate(${x},${y})`)
                .attr('class', 'node-group')
                .style('cursor', 'pointer')
                .on('click', () => this.selectInterface(eni));

            // Outer glow circle
            nodeGroup.append('circle')
                .attr('r', 25)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', 1)
                .attr('opacity', 0.2);

            // Main node shape
            if (eni.resource_type === 'internet-gateway') {
                // Diamond shape for Internet Gateway
                nodeGroup.append('polygon')
                    .attr('points', '0,-18 18,0 0,18 -18,0')
                    .attr('fill', color)
                    .attr('fill-opacity', 0.3)
                    .attr('stroke', color)
                    .attr('stroke-width', 3)
                    .style('filter', 'drop-shadow(0 0 12px ' + color + ')');
            } else {
                // Regular circle for other resources
                nodeGroup.append('circle')
                    .attr('r', 15)
                    .attr('fill', color)
                    .attr('fill-opacity', 0.2)
                    .attr('stroke', color)
                    .attr('stroke-width', 2)
                    .style('filter', 'drop-shadow(0 0 8px ' + color + ')');
            }

            // Status indicator
            nodeGroup.append('circle')
                .attr('r', 4)
                .attr('cx', 10)
                .attr('cy', -10)
                .attr('fill', eni.status === 'in-use' ? '#00ff41' : '#ffff00')
                .style('filter', 'drop-shadow(0 0 4px currentColor)');

            // Label
            const resourceType = this.getResourceType(eni);
            nodeGroup.append('text')
                .attr('y', -20)
                .attr('text-anchor', 'middle')
                .attr('fill', color)
                .attr('font-size', '10px')
                .attr('font-weight', 'bold')
                .text(resourceType);

            // IP Address
            const privateIPs = this.parseJSON(eni.private_ip_addresses || '[]');
            const publicIPs = this.parseJSON(eni.public_ips || '[]');
            const displayIP = privateIPs[0] || publicIPs[0] || 'No IP';
            
            nodeGroup.append('text')
                .attr('y', 30)
                .attr('text-anchor', 'middle')
                .attr('fill', color)
                .attr('font-size', '8px')
                .attr('opacity', 0.7)
                .text(displayIP);
        });

        // Render flow connections if enabled
        if (this.showFlows && this.flowLogs.length > 0) {
            this.renderFlowConnectionsD3(g, centerX, centerY);
        }
    }

    renderFlowConnections() {
        if (!this.flowLogs.length) return;
        
        const container = this.shadowRoot.getElementById('applicationInterfaces');
        const containerRect = container.getBoundingClientRect();
        const centerX = containerRect.width / 2;
        const centerY = containerRect.height / 2;

        const svg = d3.select(this.shadowRoot.getElementById('networkSvg'));
        const g = svg.select('g');

        this.renderFlowConnectionsD3(g, centerX, centerY);
    }

    renderFlowConnectionsD3(g, centerX, centerY) {
        // Remove existing connections
        g.selectAll('.flow-path').remove();

        // Create connection group (render behind nodes)
        const connectionGroup = g.insert('g', ':first-child')
            .attr('class', 'connections');

        this.flowLogs.forEach(flow => {
            const srcPos = this.interfacePositions.get(flow.src_eni);
            const dstPos = this.interfacePositions.get(flow.dst_eni);

            if (srcPos && dstPos) {
                // Convert to relative coordinates
                const sx = srcPos.x - centerX;
                const sy = srcPos.y - centerY;
                const dx = dstPos.x - centerX;
                const dy = dstPos.y - centerY;

                // Create curved path using D3's path generator
                const path = d3.path();
                path.moveTo(sx, sy);

                // Calculate control point for smooth curve
                const midX = (sx + dx) / 2;
                const midY = (sy + dy) / 2;
                
                const distFromCenter = Math.sqrt(midX * midX + midY * midY);
                const curveFactor = Math.min(distFromCenter * 0.3, 100);
                
                const controlX = midX * (1 - curveFactor / distFromCenter);
                const controlY = midY * (1 - curveFactor / distFromCenter);

                path.quadraticCurveTo(controlX, controlY, dx, dy);

                // Enhanced color and styling based on accepted/rejected status
                const color = this.getEnhancedFlowColor(flow);
                const width = Math.max(1, Math.min(flow.connection_strength / 1.5, 5));
                const opacity = Math.max(0.3, Math.min(flow.connection_strength / 8, 0.8));

                // Draw the path with enhanced styling
                const pathElement = connectionGroup.append('path')
                    .attr('class', 'flow-path')
                    .attr('d', path.toString())
                    .attr('fill', 'none')
                    .attr('stroke', color)
                    .attr('stroke-width', width)
                    .attr('opacity', opacity)
                    .style('filter', 'drop-shadow(0 0 3px ' + color + ')');

                // Add different dash patterns based on status
                if (flow.rejected && flow.rejected > 0) {
                    pathElement.style('stroke-dasharray', '8,4');
                } else {
                    pathElement.style('stroke-dasharray', '12,2');
                }

                // Enhanced tooltip
                pathElement.append('title')
                    .text(`${flow.srcaddr}:${flow.srcport} → ${flow.dstaddr}:${flow.dstport}\n` +
                          `Protocol: ${flow.protocol === 6 ? 'TCP' : flow.protocol === 17 ? 'UDP' : flow.protocol}\n` +
                          `Packets: ${flow.packets}, Bytes: ${flow.bytes}\n` +
                          `Accepted: ${flow.accepted || 0}, Rejected: ${flow.rejected || 0}\n` +
                          `Strength: ${flow.connection_strength}/10`);

                // Add animation with different speeds based on status
                const animationSpeed = flow.rejected > 0 ? 4 : (3 - flow.connection_strength / 5);
                pathElement.style('animation', `flowDash ${animationSpeed}s linear infinite`);
            }
        });
    }

    selectInterface(eni) {
        this.dispatchEvent(new CustomEvent('interface-selected', {
            detail: { interface: eni },
            bubbles: true
        }));
    }

    getResourceColor(type) {
        const colors = {
            'ec2': '#00ff00',
            'lambda': '#00ffff', 
            'rds': '#ff00ff',
            'ecs': '#ffff00',
            'eks': '#ffaa00',
            'elb': '#ff6600',
            'nat-gateway': '#0088ff',
            'vpc-endpoint': '#8800ff',
            'internet-gateway': '#ff4444',
            'interface': '#00ff41',
            'gateway': '#ff8800'
        };
        return colors[type] || '#00ff41';
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

    getEnhancedFlowColor(flow) {
        const hasRejected = flow.rejected && flow.rejected > 0;
        
        if (hasRejected) {
            // Red spectrum for flows with rejected traffic
            if (flow.connection_strength > 8) return '#ff4444';
            if (flow.connection_strength > 6) return '#ff6666';
            if (flow.connection_strength > 4) return '#cc4444';
            return '#884444';
        } else {
            // Green spectrum for accepted-only traffic
            if (flow.protocol === 6) { // TCP
                if (flow.connection_strength > 8) return '#00ff88';
                if (flow.connection_strength > 6) return '#00ff41';
                if (flow.connection_strength > 4) return '#00cc33';
                return '#008822';
            } else if (flow.protocol === 17) { // UDP
                if (flow.connection_strength > 8) return '#00ffff';
                if (flow.connection_strength > 6) return '#00ccff';
                if (flow.connection_strength > 4) return '#0099cc';
                return '#006699';
            } else {
                // Other protocols - blue spectrum for accepted
                if (flow.connection_strength > 8) return '#4488ff';
                if (flow.connection_strength > 6) return '#6699ff';
                if (flow.connection_strength > 4) return '#4466cc';
                return '#334499';
            }
        }
    }

    parseJSON(jsonString) {
        try {
            return JSON.parse(jsonString || '[]');
        } catch {
            return [];
        }
    }
}

customElements.define('network-visualization', NetworkVisualization);