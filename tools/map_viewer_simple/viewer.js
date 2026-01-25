// Settlement Outlines Viewer
// Zero-dependency canvas viewer for settlement polygons (outlines only)

class SettlementViewer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        // World bounds (from map_bounds.json)
        this.worldBounds = null;
        this.worldCenter = { x: 0, y: 0 };
        
        // View state
        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };
        this.fitScale = 1.0;
        
        // Data
        this.polygons = [];
        
        // Interaction state
        this.isDragging = false;
        this.dragStart = { x: 0, y: 0 };
        this.panStart = { x: 0, y: 0 };
        
        // Render state
        this.needsRedraw = true;
        this.lastRenderTime = 0;
        
        this.setupCanvas();
        this.setupEventListeners();
        this.loadData();
    }
    
    setupCanvas() {
        this.resizeCanvas();
        window.addEventListener('resize', () => {
            this.resizeCanvas();
            this.needsRedraw = true;
            this.render();
        });
    }
    
    resizeCanvas() {
        const rect = this.canvas.getBoundingClientRect();
        this.canvas.width = rect.width * window.devicePixelRatio;
        this.canvas.height = rect.height * window.devicePixelRatio;
        this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
        this.needsRedraw = true;
    }
    
    setupEventListeners() {
        // Mouse drag for panning
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // Left mouse button
                this.isDragging = true;
                this.dragStart = { x: e.clientX, y: e.clientY };
                this.panStart = { ...this.pan };
                this.canvas.style.cursor = 'grabbing';
            }
        });
        
        this.canvas.addEventListener('mousemove', (e) => {
            if (this.isDragging) {
                const dx = e.clientX - this.dragStart.x;
                const dy = e.clientY - this.dragStart.y;
                this.pan.x = this.panStart.x + dx;
                this.pan.y = this.panStart.y + dy;
                this.needsRedraw = true;
                this.render();
            }
        });
        
        this.canvas.addEventListener('mouseup', () => {
            this.isDragging = false;
            this.canvas.style.cursor = 'default';
        });
        
        this.canvas.addEventListener('mouseleave', () => {
            this.isDragging = false;
            this.canvas.style.cursor = 'default';
        });
        
        // Wheel zoom towards cursor
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            
            const rect = this.canvas.getBoundingClientRect();
            const cursorX = e.clientX - rect.left;
            const cursorY = e.clientY - rect.top;
            
            // Convert screen to world coordinates
            const canvasCenter = {
                x: this.canvas.width / window.devicePixelRatio / 2,
                y: this.canvas.height / window.devicePixelRatio / 2
            };
            const worldX = (cursorX - canvasCenter.x - this.pan.x) / this.zoom + this.worldCenter.x;
            const worldY = (cursorY - canvasCenter.y - this.pan.y) / this.zoom + this.worldCenter.y;
            
            // Zoom factor
            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = this.zoom * zoomFactor;
            
            // Clamp zoom
            const minZoom = this.fitScale * 0.2;
            const maxZoom = this.fitScale * 40;
            this.zoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
            
            // Adjust pan to zoom towards cursor
            const newCanvasCenter = {
                x: this.canvas.width / window.devicePixelRatio / 2,
                y: this.canvas.height / window.devicePixelRatio / 2
            };
            this.pan.x = cursorX - (worldX - this.worldCenter.x) * this.zoom - newCanvasCenter.x;
            this.pan.y = cursorY - (worldY - this.worldCenter.y) * this.zoom - newCanvasCenter.y;
            
            this.needsRedraw = true;
            this.render();
        });
        
        // Double click to fit
        this.canvas.addEventListener('dblclick', () => {
            this.fit();
        });
        
        // Fit button
        document.getElementById('fit-btn').addEventListener('click', () => {
            this.fit();
        });
    }
    
    async loadData() {
        try {
            // Load bounds
            const boundsResponse = await fetch('./data/derived/map_bounds.json');
            this.worldBounds = await boundsResponse.json();
            
            // Calculate world center
            this.worldCenter.x = (this.worldBounds.min_x + this.worldBounds.max_x) / 2;
            this.worldCenter.y = (this.worldBounds.min_y + this.worldBounds.max_y) / 2;
            
            // Load polygons
            const polygonsResponse = await fetch('./data/derived/settlements_polygons.geojson');
            const geojson = await polygonsResponse.json();
            
            this.polygons = geojson.features || [];
            
            // Calculate fit scale
            const canvasW = this.canvas.width / window.devicePixelRatio;
            const canvasH = this.canvas.height / window.devicePixelRatio;
            const scaleX = (canvasW / this.worldBounds.width) * 0.95;
            const scaleY = (canvasH / this.worldBounds.height) * 0.95;
            this.fitScale = Math.min(scaleX, scaleY);
            
            // Set initial zoom and pan
            this.zoom = this.fitScale;
            this.pan = { x: 0, y: 0 };
            
            // Update UI
            document.getElementById('polygon-count').textContent = this.polygons.length;
            
            this.needsRedraw = true;
            this.render();
        } catch (error) {
            console.error('Failed to load data:', error);
            alert('Failed to load map data. Make sure the server is running and data files exist.');
        }
    }
    
    fit() {
        if (!this.worldBounds) return;
        
        const canvasW = this.canvas.width / window.devicePixelRatio;
        const canvasH = this.canvas.height / window.devicePixelRatio;
        const scaleX = (canvasW / this.worldBounds.width) * 0.95;
        const scaleY = (canvasH / this.worldBounds.height) * 0.95;
        this.fitScale = Math.min(scaleX, scaleY);
        
        this.zoom = this.fitScale;
        this.pan = { x: 0, y: 0 };
        
        this.needsRedraw = true;
        this.render();
    }
    
    worldToScreen(wx, wy) {
        const canvasCenter = {
            x: this.canvas.width / window.devicePixelRatio / 2,
            y: this.canvas.height / window.devicePixelRatio / 2
        };
        const sx = (wx - this.worldCenter.x) * this.zoom + canvasCenter.x + this.pan.x;
        const sy = (wy - this.worldCenter.y) * this.zoom + canvasCenter.y + this.pan.y;
        return { x: sx, y: sy };
    }
    
    render() {
        if (!this.needsRedraw || !this.worldBounds || this.polygons.length === 0) {
            return;
        }
        
        const startTime = performance.now();
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width / window.devicePixelRatio, this.canvas.height / window.devicePixelRatio);
        
        // Set stroke style (outlines only, no fill)
        this.ctx.strokeStyle = '#333333';
        // Scale line width with zoom so it stays visible
        this.ctx.lineWidth = Math.max(0.5, 1.0 / Math.sqrt(this.zoom));
        
        // Render each polygon as an outline
        for (const feature of this.polygons) {
            const geometry = feature.geometry;
            if (geometry.type !== 'Polygon' || !geometry.coordinates || geometry.coordinates.length === 0) {
                continue;
            }
            
            // Get the outer ring (first coordinate array)
            const ring = geometry.coordinates[0];
            if (!ring || ring.length < 3) {
                continue;
            }
            
            // CRITICAL: Each polygon must use its own beginPath(), moveTo(), and closePath()
            // This prevents the "connected polygons / fan lines" mistake
            this.ctx.beginPath();
            
            // Transform first point and move to it
            const firstPoint = this.worldToScreen(ring[0][0], ring[0][1]);
            this.ctx.moveTo(firstPoint.x, firstPoint.y);
            
            // Line to remaining points
            for (let i = 1; i < ring.length; i++) {
                const point = this.worldToScreen(ring[i][0], ring[i][1]);
                this.ctx.lineTo(point.x, point.y);
            }
            
            // Close the path and stroke
            this.ctx.closePath();
            this.ctx.stroke();
        }
        
        const endTime = performance.now();
        this.lastRenderTime = Math.round(endTime - startTime);
        
        // Update UI
        document.getElementById('zoom-level').textContent = this.zoom.toFixed(3);
        document.getElementById('render-time').textContent = this.lastRenderTime;
        
        this.needsRedraw = false;
        
        // Schedule next frame if needed
        requestAnimationFrame(() => {
            if (this.needsRedraw) {
                this.render();
            }
        });
    }
}

// Initialize viewer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new SettlementViewer('canvas');
    });
} else {
    new SettlementViewer('canvas');
}
