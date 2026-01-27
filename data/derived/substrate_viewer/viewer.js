/**
 * Substrate Settlement Viewer
 * 
 * Pure static viewer - no bundler required.
 * Loads settlement geometry from settlements_substrate.geojson
 * and index data, renders to canvas with pan/zoom.
 * 
 * Strict settlement-level majority ethnicity coloring only (no municipality fallback).
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const tooltip = document.getElementById('tooltip');
  const showEthnicityCheck = document.getElementById('show-ethnicity');
  const showUnknownOnlyCheck = document.getElementById('show-unknown-only');
  const filterSidInput = document.getElementById('filter-sid');
  const resetViewBtn = document.getElementById('reset-view');
  const legendDiv = document.getElementById('legend');
  const warningBanner = document.getElementById('warning-banner');

  let settlementsGeoJSON = null;
  let dataIndex = null;
  const settlementIndex = new Map(); // sid -> index entry

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

  // Fixed color palette (must match exactly)
  const ETHNICITY_COLORS = {
    bosniak: '#2e7d32', // Green
    serb: '#c62828',    // Red
    croat: '#1565c0',   // Blue
    other: '#6d6d6d',   // Gray
    unknown: '#bdbdbd', // Light gray
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
    
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    
    viewX = canvas.width / 2 - centerX * viewScale;
    viewY = canvas.height / 2 - centerY * viewScale;
    
    render();
  }

  // Get index entry for a feature
  function getIndexEntry(feature) {
    if (!dataIndex) return null;
    
    const sid = feature.properties?.sid;
    if (sid) {
      return settlementIndex.get(String(sid)) || null;
    }
    
    return null;
  }

  // Check if feature passes filters
  function passesFilters(feature, indexEntry) {
    const sidFilter = filterSidInput.value.trim();
    
    if (sidFilter) {
      const sid = feature.properties?.sid;
      if (!sid || !String(sid).includes(sidFilter)) {
        return false;
      }
    }
    
    // Show Unknown only filter
    if (showUnknownOnlyCheck.checked) {
      if (!indexEntry || indexEntry.majority !== 'unknown') {
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
    
    // Determine fill color
    let fillColor = null;
    if (showEthnicityCheck.checked) {
      if (dataIndex && dataIndex.meta.ordering_mode === 'ambiguous') {
        // Ambiguous ordering: fill everything Unknown
        fillColor = hexToRgba(ETHNICITY_COLORS.unknown, 0.3);
      } else if (indexEntry && indexEntry.majority) {
        const colorHex = ETHNICITY_COLORS[indexEntry.majority];
        if (colorHex) {
          fillColor = hexToRgba(colorHex, 0.3); // 30% opacity for fills
        }
      } else {
        fillColor = hexToRgba(ETHNICITY_COLORS.unknown, 0.3);
      }
    }
    
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

  // Render all features
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!settlementsGeoJSON) return;
    
    // Draw features in deterministic order: sorted by sid (string compare)
    const features = [...settlementsGeoJSON.features];
    features.sort((a, b) => {
      const sidA = a.properties?.sid || '';
      const sidB = b.properties?.sid || '';
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

  // Find feature at point (simple bbox check)
  function findFeatureAt(x, y) {
    if (!settlementsGeoJSON) return null;
    
    const world = screenToWorld(x, y);
    
    // Check features in reverse order (top-most first)
    const features = [...settlementsGeoJSON.features].reverse();
    for (const feature of features) {
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
    
    const sid = feature.properties?.sid || '(missing sid)';
    html += `<div class="tooltip-line"><strong>SID:</strong> ${sid}</div>`;
    
    if (indexEntry && indexEntry.name) {
      html += `<div class="tooltip-line"><strong>Name:</strong> ${indexEntry.name}</div>`;
    }
    
    // Provenance
    if (indexEntry && indexEntry.provenance) {
      html += `<div class="tooltip-line"><strong>Provenance:</strong> ${indexEntry.provenance}</div>`;
    }
    
    // Majority
    if (indexEntry && indexEntry.majority) {
      html += `<div class="tooltip-line"><strong>Majority:</strong> ${indexEntry.majority}</div>`;
    } else {
      html += `<div class="tooltip-line"><strong>Majority:</strong> unknown</div>`;
    }
    
    // Composition breakdown (when ordering_mode is "named")
    if (indexEntry && indexEntry.shares && dataIndex && dataIndex.meta.ordering_mode === 'named') {
      html += '<div class="tooltip-line"><strong>Composition:</strong></div>';
      const shares = indexEntry.shares;
      if (shares.bosniak !== undefined) html += `<div class="tooltip-line">  Bosniak: ${(shares.bosniak * 100).toFixed(1)}%</div>`;
      if (shares.croat !== undefined) html += `<div class="tooltip-line">  Croat: ${(shares.croat * 100).toFixed(1)}%</div>`;
      if (shares.serb !== undefined) html += `<div class="tooltip-line">  Serb: ${(shares.serb * 100).toFixed(1)}%</div>`;
      if (shares.other !== undefined) html += `<div class="tooltip-line">  Other: ${(shares.other * 100).toFixed(1)}%</div>`;
    }
    
    // If unknown, show why
    if (indexEntry && indexEntry.majority === 'unknown') {
      if (indexEntry.provenance === 'no_settlement_census') {
        html += `<div class="tooltip-line" style="color: #ffcccc;"><strong>Reason:</strong> No settlement-level census data</div>`;
      } else if (indexEntry.provenance === 'ambiguous_ordering') {
        html += `<div class="tooltip-line" style="color: #ffcccc;"><strong>Reason:</strong> Census ordering ambiguous</div>`;
      }
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
    
    const counts = dataIndex.meta.counts.majority;
    const order = ['bosniak', 'serb', 'croat', 'other', 'unknown'];
    
    for (const key of order) {
      const count = counts[key] || 0;
      const colorHex = ETHNICITY_COLORS[key];
      if (colorHex) {
        const label = key.charAt(0).toUpperCase() + key.slice(1);
        html += `<div class="legend-item">
          <span><span class="legend-color" style="background: ${colorHex}"></span>${label}</span>
          <span>${count}</span>
        </div>`;
      }
    }
    
    legendDiv.innerHTML = html;
  }

  // Update warning banner
  function updateWarningBanner() {
    if (!dataIndex) return;
    
    if (dataIndex.meta.ordering_mode === 'ambiguous') {
      warningBanner.textContent = 'Settlement-level census ordering ambiguous (p0 != sum(p1..p4) frequently).';
      warningBanner.classList.add('show');
    } else if (dataIndex.meta.settlement_census_key === null) {
      warningBanner.textContent = 'Settlement-level census table missing. All settlements shown as Unknown.';
      warningBanner.classList.add('show');
    } else {
      warningBanner.classList.remove('show');
    }
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
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      viewX = dragStartViewX + dx;
      viewY = dragStartViewY + dy;
      render();
    } else {
      const feature = findFeatureAt(e.clientX, e.clientY);
      if (feature !== hoveredFeature) {
        hoveredFeature = feature;
        render();
        updateTooltip(feature, e.clientX, e.clientY);
      } else if (feature) {
        updateTooltip(feature, e.clientX, e.clientY);
      }
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

  // Zoom with mouse wheel
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const world = screenToWorld(e.clientX, e.clientY);
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    viewScale *= zoomFactor;
    viewScale = Math.max(0.1, Math.min(100, viewScale));
    
    const newWorld = screenToWorld(e.clientX, e.clientY);
    viewX += (world.x - newWorld.x) * viewScale;
    viewY += (world.y - newWorld.y) * viewScale;
    
    render();
  });

  // Control events
  showEthnicityCheck.addEventListener('change', render);
  showUnknownOnlyCheck.addEventListener('change', render);
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
      const geoResponse = await fetch(dataIndex.meta.geometry_path);
      if (!geoResponse.ok) {
        throw new Error(`Failed to load geometry: ${geoResponse.statusText}`);
      }
      settlementsGeoJSON = await geoResponse.json();
      
      // Build settlement index
      if (dataIndex && dataIndex.by_sid) {
        for (const [sid, entry] of Object.entries(dataIndex.by_sid)) {
          settlementIndex.set(sid, entry);
        }
      }
      
      // Compute global bounds
      if (dataIndex && dataIndex.meta.global_bbox) {
        const bbox = dataIndex.meta.global_bbox;
        globalBounds = {
          minX: bbox[0],
          minY: bbox[1],
          maxX: bbox[2],
          maxY: bbox[3]
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
        globalBounds = { minX, minY, maxX, maxY };
      }
      
      // Fit to bounds
      if (globalBounds) {
        fitToBounds(globalBounds);
      }
      
      updateLegend();
      updateWarningBanner();
      render();
    } catch (err) {
      console.error('Error loading data:', err);
      alert('Failed to load data. Check console for details.');
    }
  }

  // Load index first, then geometry
  fetch('./data_index.json')
    .then(response => {
      if (!response.ok) {
        throw new Error(`Failed to load index: ${response.statusText}`);
      }
      return response.json();
    })
    .then(index => {
      dataIndex = index;
      return loadData();
    })
    .catch(err => {
      console.error('Error loading index:', err);
      alert('Failed to load index. Check console for details.');
    });

})();
