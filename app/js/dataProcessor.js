export class DataProcessor {
    constructor(rawData) {
        this.rawData = rawData;
    }

    calculateInterfaceStatus(iface, trafficData, ipToInterfaceMap) {
        const now = new Date();
        const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
        
        // Check if interface was created in the last 5 minutes
        if (iface.createdAt) {
            const createdAt = new Date(iface.createdAt);
            if (createdAt > fiveMinutesAgo) {
                return 'new';
            }
        }
        
        // Check connections for failed >= 1
        const ifaceIPs = iface.ips ? new Set(iface.ips) : new Set();
        
        for (const traffic of trafficData || []) {
            // Outgoing connections (from this interface)
            if (traffic.id === iface.id && traffic.failed >= 1) {
                return 'bad';
            }
            
            // Incoming connections (to this interface's IPs)
            if (ifaceIPs.has(traffic.dstaddr) && traffic.failed >= 1) {
                return 'bad';
            }
        }
        
        return 'good';
    }

    normalize() {
        const groups = this.rawData.groups || [];
        const interfaces = this.rawData.interfaces || [];
        const trafficData = this.rawData.traffic || [];
        
        // Build IP to interface map for status calculation
        const ipToInterfaceMap = new Map();
        interfaces.forEach(iface => {
            if (iface.ips && Array.isArray(iface.ips)) {
                iface.ips.forEach(ip => {
                    ipToInterfaceMap.set(ip, iface.id);
                });
            }
        });

        // Calculate status and set default type for each interface
        // Also reassign group for endpoint, igw, vgw, peering types to "vpc"
        const interfacesWithStatus = interfaces.map(iface => {
            const processedIface = {
                ...iface,
                type: iface.type || 'standard',
                subtype: iface.subtype || null,
                status: this.calculateInterfaceStatus(iface, trafficData, ipToInterfaceMap)
            };
            
            // Reassign group for endpoint, igw, vgw, peering, dns types to "vpc"
            if (iface.type === 'endpoint' || iface.type === 'igw' || iface.type === 'vgw' || iface.type === 'peering' || iface.type === 'dns') {
                processedIface.group = 'vpc';
            }
            
            return processedIface;
        });

        const groupIndex = new Map(groups.map((g, i) => [g.id, i]));

        // Separate interfaces by group
        const interfacesByGroup = new Map();
        interfacesWithStatus.forEach(iface => {
            const groupId = iface.group;
            if (!interfacesByGroup.has(groupId)) {
                interfacesByGroup.set(groupId, []);
            }
            interfacesByGroup.get(groupId).push(iface);
        });

        // Special sorting for VPC group
        const vpcGroupId = 'vpc';
        if (interfacesByGroup.has(vpcGroupId)) {
            const vpcInterfaces = interfacesByGroup.get(vpcGroupId);
            
            // Separate by type
            const endpoints = vpcInterfaces.filter(i => i.type === 'endpoint');
            const dnsInterfaces = vpcInterfaces.filter(i => i.type === 'dns');
            const igwInterfaces = vpcInterfaces.filter(i => i.type === 'igw');
            const vgwInterfaces = vpcInterfaces.filter(i => i.type === 'vgw');
            const peeringInterfaces = vpcInterfaces.filter(i => i.type === 'peering');
            
            // Sort endpoints by name for consistency
            endpoints.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
            
            // Calculate distribution:
            // - Start and end: equal number of endpoints (most)
            // - Near PX: some endpoints
            // - Center: DX and IG (1 each)
            const totalEndpoints = endpoints.length;
            // Split endpoints: half at start/end, rest near PX
            const endpointsAtStart = Math.floor(totalEndpoints / 2);
            const endpointsAtEnd = Math.floor(totalEndpoints / 2);
            const endpointsNearPX = totalEndpoints - endpointsAtStart - endpointsAtEnd;
            
            // Calculate how many endpoints go before and after center (IG and DX)
            const totalEndpointsBeforeCenter = Math.floor(totalEndpoints / 2);
            const totalEndpointsAfterCenter = totalEndpoints - totalEndpointsBeforeCenter;
            
            const sortedVPC = [
                // Start: endpoints (first half)
                ...endpoints.slice(0, totalEndpointsBeforeCenter),
                // Near PX: peering
                ...peeringInterfaces,
                // Center: IG, DNS, and DX (most central)
                ...igwInterfaces,
                ...dnsInterfaces,
                ...vgwInterfaces,
                // End: remaining endpoints (second half)
                ...endpoints.slice(totalEndpointsBeforeCenter)
            ];
            
            interfacesByGroup.set(vpcGroupId, sortedVPC);
        }

        // Sort other groups normally
        interfacesByGroup.forEach((ifaces, groupId) => {
            if (groupId !== vpcGroupId) {
                ifaces.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
            }
        });

        // Combine all interfaces in group order, but put VPC first (to position it at bottom)
        // VPC is always at the bottom because it's always present in every VPC
        const sortedIfaces = [];
        
        // First add VPC group if it exists
        const vpcGroup = groups.find(g => g.id === vpcGroupId);
        if (vpcGroup) {
            const vpcInterfaces = interfacesByGroup.get(vpcGroupId) || [];
            sortedIfaces.push(...vpcInterfaces);
        }
        
        // Then add all other groups (these are VPC-specific)
        groups.forEach(group => {
            if (group.id !== vpcGroupId) {
                const groupInterfaces = interfacesByGroup.get(group.id) || [];
                sortedIfaces.push(...groupInterfaces);
            }
        });

        // Reorder ranges to put VPC first (at bottom of circle)
        const otherGroups = groups.filter(g => g.id !== vpcGroupId);
        const reorderedGroups = vpcGroup ? [vpcGroup, ...otherGroups] : groups;
        
        const ranges = reorderedGroups.map(g => ({ group: g, start: null, end: null }));
        sortedIfaces.forEach((itf, i) => {
            const gi = reorderedGroups.findIndex(g => g.id === itf.group);
            if (gi === -1) return;
            const r = ranges[gi];
            if (r.start == null) r.start = i;
            r.end = i + 1;
        });

        return { groups: reorderedGroups, interfaces: sortedIfaces, ranges };
    }
}

