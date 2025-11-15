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

// Load data from API endpoint and convert to chart format
export async function loadAndConvertData(groupingType = 'resource-type', tagName = '') {
    // Get enabled VPC data from window.vpcDetails (already loaded by loadVPCData)
    const vpcDetails = window.vpcDetails || [];
    if (vpcDetails.length === 0) {
        console.log('No VPC details available yet');
        return;
    }

    try {
        // Use the first enabled VPC's data (already fetched, no need to fetch again)
        const gatherData = vpcDetails[0];
        
        // Skip if VPC data is invalid
        if (!gatherData || !gatherData.vpc_id) {
            console.log('VPC data is invalid, skipping data load');
            return;
        }
        
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
                
                // Restore saved tag selection immediately after populating
                const savedTagName = sessionStorage.getItem('tagName');
                if (savedTagName) {
                    tagSelect.value = savedTagName;
                }
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
    
    // Handle Add VPC button
    const addVpcBtn = document.getElementById('add-vpc-btn');
    if (addVpcBtn) {
        addVpcBtn.addEventListener('click', async () => {
            const vpcId = document.getElementById('filter-vpc-id').value.trim();
            const account = document.getElementById('filter-vpc-account').value.trim();
            const region = document.getElementById('filter-vpc-region').value.trim();
            const messageDiv = document.getElementById('add-vpc-message');
            
            // Clear previous message
            messageDiv.className = 'add-vpc-message';
            messageDiv.textContent = '';
            
            // Validate inputs
            if (!vpcId || !account || !region) {
                messageDiv.className = 'add-vpc-message error';
                messageDiv.textContent = 'All fields are required';
                return;
            }
            
            // Disable button during request
            addVpcBtn.disabled = true;
            addVpcBtn.textContent = 'Adding...';
            
            try {
                const response = await fetch('/api/vpc', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        vpc_id: vpcId,
                        account: account,
                        region: region
                    })
                });
                
                const result = await response.json();
                
                if (response.ok) {
                    messageDiv.className = 'add-vpc-message success';
                    messageDiv.textContent = result.message || 'VPC added successfully';
                    
                    // Clear form
                    document.getElementById('filter-vpc-id').value = '';
                    document.getElementById('filter-vpc-account').value = '';
                    document.getElementById('filter-vpc-region').value = '';
                    
                    // Reload VPC list
                    setTimeout(() => {
                        loadVPCData();
                        messageDiv.className = 'add-vpc-message';
                        messageDiv.textContent = '';
                    }, 2000);
                } else {
                    messageDiv.className = 'add-vpc-message error';
                    messageDiv.textContent = result.error || 'Failed to add VPC';
                }
            } catch (error) {
                console.error('Error adding VPC:', error);
                messageDiv.className = 'add-vpc-message error';
                messageDiv.textContent = 'Network error: ' + error.message;
            } finally {
                addVpcBtn.disabled = false;
                addVpcBtn.textContent = 'Add';
            }
        });
    }
    
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

// Load VPC list and then load details for enabled VPCs
async function loadVPCData() {
    try {
        // First, load the VPC list
        const response = await fetch('/api/vpc');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const vpcs = await response.json();
        
        // Check which VPCs have data available
        const vpcDataAvailability = {};
        const dataCheckPromises = vpcs.map(async vpc => {
            if (!vpc.id || vpc.id.trim() === '') return;
            
            try {
                const res = await fetch(`/api/vpc/${vpc.id}`);
                vpcDataAvailability[vpc.id] = res.ok;
            } catch (err) {
                console.error(`Error checking VPC ${vpc.id}:`, err);
                vpcDataAvailability[vpc.id] = false;
            }
        });
        
        await Promise.all(dataCheckPromises);
        
        // Display VPC list in UI with data availability info
        displayVPCList(vpcs, vpcDataAvailability);
        
        // Extract enabled VPC IDs and filter out empty IDs
        const enabledVpcIds = vpcs
            .filter(vpc => vpc.enabled && vpc.id && vpc.id.trim() !== '')
            .map(vpc => vpc.id);
        
        console.log('Enabled VPC IDs:', enabledVpcIds);
        
        // Load details for each enabled VPC
        const vpcDetailsPromises = enabledVpcIds.map(vpcId =>
            fetch(`/api/vpc/${vpcId}`)
                .then(res => res.ok ? res.json() : null)
                .catch(err => {
                    console.error(`Error loading VPC ${vpcId}:`, err);
                    return null;
                })
        );
        
        const vpcDetails = await Promise.all(vpcDetailsPromises);
        const validVpcDetails = vpcDetails.filter(detail => detail !== null);
        
        console.log('Loaded VPC details:', validVpcDetails);
        
        // Store VPC details for later use
        window.vpcDetails = validVpcDetails;
        
        return validVpcDetails;
    } catch (error) {
        console.error('Error loading VPC data:', error);
        displayVPCError(error.message);
        return [];
    }
}

function displayVPCList(vpcs, vpcDataAvailability = {}) {
    const container = document.getElementById('vpc-list');
    if (!container) return;
    
    if (vpcs.length === 0) {
        container.innerHTML = '<p class="no-vpcs">No VPCs found</p>';
        return;
    }
    
    const list = document.createElement('ul');
    list.className = 'vpc-list';
    
    vpcs.forEach(vpc => {
        const item = document.createElement('li');
        item.className = 'vpc-item';
        
        const displayText = vpc.name || vpc.id || 'Unnamed';
        const tooltipText = vpc.id;
        const hasData = vpcDataAvailability[vpc.id] === true;
        
        // Add green checkmark icon if VPC has data
        const dataIcon = hasData 
            ? `<svg class="vpc-data-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2ecc71" stroke-width="3" title="Data available">
                <polyline points="20 6 9 17 4 12"></polyline>
               </svg>` 
            : '';
        
        item.innerHTML = `
            ${dataIcon}
            <input type="checkbox" class="vpc-checkbox" ${vpc.enabled ? 'checked' : ''} data-vpc-id="${vpc.id}" ${hasData ? '' : 'disabled'}>
            <span class="vpc-name" title="${tooltipText}">${displayText}</span>
            ${hasData ? `<button class="vpc-refresh-btn" data-vpc-id="${vpc.id}" title="Refresh VPC data">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="23 4 23 10 17 10"></polyline>
                    <polyline points="1 20 1 14 7 14"></polyline>
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
            </button>` : ''}
            <button class="vpc-copy-btn" data-vpc-id="${vpc.id}" title="Copy VPC ID">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
            </button>
        `;
        
        // Add click handler for checkbox toggle
        const checkbox = item.querySelector('.vpc-checkbox');
        if (checkbox && !checkbox.disabled) {
            checkbox.addEventListener('change', async (e) => {
                const vpcId = checkbox.getAttribute('data-vpc-id');
                const isEnabled = checkbox.checked;
                
                try {
                    const response = await fetch(`/api/vpc/${vpcId}/toggle`, {
                        method: 'POST'
                    });
                    
                    const result = await response.json();
                    
                    if (response.ok) {
                        console.log(`VPC ${vpcId} ${isEnabled ? 'enabled' : 'disabled'}`);
                        // Reload data to show/hide the VPC graph
                        await loadVPCData();
                        loadAndConvertData(currentGrouping, currentTagName);
                    } else {
                        alert(`Failed to toggle VPC: ${result.error}`);
                        // Revert checkbox state
                        checkbox.checked = !isEnabled;
                    }
                } catch (error) {
                    console.error('Error toggling VPC:', error);
                    alert(`Error toggling VPC: ${error.message}`);
                    // Revert checkbox state
                    checkbox.checked = !isEnabled;
                }
            });
        }
        
        // Add click handler for refresh button
        const refreshBtn = item.querySelector('.vpc-refresh-btn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const vpcId = refreshBtn.getAttribute('data-vpc-id');
                
                // Disable button and show loading state
                refreshBtn.disabled = true;
                refreshBtn.classList.add('refreshing');
                
                try {
                    const response = await fetch(`/api/vpc/${vpcId}/refresh`, {
                        method: 'POST'
                    });
                    
                    const result = await response.json();
                    
                    if (response.ok) {
                        // Visual feedback
                        refreshBtn.classList.add('refreshed');
                        setTimeout(() => {
                            refreshBtn.classList.remove('refreshed');
                            // Reload VPC data
                            loadVPCData();
                            loadAndConvertData(currentGrouping, currentTagName);
                        }, 1000);
                    } else {
                        alert(`Failed to refresh VPC: ${result.error}`);
                        refreshBtn.classList.remove('refreshing');
                        refreshBtn.disabled = false;
                    }
                } catch (error) {
                    console.error('Error refreshing VPC:', error);
                    alert(`Error refreshing VPC: ${error.message}`);
                    refreshBtn.classList.remove('refreshing');
                    refreshBtn.disabled = false;
                }
            });
        }
        
        // Add click handler for copy button
        const copyBtn = item.querySelector('.vpc-copy-btn');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const vpcId = copyBtn.getAttribute('data-vpc-id');
            navigator.clipboard.writeText(vpcId).then(() => {
                // Visual feedback
                copyBtn.classList.add('copied');
                setTimeout(() => copyBtn.classList.remove('copied'), 1000);
            }).catch(err => {
                console.error('Failed to copy:', err);
            });
        });
        
        list.appendChild(item);
    });
    
    container.innerHTML = '';
    container.appendChild(list);
}

function displayVPCError(message) {
    const container = document.getElementById('vpc-list');
    if (!container) return;
    
    container.innerHTML = `<p class="error">Error loading VPCs: ${message}</p>`;
}

// Initialize when page is ready
export function initializeDataLoader() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', async () => {
            restoreSelections();
            setupControlPanel();
            await loadVPCData();
            loadAndConvertData(currentGrouping, currentTagName);
        });
    } else {
        (async () => {
            restoreSelections();
            setupControlPanel();
            await loadVPCData();
            loadAndConvertData(currentGrouping, currentTagName);
        })();
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
    
    // Tag selection will be restored in loadAndConvertData after options are populated
}
