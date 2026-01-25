/**
 * Build Municipality Borders Viewer: Create HTML viewer for municipality borders from drzava.js
 * 
 * Generates a standalone HTML file that renders ONLY municipality borders
 * (no settlement points, no polygon fabric) for visual inspection.
 * 
 * Input:
 *   - data/derived/municipality_borders.geojson
 * 
 * Output:
 *   - data/derived/municipality_borders_viewer.html
 * 
 * Usage:
 *   tsx tools/map/build_municipality_borders_viewer_html.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: municipality borders viewer from drzava.js, canvas polygon isolation");
loadLedger();
assertLedgerFresh("map rebuild: municipality borders viewer from drzava.js, canvas polygon isolation");

// ============================================================================
// Types
// ============================================================================

interface MunicipalityFeature {
  mid: number;
  bbox: [number, number, number, number];
  rings: number[][][]; // Array of rings (each ring is array of [x,y] coordinates)
  vertexCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const INPUT_PATH = resolve('data/derived/municipality_borders.geojson');
const OUTPUT_PATH = resolve('data/derived/municipality_borders_viewer.html');
const COORDINATE_PRECISION = 3; // For LOCAL_PIXELS_V2

// ============================================================================
// Utilities
// ============================================================================

/**
 * Round coordinate to fixed precision
 */
function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

/**
 * Calculate bbox for a feature
 */
function calculateBbox(feature: turf.Feature<turf.Polygon | turf.MultiPolygon>): [number, number, number, number] {
  const bbox = turf.bbox(feature);
  return [
    roundCoord(bbox[0]),
    roundCoord(bbox[1]),
    roundCoord(bbox[2]),
    roundCoord(bbox[3])
  ];
}

/**
 * Extract rings from Polygon or MultiPolygon
 */
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

/**
 * Count total vertices in rings
 */
function countVertices(rings: number[][][]): number {
  return rings.reduce((sum, ring) => sum + ring.length, 0);
}

// ============================================================================
// HTML Generation
// ============================================================================

/**
 * Generate HTML viewer
 */
function generateHTML(features: MunicipalityFeature[], bounds: [number, number, number, number]): string {
  const featuresJson = JSON.stringify(features);
  const boundsJson = JSON.stringify(bounds);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Borders Viewer (drzava.js)</title>
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
    
    #canvas-container {
      flex: 1;
      position: relative;
      background: #1a1a1a;
      cursor: grab;
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
    }
    
    #search-box:focus {
      outline: none;
      border-color: #666;
      background: #404040;
    }
    
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
      top: 10px;
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
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
    <button id="fit-button">Fit to View</button>
  </div>
  
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Municipality Borders</h1>
      <input type="text" id="search-box" placeholder="Search by mid (e.g., 10014)">
    </div>
    <div id="properties">
      <h2>Selected Municipality</h2>
      <div id="properties-content">Click on a municipality to view details</div>
    </div>
  </div>
  
  <script>
    const features = ${featuresJson};
    const bounds = ${boundsJson};
    
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const tooltip = document.getElementById('tooltip');
    const searchBox = document.getElementById('search-box');
    const propertiesContent = document.getElementById('properties-content');
    const fitButton = document.getElementById('fit-button');
    const container = document.getElementById('canvas-container');
    
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let selectedMid = null;
    
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
      
      // Draw all municipalities
      for (const feature of features) {
        // IMPORTANT: Each polygon uses its own beginPath()/closePath()
        // to prevent borders from connecting across municipalities
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
          if (selectedMid === feature.mid) {
            ctx.fillStyle = 'rgba(100, 150, 255, 0.3)';
            ctx.fill();
          }
          
          ctx.strokeStyle = selectedMid === feature.mid ? '#66aaff' : '#888';
          ctx.lineWidth = selectedMid === feature.mid ? 2 : 1;
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
        
        let hoveredMid = null;
        for (const feature of features) {
          // Simple point-in-polygon check (using first ring only for performance)
          if (feature.rings.length > 0 && isPointInRing(x, y, feature.rings[0])) {
            hoveredMid = feature.mid;
            break;
          }
        }
        
        if (hoveredMid) {
          tooltip.textContent = \`mid: \${hoveredMid}\`;
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
      
      for (const feature of features) {
        if (feature.rings.length > 0 && isPointInRing(x, y, feature.rings[0])) {
          selectedMid = feature.mid;
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
        const searchMid = parseInt(searchBox.value.trim(), 10);
        if (!isNaN(searchMid)) {
          const feature = features.find(f => f.mid === searchMid);
          if (feature) {
            selectedMid = searchMid;
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
            alert(\`Municipality with mid \${searchMid} not found\`);
          }
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
      propertiesContent.textContent = \`mid: \${feature.mid}
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
  console.log('Building municipality borders viewer...\n');
  
  // Read GeoJSON
  const content = await readFile(INPUT_PATH, 'utf8');
  const fc: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(content);
  
  // Process features
  const processedFeatures: MunicipalityFeature[] = [];
  
  for (const feature of fc.features) {
    const mid = feature.properties?.mid;
    if (typeof mid !== 'number') {
      console.warn(`Skipping feature without numeric mid: ${mid}`);
      continue;
    }
    
    const rings = extractRings(feature);
    const bbox = calculateBbox(feature);
    const vertexCount = countVertices(rings);
    
    processedFeatures.push({
      mid,
      bbox,
      rings,
      vertexCount
    });
  }
  
  // Calculate overall bounds
  const allBbox = turf.bbox(fc);
  const bounds: [number, number, number, number] = [
    roundCoord(allBbox[0]),
    roundCoord(allBbox[1]),
    roundCoord(allBbox[2]),
    roundCoord(allBbox[3])
  ];
  
  // Generate HTML
  const html = generateHTML(processedFeatures, bounds);
  
  // Write HTML
  await writeFile(OUTPUT_PATH, html, 'utf8');
  
  console.log(`✓ Generated viewer with ${processedFeatures.length} municipalities`);
  console.log(`✓ Output: ${OUTPUT_PATH}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
