/**
 * Build Municipality Borders Viewer: Create HTML viewer for municipality borders only
 * 
 * Generates a standalone HTML file that renders ONLY municipality borders
 * (no settlement polygons, no points) for visual inspection.
 * 
 * Outputs:
 *   - data/derived/municipality_borders_viewer.html
 * 
 * Usage:
 *   tsx tools/map/build_municipality_viewer_html.ts
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: municipality borders only HTML viewer (no settlements)");
loadLedger();
assertLedgerFresh("map rebuild: municipality borders only HTML viewer (no settlements)");

// ============================================================================
// Types
// ============================================================================

interface MunicipalityFeature {
  mid: string;
  name?: string;
  bbox: [number, number, number, number];
  rings: number[][][]; // Array of rings (each ring is array of [x,y] coordinates)
}

// ============================================================================
// Constants
// ============================================================================

const PREFERRED_PATH = resolve('data/derived/municipality_outline_rekeyed.geojson');
const FALLBACK_PATH = resolve('data/derived/municipality_outline.geojson');
const NATIONAL_FALLBACK_PATH = resolve('data/derived/national_outline.geojson');
const OUTPUT_PATH = resolve('data/derived/municipality_borders_viewer.html');
const DERIVED_DIR = resolve('data/derived');
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
 * Load municipality outlines with fallback logic
 */
async function loadOutlines(): Promise<{
  features: MunicipalityFeature[];
  isNational: boolean;
  hasOutlines: boolean;
}> {
  // Try preferred path first
  let geojsonPath: string | null = null;
  let isNational = false;
  
  // Try to load from preferred path, then fallback path
  const pathsToTry = [PREFERRED_PATH, FALLBACK_PATH];
  
  for (const path of pathsToTry) {
    try {
      await access(path, constants.F_OK);
      const content = await readFile(path, 'utf8');
      const fc: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(content);
      
      if (fc.features && fc.features.length > 0) {
        // Convert to MunicipalityFeature format
        const features: MunicipalityFeature[] = [];
        
        for (const feature of fc.features) {
          const mid = feature.properties?.mid || feature.properties?.id || '';
          if (!mid) continue;
          
          features.push({
            mid: String(mid),
            name: feature.properties?.name || feature.properties?.municipality_name,
            bbox: calculateBbox(feature),
            rings: extractRings(feature)
          });
        }
        
        if (features.length > 0) {
          // Stable sort by mid (string compare)
          features.sort((a, b) => a.mid.localeCompare(b.mid));
          return { features, isNational: false, hasOutlines: true };
        }
      }
    } catch {
      // Try next path
      continue;
    }
  }
  
  // Fallback to national outline if municipality outlines unavailable
  try {
    await access(NATIONAL_FALLBACK_PATH, constants.F_OK);
    const nationalContent = await readFile(NATIONAL_FALLBACK_PATH, 'utf8');
    const nationalFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(nationalContent);
    if (nationalFC.features && nationalFC.features.length > 0) {
      const feature = nationalFC.features[0];
      return {
        features: [{
          mid: feature.properties?.id || 'BIH',
          name: feature.properties?.name || 'Bosnia and Herzegovina',
          bbox: calculateBbox(feature),
          rings: extractRings(feature)
        }],
        isNational: true,
        hasOutlines: false
      };
    }
  } catch {
    // No national outline available either
  }
  
  return { features: [], isNational: false, hasOutlines: false };
}

// ============================================================================
// HTML Generation
// ============================================================================

function generateHTML(features: MunicipalityFeature[], isNational: boolean, hasOutlines: boolean): string {
  const featuresJson = JSON.stringify(features);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Borders Viewer</title>
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
    
    #search-box:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    #warning-overlay {
      position: absolute;
      top: 10px;
      left: 10px;
      background: rgba(255, 170, 0, 0.9);
      color: #000;
      padding: 12px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      z-index: 1000;
      max-width: 300px;
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
      background: #404040;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip"></div>
    ${isNational || !hasOutlines ? '<div id="warning-overlay">⚠ Municipality outlines unavailable</div>' : ''}
    <button id="fit-button">Fit to View</button>
  </div>
  
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Municipality Borders</h1>
      <input type="text" id="search-box" placeholder="Search by mid or name..." ${isNational || !hasOutlines ? 'disabled' : ''}>
    </div>
    <div id="properties">
      <h2>Selected Municipality</h2>
      <div id="properties-content">Click on a border to see details</div>
    </div>
  </div>

  <script>
    // Data embedded from build
    const FEATURES = ${featuresJson};
    const IS_NATIONAL = ${isNational ? 'true' : 'false'};
    const HAS_OUTLINES = ${hasOutlines ? 'true' : 'false'};
    
    // Canvas setup
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    const container = document.getElementById('canvas-container');
    const tooltip = document.getElementById('tooltip');
    const searchBox = document.getElementById('search-box');
    const propertiesContent = document.getElementById('properties-content');
    const fitButton = document.getElementById('fit-button');
    
    // View state
    let scale = 1;
    let panX = 0;
    let panY = 0;
    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let hoveredFeature = null;
    let selectedFeature = null;
    
    // Feature bounds (precomputed)
    const featureBounds = new Map();
    
    // Initialize
    function init() {
      // Precompute bounds for all features
      FEATURES.forEach((feature, idx) => {
        featureBounds.set(idx, feature.bbox);
      });
      
      // Calculate initial view
      let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
      FEATURES.forEach(f => {
        const [minX, minY, maxX, maxY] = f.bbox;
        allMinX = Math.min(allMinX, minX);
        allMinY = Math.min(allMinY, minY);
        allMaxX = Math.max(allMaxX, maxX);
        allMaxY = Math.max(allMaxY, maxY);
      });
      
      // Fit to view
      const width = allMaxX - allMinX;
      const height = allMaxY - allMinY;
      const centerX = (allMinX + allMaxX) / 2;
      const centerY = (allMinY + allMaxY) / 2;
      
      scale = Math.min(canvas.width / width, canvas.height / height) * 0.9;
      panX = canvas.width / 2 - centerX * scale;
      panY = canvas.height / 2 - centerY * scale;
      
      draw();
    }
    
    function worldToScreen(x, y) {
      return {
        x: x * scale + panX,
        y: y * scale + panY
      };
    }
    
    function screenToWorld(x, y) {
      return {
        x: (x - panX) / scale,
        y: (y - panY) / scale
      };
    }
    
    function isPointInPolygon(point, rings) {
      // Test against outer ring (first ring)
      if (rings.length === 0) return false;
      const outerRing = rings[0];
      
      let inside = false;
      for (let i = 0, j = outerRing.length - 1; i < outerRing.length; j = i++) {
        const xi = outerRing[i][0], yi = outerRing[i][1];
        const xj = outerRing[j][0], yj = outerRing[j][1];
        const intersect = ((yi > point.y) !== (yj > point.y)) &&
          (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      // Viewport bounds for culling
      const viewBounds = {
        minX: screenToWorld(0, 0).x,
        minY: screenToWorld(0, 0).y,
        maxX: screenToWorld(canvas.width, canvas.height).x,
        maxY: screenToWorld(canvas.height, canvas.height).y
      };
      
      // Draw all borders
      FEATURES.forEach((feature, idx) => {
        const bounds = featureBounds.get(idx);
        if (!bounds) return;
        
        // Viewport culling
        const [minX, minY, maxX, maxY] = bounds;
        if (maxX < viewBounds.minX || minX > viewBounds.maxX ||
            maxY < viewBounds.minY || minY > viewBounds.maxY) {
          return;
        }
        
        const isSelected = selectedFeature === feature;
        const isHovered = hoveredFeature === feature;
        
        // Draw all rings
        feature.rings.forEach(ring => {
          if (ring.length < 2) return;
          
          ctx.beginPath();
          const first = worldToScreen(ring[0][0], ring[0][1]);
          ctx.moveTo(first.x, first.y);
          
          for (let i = 1; i < ring.length; i++) {
            const screen = worldToScreen(ring[i][0], ring[i][1]);
            ctx.lineTo(screen.x, screen.y);
          }
          ctx.closePath();
          
          // Style
          if (isSelected) {
            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 3;
          } else if (isHovered) {
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
          } else {
            ctx.strokeStyle = '#6666ff';
            ctx.lineWidth = 1;
          }
          
          ctx.stroke();
        });
      });
    }
    
    function findFeatureAt(x, y) {
      if (IS_NATIONAL || !HAS_OUTLINES) return null;
      
      const world = screenToWorld(x, y);
      
      // Bbox prefilter, then point-in-polygon test
      for (let i = FEATURES.length - 1; i >= 0; i--) {
        const feature = FEATURES[i];
        const [minX, minY, maxX, maxY] = feature.bbox;
        
        // Bbox check
        if (world.x >= minX && world.x <= maxX && world.y >= minY && world.y <= maxY) {
          // Point-in-polygon test
          if (isPointInPolygon(world, feature.rings)) {
            return feature;
          }
        }
      }
      
      return null;
    }
    
    function updateTooltip(feature, x, y) {
      if (!feature || IS_NATIONAL || !HAS_OUTLINES) {
        tooltip.classList.remove('visible');
        return;
      }
      
      const mid = feature.mid || 'N/A';
      const name = feature.name || '';
      const text = name ? \`mid: \${mid}\\nname: \${name}\` : \`mid: \${mid}\`;
      
      tooltip.textContent = text;
      tooltip.style.left = (x + 10) + 'px';
      tooltip.style.top = (y + 10) + 'px';
      tooltip.classList.add('visible');
    }
    
    function showFeatureProperties(feature) {
      if (!feature || IS_NATIONAL || !HAS_OUTLINES) {
        propertiesContent.textContent = 'Click on a border to see details';
        return;
      }
      
      const props = {
        mid: feature.mid,
        name: feature.name,
        bbox: feature.bbox
      };
      
      propertiesContent.textContent = JSON.stringify(props, null, 2);
    }
    
    function fitToView() {
      if (FEATURES.length === 0) return;
      
      let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
      FEATURES.forEach(f => {
        const [minX, minY, maxX, maxY] = f.bbox;
        allMinX = Math.min(allMinX, minX);
        allMinY = Math.min(allMinY, minY);
        allMaxX = Math.max(allMaxX, maxX);
        allMaxY = Math.max(allMaxY, maxY);
      });
      
      const width = allMaxX - allMinX;
      const height = allMaxY - allMinY;
      const centerX = (allMinX + allMaxX) / 2;
      const centerY = (allMinY + allMaxY) / 2;
      
      scale = Math.min(canvas.width / width, canvas.height / height) * 0.9;
      panX = canvas.width / 2 - centerX * scale;
      panY = canvas.height / 2 - centerY * scale;
      
      draw();
    }
    
    // Event handlers
    function resizeCanvas() {
      canvas.width = container.clientWidth;
      canvas.height = container.clientHeight;
      draw();
    }
    
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      dragStartX = e.clientX - panX;
      dragStartY = e.clientY - panY;
      container.classList.add('dragging');
    });
    
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      if (isDragging) {
        panX = e.clientX - dragStartX;
        panY = e.clientY - dragStartY;
        draw();
      } else {
        const feature = findFeatureAt(x, y);
        hoveredFeature = feature;
        updateTooltip(feature, e.clientX, e.clientY);
        draw();
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
      container.classList.remove('dragging');
    });
    
    canvas.addEventListener('click', (e) => {
      if (IS_NATIONAL || !HAS_OUTLINES) return;
      
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const feature = findFeatureAt(x, y);
      selectedFeature = feature;
      showFeatureProperties(feature);
      draw();
    });
    
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      
      const worldBefore = screenToWorld(mouseX, mouseY);
      scale *= e.deltaY > 0 ? 0.9 : 1.1;
      scale = Math.max(0.1, Math.min(100, scale));
      const worldAfter = screenToWorld(mouseX, mouseY);
      
      panX += (worldBefore.x - worldAfter.x) * scale;
      panY += (worldBefore.y - worldAfter.y) * scale;
      
      draw();
    });
    
    fitButton.addEventListener('click', fitToView);
    
    searchBox.addEventListener('input', (e) => {
      if (IS_NATIONAL || !HAS_OUTLINES) return;
      
      const query = e.target.value.toLowerCase().trim();
      if (!query) {
        selectedFeature = null;
        showFeatureProperties(null);
        draw();
        return;
      }
      
      // Search by mid or name
      const found = FEATURES.find(f => {
        const mid = String(f.mid || '').toLowerCase();
        const name = String(f.name || '').toLowerCase();
        return mid.includes(query) || name.includes(query);
      });
      
      if (found) {
        selectedFeature = found;
        showFeatureProperties(found);
        
        // Zoom to bbox
        const [minX, minY, maxX, maxY] = found.bbox;
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const width = maxX - minX;
        const height = maxY - minY;
        
        scale = Math.min(canvas.width / width, canvas.height / height) * 0.9;
        panX = canvas.width / 2 - centerX * scale;
        panY = canvas.height / 2 - centerY * scale;
        
        draw();
      }
    });
    
    window.addEventListener('resize', resizeCanvas);
    
    // Initialize
    resizeCanvas();
    init();
  </script>
</body>
</html>`;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Building municipality borders viewer...\n');
  
  try {
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Load outlines with fallback
    const { features, isNational, hasOutlines } = await loadOutlines();
    
    if (isNational || !hasOutlines) {
      console.log(`Loaded ${features.length} national outline(s)`);
      console.log('  Warning: Municipality outlines unavailable, showing national outline fallback');
    } else {
      console.log(`Loaded ${features.length} municipality outline(s)`);
    }
    
    // Generate HTML
    const html = generateHTML(features, isNational, hasOutlines);
    
    await writeFile(OUTPUT_PATH, html, 'utf8');
    
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log(`  Features: ${features.length}`);
    console.log(`  Is national: ${isNational}`);
    console.log(`  Has outlines: ${hasOutlines}`);
    console.log('✓ Municipality borders viewer build complete');
  } catch (err) {
    console.error('Error building municipality borders viewer:', err);
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) {
        console.error(err.stack);
      }
    }
    process.exit(1);
  }
}

main();
