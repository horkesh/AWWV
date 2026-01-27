/**
 * Phase 0 Settlement Validation Viewer
 * 
 * Pure static viewer - no bundler required.
 * Loads settlement geometry and overlay data, renders to canvas with pan/zoom.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const showEthnicityCheck = document.getElementById('show-ethnicity');
  const filterMuniInput = document.getElementById('filter-muni');
  const filterSidInput = document.getElementById('filter-sid');
  const resetViewBtn = document.getElementById('reset-view');
  const legendDiv = document.getElementById('legend');

  let settlementsGeoJSON = null;
  let dataIndex = null;
  let settlementIndex = new Map(); // sid -> index entry

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

  // Fixed color palette
  const ETHNICITY_COLORS = {
    bosniak: '#2e7d32', // Green
    serb: '#c62828',    // Red
    croat: '#1565c0',   // Blue
    other: '#6d6d6d',   // Neutral gray
    unknown: '#bdbdbd', // Light gray
    p1: '#2e7d32',      // Green (if ambiguous, assume p1 = bosniak)
    p2: '#1565c0',      // Blue (if ambiguous, assume p2 = croat)
    p3: '#c62828',      // Red (if ambiguous, assume p3 = serb)
    p4: '#6d6d6d',      // Gray (if ambiguous, assume p4 = other)
  };
  
  // Convert hex to rgba with opacity for fills
  function hexToRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

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
    for (const coord of coords) {
      if (coord.length >= 2) {
        minX = Math.min(minX, coord[0]);
        minY = Math.min(minY, coord[1]);
        maxX = Math.max(maxX, coord[0]);
        maxY = Math.max(maxY, coord[1]);
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
    
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    
    viewX = canvas.width / 2 - centerX * viewScale;
    viewY = canvas.height / 2 - centerY * viewScale;
    
    render();
  }

  // Get index entry for a feature
  function getIndexEntry(feature) {
    if (!dataIndex) return null;
    
    // Try to match by sid
    const sid = feature.properties?.id || feature.properties?.sid || feature.properties?.settlement_id || feature.id;
    if (sid) {
      const entry = settlementIndex.get(String(sid));
      if (entry) return entry;
    }
    
    // Fallback: try to match by source index if available
    // (This would require storing feature index, which we don't have easily)
    return null;
  }

  // Check if feature passes filters
  function passesFilters(feature, indexEntry) {
    const muniFilter = filterMuniInput.value.trim();
    const sidFilter = filterSidInput.value.trim();
    
    if (muniFilter) {
      const muniId = indexEntry?.municipality_id || feature.properties?.municipality_id;
      if (!muniId || String(muniId) !== muniFilter) {
        return false;
      }
    }
    
    if (sidFilter) {
      const sid = indexEntry?.sid || feature.properties?.id || feature.properties?.sid || feature.id;
      if (!sid || !String(sid).includes(sidFilter)) {
        return false;
      }
    }
    
    return true;
  }

  // Render polygon outline
  function renderPolygon(coords, fillColor, strokeColor) {
    if (coords.length < 2) return;
    
    ctx.beginPath();
    const first = worldToScreen(coords[0][0], coords[0][1]);
    ctx.moveTo(first.x, first.y);
    
    for (let i = 1; i < coords.length; i++) {
      const pt = worldToScreen(coords[i][0], coords[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    ctx.closePath();
    
    if (fillColor) {
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
    
    if (strokeColor) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = STROKE_WIDTH;
      ctx.stroke();
    }
  }

  // Render feature
  function renderFeature(feature, indexEntry) {
    const geom = feature.geometry;
    
    if (geom.type === 'Polygon') {
      const coords = geom.coordinates;
      if (coords && coords[0]) {
        let fillColor = null;
        let strokeColor = STROKE_COLOR;
        
        if (showEthnicityCheck.checked && indexEntry && indexEntry.majority_ethnicity) {
          const colorHex = ETHNICITY_COLORS[indexEntry.majority_ethnicity];
          if (colorHex) {
            fillColor = hexToRgba(colorHex, 0.3); // 30% opacity for fills
          }
        }
        
        renderPolygon(coords[0], fillColor, strokeColor);
      }
    } else if (geom.type === 'MultiPolygon') {
      for (const poly of geom.coordinates) {
        if (poly && poly[0]) {
          let fillColor = null;
          let strokeColor = STROKE_COLOR;
          
          if (showEthnicityCheck.checked && indexEntry && indexEntry.majority_ethnicity) {
            const colorHex = ETHNICITY_COLORS[indexEntry.majority_ethnicity];
            if (colorHex) {
              fillColor = hexToRgba(colorHex, 0.3); // 30% opacity for fills
            }
          }
          
          renderPolygon(poly[0], fillColor, strokeColor);
        }
      }
    }
  }

  // Render all features
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!settlementsGeoJSON) return;
    
    // Draw features in deterministic order (sorted by sid, null sids last)
    const features = [...settlementsGeoJSON.features];
    features.sort((a, b) => {
      const sidA = a.properties?.id || a.properties?.sid || a.properties?.settlement_id || a.id || '';
      const sidB = b.properties?.id || b.properties?.sid || b.properties?.settlement_id || b.id || '';
      if (sidA === '' && sidB !== '') return 1;
      if (sidA !== '' && sidB === '') return -1;
      return String(sidA).localeCompare(String(sidB));
    });
    
    for (const feature of features) {
      const indexEntry = getIndexEntry(feature);
      
      if (!passesFilters(feature, indexEntry)) continue;
      
      renderFeature(feature, indexEntry);
    }
    
    // Draw hover highlight
    if (hoveredFeature) {
      const indexEntry = getIndexEntry(hoveredFeature);
      if (passesFilters(hoveredFeature, indexEntry)) {
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
  }

  // Find feature at point
  function findFeatureAt(x, y) {
    if (!settlementsGeoJSON) return null;
    
    const world = screenToWorld(x, y);
    
    // Simple bbox check (point-in-polygon would be more accurate but slower)
    for (const feature of settlementsGeoJSON.features) {
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
    
    const indexEntry = getIndexEntry(feature);
    
    let html = '';
    
    const sid = indexEntry?.sid || feature.properties?.id || feature.properties?.sid || feature.id;
    html += `<div class="tooltip-line"><strong>SID:</strong> ${sid || '(missing sid)'}</div>`;
    
    // Add data provenance line (settlement-level only, no municipality fallback)
    if (indexEntry && indexEntry.data_provenance) {
      if (indexEntry.data_provenance === 'settlement') {
        html += `<div class="tooltip-line"><strong>Data Provenance:</strong> settlement</div>`;
      } else if (indexEntry.data_provenance === 'no_settlement_census') {
        html += `<div class="tooltip-line"><strong>Data Provenance:</strong> no settlement-level census match</div>`;
      } else if (indexEntry.data_provenance === 'invalid_settlement_p') {
        html += `<div class="tooltip-line"><strong>Data Provenance:</strong> invalid settlement p-sum</div>`;
      } else if (indexEntry.data_provenance === 'missing_sid') {
        html += `<div class="tooltip-line"><strong>Data Provenance:</strong> missing sid</div>`;
      } else {
        html += `<div class="tooltip-line"><strong>Data Provenance:</strong> ${indexEntry.data_provenance}</div>`;
      }
    }
    
    if (indexEntry && indexEntry.majority_ethnicity && indexEntry.majority_ethnicity !== 'unknown') {
      html += `<div class="tooltip-line"><strong>Majority:</strong> ${indexEntry.majority_ethnicity}</div>`;
    } else {
      html += `<div class="tooltip-line"><strong>Majority:</strong> unknown</div>`;
    }
    
    if (indexEntry && indexEntry.shares && indexEntry.data_provenance === 'settlement') {
      html += '<div class="tooltip-line"><strong>Composition:</strong></div>';
      if (dataIndex && dataIndex.census_ordering_validated) {
        // Use ethnicity labels
        const shares = indexEntry.shares;
        if (shares.bosniak !== undefined) html += `<div class="tooltip-line">  Bosniak: ${(shares.bosniak * 100).toFixed(1)}%</div>`;
        if (shares.croat !== undefined) html += `<div class="tooltip-line">  Croat: ${(shares.croat * 100).toFixed(1)}%</div>`;
        if (shares.serb !== undefined) html += `<div class="tooltip-line">  Serb: ${(shares.serb * 100).toFixed(1)}%</div>`;
        if (shares.other !== undefined) html += `<div class="tooltip-line">  Other: ${(shares.other * 100).toFixed(1)}%</div>`;
      } else {
        // Use p1..p4 labels
        const shares = indexEntry.shares;
        if (shares.p1 !== undefined) html += `<div class="tooltip-line">  p1: ${(shares.p1 * 100).toFixed(1)}%</div>`;
        if (shares.p2 !== undefined) html += `<div class="tooltip-line">  p2: ${(shares.p2 * 100).toFixed(1)}%</div>`;
        if (shares.p3 !== undefined) html += `<div class="tooltip-line">  p3: ${(shares.p3 * 100).toFixed(1)}%</div>`;
        if (shares.p4 !== undefined) html += `<div class="tooltip-line">  p4: ${(shares.p4 * 100).toFixed(1)}%</div>`;
      }
    } else if (indexEntry && indexEntry.data_provenance !== 'settlement') {
      html += '<div class="tooltip-line"><strong>Composition:</strong> No settlement-level census data</div>';
    }
    
    tooltip.innerHTML = html;
    tooltip.style.display = 'block';
    tooltip.style.left = (x + 10) + 'px';
    tooltip.style.top = (y + 10) + 'px';
    
    // Keep tooltip in viewport
    const rect = tooltip.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      tooltip.style.left = (x - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      tooltip.style.top = (y - rect.height - 10) + 'px';
    }
  }

  // Update legend
  function updateLegend() {
    if (!dataIndex) return;
    
    let html = '<div style="font-weight: bold; margin-bottom: 6px;">Legend:</div>';
    
    const labels = dataIndex.legend_labels || {};
    const counts = dataIndex.counts_by_majority || {};
    
    // Show in fixed order: bosniak, serb, croat, other, unknown (or p1..p4 if ambiguous)
    const order = dataIndex.census_ordering_validated
      ? ['bosniak', 'serb', 'croat', 'other', 'unknown']
      : ['p1', 'p2', 'p3', 'p4', 'unknown'];
    
    for (const key of order) {
      const label = labels[key];
      if (label === undefined) continue;
      const count = counts[key] || 0;
      const colorHex = ETHNICITY_COLORS[key];
      if (colorHex) {
        html += `<div class="legend-item">
          <span><span class="legend-color" style="background: ${colorHex}"></span>${label}</span>
          <span>${count}</span>
        </div>`;
      }
    }
    
    legendDiv.innerHTML = html;
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
      hoveredFeature = findFeatureAt(e.clientX, e.clientY);
      render();
      updateTooltip(hoveredFeature, e.clientX, e.clientY);
    }
  });

  canvas.addEventListener('mouseup', () => {
    isDragging = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
    canvas.classList.remove('dragging');
    hoveredFeature = null;
    tooltip.style.display = 'none';
    render();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const world = screenToWorld(e.clientX, e.clientY);
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    viewScale *= zoomFactor;
    
    const newWorld = screenToWorld(e.clientX, e.clientY);
    viewX += (world.x - newWorld.x) * viewScale;
    viewY += (world.y - newWorld.y) * viewScale;
    
    render();
  });

  // Control events
  showEthnicityCheck.addEventListener('change', render);
  filterMuniInput.addEventListener('input', render);
  filterSidInput.addEventListener('input', render);
  resetViewBtn.addEventListener('click', () => {
    if (globalBounds) {
      fitToBounds(globalBounds);
    }
  });

  // Load data
  async function loadData() {
    try {
      // Load geometry
      // Relative path: from phase0_viewer/ to data/source/
      // Works when served via http-server from repo root: http://localhost:8080/data/derived/phase0_viewer/
      // Path resolves to: http://localhost:8080/data/source/bih_settlements_1991.geojson
      const geoResponse = await fetch('../../source/bih_settlements_1991.geojson');
      if (!geoResponse.ok) {
        throw new Error(`Failed to load geometry: ${geoResponse.statusText}`);
      }
      settlementsGeoJSON = await geoResponse.json();
      
      // Load index
      const indexResponse = await fetch('./data_index.json');
      if (!indexResponse.ok) {
        throw new Error(`Failed to load index: ${indexResponse.statusText}`);
      }
      dataIndex = await indexResponse.json();
      
      // Build settlement index map
      if (dataIndex && dataIndex.settlements) {
        for (const entry of dataIndex.settlements) {
          if (entry.sid) {
            settlementIndex.set(String(entry.sid), entry);
          }
        }
      }
      
      // Compute global bounds
      if (dataIndex && dataIndex.global_bbox) {
        globalBounds = {
          minX: dataIndex.global_bbox.minx,
          minY: dataIndex.global_bbox.miny,
          maxX: dataIndex.global_bbox.maxx,
          maxY: dataIndex.global_bbox.maxy
        };
      } else {
        // Fallback: compute from features
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
        }
      }
      
      // Fit to bounds
      if (globalBounds) {
        fitToBounds(globalBounds);
      }
      
      // Update legend
      updateLegend();
      
      console.log('Data loaded successfully');
    } catch (err) {
      console.error('Error loading data:', err);
      alert('Failed to load data. Check console for details.');
    }
  }

  // Start loading
  loadData();
})();
