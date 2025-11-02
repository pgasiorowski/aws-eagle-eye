class AWSCredentialsPanel extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
        this.render();
        this.setupEventListeners();
        this.loadStoredCredentials();
    }

    render() {
        this.shadowRoot.innerHTML = `
            <style>
                :host {
                    display: block;
                    width: 400px;
                    background: rgba(0, 17, 0, 0.9);
                    border: 2px solid #00ff41;
                    padding: 2rem;
                    box-shadow: 0 0 30px rgba(0, 255, 65, 0.3);
                    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
                    color: #00ff41;
                }

                .login-title {
                    text-align: center;
                    font-size: 1.2rem;
                    margin-bottom: 2rem;
                    color: #00ff41;
                    text-shadow: 0 0 10px #00ff41;
                }

                .form-group {
                    margin-bottom: 1rem;
                }

                label {
                    display: block;
                    font-size: 0.8rem;
                    margin-bottom: 0.3rem;
                    color: #00cc33;
                    text-transform: uppercase;
                }

                input {
                    width: 100%;
                    padding: 0.5rem;
                    background: #000;
                    border: 1px solid #00ff41;
                    color: #00ff41;
                    font-family: inherit;
                    font-size: 0.8rem;
                    box-sizing: border-box;
                }

                input:focus {
                    outline: none;
                    box-shadow: 0 0 5px #00ff41;
                }

                .btn {
                    width: 100%;
                    padding: 0.7rem;
                    background: #000;
                    border: 1px solid #00ff41;
                    color: #00ff41;
                    font-family: inherit;
                    cursor: pointer;
                    text-transform: uppercase;
                    letter-spacing: 1px;
                    margin-top: 1rem;
                }

                .btn:hover {
                    background: #00ff41;
                    color: #000;
                }

                .btn:disabled {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .error {
                    color: #ff4444;
                    font-size: 0.75rem;
                    margin-top: 0.5rem;
                    text-align: left;
                    white-space: pre-line;
                    background: rgba(255, 68, 68, 0.1);
                    border: 1px solid #ff4444;
                    padding: 0.5rem;
                    border-radius: 3px;
                    max-height: 150px;
                    overflow-y: auto;
                    display: none;
                }

                .error:not(:empty) {
                    display: block;
                }
            </style>

            <div class="login-title">[ AWS CREDENTIALS ]</div>
            
            <div class="form-group">
                <label>AWS Access Key ID</label>
                <input type="text" id="accessKeyId" placeholder="AKIA...">
            </div>

            <div class="form-group">
                <label>AWS Secret Access Key</label>
                <input type="password" id="secretAccessKey" placeholder="Secret key">
            </div>

            <div class="form-group">
                <label>AWS Session Token (Optional)</label>
                <input type="password" id="sessionToken" placeholder="Optional for STS credentials">
            </div>

            <div class="form-group">
                <label>AWS Region</label>
                <input type="text" id="region" placeholder="us-east-1" value="us-east-1">
            </div>

            <button class="btn" id="connectBtn">Connect</button>
            <div class="error" id="errorMsg"></div>
        `;
    }

    setupEventListeners() {
        const connectBtn = this.shadowRoot.getElementById('connectBtn');
        connectBtn.addEventListener('click', () => this.handleConnect());
    }

    loadStoredCredentials() {
        const stored = sessionStorage.getItem('aws-eagle-eye-credentials');
        if (stored) {
            try {
                const creds = JSON.parse(stored);
                this.shadowRoot.getElementById('accessKeyId').value = creds.accessKeyId || '';
                this.shadowRoot.getElementById('secretAccessKey').value = creds.secretAccessKey || '';
                this.shadowRoot.getElementById('sessionToken').value = creds.sessionToken || '';
                this.shadowRoot.getElementById('region').value = creds.region || 'us-east-1';
            } catch (e) {
                console.warn('Failed to load stored credentials');
            }
        }
    }

    async handleConnect() {
        const accessKeyId = this.shadowRoot.getElementById('accessKeyId').value.trim();
        const secretAccessKey = this.shadowRoot.getElementById('secretAccessKey').value.trim();
        const sessionToken = this.shadowRoot.getElementById('sessionToken').value.trim();
        const region = this.shadowRoot.getElementById('region').value.trim();

        if (!accessKeyId || !secretAccessKey || !region) {
            this.showError('Please provide AWS Access Key ID, Secret Access Key, and Region');
            return;
        }

        this.showLoading(true);
        this.clearError();

        try {
            const credentials = { accessKeyId, secretAccessKey, region };
            if (sessionToken) {
                credentials.sessionToken = sessionToken;
            }

            // Store credentials
            sessionStorage.setItem('aws-eagle-eye-credentials', JSON.stringify(credentials));

            // Dispatch connect event
            this.dispatchEvent(new CustomEvent('aws-connect', {
                detail: { credentials },
                bubbles: true
            }));

        } catch (error) {
            this.showError(`Connection failed: ${error.message}`);
        } finally {
            this.showLoading(false);
        }
    }

    showLoading(show) {
        const btn = this.shadowRoot.getElementById('connectBtn');
        if (show) {
            btn.disabled = true;
            btn.textContent = 'Connecting...';
        } else {
            btn.disabled = false;
            btn.textContent = 'Connect';
        }
    }

    showError(message) {
        const errorElement = this.shadowRoot.getElementById('errorMsg');
        errorElement.textContent = message;
    }

    clearError() {
        const errorElement = this.shadowRoot.getElementById('errorMsg');
        errorElement.textContent = '';
    }
}

customElements.define('aws-credentials-panel', AWSCredentialsPanel);