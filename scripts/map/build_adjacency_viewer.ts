/**
 * Build Settlement Adjacency Viewer
 *
 * Generates an interactive HTML viewer showing settlement polygons with
 * adjacency edges overlaid. Supports toggling between shared-border edges
 * (v3 canonical) and point-touch edges (diagnostic).
 *
 * This viewer is for inspection only - it does not modify any data or canon.
 *
 * Usage:
 *   npm run map:viewer:adjacency
 *   or: tsx scripts/map/build_adjacency_viewer.ts
 *
 * Output:
 *   - data/derived/adjacency_viewer/index.html
 *   - data/derived/adjacency_viewer/data.json (combined substrate + graphs)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1: build adjacency viewer for visual inspection of settlement graph (v3 + point-touch diagnostic)");

interface Point {
  x: number;
  y: number;
}

interface SettlementData {
  sid: string;
  name: string | null;
  municipality_id: string | null;
  centroid: Point;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  coords: Array<[number, number]>;
}

interface EdgeData {
  a: string;
  b: string;
  length: number;
  type: 'shared_border' | 'point_touch';
}

interface ViewerData {
  settlements: SettlementData[];
  edges: EdgeData[];
  stats: {
    total_settlements: number;
    shared_border_edges: number;
    point_touch_edges: number;
    isolated_shared_border: number;
    isolated_with_point_touch: number;
  };
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const graphV3Path = resolve('data/derived/settlement_graph_v3.json');
  const contactGraphPath = resolve('data/derived/settlement_contact_graph.json');

  const outputDir = resolve('data/derived/adjacency_viewer');
  const dataPath = resolve(outputDir, 'data.json');
  const htmlPath = resolve(outputDir, 'index.html');

  mkdirSync(outputDir, { recursive: true });

  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrate = JSON.parse(readFileSync(substratePath, 'utf8'));

  // Load v3 graph (canonical shared-border)
  process.stdout.write(`Loading ${graphV3Path}...\n`);
  let graphV3: { edge_list: Array<{ a: string; b: string; shared_border_length: number }> } | null = null;
  if (existsSync(graphV3Path)) {
    graphV3 = JSON.parse(readFileSync(graphV3Path, 'utf8'));
  } else {
    process.stdout.write(`  Warning: ${graphV3Path} not found, shared-border edges will be empty\n`);
  }

  // Load contact graph (shared-border + point-touch)
  process.stdout.write(`Loading ${contactGraphPath}...\n`);
  let contactGraph: { edge_list: Array<{ a: string; b: string; shared_border_length?: number; min_distance?: number; edge_type: string }> } | null = null;
  if (existsSync(contactGraphPath)) {
    contactGraph = JSON.parse(readFileSync(contactGraphPath, 'utf8'));
  } else {
    process.stdout.write(`  Warning: ${contactGraphPath} not found, point-touch edges will be empty\n`);
  }

  // Extract settlement data
  process.stdout.write(`Processing ${substrate.features.length} settlements...\n`);

  let globalMinX = Infinity;
  let globalMinY = Infinity;
  let globalMaxX = -Infinity;
  let globalMaxY = -Infinity;

  const settlements: SettlementData[] = [];
  const sidSet = new Set<string>();

  for (const feature of substrate.features) {
    const sid = String(feature.properties.sid);
    sidSet.add(sid);

    const coords: Array<[number, number]> = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates[0]
      : feature.geometry.coordinates[0][0];

    // Compute centroid and bbox
    let sumX = 0, sumY = 0;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    for (const [x, y] of coords) {
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    const centroid = { x: sumX / coords.length, y: sumY / coords.length };
    const bbox = { minx: minX, miny: minY, maxx: maxX, maxy: maxY };

    globalMinX = Math.min(globalMinX, minX);
    globalMinY = Math.min(globalMinY, minY);
    globalMaxX = Math.max(globalMaxX, maxX);
    globalMaxY = Math.max(globalMaxY, maxY);

    settlements.push({
      sid,
      name: feature.properties.name || null,
      municipality_id: feature.properties.municipality_id || null,
      centroid,
      bbox,
      coords
    });
  }

  // Collect edges
  const edges: EdgeData[] = [];
  const sharedBorderPairs = new Set<string>();

  // Add shared-border edges from v3 graph
  if (graphV3) {
    for (const edge of graphV3.edge_list) {
      const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
      sharedBorderPairs.add(key);
      edges.push({
        a: edge.a,
        b: edge.b,
        length: edge.shared_border_length,
        type: 'shared_border'
      });
    }
  }

  // Add point-touch edges from contact graph (excluding shared-border edges already added)
  // Note: contact graph uses 'type' field with values 'shared_border' or 'point_touch'
  if (contactGraph) {
    for (const edge of contactGraph.edge_list) {
      const edgeType = (edge as { type?: string }).type;
      if (edgeType === 'point_touch') {
        const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
        if (!sharedBorderPairs.has(key)) {
          edges.push({
            a: edge.a,
            b: edge.b,
            length: (edge as { boundary_dist?: number }).boundary_dist || 0,
            type: 'point_touch'
          });
        }
      }
    }
  }

  // Compute stats
  const sharedBorderEdgeCount = edges.filter(e => e.type === 'shared_border').length;
  const pointTouchEdgeCount = edges.filter(e => e.type === 'point_touch').length;

  // Count isolated settlements
  const connectedSharedBorder = new Set<string>();
  const connectedPointTouch = new Set<string>();

  for (const edge of edges) {
    if (edge.type === 'shared_border') {
      connectedSharedBorder.add(edge.a);
      connectedSharedBorder.add(edge.b);
    }
    connectedPointTouch.add(edge.a);
    connectedPointTouch.add(edge.b);
  }

  const isolatedSharedBorder = settlements.filter(s => !connectedSharedBorder.has(s.sid)).length;
  const isolatedWithPointTouch = settlements.filter(s => !connectedPointTouch.has(s.sid)).length;

  const viewerData: ViewerData = {
    settlements,
    edges,
    stats: {
      total_settlements: settlements.length,
      shared_border_edges: sharedBorderEdgeCount,
      point_touch_edges: pointTouchEdgeCount,
      isolated_shared_border: isolatedSharedBorder,
      isolated_with_point_touch: isolatedWithPointTouch
    },
    bbox: { minx: globalMinX, miny: globalMinY, maxx: globalMaxX, maxy: globalMaxY }
  };

  // Write data.json
  writeFileSync(dataPath, JSON.stringify(viewerData), 'utf8');
  process.stdout.write(`Wrote ${dataPath}\n`);

  // Generate HTML
  const html = generateHTML();
  writeFileSync(htmlPath, html, 'utf8');
  process.stdout.write(`Wrote ${htmlPath}\n`);

  process.stdout.write('\nSummary:\n');
  process.stdout.write(`  Settlements: ${settlements.length}\n`);
  process.stdout.write(`  Shared-border edges: ${sharedBorderEdgeCount}\n`);
  process.stdout.write(`  Point-touch edges: ${pointTouchEdgeCount}\n`);
  process.stdout.write(`  Isolated (shared-border only): ${isolatedSharedBorder}\n`);
  process.stdout.write(`  Isolated (with point-touch): ${isolatedWithPointTouch}\n`);
  process.stdout.write(`\nOpen ${htmlPath} in a browser to view.\n`);
}

function generateHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settlement Adjacency Viewer</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      overflow: hidden;
    }
    #container {
      display: flex;
      height: 100vh;
    }
    #sidebar {
      width: 300px;
      background: #16213e;
      padding: 16px;
      overflow-y: auto;
      flex-shrink: 0;
    }
    #canvas-container {
      flex: 1;
      position: relative;
    }
    canvas {
      display: block;
    }
    h1 {
      font-size: 18px;
      margin-bottom: 16px;
      color: #00d9ff;
    }
    h2 {
      font-size: 14px;
      margin: 16px 0 8px;
      color: #aaa;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 4px 0;
      border-bottom: 1px solid #2a2a4a;
    }
    .stat-label { color: #888; }
    .stat-value { color: #fff; font-weight: 600; }
    .controls {
      margin-top: 16px;
    }
    label {
      display: flex;
      align-items: center;
      padding: 8px 0;
      cursor: pointer;
    }
    input[type="checkbox"] {
      width: 18px;
      height: 18px;
      margin-right: 10px;
      cursor: pointer;
    }
    .legend {
      margin-top: 16px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      padding: 4px 0;
    }
    .legend-color {
      width: 24px;
      height: 4px;
      margin-right: 8px;
      border-radius: 2px;
    }
    .shared-border { background: #00ff88; }
    .point-touch { background: #ffaa00; }
    .settlement-fill { background: rgba(100, 100, 150, 0.3); border: 1px solid #666; }
    #tooltip {
      position: absolute;
      background: rgba(22, 33, 62, 0.95);
      border: 1px solid #00d9ff;
      border-radius: 4px;
      padding: 8px 12px;
      font-size: 12px;
      pointer-events: none;
      display: none;
      z-index: 100;
      max-width: 250px;
    }
    #tooltip .name { font-weight: 600; color: #00d9ff; }
    #tooltip .info { color: #aaa; margin-top: 4px; }
    #help {
      margin-top: 20px;
      font-size: 11px;
      color: #666;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div id="container">
    <div id="sidebar">
      <h1>Adjacency Viewer</h1>

      <h2>Statistics</h2>
      <div class="stat">
        <span class="stat-label">Settlements</span>
        <span class="stat-value" id="stat-settlements">-</span>
      </div>
      <div class="stat">
        <span class="stat-label">Shared-border edges</span>
        <span class="stat-value" id="stat-shared">-</span>
      </div>
      <div class="stat">
        <span class="stat-label">Point-touch edges</span>
        <span class="stat-value" id="stat-touch">-</span>
      </div>
      <div class="stat">
        <span class="stat-label">Isolated (shared-border)</span>
        <span class="stat-value" id="stat-isolated-shared">-</span>
      </div>
      <div class="stat">
        <span class="stat-label">Isolated (with point-touch)</span>
        <span class="stat-value" id="stat-isolated-touch">-</span>
      </div>

      <h2>Display</h2>
      <div class="controls">
        <label>
          <input type="checkbox" id="show-settlements" checked>
          Show settlement polygons
        </label>
        <label>
          <input type="checkbox" id="show-shared-border" checked>
          Show shared-border edges (v3)
        </label>
        <label>
          <input type="checkbox" id="show-point-touch">
          Show point-touch edges (diagnostic)
        </label>
        <label>
          <input type="checkbox" id="highlight-isolated">
          Highlight isolated settlements
        </label>
      </div>

      <h2>Legend</h2>
      <div class="legend">
        <div class="legend-item">
          <div class="legend-color shared-border"></div>
          <span>Shared-border (canonical)</span>
        </div>
        <div class="legend-item">
          <div class="legend-color point-touch"></div>
          <span>Point-touch (diagnostic)</span>
        </div>
        <div class="legend-item">
          <div class="legend-color settlement-fill"></div>
          <span>Settlement polygon</span>
        </div>
      </div>

      <div id="help">
        <strong>Controls:</strong><br>
        Scroll to zoom<br>
        Drag to pan<br>
        Hover for details
      </div>
    </div>

    <div id="canvas-container">
      <canvas id="canvas"></canvas>
      <div id="tooltip"></div>
    </div>
  </div>

  <script>
    let data = null;
    let canvas, ctx;
    let width, height;
    let transform = { x: 0, y: 0, scale: 1 };
    let isDragging = false;
    let dragStart = { x: 0, y: 0 };
    let hoveredSettlement = null;

    // Load data
    fetch('data.json')
      .then(r => r.json())
      .then(d => {
        data = d;
        init();
      })
      .catch(err => {
        console.error('Failed to load data:', err);
        alert('Failed to load data.json. Make sure to run the viewer build script first.');
      });

    function init() {
      canvas = document.getElementById('canvas');
      ctx = canvas.getContext('2d');

      // Update stats
      document.getElementById('stat-settlements').textContent = data.stats.total_settlements.toLocaleString();
      document.getElementById('stat-shared').textContent = data.stats.shared_border_edges.toLocaleString();
      document.getElementById('stat-touch').textContent = data.stats.point_touch_edges.toLocaleString();
      document.getElementById('stat-isolated-shared').textContent = data.stats.isolated_shared_border.toLocaleString();
      document.getElementById('stat-isolated-touch').textContent = data.stats.isolated_with_point_touch.toLocaleString();

      // Setup canvas
      resize();
      window.addEventListener('resize', resize);

      // Initial view to fit all data
      fitToView();

      // Event listeners
      canvas.addEventListener('wheel', onWheel);
      canvas.addEventListener('mousedown', onMouseDown);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mouseup', onMouseUp);
      canvas.addEventListener('mouseleave', onMouseLeave);

      // Checkbox listeners
      document.getElementById('show-settlements').addEventListener('change', render);
      document.getElementById('show-shared-border').addEventListener('change', render);
      document.getElementById('show-point-touch').addEventListener('change', render);
      document.getElementById('highlight-isolated').addEventListener('change', render);

      render();
    }

    function resize() {
      const container = document.getElementById('canvas-container');
      width = container.clientWidth;
      height = container.clientHeight;
      canvas.width = width;
      canvas.height = height;
      render();
    }

    function fitToView() {
      const bbox = data.bbox;
      const dataWidth = bbox.maxx - bbox.minx;
      const dataHeight = bbox.maxy - bbox.miny;

      const scaleX = (width - 40) / dataWidth;
      const scaleY = (height - 40) / dataHeight;
      transform.scale = Math.min(scaleX, scaleY);

      transform.x = width / 2 - (bbox.minx + dataWidth / 2) * transform.scale;
      transform.y = height / 2 - (bbox.miny + dataHeight / 2) * transform.scale;
    }

    function worldToScreen(x, y) {
      return {
        x: x * transform.scale + transform.x,
        y: (data.bbox.maxy - y + data.bbox.miny) * transform.scale + transform.y - (data.bbox.maxy - data.bbox.miny) * transform.scale + height
      };
    }

    function screenToWorld(sx, sy) {
      const adjustedY = height - sy + (data.bbox.maxy - data.bbox.miny) * transform.scale - transform.y;
      return {
        x: (sx - transform.x) / transform.scale,
        y: data.bbox.maxy - adjustedY / transform.scale + data.bbox.miny
      };
    }

    function render() {
      if (!data) return;

      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, width, height);

      const showSettlements = document.getElementById('show-settlements').checked;
      const showSharedBorder = document.getElementById('show-shared-border').checked;
      const showPointTouch = document.getElementById('show-point-touch').checked;
      const highlightIsolated = document.getElementById('highlight-isolated').checked;

      // Build set of connected settlements for highlighting
      const connectedShared = new Set();
      const connectedAll = new Set();
      for (const edge of data.edges) {
        if (edge.type === 'shared_border') {
          connectedShared.add(edge.a);
          connectedShared.add(edge.b);
        }
        connectedAll.add(edge.a);
        connectedAll.add(edge.b);
      }

      // Draw settlements
      if (showSettlements) {
        for (const settlement of data.settlements) {
          const isIsolated = !connectedShared.has(settlement.sid);

          ctx.beginPath();
          let first = true;
          for (const [x, y] of settlement.coords) {
            const pt = worldToScreen(x, y);
            if (first) {
              ctx.moveTo(pt.x, pt.y);
              first = false;
            } else {
              ctx.lineTo(pt.x, pt.y);
            }
          }
          ctx.closePath();

          if (highlightIsolated && isIsolated) {
            ctx.fillStyle = 'rgba(255, 50, 50, 0.4)';
            ctx.strokeStyle = '#ff3333';
          } else if (hoveredSettlement && hoveredSettlement.sid === settlement.sid) {
            ctx.fillStyle = 'rgba(0, 217, 255, 0.4)';
            ctx.strokeStyle = '#00d9ff';
          } else {
            ctx.fillStyle = 'rgba(100, 100, 150, 0.2)';
            ctx.strokeStyle = '#444';
          }

          ctx.fill();
          ctx.lineWidth = 0.5;
          ctx.stroke();
        }
      }

      // Build centroid map for edge drawing
      const centroidMap = new Map();
      for (const s of data.settlements) {
        centroidMap.set(s.sid, s.centroid);
      }

      // Draw edges
      for (const edge of data.edges) {
        const show = (edge.type === 'shared_border' && showSharedBorder) ||
                     (edge.type === 'point_touch' && showPointTouch);
        if (!show) continue;

        const c1 = centroidMap.get(edge.a);
        const c2 = centroidMap.get(edge.b);
        if (!c1 || !c2) continue;

        const p1 = worldToScreen(c1.x, c1.y);
        const p2 = worldToScreen(c2.x, c2.y);

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);

        if (edge.type === 'shared_border') {
          ctx.strokeStyle = 'rgba(0, 255, 136, 0.6)';
          ctx.lineWidth = 1.5;
        } else {
          ctx.strokeStyle = 'rgba(255, 170, 0, 0.4)';
          ctx.lineWidth = 1;
        }

        ctx.stroke();
      }
    }

    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newScale = transform.scale * zoomFactor;

      // Zoom towards mouse position
      transform.x = mx - (mx - transform.x) * (newScale / transform.scale);
      transform.y = my - (my - transform.y) * (newScale / transform.scale);
      transform.scale = newScale;

      render();
    }

    function onMouseDown(e) {
      isDragging = true;
      dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
    }

    function onMouseMove(e) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (isDragging) {
        transform.x = e.clientX - dragStart.x;
        transform.y = e.clientY - dragStart.y;
        render();
      } else {
        // Hit test for hover
        const world = screenToWorld(mx, my);
        let found = null;

        for (const settlement of data.settlements) {
          if (world.x >= settlement.bbox.minx && world.x <= settlement.bbox.maxx &&
              world.y >= settlement.bbox.miny && world.y <= settlement.bbox.maxy) {
            // Rough bbox check passed, could do point-in-polygon for accuracy
            found = settlement;
            break;
          }
        }

        if (found !== hoveredSettlement) {
          hoveredSettlement = found;
          render();
          updateTooltip(mx, my);
        }
      }
    }

    function onMouseUp() {
      isDragging = false;
    }

    function onMouseLeave() {
      isDragging = false;
      hoveredSettlement = null;
      render();
      document.getElementById('tooltip').style.display = 'none';
    }

    function updateTooltip(mx, my) {
      const tooltip = document.getElementById('tooltip');

      if (hoveredSettlement) {
        const s = hoveredSettlement;

        // Count neighbors
        let sharedNeighbors = 0;
        let touchNeighbors = 0;
        for (const edge of data.edges) {
          if (edge.a === s.sid || edge.b === s.sid) {
            if (edge.type === 'shared_border') sharedNeighbors++;
            else touchNeighbors++;
          }
        }

        tooltip.innerHTML = \`
          <div class="name">\${s.name || s.sid}</div>
          <div class="info">
            SID: \${s.sid}<br>
            Municipality: \${s.municipality_id || '-'}<br>
            Shared-border neighbors: \${sharedNeighbors}<br>
            Point-touch neighbors: \${touchNeighbors}
          </div>
        \`;

        tooltip.style.left = (mx + 15) + 'px';
        tooltip.style.top = (my + 15) + 'px';
        tooltip.style.display = 'block';
      } else {
        tooltip.style.display = 'none';
      }
    }
  </script>
</body>
</html>`;
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
