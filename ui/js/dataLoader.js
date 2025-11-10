// Global state
let originalData = null;
let currentGrouping = 'resource-type';
let currentTagName = '';

// Function to group interfaces based on selected criteria
export function groupInterfaces(networkInterfaces, groupingType, tagName = '') {
    const grouped = {};
    
    networkInterfaces.forEach(eni => {
        let groupKey;
        
        switch (groupingType) {
            case 'resource-type':
                groupKey = eni.group || eni.resource_type || 'unknown';
                break;
                
            case 'subnet':
                // Get first subnet ID from subnet_ids map
                const subnetIds = eni.subnet_ids || {};
                const firstSubnetId = Object.keys(subnetIds)[0];
                groupKey = firstSubnetId || 'no-subnet';
                break;
                
            case 'availability-zone':
                // Get first AZ from azs map
                const azs = eni.azs || {};
                const firstAz = Object.keys(azs)[0];
                groupKey = firstAz || 'no-az';
                break;
                
            case 'tag':
                // Group by specific tag value
                const tags = eni.resource_tags || {};
                groupKey = tags[tagName] || 'no-tag';
                break;
                
            default:
                groupKey = 'unknown';
        }
        
        if (!grouped[groupKey]) {
            grouped[groupKey] = [];
        }
        grouped[groupKey].push(eni);
    });
    
    return grouped;
}

// Function to collect all unique tag names from interfaces
export function collectTagNames(networkInterfaces) {
    const tagNames = new Set();
    
    networkInterfaces.forEach(eni => {
        const tags = eni.resource_tags || {};
        Object.keys(tags).forEach(tagName => tagNames.add(tagName));
    });
    
    return Array.from(tagNames).sort();
}

// Global variable to store the data file name
let dataFileName = '';

// Set the data file name
export function setDataFileName(fileName) {
    dataFileName = fileName;
}

// Load data from specified JSON file and convert to chart format
export async function loadAndConvertData(groupingType = 'resource-type', tagName = '') {
    if (!dataFileName) {
        return;
    }

    try {
        const response = await fetch(`./${dataFileName}`);
        const gatherData = await response.json();
        
        // Store original data
        if (!originalData) {
            originalData = gatherData;
            
            // Populate tag selector
            const tagNames = collectTagNames(gatherData.network_interfaces || []);
            const tagSelect = document.getElementById('tag-name-select');
            if (tagSelect) {
                tagNames.forEach(tagName => {
                    const option = document.createElement('option');
                    option.value = tagName;
                    option.textContent = tagName;
                    tagSelect.appendChild(option);
                });
            }
        }
        
        // Extract network interfaces from gather data
        const networkInterfaces = gatherData.network_interfaces || [];
        
        // Group interfaces based on selected criteria
        const groupedByGroup = groupInterfaces(networkInterfaces, groupingType, tagName);
        
        // Create groups from the grouped interfaces
        const groups = Object.keys(groupedByGroup).map(groupId => ({
            id: groupId,
            name: groupId.toUpperCase().replace(/-/g, ' ')
        }));
        
        // Create interfaces from ENIs
        const interfaces = networkInterfaces.map((eni, index) => {
            const resourceType = eni.resource_type || 'unknown';
            const isVirtualAppliance = eni.type && ['igw', 'vgw', 'peering', 'dns', 'endpoint'].includes(eni.type);
            
            // Determine group based on grouping type
            let group;
            switch (groupingType) {
                case 'resource-type':
                    group = eni.group || resourceType;
                    break;
                case 'subnet':
                    const subnetIds = eni.subnet_ids || {};
                    group = Object.keys(subnetIds)[0] || 'no-subnet';
                    break;
                case 'availability-zone':
                    const azs = eni.azs || {};
                    group = Object.keys(azs)[0] || 'no-az';
                    break;
                case 'tag':
                    const tags = eni.resource_tags || {};
                    group = tags[tagName] || 'no-tag';
                    break;
                default:
                    group = eni.group || resourceType;
            }
            
            const interfaceData = {
                id: eni.id,
                name: `${eni.resource_name || eni.resource_id}/${eni.id}`,
                group: group,
                ips: eni.private_ip_addresses || [],
                publicIps: eni.public_ips || [],
                subnetIds: eni.subnet_ids || {},
                azs: eni.azs || {},
                vpcId: eni.vpc_id,
                securityGroups: eni.security_group_ids || [],
                resourceType: resourceType,
                resourceId: eni.resource_id,
                resourceName: eni.resource_name,
                description: eni.description,
                tags: eni.resource_tags || {}
            };
            
            // Only set createdAt for non-virtual appliances
            if (!isVirtualAppliance) {
                interfaceData.createdAt = eni.last_updated || new Date().toISOString();
            }
            
            // Add type field if present (for virtual appliances)
            if (eni.type) {
                interfaceData.type = eni.type;
            }
            
            return interfaceData;
        });
        
        // Traffic will be added later
        const traffic = [];
        
        // Update the chart data
        const chartData = {
            groups,
            interfaces,
            traffic,
            metadata: gatherData.metadata || {}
        };
        
        // Update the script tag with new data
        const scriptTag = document.getElementById('chart-data');
        if (scriptTag) {
            scriptTag.textContent = JSON.stringify(chartData, null, 2);
        }
        
        // Trigger a custom event to notify the component
        const diagramElement = document.getElementById('demo');
        if (diagramElement) {
            const event = new CustomEvent('data-loaded', { detail: chartData });
            diagramElement.dispatchEvent(event);
        }
        
        console.log('Data loaded successfully:', {
            groups: groups.length,
            interfaces: interfaces.length,
            traffic: traffic.length
        });
        
    } catch (error) {
        console.error('Error loading gather.json data:', error);
        // Keep the default empty data structure
    }
}

// Setup event handlers for control panel
export function setupControlPanel() {
    // Handle grouping radio button changes
    const radioButtons = document.querySelectorAll('input[name="grouping"]');
    radioButtons.forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentGrouping = e.target.value;
            
            // Show/hide tag selector
            const tagSelector = document.getElementById('tag-selector');
            if (tagSelector) {
                if (currentGrouping === 'tag') {
                    tagSelector.classList.add('visible');
                } else {
                    tagSelector.classList.remove('visible');
                    // Reload data with new grouping
                    loadAndConvertData(currentGrouping, currentTagName);
                }
            }
        });
    });
    
    // Handle tag name selection
    const tagSelect = document.getElementById('tag-name-select');
    if (tagSelect) {
        tagSelect.addEventListener('change', (e) => {
            currentTagName = e.target.value;
            if (currentGrouping === 'tag' && currentTagName) {
                loadAndConvertData(currentGrouping, currentTagName);
            }
        });
    }
}

// Initialize when page is ready
export function initializeDataLoader(fileName) {
    // Set the data file name
    setDataFileName(fileName);
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setupControlPanel();
            loadAndConvertData();
        });
    } else {
        setupControlPanel();
        loadAndConvertData();
    }
}
