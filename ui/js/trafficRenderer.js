import { INTERFACE_TYPES } from './constants.js';

export class TrafficRenderer {
    constructor(svg, circleR) {
        this.svg = svg;
        this.circleR = circleR;
    }

    canConnect(srcType, dstType) {
        // Standard interfaces can connect to all types
        if (srcType === INTERFACE_TYPES.standard) {
            return true;
        }
        // Non-standard interfaces can only connect to standard interfaces
        return dstType === INTERFACE_TYPES.standard;
    }

    calculateTrafficProperties(trafficBytes, failed, topTraffic) {
        const trafficPercent = (trafficBytes / topTraffic) * 100;
        
        let strokeWidth = 1;
        let isNarrow = false;
        
        if (trafficPercent < 0.1) {
            strokeWidth = 1;
            isNarrow = true;
        } else if (trafficPercent < 10) {
            strokeWidth = 1;
        } else if (trafficPercent < 33) {
            strokeWidth = 2;
        } else if (trafficPercent < 66) {
            strokeWidth = 3;
        } else {
            strokeWidth = 4;
        }
        
        const color = failed > 0 ? '#e74c3c' : '#1f77b4';  // red for failed, blue for successful
        
        let opacity = 0.5;
        if (failed >= 50) {
            opacity = 1.0;
        } else if (failed > 0) {
            opacity = 0.5 + (failed / 50) * 0.5;
        }
        
        const strokeDasharray = isNarrow ? '2,2' : 'none';
        let lineOpacity = opacity;
        if (isNarrow) {
            lineOpacity = 0.25;
        }

        return { strokeWidth, color, strokeDasharray, lineOpacity };
    }

    getConnectionPointCoordinates(ifaceId) {
        // Find the connection point element for this interface in sector0-iface
        const svgNode = this.svg.node();
        const connectionPoint = svgNode.querySelector(`circle.connection-point[data-iface-id="${ifaceId}"]`);
        
        if (!connectionPoint) return null;
        
        // Get the local coordinates (cx, cy) from the connection point
        // localX is the offset along the element's width (tangential to the arc)
        // localY is the offset along the element's height (radial, always 0 for center)
        const localX = parseFloat(connectionPoint.getAttribute('cx') || 0);
        const localY = parseFloat(connectionPoint.getAttribute('cy') || 0);
        
        // Get the parent sector0-iface element to extract transform data
        const parentGroup = connectionPoint.parentElement;
        if (!parentGroup) return null;
        
        // Get transform attribute to extract angle and radius
        const transformAttr = parentGroup.getAttribute('transform');
        if (!transformAttr) return null;
        
        // Parse transform: "rotate(ang) translate(radius,0) rotate(90)"
        const rotateMatches = transformAttr.matchAll(/rotate\(([^)]+)\)/g);
        const rotateArray = Array.from(rotateMatches);
        const translateMatch = transformAttr.match(/translate\(([^,]+),\s*([^)]+)\)/);
        
        if (rotateArray.length < 2 || !translateMatch) return null;
        
        // First rotation angle (in degrees) - this is the element's center angle
        const angleDeg = parseFloat(rotateArray[0][1]);
        const angleRad = angleDeg * Math.PI / 180;
        
        // Translation radius - this is the distance from center to the element
        const radius = parseFloat(translateMatch[1]);
        
        // After rotate(90), the local coordinate system has:
        // - x-axis pointing along the arc (tangential)
        // - y-axis pointing radially (outward)
        // So localX is the tangential offset along the arc
        // Convert tangential offset to angular offset: angularOffset = localX / radius
        const angularOffset = localX / radius;
        
        // The connection point's angle is the element's angle plus the angular offset
        const pointAngle = angleRad + angularOffset;
        
        // The connection point's radius is the element's radius plus the radial offset
        // localY is 0 (center of element height), so radius stays the same
        const pointRadius = radius + localY;
        
        // Calculate global coordinates using polar to cartesian conversion
        const globalX = pointRadius * Math.cos(pointAngle);
        const globalY = pointRadius * Math.sin(pointAngle);
        
        return { cpX: globalX, cpY: globalY };
    }

    generatePathData(srcPoint, dstPoint) {
        if (!srcPoint || !dstPoint || 
            typeof srcPoint.cpX !== 'number' || typeof srcPoint.cpY !== 'number' ||
            typeof dstPoint.cpX !== 'number' || typeof dstPoint.cpY !== 'number') {
            return '';
        }
        
        const x1 = srcPoint.cpX;
        const y1 = srcPoint.cpY;
        const x2 = dstPoint.cpX;
        const y2 = dstPoint.cpY;
        
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;
        
        const centerOffsetX = midX * 0.4;
        const centerOffsetY = midY * 0.4;
        
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        
        if (len === 0) return '';
        
        const perpX = -dy / len * this.circleR * 0.08;
        const perpY = dx / len * this.circleR * 0.08;
        
        const controlX = centerOffsetX + perpX;
        const controlY = centerOffsetY + perpY;
        
        return `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
    }

    render(trafficData, connectionPointsMap, ipToInterfaceMap, interfaces = []) {
        if (!trafficData || !Array.isArray(trafficData) || trafficData.length === 0) {
            return;
        }

        // Build interface map for type checking
        const interfaceMap = new Map();
        interfaces.forEach(iface => {
            interfaceMap.set(iface.id, iface);
        });

        const topTraffic = Math.max(...trafficData.map(t => t.bytes), 1);
        const trafficG = this.svg.insert('g', ':first-child').attr('class', 'traffic-curves');
        
        const trafficConnections = new Map();
        trafficData.forEach(t => {
            const key = t.id;
            if (!trafficConnections.has(key)) {
                trafficConnections.set(key, []);
            }
            trafficConnections.get(key).push(t);
        });
        
        trafficConnections.forEach((trafficList, srcId) => {
            // Get connection point coordinates from DOM (sector0-iface elements)
            const srcPoint = this.getConnectionPointCoordinates(srcId);
            if (!srcPoint) return;
            
            const srcInterface = interfaceMap.get(srcId);
            const srcType = srcInterface?.type || INTERFACE_TYPES.standard;
            
            trafficList.forEach(t => {
                const dstIfaceId = ipToInterfaceMap.get(t.dstaddr);
                // Get connection point coordinates from DOM (sector0-iface elements)
                const dstPoint = dstIfaceId ? this.getConnectionPointCoordinates(dstIfaceId) : null;
                
                if (!dstPoint) return;
                
                const dstInterface = interfaceMap.get(dstIfaceId);
                const dstType = dstInterface?.type || INTERFACE_TYPES.standard;
                
                // Check if connection is allowed based on interface types
                if (!this.canConnect(srcType, dstType)) {
                    return; // Skip invalid connections
                }
                
                const { strokeWidth, color, strokeDasharray, lineOpacity } = 
                    this.calculateTrafficProperties(t.bytes, t.failed, topTraffic);
                
                const pathData = this.generatePathData(srcPoint, dstPoint);
                
                if (!pathData) return; // Skip invalid paths
                
                trafficG.append('path')
                    .attr('d', pathData)
                    .attr('stroke', color)
                    .attr('stroke-width', strokeWidth)
                    .attr('fill', 'none')
                    .attr('stroke-dasharray', strokeDasharray)
                    .attr('opacity', lineOpacity)
                    .attr('data-src-id', srcId)
                    .attr('data-dst-id', dstIfaceId || '')
                    .attr('data-original-opacity', lineOpacity)
                    .append('title')
                    .text(`${t.id}: ${t.srcaddr} → ${t.dstaddr}, ${t.bytes} bytes, Success: ${t.success}%, Failed: ${t.failed}%`);
            });
        });
    }
}

