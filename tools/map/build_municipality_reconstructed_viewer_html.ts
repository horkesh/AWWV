/**
 * Build Municipality Reconstructed Borders Viewer
 * 
 * Generates a standalone HTML file that renders reconstructed municipality borders
 * (from settlement-derived outlines) as the default layer, with optional toggle
 * for drzava.js-derived borders for comparison.
 * 
 * Inputs:
 *   - data/derived/municipality_borders_reconstructed.geojson (default)
 *   - data/derived/municipality_borders_from_drzava.geojson (optional, for comparison)
 * 
 * Output:
 *   - data/derived/municipality_borders_reconstructed_viewer.html
 * 
 * Usage:
 *   tsx tools/map/build_municipality_reconstructed_viewer_html.ts
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: municipality reconstructed borders viewer, canvas polygon isolation");
loadLedger();
assertLedgerFresh("map rebuild: municipality reconstructed borders viewer, canvas polygon isolation");

// ============================================================================
// Types
// ============================================================================

interface MunicipalityFeature {
  munid_5: string;
  name: string | null;
  bbox: [number, number, number, number];
  rings: number[][][];
  vertexCount: number;
  source: string;
}

// ============================================================================
// Constants
// ============================================================================

const RECONSTRUCTED_PATH = resolve('data/derived/municipality_borders_reconstructed.geojson');
const DRZAVA_PATH = resolve('data/derived/municipality_borders_from_drzava.geojson');
const OUTPUT_PATH = resolve('data/derived/municipality_borders_reconstructed_viewer.html');
const COORDINATE_PRECISION = 3;

// ============================================================================
// Utilities
// ============================================================================

function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

function calculateBbox(feature: turf.Feature<turf.Polygon | turf.MultiPolygon>): [number, number, number, number] {
  const bbox = turf.bbox(feature);
  return [
    roundCoord(bbox[0]),
    roundCoord(bbox[1]),
    roundCoord(bbox[2]),
    roundCoord(bbox[3])
  ];
}

function extractRings(feature: turf.Feature<turf.Polygon | turf.MultiPolygon>): number[][][] {
  const rings: number[][][] = [];
  
  if (feature.geometry.type === 'Polygon') {
    for (const ring of feature.geometry.coordinates) {
      rings.push(ring.map(coord => [roundCoord(coord[0]), roundCoord(coord[1])]));
    }
  } else if (feature.geometry.type === 'MultiPolygon') {
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        rings.push(ring.map(coord => [roundCoord(coord[0]), roundCoord(coord[1])]));
      }
    }
  }
  
  return rings;
}

function countVertices(rings: number[][][]): number {
  return rings.reduce((sum, ring) => sum + ring.length, 0);
}

// ============================================================================
// HTML Generation
// ============================================================================

function generateHTML(
  reconstructedFeatures: MunicipalityFeature[],
  drzavaFeatures: MunicipalityFeature[] | null,
  bounds: [number, number, number, number]
): string {
  const reconstructedJson = JSON.stringify(reconstructedFeatures);
  const drzavaJson = drzavaFeatures ? JSON.stringify(drzavaFeatures) : 'null';
  const boundsJson = JSON.stringify(bounds);
  const hasDrzavaLayer = drzavaFeatures !== null;
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Borders Viewer (Reconstructed)</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
      background: #1a1a1a;
    }
    
    #banner {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      background: #ff6b6b;
      color: #fff;
      padding: 12px 16px;
      text-align: center;
      font-weight: 600;
      font-size: 14px;
      z-index: 2000;
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    }
    
    #canvas-container {
      flex: 1;
      position: relative;
      background: #1a1a1a;
      cursor: grab;
      margin-top: 48px;
    }
    
    #canvas-container.dragging {
      cursor: grabbing;
    }
    
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    #sidebar {
      width: 350px;
      background: #2d2d2d;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      border-left: 1px solid #444;
      overflow-y: auto;
    }
    
    #sidebar-header {
      padding: 16px;
      background: #1e1e1e;
      border-bottom: 1px solid #444;
    }
    
    #sidebar-header h1 {
      font-size: 18px;
      margin-bottom: 12px;
      color: #fff;
    }
    
    #search-box {
      width: 100%;
      padding: 8px 12px;
      background: #3d3d3d;
      border: 1px solid #555;
      border-radius: 4px;
      color: #e0e0e0;
      font-size: 14px;
      margin-bottom: 12px;
    }
    
    #search-box:focus {
      outline: none;
      border-color: #666;
      background: #404040;
    }
    
    ${hasDrzavaLayer ? `
    #layer-toggle {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px;
      background: #3d3d3d;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    
    #layer-toggle label {
      flex: 1;
      font-size: 13px;
      cursor: pointer;
    }
    
    #layer-toggle input[type="checkbox"] {
      cursor: pointer;
    }
    ` : ''}
    
    #properties {
      padding: 16px;
      flex: 1;
      overflow-y: auto;
    }
    
    #properties h2 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #fff;
    }
    
    #properties-content {
      font-family: 'Courier New', monospace;
      font-size: 12px;
      background: #1e1e1e;
      padding: 12px;
      border-radius: 4px;
      white-space: pre-wrap;
      word-break: break-all;
      max-height: 400px;
      overflow-y: auto;
    }
    
    #tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.85);
      color: #fff;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 12px;
      pointer-events: none;
      z-index: 1000;
      display: none;
      max-width: 300px;
    }
    
    #tooltip.visible {
      display: block;
    }
    
    #fit-button {
      position: absolute;
      top: 60px;
      right: 10px;
      padding: 8px 16px;
      background: #3d3d3d;
      border: 1px solid #555;
      border-radius: 4px;
      color: #e0e0e0;
      cursor: pointer;
      font-size: 12px;
      z-index: 1000;
    }
    
    #fit-button:hover {
      background: #4d4d4d;
    }
  </style>
</head>
<body>
  <div id="banner">
    RECONSTRUCTED MUNICIPALITY BORDERS (DERIVED FROM SETTLEMENT OUTLINES)
  </div>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
    <button id="fit-button">Fit to View</button>
  </div>
  
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Municipality Borders</h1>
      <input type="text" id="search-box" placeholder="Search by munid_5 or name">
      ${hasDrzavaLayer ? `
      <div id="layer-toggle">
        <label>
          <input type="checkbox" id="show-drzava-layer"> Show drzava.js layer (comparison)
        </label>
      </div>
      ` : ''}
    </div>
    <div id="properties">
      <h2>Selected Municipality</h2>
      <div id="properties-content">Click on a municipality to view details</div>
    </div>
  </div>
  
  <script>
    const reconstructedFeatures = ${reconstructedJson};
    const drzavaFeatures = ${drzavaJson};
    const bounds = ${boundsJson};
    const hasDrzavaLayer = ${hasDrzavaLayer};
    
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('tooltip');
    const searchBox = document.getElementById('search-box');
    const propertiesContent = document.getElementById('properties-content');
    const fitButton = document.getElementById('fit-button');
    const container = document.getElementById('canvas-container');
    const showDrzavaCheckbox = hasDrzavaLayer ? document.getElementById('show-drzava-layer') : null;
    
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let selectedMunid5 = null;
    let showDrzavaLayer = false;
    
    // Initialize canvas size
    function resizeCanvas() {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      render();
    }
    
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    
    // Calculate initial view to fit all features
    function fitToView() {
      const padding = 20;
      const width = bounds[2] - bounds[0];
      const height = bounds[3] - bounds[1];
      const scaleX = (canvas.width - padding * 2) / width;
      const scaleY = (canvas.height - padding * 2) / height;
      scale = Math.min(scaleX, scaleY);
      offsetX = (canvas.width - width * scale) / 2 - bounds[0] * scale;
      offsetY = (canvas.height - height * scale) / 2 - bounds[1] * scale;
      render();
    }
    
    fitToView();
    fitButton.addEventListener('click', fitToView);
    
    if (showDrzavaCheckbox) {
      showDrzavaCheckbox.addEventListener('change', (e) => {
        showDrzavaLayer = e.target.checked;
        render();
      });
    }
    
    // Transform coordinates
    function transformX(x) {
      return x * scale + offsetX;
    }
    
    function transformY(y) {
      return y * scale + offsetY;
    }
    
    // Render all features
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Draw drzava layer first (if enabled) as background
      if (hasDrzavaLayer && showDrzavaLayer && drzavaFeatures) {
        for (const feature of drzavaFeatures) {
          for (const ring of feature.rings) {
            if (ring.length < 2) continue;
            
            ctx.beginPath();
            const first = ring[0];
            ctx.moveTo(transformX(first[0]), transformY(first[1]));
            
            for (let i = 1; i < ring.length; i++) {
              ctx.lineTo(transformX(ring[i][0]), transformY(ring[i][1]));
            }
            
            ctx.closePath();
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 0.5;
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }
      
      // Draw reconstructed layer (default)
      for (const feature of reconstructedFeatures) {
        for (const ring of feature.rings) {
          if (ring.length < 2) continue;
          
          ctx.beginPath();
          const first = ring[0];
          ctx.moveTo(transformX(first[0]), transformY(first[1]));
          
          for (let i = 1; i < ring.length; i++) {
            ctx.lineTo(transformX(ring[i][0]), transformY(ring[i][1]));
          }
          
          ctx.closePath();
          
          // Highlight selected municipality
          if (selectedMunid5 === feature.munid_5) {
            ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';
            ctx.fill();
          }
          
          ctx.strokeStyle = selectedMunid5 === feature.munid_5 ? '#66aaff' : '#888';
          ctx.lineWidth = selectedMunid5 === feature.munid_5 ? 2 : 1;
          ctx.stroke();
        }
      }
    }
    
    // Mouse interaction
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX - offsetX;
      dragStartY = e.clientY - offsetY;
      container.classList.add('dragging');
    });
    
    canvas.addEventListener('mousemove', (e) => {
      if (isDragging) {
        offsetX = e.clientX - dragStartX;
        offsetY = e.clientY - dragStartY;
        render();
      } else {
        // Hover detection
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left - offsetX) / scale;
        const y = (e.clientY - rect.top - offsetY) / scale;
        
        let hoveredMunid5 = null;
        for (const feature of reconstructedFeatures) {
          if (feature.rings.length > 0 && isPointInRing(x, y, feature.rings[0])) {
            hoveredMunid5 = feature.munid_5;
            break;
          }
        }
        
        if (hoveredMunid5) {
          const feature = reconstructedFeatures.find(f => f.munid_5 === hoveredMunid5);
          tooltip.textContent = \`munid_5: \${hoveredMunid5}\${feature.name ? ' (' + feature.name + ')' : ''}\`;
          tooltip.classList.add('visible');
          tooltip.style.left = e.clientX + 'px';
          tooltip.style.top = (e.clientY + 20) + 'px';
        } else {
          tooltip.classList.remove('visible');
        }
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      container.classList.remove('dragging');
    });
    
    canvas.addEventListener('mouseleave', () => {
      isDragging = false;
      container.classList.remove('dragging');
      tooltip.classList.remove('visible');
    });
    
    // Click to select
    canvas.addEventListener('click', (e) => {
      if (isDragging) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left - offsetX) / scale;
      const y = (e.clientY - rect.top - offsetY) / scale;
      
      for (const feature of reconstructedFeatures) {
        if (feature.rings.length > 0 && isPointInRing(x, y, feature.rings[0])) {
          selectedMunid5 = feature.munid_5;
          render();
          updateProperties(feature);
          break;
        }
      }
    });
    
    // Wheel zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = scale * zoomFactor;
      
      if (newScale > 0.01 && newScale < 100) {
        const worldX = (mouseX - offsetX) / scale;
        const worldY = (mouseY - offsetY) / scale;
        
        scale = newScale;
        offsetX = mouseX - worldX * scale;
        offsetY = mouseY - worldY * scale;
        
        render();
      }
    });
    
    // Search functionality
    searchBox.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const searchTerm = searchBox.value.trim().toLowerCase();
        if (!searchTerm) return;
        
        const feature = reconstructedFeatures.find(f => 
          f.munid_5.toLowerCase() === searchTerm || 
          (f.name && f.name.toLowerCase().includes(searchTerm))
        );
        
        if (feature) {
          selectedMunid5 = feature.munid_5;
          render();
          updateProperties(feature);
          
          // Zoom to feature
          const centerX = (feature.bbox[0] + feature.bbox[2]) / 2;
          const centerY = (feature.bbox[1] + feature.bbox[3]) / 2;
          const width = feature.bbox[2] - feature.bbox[0];
          const height = feature.bbox[3] - feature.bbox[1];
          const padding = 50;
          
          const scaleX = (canvas.width - padding * 2) / width;
          const scaleY = (canvas.height - padding * 2) / height;
          scale = Math.min(scaleX, scaleY) * 0.8;
          offsetX = (canvas.width - width * scale) / 2 - feature.bbox[0] * scale;
          offsetY = (canvas.height - height * scale) / 2 - feature.bbox[1] * scale;
          
          render();
        } else {
          alert(\`Municipality not found: \${searchTerm}\`);
        }
      }
    });
    
    // Simple point-in-polygon (ray casting)
    function isPointInRing(x, y, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    
    // Update properties panel
    function updateProperties(feature) {
      propertiesContent.textContent = \`munid_5: \${feature.munid_5}
name: \${feature.name || 'null'}
source: \${feature.source}
vertex_count: \${feature.vertexCount}
bbox: [\${feature.bbox[0]}, \${feature.bbox[1]}, \${feature.bbox[2]}, \${feature.bbox[3]}]\`;
    }
  </script>
</body>
</html>`;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Building municipality reconstructed borders viewer...\n');
  
  // Read reconstructed GeoJSON
  console.log('Loading reconstructed borders...');
  const reconstructedContent = await readFile(RECONSTRUCTED_PATH, 'utf8');
  const reconstructedFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(reconstructedContent);
  
  // Process reconstructed features
  const reconstructedFeatures: MunicipalityFeature[] = [];
  
  for (const feature of reconstructedFC.features) {
    const munid_5 = feature.properties?.munid_5;
    if (typeof munid_5 !== 'string' && typeof munid_5 !== 'number') {
      console.warn(`Skipping feature without munid_5: ${munid_5}`);
      continue;
    }
    
    const rings = extractRings(feature);
    const bbox = calculateBbox(feature);
    const vertexCount = countVertices(rings);
    const name = feature.properties?.name || null;
    const source = feature.properties?.source || 'unknown';
    
    reconstructedFeatures.push({
      munid_5: String(munid_5),
      name: name ? String(name) : null,
      bbox,
      rings,
      vertexCount,
      source: String(source)
    });
  }
  
  console.log(`Loaded ${reconstructedFeatures.length} reconstructed municipalities\n`);
  
  // Try to load drzava layer for comparison (optional)
  let drzavaFeatures: MunicipalityFeature[] | null = null;
  try {
    await access(DRZAVA_PATH);
    console.log('Loading drzava.js borders for comparison...');
    const drzavaContent = await readFile(DRZAVA_PATH, 'utf8');
    const drzavaFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(drzavaContent);
    
    for (const feature of drzavaFC.features) {
      const munid_5 = feature.properties?.munid_5;
      if (typeof munid_5 !== 'string' && typeof munid_5 !== 'number') {
        continue;
      }
      
      const rings = extractRings(feature);
      const bbox = calculateBbox(feature);
      const vertexCount = countVertices(rings);
      const name = feature.properties?.name || null;
      
      if (!drzavaFeatures) {
        drzavaFeatures = [];
      }
      
      drzavaFeatures.push({
        munid_5: String(munid_5),
        name: name ? String(name) : null,
        bbox,
        rings,
        vertexCount,
        source: 'drzava.js'
      });
    }
    
    if (drzavaFeatures) {
      console.log(`Loaded ${drzavaFeatures.length} drzava.js municipalities for comparison\n`);
    }
  } catch (err) {
    console.log('drzava.js borders not found, comparison layer disabled\n');
  }
  
  // Calculate overall bounds from reconstructed layer
  const allBbox = turf.bbox(reconstructedFC);
  const bounds: [number, number, number, number] = [
    roundCoord(allBbox[0]),
    roundCoord(allBbox[1]),
    roundCoord(allBbox[2]),
    roundCoord(allBbox[3])
  ];
  
  // Generate HTML
  const html = generateHTML(reconstructedFeatures, drzavaFeatures, bounds);
  
  // Write HTML
  await writeFile(OUTPUT_PATH, html, 'utf8');
  
  console.log(`✓ Generated viewer with ${reconstructedFeatures.length} reconstructed municipalities`);
  if (drzavaFeatures) {
    console.log(`✓ Comparison layer available: ${drzavaFeatures.length} drzava.js municipalities`);
  }
  console.log(`✓ Output: ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
