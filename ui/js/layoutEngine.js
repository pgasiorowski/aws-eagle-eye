export class LayoutEngine {
    constructor(ranges, circleR = 250) {
        this.ranges = ranges;
        this.circleR = circleR;
    }

    calculateGroupAngleRanges(interfaces = []) {
        const rectTangential = 34;
        const rectR = this.circleR + 10;
        const iface1pxMargin = 2;
        const rectAngularWidth = (rectTangential + iface1pxMargin) / rectR;
        const maxIfacesInSector1 = 10; // Maximum interfaces in sector 1 (first row)
        
        const validGroupCount = this.ranges.filter(r => r.start != null && r.end != null).length;
        const groupGapAngle = 10 / this.circleR;
        const totalGapAngle = validGroupCount * groupGapAngle;
        const availableAngle = 2 * Math.PI - totalGapAngle;
        
        // Calculate how many interfaces will be in sector 1 for each group
        // Sector 1 contains min(total interfaces, maxIfacesInSector1) interfaces
        const sector1Counts = [];
        this.ranges.forEach((r, groupIdx) => {
            if (r.start == null || r.end == null) {
                sector1Counts.push(0);
                return;
            }
            
            const totalInterfaces = r.end - r.start;
            // Sector 1 will contain at most maxIfacesInSector1 interfaces
            const sector1Count = Math.min(totalInterfaces, maxIfacesInSector1);
            sector1Counts.push(sector1Count);
        });
        
        // Calculate total interfaces in sector 1 across all groups
        const totalSector1Interfaces = sector1Counts.reduce((sum, count) => sum + count, 0);
        
        // Calculate angular spans proportionally to sector 1 interface counts
        // First, calculate spans for all groups
        const angularSpans = [];
        this.ranges.forEach((r, groupIdx) => {
            if (r.start == null || r.end == null) {
                angularSpans.push(0);
                return;
            }
            
            const sector1Count = sector1Counts[groupIdx];
            const angularSpan = totalSector1Interfaces > 0 
                ? (sector1Count / totalSector1Interfaces) * availableAngle
                : availableAngle / validGroupCount;
            angularSpans.push(angularSpan);
        });
        
        // Find VPC group index
        const vpcGroupIdx = this.ranges.findIndex(r => r.group && r.group.id === 'vpc' && r.start != null && r.end != null);
        const vpcAngularSpan = vpcGroupIdx >= 0 ? angularSpans[vpcGroupIdx] : 0;
        
        // Calculate total angular span of non-VPC groups
        let nonVpcTotalSpan = 0;
        angularSpans.forEach((span, idx) => {
            if (idx !== vpcGroupIdx) {
                nonVpcTotalSpan += span;
            }
        });
        const nonVpcGaps = validGroupCount - (vpcGroupIdx >= 0 ? 1 : 0);
        const nonVpcTotalWithGaps = nonVpcTotalSpan + nonVpcGaps * groupGapAngle;
        
        // Position VPC centered at bottom
        // In SVG/D3: y-axis points down, so Math.sin(Math.PI/2) = 1 means y positive = down
        // Therefore Math.PI/2 (90 degrees) = bottom of circle
        // VPC center should be at Math.PI/2, so start = Math.PI/2 - vpcAngularSpan/2
        const vpcCenterAngle = Math.PI / 2;
        const vpcStartAngle = vpcCenterAngle - vpcAngularSpan / 2;
        const vpcEndAngle = vpcStartAngle + vpcAngularSpan;
        
        // Position other groups starting after VPC, going clockwise
        const groupAngleRanges = [];
        let currentAngle = vpcEndAngle + groupGapAngle;
        
        this.ranges.forEach((r, groupIdx) => {
            if (r.start == null || r.end == null) {
                groupAngleRanges.push(null);
                return;
            }
            
            const ifaceIndices = [];
            for (let i = r.start; i < r.end; i++) ifaceIndices.push(i);
            
            const angularSpan = angularSpans[groupIdx];
            
            let groupStartAngle, groupEndAngle;
            
            if (groupIdx === vpcGroupIdx) {
                // VPC is centered at bottom
                groupStartAngle = vpcStartAngle;
                groupEndAngle = vpcEndAngle;
            } else {
                // Other groups continue clockwise from VPC
                groupStartAngle = currentAngle;
                groupEndAngle = groupStartAngle + angularSpan;
                currentAngle = groupEndAngle + groupGapAngle;
            }
            
            groupAngleRanges.push({
                ifaceIndices,
                startAngle: groupStartAngle,
                endAngle: groupEndAngle,
                angularSpan: angularSpan
            });
        });

        return groupAngleRanges;
    }

    buildConnectionPointsMap(ranges, interfaces, groupAngleRanges, trafficData = []) {
        const rectTangential = 34;
        const rectR = this.circleR + 10;
        const connectionPointsMap = new Map();
        const ipToInterfaceMap = new Map();
        
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

            const { ifaceIndices, startAngle: groupStartAngle } = groupRange;
            const iface1pxMargin = 1;
            const rectAngularWidth = (rectTangential + iface1pxMargin) / rectR;
            const maxIfacesPerRow = Math.floor(groupRange.angularSpan / rectAngularWidth);
            
            // Group interfaces by position in row (posInRow)
            // Each interface gets its own connection point, distributed tangentially within sector 0 element
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
            
            // For each position, create connection points distributed radially
            interfacesByPosInRow.forEach((ifaceList, posInRow) => {
                const rectStartAngle = groupStartAngle + posInRow * rectAngularWidth;
                const rectCenterAngle = rectStartAngle + (rectTangential / 2) / rectR;
                
                // Base radius for sector 0 element
                const sector0Radius = this.circleR - 3;
                
                // Create one connection point for each interface at this position
                // Distribute them tangentially (along the arc) within the element - rotated 90 degrees
                const numPoints = ifaceList.length;
                ifaceList.forEach((item, pointIdx) => {
                    // Distribute points along the arc (tangentially) within the element
                    // Calculate angular offset - spread points along the arc
                    const maxTangentialSpread = rectTangential / rectR; // Angular width of element
                    const tangentialOffset = (pointIdx - (numPoints - 1) / 2) * (maxTangentialSpread / Math.max(1, numPoints - 1));
                    const pointAngle = rectCenterAngle + tangentialOffset;
                    
                    const cpX = Math.cos(pointAngle) * sector0Radius;
                    const cpY = Math.sin(pointAngle) * sector0Radius;
                    
                    const ifaceId = interfaces[item.index]?.id;
                    connectionPointsMap.set(ifaceId, { cpX, cpY });
                    
                    const iface = interfaces[item.index];
                    if (iface && iface.ips && Array.isArray(iface.ips)) {
                        iface.ips.forEach(ip => {
                            ipToInterfaceMap.set(ip, ifaceId);
                        });
                    }
                });
            });
        });

        return { connectionPointsMap, ipToInterfaceMap };
    }
}
