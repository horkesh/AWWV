/**
 * Build Contact Graph Viewer
 * 
 * CANONICAL SCRIPT FOR PHASE 1 CONTACT GRAPH VIEWER
 * 
 * This script builds a canvas-based viewer for the Phase 1 settlement contact graph.
 * It renders settlement borders and overlays adjacency edges with toggles by type.
 * 
 * Usage:
 *   npm run map:viewer:contact:phase1
 *   or: tsx scripts/map/build_contact_graph_viewer.ts
 * 
 * Outputs:
 *   - data/derived/contact_graph_viewer/index.html
 *   - data/derived/contact_graph_viewer/viewer.js
 *   - data/derived/contact_graph_viewer/data_index.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, warnIfUnrecorded } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("fix Phase 1 contact graph viewer to actually load and render settlement_contact_graph.json");

interface ContactGraph {
  schema_version: number;
  parameters: {
    D0: number;
  };
  nodes: Array<{ sid: string }>;
  edges: Array<{
    a: string;
    b: string;
    type: 'shared_border' | 'point_touch' | 'distance_contact';
    overlap_len?: number;
    min_dist?: number;
  }>;
}

interface GeoJSONFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface ViewerIndex {
  meta: {
    substrate_path: string;
    graph_path: string;
    parameters: {
      D0: number;
    };
    counts: {
      nodes: number;
      edges_total: number;
      edges_shared_border: number;
      edges_point_touch: number;
      edges_distance_contact: number;
    };
  };
  settlements: Record<string, {
    bbox: [number, number, number, number];
    centroid: [number, number];
  }>;
}

/**
 * Compute bbox and centroid for a feature
 */
function computeFeatureBounds(feature: GeoJSONFeature): { bbox: [number, number, number, number]; centroid: [number, number] } | null {
  const geom = feature.geometry;
  let coords: Array<[number, number]> = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Array<Array<[number, number]>>;
    if (polygon.length > 0) {
      coords = polygon[0];
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as Array<Array<Array<[number, number]>>>;
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        coords.push(...polygon[0]);
      }
    }
  }
  
  if (coords.length === 0) {
    return null;
  }
  
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let sumX = 0;
  let sumY = 0;
  
  for (const coord of coords) {
    if (coord.length >= 2) {
      const x = coord[0];
      const y = coord[1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
    }
  }
  
  if (minX === Infinity) {
    return null;
  }
  
  return {
    bbox: [minX, minY, maxX, maxY],
    centroid: [sumX / coords.length, sumY / coords.length]
  };
}

function extractSid(properties: Record<string, unknown>): string | null {
  if (properties.sid !== null && properties.sid !== undefined) {
    return String(properties.sid);
  }
  if (properties.settlement_id !== null && properties.settlement_id !== undefined) {
    return String(properties.settlement_id);
  }
  return null;
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const graphPath = resolve('data/derived/settlement_contact_graph.json');
  const outputDir = resolve('data/derived/contact_graph_viewer');
  
  mkdirSync(outputDir, { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  // Load graph
  process.stdout.write(`Loading ${graphPath}...\n`);
  let graphContent: string;
  try {
    graphContent = readFileSync(graphPath, 'utf8');
  } catch (err) {
    console.error(`Error: Cannot load ${graphPath}`);
    console.error(`Please run 'npm run map:derive:contact:phase1' first to generate the contact graph.`);
    process.exit(1);
  }
  const graph = JSON.parse(graphContent) as ContactGraph;
  
  // Handle old graph format (from diagnostic scripts) - convert to canonical format
  let d0 = 0.5; // Default canonical D0
  let nodes: Array<{ sid: string }> = [];
  let edges: Array<{
    a: string;
    b: string;
    type: 'shared_border' | 'point_touch' | 'distance_contact';
    overlap_len?: number;
    min_dist?: number;
  }> = [];
  
  if (graph.parameters && graph.parameters.D0 !== undefined) {
    // Canonical Phase 1 format
    d0 = graph.parameters.D0;
    nodes = graph.nodes || [];
    edges = graph.edges || [];
  } else if ('edge_list' in graph && Array.isArray((graph as any).edge_list)) {
    // Old diagnostic format - convert it
    console.warn(`Warning: Old graph format detected, converting to canonical format`);
    console.warn(`For canonical Phase 1 graph, run 'npm run map:derive:contact:phase1'`);
    
    const oldGraph = graph as any;
    d0 = 0.5; // Use default
    
    // Extract nodes from edge_list
    const nodeSet = new Set<string>();
    for (const edge of oldGraph.edge_list || []) {
      if (edge.a) nodeSet.add(String(edge.a));
      if (edge.b) nodeSet.add(String(edge.b));
    }
    nodes = Array.from(nodeSet).sort().map(sid => ({ sid }));
    
    // Convert edge_list to edges format
    edges = (oldGraph.edge_list || []).map((e: any) => ({
      a: String(e.a),
      b: String(e.b),
      type: e.type === 'shared_border' ? 'shared_border' : 
            e.type === 'point_touch' ? 'point_touch' : 
            'distance_contact',
      ...(e.overlap_len !== undefined ? { overlap_len: e.overlap_len } : {}),
      ...(e.min_dist !== undefined ? { min_dist: e.min_dist } : {}),
      ...(e.boundary_dist !== undefined ? { min_dist: e.boundary_dist } : {})
    }));
  } else {
    console.error(`Error: Invalid graph format. Cannot parse graph structure.`);
    process.exit(1);
  }
  
  if (nodes.length === 0) {
    console.warn(`Warning: No nodes found in graph`);
  }
  
  if (edges.length === 0) {
    console.warn(`Warning: No edges found in graph`);
  }
  
  // Build settlement index
  const settlements: Record<string, { bbox: [number, number, number, number]; centroid: [number, number] }> = {};
  
  for (const feature of substrateGeoJSON.features) {
    const sid = extractSid(feature.properties);
    if (!sid) continue;
    
    const bounds = computeFeatureBounds(feature);
    if (bounds) {
      settlements[sid] = {
        bbox: bounds.bbox,
        centroid: bounds.centroid
      };
    }
  }
  
  // Build viewer index (meta only, no edges - edges come from graph JSON)
  const viewerIndex: ViewerIndex = {
    meta: {
      substrate_path: 'settlements_substrate.geojson',
      graph_path: 'settlement_contact_graph.json',
      parameters: {
        D0: d0
      },
      counts: {
        nodes: nodes.length,
        edges_total: edges.length,
        edges_shared_border: edges.filter(e => e.type === 'shared_border').length,
        edges_point_touch: edges.filter(e => e.type === 'point_touch').length,
        edges_distance_contact: edges.filter(e => e.type === 'distance_contact').length
      }
    },
    settlements
  };
  
  // Write data index
  const dataIndexPath = resolve(outputDir, 'data_index.json');
  process.stdout.write(`Writing ${dataIndexPath}...\n`);
  writeFileSync(dataIndexPath, JSON.stringify(viewerIndex, null, 2) + '\n', 'utf8');
  
  // Copy substrate and graph to viewer directory (for relative loading)
  const substrateDest = resolve(outputDir, 'settlements_substrate.geojson');
  const graphDest = resolve(outputDir, 'settlement_contact_graph.json');
  writeFileSync(substrateDest, substrateContent, 'utf8');
  writeFileSync(graphDest, graphContent, 'utf8');
  
  // Generate HTML
  const htmlPath = resolve(outputDir, 'index.html');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settlement Contact Graph Viewer (Phase 1)</title>
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
      margin-top: 8px;
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
      align-items: center;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .legend-color {
      display: inline-block;
      width: 16px;
      height: 2px;
      margin-right: 6px;
      vertical-align: middle;
    }
    .tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
      display: none;
    }
    #error-box {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 24px;
      border: 2px solid #c62828;
      border-radius: 8px;
      max-width: 500px;
      z-index: 10000;
      display: none;
    }
    #error-box h2 {
      color: #c62828;
      margin-bottom: 12px;
    }
    #error-box code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip" class="tooltip"></div>
    <div id="error-box"></div>
    <div id="controls">
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-settlements" checked>
          Show Settlement Borders
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-shared-border" checked>
          Show Shared-Border Edges
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-point-touch" checked>
          Show Point-Touch Edges
        </label>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-distance-contact" checked>
          Show Distance-Contact Edges
        </label>
      </div>
      <div class="control-group">
        <button id="reset-view">Reset View</button>
      </div>
      <div class="legend">
        <div class="legend-item">
          <span class="legend-color" style="background: #2e7d32;"></span>
          Shared-Border Edge
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background: #1565c0;"></span>
          Point-Touch Edge
        </div>
        <div class="legend-item">
          <span class="legend-color" style="background: #ff9800;"></span>
          Distance-Contact Edge
        </div>
      </div>
    </div>
  </div>
  <script src="viewer.js"></script>
</body>
</html>`;
  
  process.stdout.write(`Writing ${htmlPath}...\n`);
  writeFileSync(htmlPath, html, 'utf8');
  
  // Generate viewer.js
  const viewerJsPath = resolve(outputDir, 'viewer.js');
  const viewerJs = `/**
 * Contact Graph Viewer
 * 
 * Pure static viewer - no bundler required.
 * Loads settlement geometry and contact graph, renders to canvas with pan/zoom.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const showSettlementsCheck = document.getElementById('show-settlements');
  const showSharedBorderCheck = document.getElementById('show-shared-border');
  const showPointTouchCheck = document.getElementById('show-point-touch');
  const showDistanceContactCheck = document.getElementById('show-distance-contact');
  const resetViewBtn = document.getElementById('reset-view');
  const errorBox = document.getElementById('error-box');

  let settlementsGeoJSON = null;
  let graphData = null;
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

  const SETTLEMENT_STROKE = 'rgba(0, 0, 0, 0.3)';
  const SETTLEMENT_STROKE_WIDTH = 0.5;
  const EDGE_COLORS = {
    shared_border: '#2e7d32',
    point_touch: '#1565c0',
    distance_contact: '#ff9800'
  };
  const EDGE_WIDTH = 1;

  // Show file:// protocol error
  function showFileProtocolError() {
    errorBox.innerHTML = \`
      <h2>Cannot Load Data</h2>
      <p><strong>This viewer must be opened via a local HTTP server.</strong></p>
      <p>Run:</p>
      <p><code>npx http-server -p 8080</code></p>
      <p>Then open:</p>
      <p><code>http://localhost:8080/data/derived/contact_graph_viewer/index.html</code></p>
    \`;
    errorBox.style.display = 'block';
  }

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
    for (const coord of coords) {
      if (coord.length >= 2) {
        const x = coord[0];
        const y = coord[1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    
    if (minX === Infinity) return null;
    return { minX, minY, maxX, maxY };
  }

  // Fit view to bounds
  function fitToBounds(bounds) {
    if (!bounds) return;
    
    const padding = 20;
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    
    if (width === 0 || height === 0) return;
    
    const scaleX = (canvas.width - padding * 2) / width;
    const scaleY = (canvas.height - padding * 2) / height;
    viewScale = Math.min(scaleX, scaleY);
    
    viewX = canvas.width / 2 - (bounds.minX + bounds.maxX) / 2 * viewScale;
    viewY = canvas.height / 2 - (bounds.minY + bounds.maxY) / 2 * viewScale;
    
    render();
  }

  // Render settlement polygon
  function renderPolygon(coords, closed) {
    if (coords.length === 0) return;
    
    ctx.beginPath();
    const first = worldToScreen(coords[0][0], coords[0][1]);
    ctx.moveTo(first.x, first.y);
    
    for (let i = 1; i < coords.length; i++) {
      const pt = worldToScreen(coords[i][0], coords[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    if (closed) {
      ctx.closePath();
    }
  }

  // Render feature
  function renderFeature(feature) {
    const geom = feature.geometry;
    
    if (geom.type === 'Polygon') {
      const polygon = geom.coordinates;
      if (polygon.length > 0) {
        renderPolygon(polygon[0], true);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const polygon of geom.coordinates) {
        if (polygon.length > 0) {
          renderPolygon(polygon[0], true);
        }
      }
    }
  }

  // Get settlement centroid
  function getSettlementCentroid(sid) {
    if (!dataIndex || !dataIndex.settlements) return null;
    const settlement = dataIndex.settlements[sid];
    return settlement ? settlement.centroid : null;
  }

  // Render edges
  function renderEdges() {
    if (!graphData || !graphData.edges || graphData.edges.length === 0) return;
    
    for (const edge of graphData.edges) {
      // Check visibility toggle
      if (edge.type === 'shared_border' && !showSharedBorderCheck.checked) continue;
      if (edge.type === 'point_touch' && !showPointTouchCheck.checked) continue;
      if (edge.type === 'distance_contact' && !showDistanceContactCheck.checked) continue;
      
      const centroidA = getSettlementCentroid(edge.a);
      const centroidB = getSettlementCentroid(edge.b);
      
      if (!centroidA || !centroidB) continue;
      
      const screenA = worldToScreen(centroidA[0], centroidA[1]);
      const screenB = worldToScreen(centroidB[0], centroidB[1]);
      
      ctx.strokeStyle = EDGE_COLORS[edge.type] || '#000000';
      ctx.lineWidth = EDGE_WIDTH / viewScale;
      ctx.beginPath();
      ctx.moveTo(screenA.x, screenA.y);
      ctx.lineTo(screenB.x, screenB.y);
      ctx.stroke();
    }
  }

  // Render
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!settlementsGeoJSON || !dataIndex || !graphData) return;
    
    // Render edges first (under settlements)
    renderEdges();
    
    // Render settlements
    if (showSettlementsCheck.checked) {
      ctx.strokeStyle = SETTLEMENT_STROKE;
      ctx.lineWidth = SETTLEMENT_STROKE_WIDTH / viewScale;
      
      for (const feature of settlementsGeoJSON.features) {
        renderFeature(feature);
        ctx.stroke();
      }
    }
  }

  // Load data
  async function loadData() {
    try {
      // Check for file:// protocol
      if (window.location.protocol === 'file:') {
        showFileProtocolError();
        return;
      }
      
      // Load data index (contains metadata only)
      const indexResponse = await fetch('data_index.json');
      if (!indexResponse.ok) {
        throw new Error(\`Failed to load data_index.json: \${indexResponse.status}\`);
      }
      dataIndex = await indexResponse.json();
      
      // Load substrate geometry
      const substratePath = dataIndex.meta.substrate_path;
      const substrateResponse = await fetch(substratePath);
      if (!substrateResponse.ok) {
        throw new Error(\`Failed to load \${substratePath}: \${substrateResponse.status}\`);
      }
      settlementsGeoJSON = await substrateResponse.json();
      
      // Log settlement count
      const settlementCount = settlementsGeoJSON.features ? settlementsGeoJSON.features.length : 0;
      console.log(\`Loaded \${settlementCount} settlement features\`);
      
      // Load contact graph
      const graphPath = dataIndex.meta.graph_path;
      const graphResponse = await fetch(graphPath);
      if (!graphResponse.ok) {
        throw new Error(\`Failed to load \${graphPath}: \${graphResponse.status}\`);
      }
      graphData = await graphResponse.json();
      
      // Validate graph data
      if (!graphData.edges || !Array.isArray(graphData.edges) || graphData.edges.length === 0) {
        errorBox.innerHTML = \`
          <h2>Contact Graph Missing or Empty</h2>
          <p>Contact graph missing or empty. Run:</p>
          <p><code>npm run map:derive:contact:phase1</code></p>
          <p>Then rebuild viewer:</p>
          <p><code>npm run map:viewer:contact:phase1</code></p>
        \`;
        errorBox.style.display = 'block';
        return;
      }
      
      // Log graph counts
      const edgeCount = graphData.edges.length;
      const sharedBorderCount = graphData.edges.filter(e => e.type === 'shared_border').length;
      const pointTouchCount = graphData.edges.filter(e => e.type === 'point_touch').length;
      const distanceContactCount = graphData.edges.filter(e => e.type === 'distance_contact').length;
      
      console.log(\`Loaded \${edgeCount} graph edges\`);
      console.log(\`  - Shared-border: \${sharedBorderCount}\`);
      console.log(\`  - Point-touch: \${pointTouchCount}\`);
      console.log(\`  - Distance-contact: \${distanceContactCount}\`);
      
      // Compute global bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const feature of settlementsGeoJSON.features) {
        const bounds = computeFeatureBounds(feature);
        if (bounds) {
          minX = Math.min(minX, bounds.minX);
          minY = Math.min(minY, bounds.minY);
          maxX = Math.max(maxX, bounds.maxX);
          maxY = Math.max(maxY, bounds.maxY);
        }
      }
      
      if (minX !== Infinity) {
        globalBounds = { minX, minY, maxX, maxY };
        fitToBounds(globalBounds);
      }
      
      render();
    } catch (err) {
      console.error('Error loading data:', err);
      errorBox.innerHTML = \`
        <h2>Error Loading Data</h2>
        <p>\${err.message}</p>
        <p>Make sure you are running a local web server (not file:// protocol).</p>
      \`;
      errorBox.style.display = 'block';
    }
  }

  // Pan/zoom handlers
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
    }
  });

  canvas.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const scaleFactor = e.deltaY > 0 ? 1.1 : 0.9;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    viewScale *= scaleFactor;
    viewScale = Math.max(0.01, Math.min(100, viewScale));
    const newScreenPos = worldToScreen(worldPos.x, worldPos.y);
    viewX += e.clientX - newScreenPos.x;
    viewY += e.clientY - newScreenPos.y;
    render();
  });

  // Control handlers
  showSettlementsCheck.addEventListener('change', render);
  showSharedBorderCheck.addEventListener('change', render);
  showPointTouchCheck.addEventListener('change', render);
  showDistanceContactCheck.addEventListener('change', render);
  
  resetViewBtn.addEventListener('click', () => {
    if (globalBounds) {
      fitToBounds(globalBounds);
    }
  });

  // Load data on startup
  loadData();
})();`;
  
  process.stdout.write(`Writing ${viewerJsPath}...\n`);
  writeFileSync(viewerJsPath, viewerJs, 'utf8');
  
  process.stdout.write(`Done.\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
