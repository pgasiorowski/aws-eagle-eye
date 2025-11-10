import { DataProcessor } from './dataProcessor.js';
import { LayoutEngine } from './layoutEngine.js';
import { SVGBuilder } from './svgBuilder.js';
import { TrafficRenderer } from './trafficRenderer.js';

class NetworkChordDiagram extends HTMLElement {
    constructor() {
        super();
        this.shadow = this.attachShadow({ mode: 'open' });
        this._data = null;
    }

    connectedCallback() {
        if (!this._data) {
            const script = this.querySelector('script[type="application/json"]');
            if (script && script.textContent) {
                try { 
                    this._data = JSON.parse(script.textContent); 
                } catch (e) { 
                    console.warn('JSON parse failed', e); 
                }
            }
        }
        this.render();
    }

    set data(d) { this._data = d; this.render(); }
    get data() { return this._data; }

    render() {
        const raw = this._data;

        if (!raw) {
            this.shadow.innerHTML = `<div style="padding:8px;color:#666;font:13px ui-sans-serif,system-ui">Brak danych.</div>`;
            return;
        }

        try {
            // Step 1: Normalize data
            const processor = new DataProcessor(raw);
            const { groups, interfaces, ranges } = processor.normalize();

            // Step 2: Setup layout engine
            const circleR = 150; // Reduced to make area smaller and fit in viewport
            const layoutEngine = new LayoutEngine(ranges, circleR);
            const groupAngleRanges = layoutEngine.calculateGroupAngleRanges();

            // Step 3: Build SVG
            const svgBuilder = new SVGBuilder(circleR);
            // Calculate max radius to ensure all interfaces and labels fit
            const maxRadius = svgBuilder.calculateMaxRadius(ranges, groupAngleRanges);
            const svg = svgBuilder.create(maxRadius);
            
            // Get the zoom container group
            const zoomContainer = svg.node().zoomContainer;

            // Step 4: Build connection points map first (needed for tooltip)
            // Only include interfaces that have traffic
            const { connectionPointsMap, ipToInterfaceMap } = 
                layoutEngine.buildConnectionPointsMap(ranges, interfaces, groupAngleRanges, raw.traffic || []);

            // Step 5: Render interface rectangles (with tooltip support)
            // Render into zoom container instead of directly into svg
            svgBuilder.renderInterfaces(zoomContainer, ranges, interfaces, groupAngleRanges, raw.traffic || [], ipToInterfaceMap);

            // Step 5.5: Render arrows from DX and IG to inside circle
            svgBuilder.renderArrows(zoomContainer, ranges, interfaces, groupAngleRanges);

            // Step 6: Render connection points (only for interfaces with traffic)
            svgBuilder.renderConnectionPoints(zoomContainer, ranges, interfaces, groupAngleRanges, raw.traffic || []);

            // Step 7: Render traffic curves
            const trafficRenderer = new TrafficRenderer(zoomContainer, circleR);
            trafficRenderer.render(raw.traffic, connectionPointsMap, ipToInterfaceMap, interfaces);

            // Step 8: Render group arcs
            svgBuilder.renderGroups(zoomContainer, ranges, groupAngleRanges);

            // Step 9: Create tooltip (after all other elements to ensure highest z-index)
            // Tooltip should be in SVG, not in zoom container, so it stays fixed
            svgBuilder.createTooltip(svg);

            // Step 10: Setup interactions
            svgBuilder.setupInteractions(svg);

            // Step 11: Commit to shadow DOM
            const container = document.createElement('div');
            container.style.position = 'relative';
            container.style.width = '100%';
            container.style.height = '100%';
            container.style.display = 'flex';
            container.style.alignItems = 'center';
            container.style.justifyContent = 'center';

            const style = document.createElement('style');
            style.textContent = ':host { display: block; width: 100%; height: 100vh; }';

            this.shadow.innerHTML = '';
            this.shadow.appendChild(style);
            this.shadow.appendChild(container);
            container.appendChild(svg.node());
        } catch (error) {
            console.error('Render error:', error);
            this.shadow.innerHTML = `<div style="padding:20px; color:red;">Error: ${error.message}</div>`;
        }
    }
}

customElements.define('network-chord-diagram', NetworkChordDiagram);
