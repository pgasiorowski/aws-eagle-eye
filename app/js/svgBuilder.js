import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7/+esm';
import { STATUS_COLORS } from './constants.js';

export class SVGBuilder {
    constructor(circleR = 250) {
        this.circleR = circleR;
        this.groupOuterR = circleR;
        this.groupInnerR = circleR - 4;
        this.rectR = circleR + 10;
        this.svgSize = (circleR * 2 + 50) * 1.2;
    }

    calculateMaxRadius(ranges, groupAngleRanges) {
        const rectRadial = 16;
        const rowRadiusStep = rectRadial + 4;
        const rectTangential = 34;
        const iface1pxMargin = 2;
        let maxRadius = this.rectR;
        
        groupAngleRanges.forEach((groupRange) => {
            if (!groupRange) return;
            
            const { ifaceIndices } = groupRange;
            if (ifaceIndices.length > 0) {
                const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
                const maxIfacesPerRow = Math.floor(groupRange.angularSpan / rectAngularWidth);
                const maxRow = Math.floor((ifaceIndices.length - 1) / maxIfacesPerRow);
                const groupMaxRadius = this.rectR + maxRow * rowRadiusStep;
                // Label radius is groupMaxRadius + 30, and interfaces can extend further
                const labelR = groupMaxRadius + 30;
                // Add some margin for interface width extension (topArcExtend)
                const interfaceExtension = (maxRow * 3) / 2;
                const totalRadius = labelR + interfaceExtension + 20; // extra 20 for safety
                maxRadius = Math.max(maxRadius, totalRadius);
            }
        });
        
        return maxRadius;
    }

    create(maxRadius = null) {
        // If maxRadius is provided, use it to calculate viewBox, otherwise use default
        const effectiveRadius = maxRadius || (this.circleR + 100);
        const baseSize = effectiveRadius * 2 + 100; // Add padding
        // Increase viewBox to ensure all content fits in viewport
        // Larger viewBox = smaller content display, but everything visible
        const svgSize = baseSize * 1.1; // Increase viewBox to 110% to ensure everything fits
        
        const svg = d3.create('svg:svg')
            .attr('viewBox', `${-svgSize/2} ${-svgSize/2} ${svgSize} ${svgSize}`)
            .attr('width', '100%')
            .attr('height', '100%')
            .style('display', 'block')
            .attr('part', 'svg');
        
        // Create a container group for zoom/pan transformations
        const container = svg.append('g').attr('class', 'zoom-container');
        
        // Setup zoom behavior
        const zoom = d3.zoom()
            .scaleExtent([0.5, 5]) // Min zoom 0.5x, max zoom 5x
            .on('zoom', (event) => {
                container.attr('transform', event.transform);
            });
        
        svg.call(zoom);
        
        // Store container reference for later use
        svg.node().zoomContainer = container;
        
        return svg;
    }

    renderInterfaces(svg, ranges, interfaces, groupAngleRanges, trafficData = [], ipToInterfaceMap = new Map()) {
        const rectTangential = 34;
        const rectRadial = 16;

        // Tooltip will be created later, after all other elements
        // Store reference to create it later
        this.tooltip = null;
        
        const svgNode = svg.node();
        
        // Store references for highlighting
        this.svg = svg;
        this.interfaces = interfaces;
        this.trafficData = trafficData;
        this.ipToInterfaceMap = ipToInterfaceMap;
        this.selectedInterfaceId = null; // Track selected interface

        // Helper function to get symbol for interface type
        const getTypeSymbol = (type) => {
            switch (type) {
                case 'igw': return 'IGW';
                case 'dns': return 'DNS';
                case 'vgw': return 'VGW';
                case 'peering': return 'PX';
                case 'endpoint': return 'E';
                default: return null;
            }
        };

        ranges.forEach((r, groupIdx) => {
            const groupRange = groupAngleRanges[groupIdx];
            if (!groupRange) return;
            
            const { ifaceIndices, startAngle: groupStartAngle, angularSpan } = groupRange;
            
            const groupIfaceG = svg.append('g')
                .attr('class', 'group')
                .attr('data-group', r.group.id);
            
            const iface1pxMargin = 2;
            const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
            const maxIfacesPerRowUnlimited = Math.floor(angularSpan / rectAngularWidth);
            // Limit to maximum 10 interfaces in sector 1 (first row)
            const maxIfacesPerRow = Math.min(maxIfacesPerRowUnlimited, 10);
            const rowRadiusStep = rectRadial + 4;
            
            const ifaceData = ifaceIndices.map((i, localIdx) => {
                const row = Math.floor(localIdx / maxIfacesPerRow);
                const posInRow = localIdx % maxIfacesPerRow;
                
                const rectStartAngle = groupStartAngle + posInRow * rectAngularWidth;
                const rectCenterAngle = rectStartAngle + (rectTangential / 2) / this.rectR;
                
                const iface_rectR = this.rectR + row * rowRadiusStep;
                
                return { index: i, angle: rectCenterAngle, radius: iface_rectR, row: row };
            });

            // Sector 0: copy of first row (row === 0) only, at ring position (closer to center), with reduced height
            const sector0Data = ifaceData
                .filter(d => d.row === 0)  // Only first row
                .map(d => ({
                    ...d,
                    radius: this.groupOuterR - 3  // 3px closer to center than ring position
                }));

            // Sector 0 height: 30% of normal height
            const sector0Radial = rectRadial * 0.3;

            // Render Sector 0 first (gray, at ring distance, reduced height)
            const sector0Groups = groupIfaceG.selectAll('g.sector0-iface')
                .data(sector0Data)
                .join('g')
                .attr('class', 'sector0-iface')
                .attr('data-idx', d => d.index)
                .attr('data-iface-id', d => interfaces[d.index]?.id)
                .attr('transform', d => {
                    const ang = d.angle * 180 / Math.PI;
                    return `rotate(${ang}) translate(${d.radius},0) rotate(90)`;
                });

            sector0Groups.append('path')
                .attr('class', 'sector0-path')
                .attr('d', d => this.generateInterfacePath(d, rectTangential, sector0Radial))
                .attr('fill', '#999')  // Gray color
                .attr('stroke', '#fff')
                .attr('stroke-width', 0.5)
                .attr('opacity', 0.5)
                .style('pointer-events', 'none');  // No interactions for sector 0

            // Symbols removed from sector0 - no labels in sector 0

            // Render Sector 1 (normal interfaces)
            const ifaceGroups = groupIfaceG.selectAll('g.iface')
                .data(ifaceData)
                .join('g')
                .attr('class', 'iface')
                .attr('data-idx', d => d.index)
                .attr('data-iface-id', d => interfaces[d.index]?.id)
                .attr('transform', d => {
                    const ang = d.angle * 180 / Math.PI;
                    return `rotate(${ang}) translate(${d.radius},0) rotate(90)`;
                });

            // Add highlight outline (initially hidden)
            ifaceGroups.append('path')
                .attr('class', 'iface-highlight')
                .attr('d', d => this.generateInterfacePath(d, rectTangential, rectRadial))
                .attr('fill', 'none')
                .attr('stroke', '#ffff00')
                .attr('stroke-width', 3)
                .attr('opacity', 0)
                .style('pointer-events', 'none');

            // Add interface path
            ifaceGroups.append('path')
                .attr('class', 'iface-path')
                .attr('d', d => this.generateInterfacePath(d, rectTangential, rectRadial))
                .attr('fill', d => STATUS_COLORS[interfaces[d.index]?.status] || STATUS_COLORS.good)
                .attr('stroke', '#fff')
                .attr('stroke-width', 0.5)
                .attr('opacity', 0.75)
                .style('cursor', 'pointer');
            
            // Add symbols for special interface types
            ifaceGroups.each(function(d) {
                const iface = interfaces[d.index];
                const symbol = getTypeSymbol(iface?.type);
                if (symbol) {
                    const group = d3.select(this);
                    const textElement = group.append('text')
                        .attr('class', 'iface-symbol')
                        .attr('text-anchor', 'middle')
                        .attr('dominant-baseline', 'middle')
                        .attr('font-size', 8)
                        .attr('font-weight', 'bold')
                        .attr('fill', '#fff')
                        .text(symbol);
                    
                    // Rotate all VPC interface labels by 180 degrees (for readability when at bottom)
                    if (iface?.group === 'vpc') {
                        textElement.attr('transform', 'rotate(180)');
                    }
                }
            })
                .style('cursor', 'pointer')
                .on('mouseenter', (event, d) => {
                    const iface = interfaces[d.index];
                    const connections = this.getInterfaceConnections(iface?.id, trafficData, ipToInterfaceMap);
                    this.showTooltip(this.tooltip, event, iface, connections, svgNode);
                    // Only highlight on hover if nothing is selected, or if this is the selected one
                    if (this.selectedInterfaceId === null || this.selectedInterfaceId === iface?.id) {
                        this.highlightInterface(iface?.id, connections);
                    }
                })
                .on('mousemove', (event) => {
                    this.moveTooltip(this.tooltip, event, svgNode);
                })
                .on('mouseleave', (event, d) => {
                    const iface = interfaces[d.index];
                    // Only hide tooltip and clear highlight if nothing is selected
                    if (this.selectedInterfaceId === null) {
                        this.hideTooltip(this.tooltip);
                        this.clearHighlight();
                    } else if (this.selectedInterfaceId === iface?.id) {
                        // Keep highlight for selected interface
                        const connections = this.getInterfaceConnections(this.selectedInterfaceId, trafficData, ipToInterfaceMap);
                        this.highlightInterface(this.selectedInterfaceId, connections);
                    } else {
                        // Another interface is selected - hide tooltip, restore its highlight
                        this.hideTooltip(this.tooltip);
                        const selectedIface = this.interfaces.find(i => i.id === this.selectedInterfaceId);
                        if (selectedIface) {
                            const connections = this.getInterfaceConnections(this.selectedInterfaceId, trafficData, ipToInterfaceMap);
                            this.highlightInterface(this.selectedInterfaceId, connections);
                        }
                    }
                })
                .on('click', (event, d) => {
                    event.stopPropagation();
                    const iface = interfaces[d.index];
                    const connections = this.getInterfaceConnections(iface?.id, trafficData, ipToInterfaceMap);
                    
                    // Toggle selection: if clicking the same interface, deselect; otherwise select new one
                    if (this.selectedInterfaceId === iface?.id) {
                        // Deselect
                        this.selectedInterfaceId = null;
                        this.hideTooltip(this.tooltip);
                        this.clearHighlight();
                    } else {
                        // Clear previous selection first (remove highlight from previous interface)
                        if (this.selectedInterfaceId !== null) {
                            this.svg.selectAll(`g.iface[data-iface-id="${this.selectedInterfaceId}"]`)
                                .select('.iface-highlight')
                                .transition()
                                .duration(200)
                                .attr('opacity', 0);
                        }
                        
                        // Select new interface
                        this.selectedInterfaceId = iface?.id;
                        this.showTooltip(this.tooltip, event, iface, connections, svgNode);
                        this.highlightInterface(iface?.id, connections);
                    }
                });
        });
    }

    renderArrows(svg, ranges, interfaces, groupAngleRanges) {
        const arrowsG = svg.append('g').attr('class', 'outgoing-arrows');
        
        ranges.forEach((r, groupIdx) => {
            const groupRange = groupAngleRanges[groupIdx];
            if (!groupRange) return;
            
            const { ifaceIndices, startAngle: groupStartAngle } = groupRange;
            const rectTangential = 34;
            const rectRadial = 16;
            const iface1pxMargin = 2;
            const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
            const maxIfacesPerRowUnlimited = Math.floor(groupRange.angularSpan / rectAngularWidth);
            const maxIfacesPerRow = Math.min(maxIfacesPerRowUnlimited, 10);
            const rowRadiusStep = rectRadial + 4;
            
            ifaceIndices.forEach((i, localIdx) => {
                const iface = interfaces[i];
                // Only draw arrows for igw and vgw
                if (iface?.type !== 'igw' && iface?.type !== 'vgw') return;
                
                const row = Math.floor(localIdx / maxIfacesPerRow);
                const posInRow = localIdx % maxIfacesPerRow;
                
                const rectStartAngle = groupStartAngle + posInRow * rectAngularWidth;
                const rectCenterAngle = rectStartAngle + (rectTangential / 2) / this.rectR;
                
                const iface_rectR = this.rectR + row * rowRadiusStep;
                
                // Start point: outer edge of interface (farther from center)
                const startRadius = iface_rectR + rectRadial / 2;
                const startX = Math.cos(rectCenterAngle) * startRadius;
                const startY = Math.sin(rectCenterAngle) * startRadius;
                
                // End point: outside the circle (away from center), max 15px length
                const maxArrowLength = 15;
                const endRadius = startRadius + maxArrowLength;
                const endX = Math.cos(rectCenterAngle) * endRadius;
                const endY = Math.sin(rectCenterAngle) * endRadius;
                
                // Draw arrow line
                const arrowLine = arrowsG.append('line')
                    .attr('x1', startX)
                    .attr('y1', startY)
                    .attr('x2', endX)
                    .attr('y2', endY)
                    .attr('stroke', '#666')
                    .attr('stroke-width', 2)
                    .attr('marker-end', 'url(#arrowhead-outgoing)')
                    .attr('opacity', 0.6);
            });
        });
        
        // Define arrowhead marker if not already defined
        const defs = svg.select('defs');
        if (defs.empty()) {
            svg.append('defs');
        }
        
        const defsNode = svg.select('defs').node() || svg.append('defs').node();
        const existingMarker = svg.select('marker#arrowhead-outgoing');
        if (existingMarker.empty()) {
            svg.select('defs').append('marker')
                .attr('id', 'arrowhead-outgoing')
                .attr('viewBox', '0 0 10 10')
                .attr('refX', 8)
                .attr('refY', 5)
                .attr('markerWidth', 6)
                .attr('markerHeight', 6)
                .attr('orient', 'auto')
                .append('path')
                .attr('d', 'M 0 0 L 10 5 L 0 10 z')
                .attr('fill', '#666');
        }
    }

    getInterfaceConnections(ifaceId, trafficData, ipToInterfaceMap) {
        if (!ifaceId || !trafficData) return [];
        
        const connections = [];
        
        // Find the interface to get its IPs
        const iface = this.interfaces.find(i => i.id === ifaceId);
        const ifaceIPs = iface && iface.ips ? new Set(iface.ips) : new Set();
        
        // Track unique connection keys to avoid duplicates
        const seenConnections = new Set();
        
        trafficData.forEach(t => {
            // Outgoing connections (from this interface)
            if (t.id === ifaceId) {
                // Create unique key: direction + IP address
                const connKey = `outgoing:${t.dstaddr}`;
                if (!seenConnections.has(connKey)) {
                    seenConnections.add(connKey);
                    connections.push({
                        ip: t.dstaddr,
                        bytes: t.bytes,
                        packets: t.packets,
                        success: t.success,
                        failed: t.failed,
                        direction: 'outgoing'
                    });
                }
            }
            
            // Incoming connections (to this interface's IPs)
            if (ifaceIPs.has(t.dstaddr)) {
                const srcIfaceId = t.id;
                // Create unique key: direction + IP address
                const connKey = `incoming:${t.srcaddr}`;
                if (srcIfaceId && !seenConnections.has(connKey)) {
                    seenConnections.add(connKey);
                    connections.push({
                        ip: t.srcaddr,
                        bytes: t.bytes,
                        packets: t.packets,
                        success: t.success,
                        failed: t.failed,
                        direction: 'incoming'
                    });
                }
            }
        });
        
        return connections;
    }

    showTooltip(tooltip, event, iface, connections, svgNode) {
        if (!iface) return;
        
        const [x, y] = d3.pointer(event, svgNode);
        
        // Clear previous content
        tooltip.selectAll('*').remove();
        
        const tooltipContent = tooltip.append('g').attr('class', 'tooltip-content');
        
        const textGroup = tooltipContent.append('g');
        
        let yPos = 0;
        const lineHeight = 16;
        const fontSize = 12;
        
        const title = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-weight', 'bold')
            .attr('font-size', fontSize + 1)
            .attr('fill', '#fff')
            .text(iface.name || iface.id);
        
        yPos += lineHeight;
        const status = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-size', fontSize - 1)
            .attr('fill', '#ccc')
            .text(`Status: ${iface.status || 'unknown'}`);
        
        yPos += lineHeight;
        const typeText = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-size', fontSize - 1)
            .attr('fill', '#ccc')
            .text(`Type: ${iface.type || 'standard'}${iface.subtype ? ` (${iface.subtype})` : ''}`);
        
        yPos += lineHeight;
        const ipsTitle = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-weight', 'bold')
            .attr('font-size', fontSize - 1)
            .attr('fill', '#fff')
            .text('IP Addresses:');
        
        yPos += lineHeight * 0.7;
        const ipsList = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-size', fontSize - 2)
            .attr('fill', '#aaa')
            .text(iface.ips ? iface.ips.join(', ') : 'none');
        
        yPos += lineHeight;
        const connectionsTitle = textGroup.append('text')
            .attr('x', 0)
            .attr('y', yPos)
            .attr('font-weight', 'bold')
            .attr('font-size', fontSize - 1)
            .attr('fill', '#fff')
            .text(`Connections (${connections.length}):`);
        
        connections.forEach(conn => {
            yPos += lineHeight * 0.8;
            textGroup.append('text')
                .attr('x', 0)
                .attr('y', yPos)
                .attr('font-size', fontSize - 2)
                .attr('fill', '#aaa')
                .text(`${conn.ip} (${this.formatBytes(conn.bytes)}, ${conn.success}% success)`);
        });
        
        const bbox = textGroup.node().getBBox();
        const padding = 8;
        
        const bg = tooltipContent.insert('rect', ':first-child')
            .attr('x', bbox.x - padding)
            .attr('y', bbox.y - padding)
            .attr('width', bbox.width + padding * 2)
            .attr('height', bbox.height + padding * 2)
            .attr('rx', 4)
            .attr('ry', 4)
            .attr('fill', 'rgba(0, 0, 0, 0.85)')
            .attr('stroke', '#fff')
            .attr('stroke-width', 1);
        
        tooltip.attr('transform', `translate(${x + 25}, ${y - 10})`);
        tooltip.transition().duration(200).style('opacity', 1);
    }

    moveTooltip(tooltip, event, svgNode) {
        const [x, y] = d3.pointer(event, svgNode);
        tooltip.attr('transform', `translate(${x + 25}, ${y - 10})`);
    }

    hideTooltip(tooltip) {
        tooltip.transition().duration(200).style('opacity', 0);
    }

    highlightInterface(ifaceId, connections) {
        if (!ifaceId || !this.svg) return;
        
        // Show highlight on selected interface
        this.svg.selectAll(`g.iface[data-iface-id="${ifaceId}"]`)
            .select('.iface-highlight')
            .transition()
            .duration(200)
            .attr('opacity', 1);
        
        // Find all directly connected interface IDs (only interfaces directly connected via traffic)
        const connectedIfaceIds = new Set([ifaceId]);
        
        // Get selected interface to check its IPs
        const selectedIface = this.interfaces.find(i => i.id === ifaceId);
        const selectedIfaceIPs = selectedIface && selectedIface.ips ? new Set(selectedIface.ips) : new Set();
        
        // Find interfaces directly connected via traffic data
        // Only add interfaces that are directly connected via actual traffic records
        if (this.trafficData) {
            this.trafficData.forEach(t => {
                // Outgoing: traffic FROM selected interface
                // Use ipToInterfaceMap but be aware it may return wrong interface if multiple share same IP
                // However, we only show interfaces that have actual traffic connections
                if (t.id === ifaceId) {
                    const dstIfaceId = this.ipToInterfaceMap.get(t.dstaddr);
                    if (dstIfaceId) {
                        connectedIfaceIds.add(dstIfaceId);
                    }
                }
                
                // Incoming: traffic TO selected interface
                // t.id is the source interface ID from traffic data - this is always correct
                if (selectedIfaceIPs.has(t.dstaddr)) {
                    connectedIfaceIds.add(t.id);
                }
            });
        }
        
        // Filter: only keep interfaces that actually have traffic connections with the selected interface
        // This prevents false positives when multiple interfaces share the same IP
        const validConnectedIds = new Set([ifaceId]);
        connectedIfaceIds.forEach(candidateId => {
            if (candidateId === ifaceId) {
                validConnectedIds.add(candidateId);
                return;
            }
            
            // Check if there's actual traffic between selected interface and candidate
            const hasConnection = this.trafficData.some(t => {
                // Outgoing from selected to candidate
                if (t.id === ifaceId) {
                    const candidateIface = this.interfaces.find(i => i.id === candidateId);
                    if (candidateIface && candidateIface.ips && candidateIface.ips.includes(t.dstaddr)) {
                        return true;
                    }
                }
                // Incoming from candidate to selected
                if (t.id === candidateId) {
                    if (selectedIfaceIPs.has(t.dstaddr)) {
                        return true;
                    }
                }
                return false;
            });
            
            if (hasConnection) {
                validConnectedIds.add(candidateId);
            }
        });
        
        // Use filtered set
        connectedIfaceIds.clear();
        validConnectedIds.forEach(id => connectedIfaceIds.add(id));
        
        // Hide unconnected interfaces
        this.svg.selectAll('g.iface')
            .select('.iface-path')
            .transition()
            .duration(200)
            .attr('opacity', function() {
                const ifaceIdAttr = this.parentNode.getAttribute('data-iface-id');
                return connectedIfaceIds.has(ifaceIdAttr) ? 0.75 : 0.1;
            });
        
        // Show only traffic curves directly connected to the selected interface
        this.svg.selectAll('.traffic-curves path')
            .transition()
            .duration(200)
            .attr('opacity', function() {
                const srcId = this.getAttribute('data-src-id');
                const dstId = this.getAttribute('data-dst-id');
                const originalOpacity = parseFloat(this.getAttribute('data-original-opacity') || '0.5');
                
                // Show only if path directly connects to the selected interface
                // Either source or destination must be the selected interface
                if (srcId && dstId && (srcId === ifaceId || dstId === ifaceId)) {
                    return originalOpacity;
                }
                // Hide all other paths completely
                return 0;
            });
    }

    clearHighlight() {
        if (!this.svg) return;
        
        // Hide highlight
        this.svg.selectAll('.iface-highlight')
            .transition()
            .duration(200)
            .attr('opacity', 0);
        
        // Restore all interfaces opacity
        this.svg.selectAll('g.iface')
            .select('.iface-path')
            .transition()
            .duration(200)
            .attr('opacity', 0.75);
        
        // Restore all traffic curves opacity to their original values
        this.svg.selectAll('.traffic-curves path')
            .transition()
            .duration(200)
            .attr('opacity', function() {
                return parseFloat(this.getAttribute('data-original-opacity') || '0.5');
            });
    }

    formatBytes(bytes) {
        if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
        if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
        if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
        return bytes + ' B';
    }

    generateInterfacePath(d, rectTangential, rectRadial) {
        const w = rectTangential / 2;
        const h = rectRadial / 2;
        const R = d.radius;
        
        const topArcExtend = d.row * 3;
        const bottomArcExtend = topArcExtend - 2;
        
        const w_top = w + topArcExtend / 2;
        const w_bottom = w + bottomArcExtend / 2;
        
        return `M ${-w_bottom} ${h}
                A ${R} ${R} 0 0 1 ${w_bottom} ${h}
                L ${w_top} ${-h}
                A ${R} ${R} 0 0 0 ${-w_top} ${-h}
                Z`;
    }

    renderConnectionPoints(svg, ranges, interfaces, groupAngleRanges, trafficData = []) {
        const rectTangential = 34;
        
        // Build set of interface IDs that have traffic
        const interfacesWithTraffic = new Set();
        trafficData.forEach(t => {
            if (t.id) interfacesWithTraffic.add(t.id);
            // Also check IPs - if interface IP matches traffic destination
            interfaces.forEach(iface => {
                if (iface.ips && iface.ips.includes(t.dstaddr)) {
                    interfacesWithTraffic.add(iface.id);
                }
            });
        });
        
        ranges.forEach((r, groupIdx) => {
            const groupRange = groupAngleRanges[groupIdx];
            if (!groupRange) return;
            
            const { ifaceIndices, startAngle: groupStartAngle, angularSpan } = groupRange;
            const iface1pxMargin = 2; // Must match renderInterfaces
            const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
            const maxIfacesPerRowUnlimited = Math.floor(angularSpan / rectAngularWidth);
            // Limit to maximum 10 interfaces in sector 1 (first row) - must match renderInterfaces
            const maxIfacesPerRow = Math.min(maxIfacesPerRowUnlimited, 10);
            
            // Group interfaces by position in row (posInRow)
            // Each position in sector 0 should contain connection points for all interfaces at that position across all rows
            // But only for interfaces that have traffic
            const interfacesByPosInRow = new Map();
            
            ifaceIndices.forEach((i, localIdx) => {
                const iface = interfaces[i];
                // Only include interfaces that have traffic
                if (!interfacesWithTraffic.has(iface?.id)) return;
                
                const row = Math.floor(localIdx / maxIfacesPerRow);
                const posInRow = localIdx % maxIfacesPerRow;
                
                if (!interfacesByPosInRow.has(posInRow)) {
                    interfacesByPosInRow.set(posInRow, []);
                }
                interfacesByPosInRow.get(posInRow).push({ index: i, row, localIdx });
            });
            
            // For each position in row, create multiple connection points (one per interface at that position)
            // Distribute them radially within the sector 0 element
            interfacesByPosInRow.forEach((ifaceList, posInRow) => {
                // Calculate angle for this position (same as sector 0 first row)
                const rectStartAngle = groupStartAngle + posInRow * rectAngularWidth;
                const rectCenterAngle = rectStartAngle + (rectTangential / 2) / this.rectR;
                
                // Base radius for sector 0 element
                const sector0Radius = this.groupOuterR - 3;
                
                // Find the sector0-iface element for this position (row 0, posInRow)
                // All connection points for interfaces at this position go into the same sector0-iface element
                const sector0IfaceIdx = ifaceIndices.find((idx, localIdx) => {
                    const row = Math.floor(localIdx / maxIfacesPerRow);
                    const pos = localIdx % maxIfacesPerRow;
                    return row === 0 && pos === posInRow;
                });
                
                if (sector0IfaceIdx === undefined) return;
                
                const sector0IfaceId = interfaces[sector0IfaceIdx]?.id;
                const sector0Group = svg.select(`g.group[data-group="${r.group.id}"] g.sector0-iface[data-iface-id="${sector0IfaceId}"]`);
                
                if (sector0Group.empty()) return;
                
                // Create one connection point for each interface at this position
                // Distribute them evenly within the element using the formula: position = (i+1)/(n+1) from left edge
                // where i is 0-indexed point index and n is total number of points
                const numPoints = ifaceList.length;
                const elementWidth = rectTangential;
                
                ifaceList.forEach((item, pointIdx) => {
                    // Calculate position as fraction from left edge: (pointIdx + 1) / (numPoints + 1)
                    // This gives: 1 point -> 50%, 2 points -> 33%, 66%, 3 points -> 25%, 50%, 75%, etc.
                    const fractionFromLeft = (pointIdx + 1) / (numPoints + 1);
                    
                    // Convert fraction to local X coordinate
                    // Element center is at (0, 0), so left edge is at -elementWidth/2, right edge at +elementWidth/2
                    const localX = -elementWidth / 2 + fractionFromLeft * elementWidth;
                    
                    // Position at the center of the element's height (middle of sector0Radial)
                    // In local coords: Y = 0 is the center of the element
                    const localY = 0;
                    
                    const ifaceId = interfaces[item.index]?.id;
                    const ifaceName = interfaces[item.index]?.name || ifaceId;
                    
                    sector0Group.append('circle')
                        .attr('class', 'connection-point')
                        .attr('data-iface-id', ifaceId)
                        .attr('cx', localX)
                        .attr('cy', localY)
                        .attr('r', 1)
                        .attr('fill', '#333')
                        .attr('opacity', 1)
                        .append('title')
                        .text(ifaceName);
                });
            });
        });
    }

    renderGroups(svg, ranges, groupAngleRanges) {
        const groupG = svg.append('g').attr('class', 'groups');
        
        const rectRadial = 16;
        const rowRadiusStep = rectRadial + 4;
        const rectTangential = 34;
        const iface1pxMargin = 2;
        
        groupAngleRanges.forEach((groupRange, groupIdx) => {
            if (!groupRange) return;
            
            const r = ranges[groupIdx];
            
            // Skip rendering label for VPC group
            if (r.group.id === 'vpc') return;
            const a0 = groupRange.startAngle;
            const a1 = groupRange.endAngle;
            
            // Calculate maximum interface radius for THIS specific group
            const { ifaceIndices } = groupRange;
            let groupMaxRadius = this.rectR;
            let actualOuterRadius = this.rectR; // Actual outer edge including extensions
            
            if (ifaceIndices.length > 0) {
                const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
                const maxIfacesPerRow = Math.floor(groupRange.angularSpan / rectAngularWidth);
                const maxRow = Math.floor((ifaceIndices.length - 1) / maxIfacesPerRow);
                groupMaxRadius = this.rectR + maxRow * rowRadiusStep;
                
                // Calculate actual outer radius including interface extensions
                // topArcExtend for last row = maxRow * 3
                const topArcExtend = maxRow * 3;
                // The top edge extends outward by topArcExtend/2
                // Plus the height of the interface (rectRadial/2)
                const interfaceExtension = topArcExtend / 2;
                actualOuterRadius = groupMaxRadius + (rectRadial / 2) + interfaceExtension;
            }
            
            // Calculate the angle for the center of visible elements (first row interfaces)
            // Find the angle that represents the middle of the first row interfaces
            let labelAngle = (a0 + a1) / 2; // Default to geometric center
            
            if (ifaceIndices.length > 0) {
                const rectAngularWidth = (rectTangential + iface1pxMargin) / this.rectR;
                const maxIfacesPerRow = Math.min(Math.floor(groupRange.angularSpan / rectAngularWidth), 10);
                
                if (maxIfacesPerRow > 0) {
                    // Calculate angles for first and last interface in first row
                    const firstIfacePos = 0;
                    const lastIfacePos = Math.min(maxIfacesPerRow - 1, ifaceIndices.length - 1);
                    
                    const firstIfaceStartAngle = a0 + firstIfacePos * rectAngularWidth;
                    const firstIfaceCenterAngle = firstIfaceStartAngle + (rectTangential / 2) / this.rectR;
                    
                    const lastIfaceStartAngle = a0 + lastIfacePos * rectAngularWidth;
                    const lastIfaceCenterAngle = lastIfaceStartAngle + (rectTangential / 2) / this.rectR;
                    
                    // Label angle is the middle between first and last interface in first row
                    labelAngle = (firstIfaceCenterAngle + lastIfaceCenterAngle) / 2;
                }
            }
            
            // Outer sector arc radius for label (invisible)
            // Position label beyond the actual outer edge of the last interface sector
            const labelR = actualOuterRadius + 30;
            
            // Create invisible path for text along the arc, centered at labelAngle
            // The path should span the visible sector but be centered at labelAngle
            const sectorSpan = a1 - a0;
            const pathStartAngle = labelAngle - sectorSpan / 2;
            const pathEndAngle = labelAngle + sectorSpan / 2;
            
            const largeArcFlag = sectorSpan > Math.PI ? 1 : 0;
            const startX = Math.cos(pathStartAngle) * labelR;
            const startY = Math.sin(pathStartAngle) * labelR;
            const endX = Math.cos(pathEndAngle) * labelR;
            const endY = Math.sin(pathEndAngle) * labelR;
            
            // Create path for text to follow along the arc
            const arcPathId = `group-arc-${groupIdx}`;
            const arcPath = `M ${startX} ${startY} A ${labelR} ${labelR} 0 ${largeArcFlag} 1 ${endX} ${endY}`;
            
            // Add invisible path for textPath
            groupG.append('path')
                .attr('id', arcPathId)
                .attr('d', arcPath)
                .attr('fill', 'none')
                .attr('stroke', 'none')
                .style('visibility', 'hidden');
            
            // Add text along the arc using textPath
            const textG = groupG.append('text')
                .attr('font-size', 11)
                .attr('fill', '#333')
                .attr('font-weight', 'bold');
            
            textG.append('textPath')
                .attr('href', `#${arcPathId}`)
                .attr('startOffset', '50%')
                .attr('text-anchor', 'middle')
                .text(r.group.name || r.group.id);
        });
    }

    createTooltip(svg) {
        // Create tooltip container at the end to ensure highest z-index
        this.tooltip = svg.append('g')
            .attr('class', 'tooltip')
            .style('opacity', 0)
            .style('pointer-events', 'none');
    }

    setupInteractions(svg) {
        // Add click handler to SVG background to deselect interface
        // Use mousedown instead of click to avoid conflicts with zoom
        svg.on('mousedown', function(event) {
            // Only deselect if clicking on background (not on an interface path)
            const target = event.target;
            const isInterfacePath = target.classList && target.classList.contains('iface-path');
            const isInterfaceHighlight = target.classList && target.classList.contains('iface-highlight');
            const isZoomContainer = target.classList && target.classList.contains('zoom-container');
            
            // Allow zoom to work - only deselect if clicking on empty space
            if (!isInterfacePath && !isInterfaceHighlight && !isZoomContainer && target === svg.node()) {
                if (this.selectedInterfaceId !== null) {
                    this.selectedInterfaceId = null;
                    this.hideTooltip(this.tooltip);
                    this.clearHighlight();
                }
            }
        }.bind(this));
        
        // Prevent zoom when clicking on interfaces
        svg.selectAll('.iface-path, .iface-highlight')
            .on('mousedown', function(event) {
                event.stopPropagation();
            });
    }
}

