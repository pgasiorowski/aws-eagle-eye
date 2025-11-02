class InterfaceInfoPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this.isVisible = false;
    }

    connectedCallback() {
        this.render();
        this.setupEventListeners();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    position: absolute;
                    top: 1rem;
                    right: 1rem;
                    width: 300px;
                    max-height: 70vh;
                    background: rgba(0, 17, 0, 0.95);
                    border: 1px solid #00ff41;
                    padding: 1rem;
                    overflow-y: auto;
                    display: none;
                    z-index: 100;
                    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                    color: #00ff41;
                }

                :host(.visible) {
                    display: block;
                }

                .info-title {
                    font-size: 0.9rem;
                    margin-bottom: 1rem;
                    text-align: center;
                    color: #00ff41;
                    border-bottom: 1px solid #00ff41;
                    padding-bottom: 0.5rem;
                }

                .info-item {
                    margin-bottom: 0.8rem;
                    padding: 0.5rem;
                    background: rgba(0, 0, 0, 0.5);
                    border-left: 2px solid #00ff41;
                }

                .info-label {
                    display: block;
                    font-size: 0.7rem;
                    color: #00cc33;
                    margin-bottom: 0.2rem;
                }

                .info-value {
                    font-size: 0.8rem;
                    word-break: break-all;
                }

                .close-btn {
                    position: absolute;
                    top: 0.5rem;
                    right: 0.5rem;
                    background: none;
                    border: none;
                    color: #00ff41;
                    cursor: pointer;
                    font-size: 1rem;
                }

                .close-btn:hover {
                    color: #ff4444;
                }
            </style>

            <button class="close-btn" id="closeBtn">×</button>
            <div class="info-title">Network Interface Details</div>
            <div id="infoContent"></div>
        `;
    }

    setupEventListeners() {
        const closeBtn = this.shadowRoot.getElementById('closeBtn');
        closeBtn.addEventListener('click', () => this.hide());

        // Listen for interface selection events
        document.addEventListener('interface-selected', (event) => {
            this.showInterface(event.detail.interface);
        });

        // Close when clicking outside
        document.addEventListener('click', (event) => {
            if (!event.composedPath().includes(this)) {
                this.hide();
            }
        });
    }

    showInterface(eni) {
        const content = this.shadowRoot.getElementById('infoContent');

        const privateIPs = this.parseJSON(eni.private_ip_addresses);
        const publicIPs = this.parseJSON(eni.public_ips);
        const securityGroups = this.parseJSON(eni.security_group_ids);

        const fields = [
            { label: 'Interface ID', value: eni.id },
            { label: 'Resource Type', value: eni.resource_type || 'unknown' },
            { label: 'Resource Name', value: eni.resource_name || 'N/A' },
            { label: 'Resource ID', value: eni.resource_id || 'N/A' },
            { label: 'VPC ID', value: eni.vpc_id || 'N/A' },
            { label: 'Subnet ID', value: eni.subnet_id || 'N/A' },
            { label: 'Availability Zone', value: eni.availability_zone || 'N/A' },
            { label: 'Private IPs', value: privateIPs.join(', ') || 'None' },
            { label: 'Public IPs', value: publicIPs.join(', ') || 'None' },
            { label: 'Status', value: eni.status || 'unknown' },
            { label: 'Interface Type', value: eni.interface_type || 'interface' },
            { label: 'Security Groups', value: securityGroups.join(', ') || 'None' },
            { label: 'Description', value: eni.description || 'None' }
        ];

        content.innerHTML = fields.map(field => `
            <div class="info-item">
                <span class="info-label">${field.label}:</span>
                <span class="info-value">${field.value}</span>
            </div>
        `).join('');

        this.show();
    }

    show() {
        this.classList.add('visible');
        this.isVisible = true;
    }

    hide() {
        this.classList.remove('visible');
        this.isVisible = false;
    }

    parseJSON(jsonString) {
        try {
            return JSON.parse(jsonString || '[]');
        } catch {
            return [];
        }
    }
}

customElements.define('interface-info-panel', InterfaceInfoPanel);