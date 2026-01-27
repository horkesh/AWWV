/**
 * Build SVG Substrate Viewer Index
 * 
 * EXPERIMENTAL SCRIPT - NOT CANONICAL
 * 
 * This script builds a viewer for the experimental SVG-derived substrate.
 * Creates a simple viewer that displays matched vs unmatched settlements.
 * 
 * Usage:
 *   npm run map:viewer:svg_substrate:index
 *   or: tsx scripts/map/build_svg_substrate_viewer_index.ts
 * 
 * Outputs:
 *   - data/derived/svg_substrate_viewer/index.html
 *   - data/derived/svg_substrate_viewer/viewer.js
 *   - data/derived/svg_substrate_viewer/data_index.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat } from "../assistant/mistake_guard";

// Mistake guard
loadMistakes();
assertNoRepeat("SVG substrate viewer: add a borders-only inspection mode (no fills) for visually inspecting settlement outlines");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    settlement_name: string | null;
    municipality_id: string | null;
    source_file: string;
    source_shape_id: string;
    transform_applied: {
      viewBox?: { x: number; y: number; width: number; height: number };
      translate?: { x: number; y: number };
      scale?: { x: number; y: number };
      rotate?: number;
      identity: boolean;
    };
    notes?: string[];
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface ViewerIndex {
  meta: {
    geometry_path: string;
    counts: {
      features: number;
      matched: number;
      unmatched: number;
    };
    global_bbox: [number, number, number, number];
  };
}

/**
 * Compute bbox for a feature
 */
function computeBbox(coords: Polygon | MultiPolygon): { minx: number; miny: number; maxx: number; maxy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const processRing = (ring: Ring) => {
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [x, y] = pt;
      if (!isFinite(x) || !isFinite(y)) continue;
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  };

  const isMultiPolygon = Array.isArray(coords) && 
                         coords.length > 0 && 
                         Array.isArray(coords[0]) && 
                         coords[0].length > 0 && 
                         Array.isArray(coords[0][0]) && 
                         coords[0][0].length > 0 && 
                         Array.isArray(coords[0][0][0]);

  if (isMultiPolygon) {
    for (const poly of coords as MultiPolygon) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        processRing(ring);
      }
    }
  } else {
    for (const ring of coords as Polygon) {
      if (!Array.isArray(ring)) continue;
      processRing(ring);
    }
  }

  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  }

  return { minx, miny, maxx, maxy };
}

async function main(): Promise<void> {
  const geojsonPath = resolve('data/derived/svg_substrate/settlements_svg_substrate.geojson');
  const outputDir = resolve('data/derived/svg_substrate_viewer');
  const indexPath = resolve(outputDir, 'data_index.json');
  const htmlPath = resolve(outputDir, 'index.html');
  const viewerJsPath = resolve(outputDir, 'viewer.js');
  
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });
  
  // Load GeoJSON
  process.stdout.write(`Loading ${geojsonPath}...\n`);
  const geojsonContent = readFileSync(geojsonPath, 'utf8');
  const geoJSON = JSON.parse(geojsonContent) as GeoJSONFC;
  
  if (geoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${geoJSON.type}`);
  }
  
  const features = geoJSON.features;
  process.stdout.write(`Loaded ${features.length} features\n`);
  
  // Compute statistics
  let matchedCount = 0;
  let unmatchedCount = 0;
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  for (const feature of features) {
    const sid = feature.properties.sid;
    if (sid.startsWith('UNMATCHED::')) {
      unmatchedCount++;
    } else {
      matchedCount++;
    }
    
    const bbox = computeBbox(feature.geometry.coordinates);
    globalMinx = Math.min(globalMinx, bbox.minx);
    globalMiny = Math.min(globalMiny, bbox.miny);
    globalMaxx = Math.max(globalMaxx, bbox.maxx);
    globalMaxy = Math.max(globalMaxy, bbox.maxy);
  }
  
  // Build index
  const index: ViewerIndex = {
    meta: {
      geometry_path: '/data/derived/svg_substrate/settlements_svg_substrate.geojson',
      counts: {
        features: features.length,
        matched: matchedCount,
        unmatched: unmatchedCount
      },
      global_bbox: [globalMinx, globalMiny, globalMaxx, globalMaxy]
    }
  };
  
  // Write index JSON
  writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  process.stdout.write(`Wrote index to ${indexPath}\n`);
  
  // Write HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SVG Substrate Viewer (Experimental)</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
      height: 100vh;
    }
    #canvas-container {
      position: relative;
      width: 100vw;
      height: 100vh;
    }
    #canvas {
      display: block;
      cursor: grab;
      background: #f5f5f5;
    }
    #canvas.dragging {
      cursor: grabbing;
    }
    #controls {
      position: absolute;
      top: 10px;
      left: 10px;
      background: white;
      padding: 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      z-index: 10;
      max-width: 300px;
      max-height: 90vh;
      overflow-y: auto;
      font-size: 12px;
    }
    .control-group {
      margin-bottom: 12px;
    }
    .control-group:last-child {
      margin-bottom: 0;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
    }
    input[type="checkbox"] {
      margin-right: 6px;
    }
    button {
      padding: 6px 12px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      width: 100%;
    }
    button:hover {
      background: #0056b3;
    }
    .legend {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #ddd;
    }
    .legend-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .legend-color {
      display: inline-block;
      width: 16px;
      height: 16px;
      margin-right: 6px;
      border: 1px solid #333;
      vertical-align: middle;
    }
    .tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 8px;
      border-radius: 4px;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
      max-width: 250px;
      display: none;
    }
    .tooltip-line {
      margin-bottom: 2px;
    }
    .tooltip-line:last-child {
      margin-bottom: 0;
    }
    .hint {
      margin-top: 12px;
      padding: 8px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 3px;
      font-size: 11px;
      color: #856404;
    }
    .warning {
      margin-top: 12px;
      padding: 8px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 3px;
      font-size: 11px;
      color: #856404;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip" class="tooltip"></div>
    <div id="controls">
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-matched" checked>
          Show Matched
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-unmatched" checked>
          Show Unmatched
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-by-municipality">
          Color by Municipality
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="borders-only" checked>
          Borders only
        </label>
      </div>
      <div class="control-group">
        <button id="reset-view">Reset View</button>
      </div>
      <div class="warning">
        <strong>EXPERIMENTAL:</strong> This is an experimental SVG-derived substrate for inspection. Not canonical.
      </div>
      <div class="legend" id="legend"></div>
      <div class="hint" id="hint">
        <strong>Note:</strong> If file:// blocks fetch, run:<br>
        <code>npx http-server -p 8080</code><br>
        from repo root, then open:<br>
        <code>http://localhost:8080/data/derived/svg_substrate_viewer/</code>
      </div>
    </div>
  </div>
  <script src="./viewer.js"></script>
</body>
</html>`;
  
  writeFileSync(htmlPath, html, 'utf8');
  process.stdout.write(`Wrote HTML to ${htmlPath}\n`);
  
  // Write viewer.js (simplified version)
  const viewerJs = `/**
 * SVG Substrate Viewer (Experimental)
 * 
 * Simple viewer for SVG-derived substrate showing matched vs unmatched settlements.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const showMatchedCheck = document.getElementById('show-matched');
  const showUnmatchedCheck = document.getElementById('show-unmatched');
  const showByMunicipalityCheck = document.getElementById('show-by-municipality');
  const bordersOnlyCheck = document.getElementById('borders-only');
  const resetViewBtn = document.getElementById('reset-view');
  const legendDiv = document.getElementById('legend');

  let settlementsGeoJSON = null;
  let dataIndex = null;

  // View state
  let viewX = 0;
  let viewY = 0;
  let viewScale = 1;
  let globalBounds = null;

  // Pan/zoom state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartViewX = 0;
  let dragStartViewY = 0;

  // Hover state
  let hoveredFeature = null;

  // Colors
  const MATCHED_COLOR = 'rgba(76, 175, 80, 0.3)'; // Green
  const UNMATCHED_COLOR = 'rgba(244, 67, 54, 0.3)'; // Red
  const STROKE_COLOR = 'rgba(0, 0, 0, 0.5)';
  const STROKE_WIDTH = 1;

  // Resize canvas
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Transform world to screen
  function worldToScreen(x, y) {
    return {
      x: x * viewScale + viewX,
      y: y * viewScale + viewY
    };
  }

  // Transform screen to world
  function screenToWorld(x, y) {
    return {
      x: (x - viewX) / viewScale,
      y: (y - viewY) / viewScale
    };
  }

  // Compute bounds for a feature
  function computeFeatureBounds(feature) {
    const geom = feature.geometry;
    let coords = [];
    
    if (geom.type === 'Polygon') {
      coords = geom.coordinates[0] || [];
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (poly[0]) coords.push(...poly[0]);
      }
    }
    
    if (coords.length === 0) return null;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of coords) {
      if (pt.length >= 2 && isFinite(pt[0]) && isFinite(pt[1])) {
        minX = Math.min(minX, pt[0]);
        minY = Math.min(minY, pt[1]);
        maxX = Math.max(maxX, pt[0]);
        maxY = Math.max(maxY, pt[1]);
      }
    }
    
    if (!isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }

  // Render polygon
  function renderPolygon(ring, fillColor, strokeColor) {
    if (!ring || ring.length === 0) return;
    
    ctx.beginPath();
    const start = worldToScreen(ring[0][0], ring[0][1]);
    ctx.moveTo(start.x, start.y);
    
    for (let i = 1; i < ring.length; i++) {
      const pt = worldToScreen(ring[i][0], ring[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    ctx.closePath();
    
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    
    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = STROKE_WIDTH / viewScale;
      ctx.stroke();
    }
  }

  // Get feature color
  function getFeatureColor(feature) {
    const sid = feature.properties?.sid || '';
    const isUnmatched = sid.startsWith('UNMATCHED::');
    
    if (showByMunicipalityCheck.checked) {
      // Simple hash-based color by municipality
      const munId = feature.properties?.municipality_id || 'unknown';
      const hash = munId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
      const hue = hash % 360;
      return \`hsla(\${hue}, 70%, 50%, 0.3)\`;
    } else {
      return isUnmatched ? UNMATCHED_COLOR : MATCHED_COLOR;
    }
  }

  // Render feature
  function renderFeature(feature) {
    const geom = feature.geometry;
    const fillColor = bordersOnlyCheck.checked ? null : getFeatureColor(feature);
    
    if (geom.type === 'Polygon') {
      const coords = geom.coordinates;
      if (coords && coords[0]) {
        renderPolygon(coords[0], fillColor, STROKE_COLOR);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (poly && poly[0]) {
          renderPolygon(poly[0], fillColor, STROKE_COLOR);
        }
      }
    }
  }

  // Check if feature should be shown
  function shouldShowFeature(feature) {
    const sid = feature.properties?.sid || '';
    const isUnmatched = sid.startsWith('UNMATCHED::');
    
    if (isUnmatched && !showUnmatchedCheck.checked) return false;
    if (!isUnmatched && !showMatchedCheck.checked) return false;
    
    return true;
  }

  // Render all features
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!settlementsGeoJSON) return;
    
    const features = [...settlementsGeoJSON.features];
    features.sort((a, b) => {
      const sidA = a.properties?.sid || '';
      const sidB = b.properties?.sid || '';
      return String(sidA).localeCompare(String(sidB));
    });
    
    for (const feature of features) {
      if (!shouldShowFeature(feature)) continue;
      renderFeature(feature);
    }
    
    // Draw hover highlight
    if (hoveredFeature && shouldShowFeature(hoveredFeature)) {
      const geom = hoveredFeature.geometry;
      if (geom.type === 'Polygon' && geom.coordinates && geom.coordinates[0]) {
        ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
        ctx.lineWidth = 2;
        renderPolygon(geom.coordinates[0], null, 'rgba(255, 0, 0, 0.8)');
      } else if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) {
          if (poly && poly[0]) {
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
            ctx.lineWidth = 2;
            renderPolygon(poly[0], null, 'rgba(255, 0, 0, 0.8)');
          }
        }
      }
    }
  }

  // Find feature at point
  function findFeatureAt(x, y) {
    if (!settlementsGeoJSON) return null;
    
    const world = screenToWorld(x, y);
    const features = [...settlementsGeoJSON.features].reverse();
    
    for (const feature of features) {
      if (!shouldShowFeature(feature)) continue;
      const bounds = computeFeatureBounds(feature);
      if (bounds && world.x >= bounds.minX && world.x <= bounds.maxX &&
          world.y >= bounds.minY && world.y <= bounds.maxY) {
        return feature;
      }
    }
    
    return null;
  }

  // Update tooltip
  function updateTooltip(feature, x, y) {
    if (!feature) {
      tooltip.style.display = 'none';
      return;
    }
    
    const props = feature.properties || {};
    const sid = props.sid || '(missing sid)';
    const name = props.settlement_name || '(no name)';
    const munId = props.municipality_id || '(no municipality)';
    const sourceFile = props.source_file || '(unknown)';
    const sourceShapeId = props.source_shape_id || '(unknown)';
    
    let html = '';
    html += \`<div class="tooltip-line"><strong>SID:</strong> \${sid}</div>\`;
    html += \`<div class="tooltip-line"><strong>Name:</strong> \${name}</div>\`;
    html += \`<div class="tooltip-line"><strong>Municipality ID:</strong> \${munId}</div>\`;
    html += \`<div class="tooltip-line"><strong>Source:</strong> \${sourceFile}</div>\`;
    html += \`<div class="tooltip-line"><strong>Shape ID:</strong> \${sourceShapeId}</div>\`;
    
    if (props.notes && props.notes.length > 0) {
      html += \`<div class="tooltip-line"><strong>Notes:</strong> \${props.notes.join(', ')}</div>\`;
    }
    
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    tooltip.style.left = (x + 10) + 'px';
    tooltip.style.top = (y + 10) + 'px';
  }

  // Update legend
  function updateLegend() {
    if (showByMunicipalityCheck.checked) {
      legendDiv.innerHTML = '<div class="legend-item"><span class="legend-color" style="background: hsla(0, 70%, 50%, 0.3);"></span>Colored by Municipality</div>';
    } else {
      legendDiv.innerHTML = \`
        <div class="legend-item"><span class="legend-color" style="background: \${MATCHED_COLOR};"></span>Matched</div>
        <div class="legend-item"><span class="legend-color" style="background: \${UNMATCHED_COLOR};"></span>Unmatched</div>
      \`;
    }
  }

  // Fit to bounds
  function fitToBounds() {
    if (!globalBounds) return;
    
    const padding = 50;
    const width = canvas.width - padding * 2;
    const height = canvas.height - padding * 2;
    
    const boundsWidth = globalBounds.maxX - globalBounds.minX;
    const boundsHeight = globalBounds.maxY - globalBounds.minY;
    
    const scaleX = width / boundsWidth;
    const scaleY = height / boundsHeight;
    viewScale = Math.min(scaleX, scaleY);
    
    const centerX = (globalBounds.minX + globalBounds.maxX) / 2;
    const centerY = (globalBounds.minY + globalBounds.maxY) / 2;
    
    viewX = canvas.width / 2 - centerX * viewScale;
    viewY = canvas.height / 2 - centerY * viewScale;
    
    render();
  }

  // Mouse events
  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartViewX = viewX;
    dragStartViewY = viewY;
    canvas.classList.add('dragging');
  });

  canvas.addEventListener('mousemove', (e) => {
    if (isDragging) {
      viewX = dragStartViewX + (e.clientX - dragStartX);
      viewY = dragStartViewY + (e.clientY - dragStartY);
      render();
    } else {
      const feature = findFeatureAt(e.clientX, e.clientY);
      if (feature !== hoveredFeature) {
        hoveredFeature = feature;
        updateTooltip(feature, e.clientX, e.clientY);
        render();
      }
    }
  });

  canvas.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
    hoveredFeature = null;
    tooltip.style.display = 'none';
    canvas.classList.remove('dragging');
    render();
  });

  // Wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const world = screenToWorld(e.clientX, e.clientY);
    const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
    viewScale *= scaleFactor;
    viewX = e.clientX - world.x * viewScale;
    viewY = e.clientY - world.y * viewScale;
    render();
  });

  // Controls
  showMatchedCheck.addEventListener('change', render);
  showUnmatchedCheck.addEventListener('change', render);
  showByMunicipalityCheck.addEventListener('change', () => {
    updateLegend();
    render();
  });
  bordersOnlyCheck.addEventListener('change', render);
  resetViewBtn.addEventListener('click', fitToBounds);

  // Load data
  async function loadData() {
    // Detect file:// protocol and show clear error
    if (window.location.protocol === 'file:') {
      const errorMsg = 'Cannot load data from file:// protocol. Browsers block local file access for security.\n\n' +
        'Please run a local web server:\n' +
        '1. Open terminal in repo root\n' +
        '2. Run: npx http-server -p 8080\n' +
        '3. Open: http://localhost:8080/data/derived/svg_substrate_viewer/index.html';
      alert(errorMsg);
      console.error('CORS error: file:// protocol detected. Use a local web server instead.');
      return;
    }
    
    try {
      // Load index first to get geometry path
      const indexRes = await fetch('./data_index.json');
      if (!indexRes.ok) {
        throw new Error(\`Failed to load index: \${indexRes.statusText}\`);
      }
      const indexData = await indexRes.json();
      
      const geoJSONRes = await fetch(indexData.meta.geometry_path);
      if (!geoJSONRes.ok) {
        throw new Error(\`Failed to load geometry: \${geoJSONRes.statusText}\`);
      }
      
      settlementsGeoJSON = await geoJSONRes.json();
      dataIndex = indexData;
      
      // Compute global bounds
      if (dataIndex.meta.global_bbox) {
        const [minx, miny, maxx, maxy] = dataIndex.meta.global_bbox;
        globalBounds = { minX: minx, minY: miny, maxX: maxx, maxY: maxy };
      }
      
      updateLegend();
      fitToBounds();
    } catch (err) {
      console.error('Error loading data:', err);
      const errorMsg = err instanceof Error && err.message.includes('fetch') && window.location.protocol === 'file:'
        ? 'CORS error: Cannot load data from file:// protocol. Please run a local web server (npx http-server -p 8080) and open via http://localhost:8080/...'
        : \`Failed to load data: \${err instanceof Error ? err.message : String(err)}\`;
      alert(errorMsg);
    }
  }

  // Initialize
  loadData();
})();`;
  
  writeFileSync(viewerJsPath, viewerJs, 'utf8');
  process.stdout.write(`Wrote viewer.js to ${viewerJsPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Features: ${index.meta.counts.features}\n`);
  process.stdout.write(`  Matched: ${index.meta.counts.matched}\n`);
  process.stdout.write(`  Unmatched: ${index.meta.counts.unmatched}\n`);
  process.stdout.write(`  Global bbox: [${globalMinx.toFixed(6)}, ${globalMiny.toFixed(6)}, ${globalMaxx.toFixed(6)}, ${globalMaxy.toFixed(6)}]\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
