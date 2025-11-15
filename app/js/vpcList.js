export async function loadVPCList() {
    try {
        const response = await fetch('/api/vpc');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const vpcs = await response.json();
        displayVPCList(vpcs);
    } catch (error) {
        console.error('Error loading VPC list:', error);
        displayError(error.message);
    }
}

function displayVPCList(vpcs) {
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
        
        item.innerHTML = `
            <input type="checkbox" class="vpc-checkbox" ${vpc.enabled ? 'checked' : ''} disabled>
            <span class="vpc-id">${vpc.id}</span>
            <span class="vpc-name">${vpc.name || 'Unnamed'}</span>
        `;
        
        list.appendChild(item);
    });
    
    container.innerHTML = '';
    container.appendChild(list);
}

function displayError(message) {
    const container = document.getElementById('vpc-list');
    if (!container) return;
    
    container.innerHTML = `<p class="error">Error loading VPCs: ${message}</p>`;
}
