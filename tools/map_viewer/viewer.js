// Map Viewer - Zero dependency canvas renderer

class MapViewer {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    
    // Data structures (all IDs are strings)
    this.settlementMetaBySid = new Map();
    this.municipalityMetaByMid = new Map();
    this.polysBySid = new Map();
    this.sidsByMid = new Map();
    this.mapBounds = null;
    this.municipalityOutlines = [];
    
    // View state
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.hoveredSid = null;
    this.selectedSid = null;
    
    // Controls
    this.showOutlines = true;
    this.showStrokes = true;
    this.filterMunicipality = false;
    this.selectedMid = null;
    
    // Spatial index (cell key -> array of sids)
    this.spatialGrid = new Map();
    this.gridCellSize = 0;
    
    // Performance tracking
    this.lastFrameTime = 0;
    this.polygonsDrawn = 0;
    
    // Mouse state
    this.isDragging = false;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartPanX = 0;
    this.dragStartPanY = 0;
    
    this.init();
  }
  
  async init() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    
    // Load data
    try {
      await this.loadData();
      this.buildSpatialIndex();
      this.setupControls();
      this.fitToScreen();
      this.render();
    } catch (err) {
      console.error('Failed to load data:', err);
      document.getElementById('diagnostics').textContent = `Error: ${err.message}`;
    }
  }
  
  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
    this.render();
  }
  
  async loadData() {
    // Load map bounds
    const boundsRes = await fetch('./data/derived/map_bounds.json');
    this.mapBounds = await boundsRes.json();
    
    // Load settlements metadata
    const settleMetaRes = await fetch('./data/derived/settlements_meta.json');
    const settlementsMeta = await settleMetaRes.json();
    for (const meta of settlementsMeta) {
      this.settlementMetaBySid.set(meta.sid, meta);
    }
    
    // Load municipalities metadata
    const muniMetaRes = await fetch('./data/derived/municipalities_meta.json');
    const municipalitiesMeta = await muniMetaRes.json();
    for (const meta of municipalitiesMeta) {
      this.municipalityMetaByMid.set(meta.mid, meta);
      if (!this.sidsByMid.has(meta.mid)) {
        this.sidsByMid.set(meta.mid, []);
      }
    }
    
    // Load settlement polygons
    const polysRes = await fetch('./data/derived/settlements_polygons.geojson');
    const polysGeoJSON = await polysRes.json();
    
    for (const feature of polysGeoJSON.features) {
      const props = feature.properties;
      const sid = props.sid;
      const mid = props.mid;
      
      if (feature.geometry.type === 'Polygon') {
        const coords = feature.geometry.coordinates[0]; // Exterior ring
        const points = new Float32Array(coords.length * 2);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (let i = 0; i < coords.length; i++) {
          const [x, y] = coords[i];
          points[i * 2] = x;
          points[i * 2 + 1] = y;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
        
        this.polysBySid.set(sid, {
          pts: points,
          bbox: [minX, minY, maxX, maxY],
          mid: mid,
          name: props.name || sid
        });
        
        if (!this.sidsByMid.has(mid)) {
          this.sidsByMid.set(mid, []);
        }
        this.sidsByMid.get(mid).push(sid);
      }
    }
    
    // Load municipality outlines
    const outlinesRes = await fetch('./data/derived/municipality_outlines.geojson');
    const outlinesGeoJSON = await outlinesRes.json();
    this.municipalityOutlines = [];
    
    for (const feature of outlinesGeoJSON.features) {
      const props = feature.properties;
      const mid = props.mid;
      
      if (feature.geometry.type === 'Polygon') {
        const coords = feature.geometry.coordinates[0];
        const points = new Float32Array(coords.length * 2);
        for (let i = 0; i < coords.length; i++) {
          const [x, y] = coords[i];
          points[i * 2] = x;
          points[i * 2 + 1] = y;
        }
        this.municipalityOutlines.push({ mid, points });
      } else if (feature.geometry.type === 'MultiPolygon') {
        for (const polyCoords of feature.geometry.coordinates) {
          const ring = polyCoords[0];
          const points = new Float32Array(ring.length * 2);
          for (let i = 0; i < ring.length; i++) {
            const [x, y] = ring[i];
            points[i * 2] = x;
            points[i * 2 + 1] = y;
          }
          this.municipalityOutlines.push({ mid, points });
        }
      }
    }
    
    // Populate municipality filter dropdown
    const select = document.getElementById('municipalityFilter');
    const sortedMunicipalities = Array.from(this.municipalityMetaByMid.values())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const muni of sortedMunicipalities) {
      const option = document.createElement('option');
      option.value = muni.mid;
      option.textContent = muni.name;
      select.appendChild(option);
    }
  }
  
  buildSpatialIndex() {
    if (!this.mapBounds) return;
    
    const width = this.mapBounds.width;
    const height = this.mapBounds.height;
    this.gridCellSize = Math.max(width, height) / 80;
    
    this.spatialGrid.clear();
    
    for (const [sid, poly] of this.polysBySid.entries()) {
      const [minX, minY, maxX, maxY] = poly.bbox;
      
      const startCellX = Math.floor((minX - this.mapBounds.min_x) / this.gridCellSize);
      const startCellY = Math.floor((minY - this.mapBounds.min_y) / this.gridCellSize);
      const endCellX = Math.floor((maxX - this.mapBounds.min_x) / this.gridCellSize);
      const endCellY = Math.floor((maxY - this.mapBounds.min_y) / this.gridCellSize);
      
      for (let cy = startCellY; cy <= endCellY; cy++) {
        for (let cx = startCellX; cx <= endCellX; cx++) {
          const key = `${cx},${cy}`;
          if (!this.spatialGrid.has(key)) {
            this.spatialGrid.set(key, []);
          }
          this.spatialGrid.get(key).push(sid);
        }
      }
    }
  }
  
  setupControls() {
    document.getElementById('showOutlines').addEventListener('change', (e) => {
      this.showOutlines = e.target.checked;
      this.render();
    });
    
    document.getElementById('showStrokes').addEventListener('change', (e) => {
      this.showStrokes = e.target.checked;
      this.render();
    });
    
    document.getElementById('filterMunicipality').addEventListener('change', (e) => {
      this.filterMunicipality = e.target.checked;
      if (this.selectedSid) {
        const settle = this.settlementMetaBySid.get(this.selectedSid);
        this.selectedMid = settle ? settle.mid : null;
      }
      this.render();
    });
    
    document.getElementById('fitBtn').addEventListener('click', () => {
      this.fitToScreen();
      this.render();
    });
    
    document.getElementById('municipalityFilter').addEventListener('change', (e) => {
      this.selectedMid = e.target.value || null;
      this.render();
    });
    
    // Canvas events
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) {
        this.isDragging = true;
        this.dragStartX = e.clientX;
        this.dragStartY = e.clientY;
        this.dragStartPanX = this.panX;
        this.dragStartPanY = this.panY;
      }
    });
    
    this.canvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) {
        const dx = e.clientX - this.dragStartX;
        const dy = e.clientY - this.dragStartY;
        this.panX = this.dragStartPanX + dx / this.zoom;
        this.panY = this.dragStartPanY + dy / this.zoom;
        this.render();
      } else {
        this.updateHover(e.clientX, e.clientY);
      }
    });
    
    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) {
        if (!this.isDragging) {
          this.selectSettlement(this.hoveredSid);
        }
        this.isDragging = false;
      }
    });
    
    this.canvas.addEventListener('mouseleave', () => {
      this.isDragging = false;
      this.hoveredSid = null;
      this.render();
    });
    
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const worldX = (mouseX / this.zoom) - this.panX;
      const worldY = (mouseY / this.zoom) - this.panY;
      
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoom *= zoomFactor;
      this.zoom = Math.max(0.1, Math.min(100, this.zoom));
      
      this.panX = (mouseX / this.zoom) - worldX;
      this.panY = (mouseY / this.zoom) - worldY;
      
      this.render();
    });
    
    this.canvas.addEventListener('dblclick', () => {
      this.fitToScreen();
      this.render();
    });
  }
  
  worldToScreen(wx, wy) {
    return {
      x: (wx + this.panX) * this.zoom,
      y: (wy + this.panY) * this.zoom
    };
  }
  
  screenToWorld(sx, sy) {
    return {
      x: (sx / this.zoom) - this.panX,
      y: (sy / this.zoom) - this.panY
    };
  }
  
  updateHover(screenX, screenY) {
    const world = this.screenToWorld(screenX, screenY);
    const cellX = Math.floor((world.x - this.mapBounds.min_x) / this.gridCellSize);
    const cellY = Math.floor((world.y - this.mapBounds.min_y) / this.gridCellSize);
    const key = `${cellX},${cellY}`;
    
    const candidates = this.spatialGrid.get(key) || [];
    let newHovered = null;
    
    for (const sid of candidates) {
      const poly = this.polysBySid.get(sid);
      if (!poly) continue;
      
      // Filter check
      if (this.selectedMid && poly.mid !== this.selectedMid) continue;
      if (this.filterMunicipality && this.selectedSid) {
        const settle = this.settlementMetaBySid.get(this.selectedSid);
        if (!settle || poly.mid !== settle.mid) continue;
      }
      
      if (this.pointInPolygon(world.x, world.y, poly.pts)) {
        newHovered = sid;
        break; // Use first match
      }
    }
    
    if (newHovered !== this.hoveredSid) {
      this.hoveredSid = newHovered;
      this.render();
      this.updateInfoPanel();
    }
  }
  
  pointInPolygon(x, y, points) {
    let inside = false;
    const n = points.length / 2;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = points[i * 2];
      const yi = points[i * 2 + 1];
      const xj = points[j * 2];
      const yj = points[j * 2 + 1];
      
      const intersect = ((yi > y) !== (yj > y)) &&
        (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    
    return inside;
  }
  
  selectSettlement(sid) {
    this.selectedSid = sid;
    if (sid) {
      const settle = this.settlementMetaBySid.get(sid);
      this.selectedMid = settle ? settle.mid : null;
    }
    this.render();
    this.updateInfoPanel();
  }
  
  fitToScreen() {
    if (!this.mapBounds) return;
    
    const margin = 0.05;
    const scaleX = (this.canvas.width * (1 - 2 * margin)) / this.mapBounds.width;
    const scaleY = (this.canvas.height * (1 - 2 * margin)) / this.mapBounds.height;
    this.zoom = Math.min(scaleX, scaleY);
    
    const centerX = this.mapBounds.min_x + this.mapBounds.width / 2;
    const centerY = this.mapBounds.min_y + this.mapBounds.height / 2;
    
    this.panX = (this.canvas.width / 2) / this.zoom - centerX;
    this.panY = (this.canvas.height / 2) / this.zoom - centerY;
  }
  
  hashToHSL(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
  }
  
  render() {
    const startTime = performance.now();
    this.polygonsDrawn = 0;
    
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    
    // Determine which settlements to draw
    let settlementsToDraw = Array.from(this.polysBySid.keys());
    
    if (this.selectedMid) {
      settlementsToDraw = settlementsToDraw.filter(sid => {
        const poly = this.polysBySid.get(sid);
        return poly && poly.mid === this.selectedMid;
      });
    } else if (this.filterMunicipality && this.selectedSid) {
      const settle = this.settlementMetaBySid.get(this.selectedSid);
      if (settle) {
        const mid = settle.mid;
        settlementsToDraw = settlementsToDraw.filter(sid => {
          const poly = this.polysBySid.get(sid);
          return poly && poly.mid === mid;
        });
      }
    }
    
    // Draw settlement polygons
    for (const sid of settlementsToDraw) {
      const poly = this.polysBySid.get(sid);
      if (!poly) continue;
      
      const isHovered = sid === this.hoveredSid;
      const isSelected = sid === this.selectedSid;
      
      // Get municipality color
      const muniMeta = this.municipalityMetaByMid.get(poly.mid);
      const fillColor = muniMeta ? this.hashToHSL(poly.mid) : '#666';
      
      this.ctx.fillStyle = isSelected ? this.adjustBrightness(fillColor, 1.2) : fillColor;
      this.ctx.strokeStyle = isHovered ? '#ffff00' : (isSelected ? '#00ffff' : '#333');
      this.ctx.lineWidth = isSelected ? 3 : (isHovered ? 2 : (this.showStrokes ? 1 : 0));
      
      this.drawPolygon(poly.pts);
      this.polygonsDrawn++;
    }
    
    // Draw municipality outlines
    if (this.showOutlines) {
      this.ctx.strokeStyle = '#888';
      this.ctx.lineWidth = 1;
      this.ctx.setLineDash([2, 2]);
      
      for (const outline of this.municipalityOutlines) {
        if (this.selectedMid && outline.mid !== this.selectedMid) continue;
        this.drawPolygon(outline.points, false);
      }
      
      this.ctx.setLineDash([]);
    }
    
    const endTime = performance.now();
    this.lastFrameTime = endTime - startTime;
    
    this.updateDiagnostics();
  }
  
  drawPolygon(points, fill = true) {
    const n = points.length / 2;
    if (n < 3) return;
    
    this.ctx.beginPath();
    const p0 = this.worldToScreen(points[0], points[1]);
    this.ctx.moveTo(p0.x, p0.y);
    
    for (let i = 1; i < n; i++) {
      const p = this.worldToScreen(points[i * 2], points[i * 2 + 1]);
      this.ctx.lineTo(p.x, p.y);
    }
    
    this.ctx.closePath();
    if (fill) this.ctx.fill();
    this.ctx.stroke();
  }
  
  adjustBrightness(color, factor) {
    // Simple brightness adjustment for selected polygons
    if (color.startsWith('hsl')) {
      const match = color.match(/hsl\((\d+),\s*(\d+)%,\s*(\d+)%\)/);
      if (match) {
        const [, h, s, l] = match;
        const newL = Math.min(100, Math.max(0, parseFloat(l) * factor));
        return `hsl(${h}, ${s}%, ${newL}%)`;
      }
    }
    return color;
  }
  
  updateDiagnostics() {
    const settleCount = this.settlementMetaBySid.size;
    const muniCount = this.municipalityMetaByMid.size;
    const withGeometry = this.polysBySid.size;
    
    const diag = document.getElementById('diagnostics');
    diag.innerHTML = `
      <div>Municipalities: ${muniCount}</div>
      <div>Settlements: ${settleCount}</div>
      <div>With Geometry: ${withGeometry}</div>
      <div>Polygons Drawn: ${this.polygonsDrawn}</div>
      <div>Render Time: ${this.lastFrameTime.toFixed(2)}ms</div>
      <div>Zoom: ${this.zoom.toFixed(2)}x</div>
    `;
  }
  
  updateInfoPanel() {
    const world = this.screenToWorld(this.canvas.width / 2, this.canvas.height / 2);
    
    if (this.selectedSid) {
      const settle = this.settlementMetaBySid.get(this.selectedSid);
      const poly = this.polysBySid.get(this.selectedSid);
      const muni = settle ? this.municipalityMetaByMid.get(settle.mid) : null;
      
      document.getElementById('settlementInfo').innerHTML = settle ? `
        <div><span class="label">Name:</span><span class="value">${settle.name}</span></div>
        <div><span class="label">SID:</span><span class="value">${settle.sid}</span></div>
        <div><span class="label">Type:</span><span class="value">${settle.settlement_type}</span></div>
        <div><span class="label">Urban Center:</span><span class="value">${settle.is_urban_center ? 'Yes' : 'No'}</span></div>
        <div><span class="label">Has Geometry:</span><span class="value">${settle.has_geometry ? 'Yes' : 'No'}</span></div>
      ` : 'No data';
      
      document.getElementById('municipalityInfo').innerHTML = muni ? `
        <div><span class="label">Name:</span><span class="value">${muni.name}</span></div>
        <div><span class="label">MID:</span><span class="value">${muni.mid}</span></div>
        <div><span class="label">Settlements:</span><span class="value">${muni.total_settlements}</span></div>
        <div><span class="label">Population:</span><span class="value">${muni.total_population.toLocaleString()}</span></div>
      ` : '-';
      
      document.getElementById('censusInfo').innerHTML = settle ? `
        <div><span class="label">Total:</span><span class="value">${settle.total_population.toLocaleString()}</span></div>
        <div><span class="label">Bosniaks:</span><span class="value">${settle.bosniaks.toLocaleString()}</span></div>
        <div><span class="label">Croats:</span><span class="value">${settle.croats.toLocaleString()}</span></div>
        <div><span class="label">Serbs:</span><span class="value">${settle.serbs.toLocaleString()}</span></div>
        <div><span class="label">Others:</span><span class="value">${settle.others.toLocaleString()}</span></div>
      ` : '-';
    } else {
      document.getElementById('settlementInfo').textContent = 'No selection';
      document.getElementById('municipalityInfo').textContent = '-';
      document.getElementById('censusInfo').textContent = '-';
    }
    
    document.getElementById('debugInfo').innerHTML = `
      <div><span class="label">World X:</span><span class="value">${world.x.toFixed(2)}</span></div>
      <div><span class="label">World Y:</span><span class="value">${world.y.toFixed(2)}</span></div>
      <div><span class="label">Hovered SID:</span><span class="value">${this.hoveredSid || 'none'}</span></div>
      <div><span class="label">Selected SID:</span><span class="value">${this.selectedSid || 'none'}</span></div>
    `;
  }
}

// Initialize viewer when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new MapViewer());
} else {
  new MapViewer();
}
