// Global state
let originalData = null;
let currentGrouping = sessionStorage.getItem('grouping') || 'resource-type';
let currentTagName = sessionStorage.getItem('tagName') || '';

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
                // Get first subnet name from subnet_ids map (use value, not key)
                const subnetIds = eni.subnet_ids || {};
                const firstSubnetKey = Object.keys(subnetIds)[0];
                groupKey = firstSubnetKey ? subnetIds[firstSubnetKey] : 'no-subnet';
                break;
                
            case 'availability-zone':
                // Get first AZ id from azs map (use value, not key)
                const azs = eni.azs || {};
                const firstAzKey = Object.keys(azs)[0];
                groupKey = firstAzKey ? azs[firstAzKey] : 'no-az';
                break;
                
            case 'tag':
                // Group by specific tag value
                // Priority: resource_tags -> eni_tags -> 'no-tag'
                const resourceTags = eni.resource_tags || {};
                const eniTags = eni.eni_tags || {};
                groupKey = resourceTags[tagName] || eniTags[tagName] || 'no-tag';
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
        // Collect from resource_tags
        const resourceTags = eni.resource_tags || {};
        Object.keys(resourceTags).forEach(tagName => tagNames.add(tagName));
        
        // Collect from eni_tags
        const eniTags = eni.eni_tags || {};
        Object.keys(eniTags).forEach(tagName => tagNames.add(tagName));
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
        
        // Separate VPC infrastructure from other interfaces
        const vpcInterfaces = networkInterfaces.filter(eni => {
            const isVirtualAppliance = eni.type && ['igw', 'vgw', 'peering', 'dns', 'endpoint'].includes(eni.type);
            return eni.group === 'vpc' || isVirtualAppliance;
        });
        
        const nonVpcInterfaces = networkInterfaces.filter(eni => {
            const isVirtualAppliance = eni.type && ['igw', 'vgw', 'peering', 'dns', 'endpoint'].includes(eni.type);
            return eni.group !== 'vpc' && !isVirtualAppliance;
        });
        
        // Group non-VPC interfaces based on selected criteria
        const groupedByGroup = groupInterfaces(nonVpcInterfaces, groupingType, tagName);
        
        // Always add VPC group first (will be positioned at bottom)
        const groups = [{ id: 'vpc', name: 'VPC' }];
        
        // Add other groups from the grouped interfaces
        Object.keys(groupedByGroup).forEach(groupId => {
            if (groupId !== 'vpc') {
                groups.push({
                    id: groupId,
                    name: groupId.toUpperCase().replace(/-/g, ' ')
                });
            }
        });
        
        // Create interfaces from ENIs
        const interfaces = networkInterfaces.map((eni, index) => {
            const resourceType = eni.resource_type || 'unknown';
            const isVirtualAppliance = eni.type && ['igw', 'vgw', 'peering', 'dns', 'endpoint'].includes(eni.type);
            
            // VPC infrastructure (IGW, DNS, VPN Gateway, Endpoints) always stays in 'vpc' group
            // regardless of the grouping type - these are the most important static resources
            const isVpcInfrastructure = eni.group === 'vpc' || isVirtualAppliance;
            
            // Determine group based on grouping type
            let group;
            if (isVpcInfrastructure) {
                // Always keep VPC infrastructure in the 'vpc' group
                group = 'vpc';
            } else {
                switch (groupingType) {
                    case 'resource-type':
                        group = eni.group || resourceType;
                        break;
                    case 'subnet':
                        const subnetIds = eni.subnet_ids || {};
                        const firstSubnetKey = Object.keys(subnetIds)[0];
                        group = firstSubnetKey ? subnetIds[firstSubnetKey] : 'no-subnet';
                        break;
                    case 'availability-zone':
                        const azs = eni.azs || {};
                        const firstAzKey = Object.keys(azs)[0];
                        group = firstAzKey ? azs[firstAzKey] : 'no-az';
                        break;
                    case 'tag':
                        const tags = eni.resource_tags || {};
                        group = tags[tagName] || 'no-tag';
                        break;
                    default:
                        group = eni.group || resourceType;
                }
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
        
        // Wait for custom element to be defined before updating
        await customElements.whenDefined('network-chord-diagram');
        
        // Update the component directly to trigger re-render
        const diagramElement = document.getElementById('demo');
        if (diagramElement) {
            console.log('Updating diagram with grouping:', groupingType, tagName ? `(tag: ${tagName})` : '');
            console.log('Groups:', groups.map(g => g.id).join(', '));
            console.log('Interfaces:', interfaces.length);
            
            // Force re-render by setting data property
            diagramElement.data = chartData;
            
            console.log('Diagram data updated, render should be triggered');
        } else {
            console.error('Could not find diagram element with id "demo"');
        }
        
        console.log('Data loaded successfully:', {
            grouping: groupingType,
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
    console.log('Setting up control panel...');
    
    // Handle grouping radio button changes
    const radioButtons = document.querySelectorAll('input[name="grouping"]');
    console.log('Found radio buttons:', radioButtons.length);
    
    radioButtons.forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentGrouping = e.target.value;
            sessionStorage.setItem('grouping', currentGrouping);
            console.log('Grouping changed to:', currentGrouping);
            
            // Show/hide tag selector
            const tagSelector = document.getElementById('tag-selector');
            if (tagSelector) {
                if (currentGrouping === 'tag') {
                    tagSelector.classList.add('visible');
                } else {
                    tagSelector.classList.remove('visible');
                }
            }
            
            // Reload data with new grouping (for non-tag options, or if tag is already selected)
            if (currentGrouping !== 'tag' || currentTagName) {
                console.log('Reloading data with grouping:', currentGrouping);
                loadAndConvertData(currentGrouping, currentTagName);
            }
        });
    });
    
    // Handle tag name selection
    const tagSelect = document.getElementById('tag-name-select');
    if (tagSelect) {
        tagSelect.addEventListener('change', (e) => {
            currentTagName = e.target.value;
            sessionStorage.setItem('tagName', currentTagName);
            console.log('Tag name changed to:', currentTagName);
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
            restoreSelections();
            setupControlPanel();
            loadAndConvertData(currentGrouping, currentTagName);
        });
    } else {
        restoreSelections();
        setupControlPanel();
        loadAndConvertData(currentGrouping, currentTagName);
    }
}

// Restore selections from sessionStorage
function restoreSelections() {
    // Restore radio button selection
    const savedGrouping = sessionStorage.getItem('grouping');
    if (savedGrouping) {
        const radio = document.querySelector(`input[name="grouping"][value="${savedGrouping}"]`);
        if (radio) {
            radio.checked = true;
        }
    }
    
    // Show tag selector if tag grouping is selected
    if (currentGrouping === 'tag') {
        const tagSelector = document.getElementById('tag-selector');
        if (tagSelector) {
            tagSelector.classList.add('visible');
        }
    }
    
    // Restore tag selection (will be set after tags are populated)
    const savedTagName = sessionStorage.getItem('tagName');
    if (savedTagName) {
        // This will be applied after tag options are populated in loadAndConvertData
        setTimeout(() => {
            const tagSelect = document.getElementById('tag-name-select');
            if (tagSelect) {
                tagSelect.value = savedTagName;
            }
        }, 100);
    }
}
