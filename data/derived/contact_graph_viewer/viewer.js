/**
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
  const phaseSelector = document.getElementById('phase-selector');
  const showSettlementsCheck = document.getElementById('show-settlements');
  const showSharedBorderCheck = document.getElementById('show-shared-border');
  const showPointTouchCheck = document.getElementById('show-point-touch');
  const showDistanceContactCheck = document.getElementById('show-distance-contact');
  const resetViewBtn = document.getElementById('reset-view');
  const errorBox = document.getElementById('error-box');
  const inspector = document.getElementById('inspector');
  const inspectorContent = document.getElementById('inspector-content');

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
  
  // Edge selection state
  let selectedEdge = null;
  let renderedEdges = []; // Store edge info for click detection

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
    errorBox.innerHTML = `
      <h2>Cannot Load Data</h2>
      <p><strong>This viewer must be opened via a local HTTP server.</strong></p>
      <p>Run:</p>
      <p><code>npx http-server -p 8080</code></p>
      <p>Then open:</p>
      <p><code>http://localhost:8080/data/derived/contact_graph_viewer/index.html</code></p>
    `;
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
    
    renderedEdges = []; // Reset for click detection
    
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
      
      // Store edge info for click detection
      renderedEdges.push({
        edge: edge,
        screenA: screenA,
        screenB: screenB,
        midpoint: {
          x: (screenA.x + screenB.x) / 2,
          y: (screenA.y + screenB.y) / 2
        }
      });
      
      // Highlight selected edge
      if (selectedEdge && selectedEdge.a === edge.a && selectedEdge.b === edge.b && selectedEdge.type === edge.type) {
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = (EDGE_WIDTH * 2) / viewScale;
      } else {
        ctx.strokeStyle = EDGE_COLORS[edge.type] || '#000000';
        ctx.lineWidth = EDGE_WIDTH / viewScale;
      }
      
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
        throw new Error(`Failed to load data_index.json: ${indexResponse.status}`);
      }
      dataIndex = await indexResponse.json();
      
      // Load substrate geometry
      const substratePath = dataIndex.meta.substrate_path;
      const substrateResponse = await fetch(substratePath);
      if (!substrateResponse.ok) {
        throw new Error(`Failed to load ${substratePath}: ${substrateResponse.status}`);
      }
      settlementsGeoJSON = await substrateResponse.json();
      
      // Log settlement count
      const settlementCount = settlementsGeoJSON.features ? settlementsGeoJSON.features.length : 0;
      console.log(`Loaded ${settlementCount} settlement features`);
      
      // Load graph using shared function
      await loadGraph();
      
      if (!graphData) {
        errorBox.innerHTML = `
          <h2>Contact Graph Missing or Empty</h2>
          <p>Contact graph missing or empty. Run:</p>
          <p><code>npm run map:derive:contact:phase1</code></p>
          <p>Then rebuild viewer:</p>
          <p><code>npm run map:viewer:contact:phase1</code></p>
        `;
        errorBox.style.display = 'block';
        return;
      }
      
      // Log graph counts
      const edgeCount = graphData.edges.length;
      const sharedBorderCount = graphData.edges.filter(e => e.type === 'shared_border').length;
      const pointTouchCount = graphData.edges.filter(e => e.type === 'point_touch').length;
      const distanceContactCount = graphData.edges.filter(e => e.type === 'distance_contact').length;
      
      console.log(`Loaded ${edgeCount} graph edges`);
      console.log(`  - Shared-border: ${sharedBorderCount}`);
      console.log(`  - Point-touch: ${pointTouchCount}`);
      console.log(`  - Distance-contact: ${distanceContactCount}`);
      
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
      errorBox.innerHTML = `
        <h2>Error Loading Data</h2>
        <p>${err.message}</p>
        <p>Make sure you are running a local web server (not file:// protocol).</p>
      `;
      errorBox.style.display = 'block';
    }
  }

  // Find closest edge to click point
  function findClosestEdge(screenX, screenY, threshold = 10) {
    let closest = null;
    let minDist = Infinity;
    
    for (const rendered of renderedEdges) {
      const dx = rendered.midpoint.x - screenX;
      const dy = rendered.midpoint.y - screenY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < threshold && dist < minDist) {
        minDist = dist;
        closest = rendered.edge;
      }
    }
    
    return closest;
  }
  
  // Update inspector panel
  function updateInspector(edge) {
    if (!edge) {
      inspector.classList.remove('visible');
      return;
    }
    
    inspector.classList.add('visible');
    
    const isPhase2 = phaseSelector.value === 'phase2';
    
    let html = '<div class="section">';
    html += '<div class="field"><div class="field-label">Settlement A</div><div class="field-value">' + edge.a + '</div></div>';
    html += '<div class="field"><div class="field-label">Settlement B</div><div class="field-value">' + edge.b + '</div></div>';
    html += '<div class="field"><div class="field-label">Type</div><div class="field-value">' + edge.type + '</div></div>';
    html += '</div>';
    
    if (isPhase2) {
      html += '<div class="section">';
      html += '<h3>Phase 2 Metrics</h3>';
      
      const formatValue = (val) => {
        if (val === null || val === undefined) return 'null';
        if (typeof val === 'number') return val.toFixed(3);
        return String(val);
      };
      
      if (edge.centroid_distance_svg !== undefined) {
        html += '<div class="field"><div class="field-label">centroid_distance_svg</div><div class="field-value">' + formatValue(edge.centroid_distance_svg) + '</div></div>';
      }
      if (edge.contact_span_svg !== undefined) {
        html += '<div class="field"><div class="field-label">contact_span_svg</div><div class="field-value">' + formatValue(edge.contact_span_svg) + '</div></div>';
      }
      if (edge.bbox_overlap_ratio !== undefined) {
        html += '<div class="field"><div class="field-label">bbox_overlap_ratio</div><div class="field-value">' + formatValue(edge.bbox_overlap_ratio) + '</div></div>';
      }
      if (edge.area_ratio !== undefined) {
        html += '<div class="field"><div class="field-label">area_ratio</div><div class="field-value">' + formatValue(edge.area_ratio) + '</div></div>';
      }
      if (edge.perimeter_ratio !== undefined) {
        html += '<div class="field"><div class="field-label">perimeter_ratio</div><div class="field-value">' + formatValue(edge.perimeter_ratio) + '</div></div>';
      }
      if (edge.overlap_len !== undefined) {
        html += '<div class="field"><div class="field-label">overlap_len</div><div class="field-value">' + formatValue(edge.overlap_len) + '</div></div>';
      }
      if (edge.min_dist !== undefined) {
        html += '<div class="field"><div class="field-label">min_dist</div><div class="field-value">' + formatValue(edge.min_dist) + '</div></div>';
      }
      
      html += '</div>';
    } else {
      // Phase 1 - show basic fields if present
      if (edge.overlap_len !== undefined || edge.min_dist !== undefined) {
        html += '<div class="section">';
        if (edge.overlap_len !== undefined) {
          html += '<div class="field"><div class="field-label">overlap_len</div><div class="field-value">' + edge.overlap_len.toFixed(3) + '</div></div>';
        }
        if (edge.min_dist !== undefined) {
          html += '<div class="field"><div class="field-label">min_dist</div><div class="field-value">' + edge.min_dist.toFixed(3) + '</div></div>';
        }
        html += '</div>';
      }
    }
    
    inspectorContent.innerHTML = html;
  }
  
  // Pan/zoom handlers
  canvas.addEventListener('mousedown', (e) => {
    // Check if clicking on an edge
    const clickedEdge = findClosestEdge(e.clientX, e.clientY);
    if (clickedEdge) {
      selectedEdge = clickedEdge;
      updateInspector(selectedEdge);
      render();
      return;
    }
    
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
  phaseSelector.addEventListener('change', async () => {
    selectedEdge = null;
    updateInspector(null);
    await loadGraph();
    render();
  });
  
  showSettlementsCheck.addEventListener('change', render);
  showSharedBorderCheck.addEventListener('change', render);
  showPointTouchCheck.addEventListener('change', render);
  showDistanceContactCheck.addEventListener('change', render);
  
  resetViewBtn.addEventListener('click', () => {
    if (globalBounds) {
      fitToBounds(globalBounds);
    }
  });

  // Load graph data (separate from initial load)
  async function loadGraph() {
    if (!dataIndex) return;
    
    const selectedPhase = phaseSelector.value;
    let graphPath;
    if (selectedPhase === 'phase2' && dataIndex.meta.graph_paths && dataIndex.meta.graph_paths.phase2) {
      graphPath = dataIndex.meta.graph_paths.phase2;
    } else if (selectedPhase === 'phase1' && dataIndex.meta.graph_paths && dataIndex.meta.graph_paths.phase1) {
      graphPath = dataIndex.meta.graph_paths.phase1;
    } else {
      graphPath = dataIndex.meta.graph_path;
    }
    
    try {
      const graphResponse = await fetch(graphPath);
      if (!graphResponse.ok) {
        // If Phase 2 fails, try Phase 1 as fallback
        if (selectedPhase === 'phase2') {
          const fallbackPath = (dataIndex.meta.graph_paths && dataIndex.meta.graph_paths.phase1) || dataIndex.meta.graph_path;
          const fallbackResponse = await fetch(fallbackPath);
          if (fallbackResponse.ok) {
            graphData = await fallbackResponse.json();
            phaseSelector.value = 'phase1';
            console.log(`Phase 2 graph not found, falling back to Phase 1`);
          } else {
            throw new Error(`Failed to load ${graphPath} or fallback ${fallbackPath}: ${graphResponse.status}`);
          }
        } else {
          throw new Error(`Failed to load ${graphPath}: ${graphResponse.status}`);
        }
      } else {
        graphData = await graphResponse.json();
      }
      
      // Validate graph data
      if (!graphData.edges || !Array.isArray(graphData.edges) || graphData.edges.length === 0) {
        console.warn('Graph has no edges');
        graphData = null;
        return;
      }
      
      console.log(`Loaded ${graphData.edges.length} graph edges`);
    } catch (err) {
      console.error('Error loading graph:', err);
      graphData = null;
      throw err;
    }
  }

  // Load data on startup
  loadData();
})();