/**
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
      return `hsla(${hue}, 70%, 50%, 0.3)`;
    } else {
      return isUnmatched ? UNMATCHED_COLOR : MATCHED_COLOR;
    }
  }

  // Render feature
  function renderFeature(feature) {
    const geom = feature.geometry;
    const fillColor = getFeatureColor(feature);
    
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
    html += `<div class="tooltip-line"><strong>SID:</strong> ${sid}</div>`;
    html += `<div class="tooltip-line"><strong>Name:</strong> ${name}</div>`;
    html += `<div class="tooltip-line"><strong>Municipality ID:</strong> ${munId}</div>`;
    html += `<div class="tooltip-line"><strong>Source:</strong> ${sourceFile}</div>`;
    html += `<div class="tooltip-line"><strong>Shape ID:</strong> ${sourceShapeId}</div>`;
    
    if (props.notes && props.notes.length > 0) {
      html += `<div class="tooltip-line"><strong>Notes:</strong> ${props.notes.join(', ')}</div>`;
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
      legendDiv.innerHTML = `
        <div class="legend-item"><span class="legend-color" style="background: ${MATCHED_COLOR};"></span>Matched</div>
        <div class="legend-item"><span class="legend-color" style="background: ${UNMATCHED_COLOR};"></span>Unmatched</div>
      `;
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
  resetViewBtn.addEventListener('click', fitToBounds);

  // Load data
  async function loadData() {
    try {
      // Load index first to get geometry path
      const indexRes = await fetch('./data_index.json');
      const indexData = await indexRes.json();
      
      const geoJSONRes = await fetch(indexData.meta.geometry_path);
      
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
      alert('Failed to load data. Make sure you are running from a web server.');
    }
  }

  // Initialize
  loadData();
})();