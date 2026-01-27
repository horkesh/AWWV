/**
 * SVG Municipality Outlines Viewer
 * 
 * Renders municipality_outlines_from_html.geojson with pan/zoom and filtering.
 * Deterministic draw order, no geometry modification.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const showOutlinesCheck = document.getElementById('show-outlines');
  const showPointsCheck = document.getElementById('show-points');
  const filterText = document.getElementById('filter-text');
  const focusSelect = document.getElementById('focus-select');
  const resetViewBtn = document.getElementById('reset-view');
  const statsDiv = document.getElementById('stats');
  const errorDiv = document.getElementById('error');

  let geojson = null;
  let features = [];
  let filteredFeatures = [];
  
  // View state
  let viewX = 0;
  let viewY = 0;
  let viewScale = 1;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  let globalBounds = null;

  // Pan/zoom state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartViewX = 0;
  let dragStartViewY = 0;

  // Resize canvas
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Load GeoJSON
  async function loadGeoJSON() {
    try {
      const response = await fetch('/data');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      geojson = await response.json();
      
      if (!geojson.features || !Array.isArray(geojson.features)) {
        throw new Error('Invalid GeoJSON: missing features array');
      }

      features = geojson.features;
      
      // Sort features deterministically by muni_key
      features.sort((a, b) => {
        const keyA = (a.properties?.muni_key || '').toLowerCase();
        const keyB = (b.properties?.muni_key || '').toLowerCase();
        return keyA.localeCompare(keyB);
      });

      // Populate focus dropdown
      focusSelect.innerHTML = '<option value="">-- Select --</option>';
      features.forEach(feature => {
        const key = feature.properties?.muni_key || 'UNKNOWN';
        const option = document.createElement('option');
        option.value = key;
        option.textContent = key;
        focusSelect.appendChild(option);
      });

      // Compute global bounds
      computeGlobalBounds();
      
      // Initial fit
      fitToBounds(globalBounds);
      
      updateStats();
      applyFilter();
      render();
    } catch (err) {
      errorDiv.textContent = `Error loading GeoJSON: ${err.message}`;
      errorDiv.style.display = 'block';
      console.error('Load error:', err);
    }
  }

  // Compute global bounds from all features
  function computeGlobalBounds() {
    let first = true;
    
    for (const feature of features) {
      const coords = extractCoordinates(feature.geometry);
      for (const coord of coords) {
        const x = coord[0];
        const y = coord[1];
        if (first) {
          minX = maxX = x;
          minY = maxY = y;
          first = false;
        } else {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
    }
    
    globalBounds = { minX, minY, maxX, maxY };
  }

  // Extract all coordinates from geometry
  function extractCoordinates(geometry) {
    const coords = [];
    
    if (geometry.type === 'Point') {
      coords.push(geometry.coordinates);
    } else if (geometry.type === 'LineString') {
      coords.push(...geometry.coordinates);
    } else if (geometry.type === 'MultiLineString') {
      for (const line of geometry.coordinates) {
        coords.push(...line);
      }
    } else if (geometry.type === 'Polygon') {
      // Exterior ring only
      if (geometry.coordinates[0]) {
        coords.push(...geometry.coordinates[0]);
      }
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        // Exterior ring only
        if (polygon[0]) {
          coords.push(...polygon[0]);
        }
      }
    }
    
    return coords;
  }

  // Compute feature bounds
  function computeFeatureBounds(feature) {
    const coords = extractCoordinates(feature.geometry);
    if (coords.length === 0) return null;
    
    let first = true;
    let fMinX = 0, fMinY = 0, fMaxX = 0, fMaxY = 0;
    
    for (const coord of coords) {
      const x = coord[0];
      const y = coord[1];
      if (first) {
        fMinX = fMaxX = x;
        fMinY = fMaxY = y;
        first = false;
      } else {
        fMinX = Math.min(fMinX, x);
        fMaxX = Math.max(fMaxX, x);
        fMinY = Math.min(fMinY, y);
        fMaxY = Math.max(fMaxY, y);
      }
    }
    
    return { minX: fMinX, minY: fMinY, maxX: fMaxX, maxY: fMaxY };
  }

  // Fit view to bounds
  function fitToBounds(bounds, padding = 20) {
    if (!bounds) return;
    
    const width = bounds.maxX - bounds.minX;
    const height = bounds.maxY - bounds.minY;
    
    if (width <= 0 || height <= 0) return;
    
    const scaleX = (canvas.width - padding * 2) / width;
    const scaleY = (canvas.height - padding * 2) / height;
    viewScale = Math.min(scaleX, scaleY);
    
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    
    viewX = canvas.width / 2 - centerX * viewScale;
    viewY = canvas.height / 2 - centerY * viewScale;
    
    render();
  }

  // Apply filter
  function applyFilter() {
    const filter = filterText.value.trim().toLowerCase();
    
    if (filter === '') {
      filteredFeatures = features;
    } else {
      filteredFeatures = features.filter(feature => {
        const key = (feature.properties?.muni_key || '').toLowerCase();
        return key.includes(filter);
      });
    }
    
    render();
  }

  // Update stats
  function updateStats() {
    if (!features.length) {
      statsDiv.textContent = 'No features';
      return;
    }
    
    let totalParts = 0;
    let totalVertices = 0;
    
    for (const feature of features) {
      const coords = extractCoordinates(feature.geometry);
      totalVertices += coords.length;
      
      if (feature.geometry.type === 'MultiLineString') {
        totalParts += feature.geometry.coordinates.length;
      } else if (feature.geometry.type === 'LineString') {
        totalParts += 1;
      } else if (feature.geometry.type === 'Polygon') {
        totalParts += 1;
      } else if (feature.geometry.type === 'MultiPolygon') {
        totalParts += feature.geometry.coordinates.length;
      }
    }
    
    statsDiv.textContent = `Municipalities: ${features.length}\n` +
                           `Total parts: ${totalParts}\n` +
                           `Total vertices: ${totalVertices}`;
  }

  // Transform world to screen
  function worldToScreen(x, y) {
    return {
      x: x * viewScale + viewX,
      y: y * viewScale + viewY
    };
  }

  // Render
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!filteredFeatures.length) {
      ctx.fillStyle = '#666';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No features to display', canvas.width / 2, canvas.height / 2);
      return;
    }
    
    ctx.save();
    ctx.strokeStyle = '#0066cc';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#0066cc';
    
    // Render outlines
    if (showOutlinesCheck.checked) {
      for (const feature of filteredFeatures) {
        renderFeature(feature, false);
      }
    }
    
    // Render points
    if (showPointsCheck.checked) {
      for (const feature of filteredFeatures) {
        renderFeature(feature, true);
      }
    }
    
    ctx.restore();
  }

  // Render a feature
  function renderFeature(feature, pointsOnly) {
    const geometry = feature.geometry;
    
    if (geometry.type === 'LineString') {
      if (!pointsOnly) {
        renderLineString(geometry.coordinates);
      }
      if (showPointsCheck.checked) {
        renderPoints(geometry.coordinates);
      }
    } else if (geometry.type === 'MultiLineString') {
      for (const line of geometry.coordinates) {
        if (!pointsOnly) {
          renderLineString(line);
        }
        if (showPointsCheck.checked) {
          renderPoints(line);
        }
      }
    } else if (geometry.type === 'Polygon') {
      // Render exterior ring only
      if (geometry.coordinates[0]) {
        if (!pointsOnly) {
          renderLineString(geometry.coordinates[0]);
        }
        if (showPointsCheck.checked) {
          renderPoints(geometry.coordinates[0]);
        }
      }
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        // Render exterior ring only
        if (polygon[0]) {
          if (!pointsOnly) {
            renderLineString(polygon[0]);
          }
          if (showPointsCheck.checked) {
            renderPoints(polygon[0]);
          }
        }
      }
    }
  }

  // Render a line string
  function renderLineString(coordinates) {
    if (coordinates.length < 2) return;
    
    ctx.beginPath();
    const first = worldToScreen(coordinates[0][0], coordinates[0][1]);
    ctx.moveTo(first.x, first.y);
    
    for (let i = 1; i < coordinates.length; i++) {
      const pt = worldToScreen(coordinates[i][0], coordinates[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    ctx.stroke();
  }

  // Render points
  function renderPoints(coordinates) {
    const pointRadius = 2;
    
    for (const coord of coordinates) {
      const pt = worldToScreen(coord[0], coord[1]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pointRadius, 0, Math.PI * 2);
      ctx.fill();
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

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
    canvas.classList.remove('dragging');
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    // Zoom around cursor position
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Convert screen to world
    const worldX = (mouseX - viewX) / viewScale;
    const worldY = (mouseY - viewY) / viewScale;
    
    // Adjust scale
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    viewScale *= zoomFactor;
    viewScale = Math.max(0.01, Math.min(100, viewScale));
    
    // Adjust view to keep cursor point fixed
    viewX = mouseX - worldX * viewScale;
    viewY = mouseY - worldY * viewScale;
    
    render();
  });

  // UI handlers
  showOutlinesCheck.addEventListener('change', render);
  showPointsCheck.addEventListener('change', render);
  filterText.addEventListener('input', applyFilter);
  
  focusSelect.addEventListener('change', () => {
    const selected = focusSelect.value;
    if (!selected) return;
    
    const feature = features.find(f => f.properties?.muni_key === selected);
    if (feature) {
      const bounds = computeFeatureBounds(feature);
      if (bounds) {
        fitToBounds(bounds);
      }
    }
  });
  
  resetViewBtn.addEventListener('click', () => {
    if (globalBounds) {
      fitToBounds(globalBounds);
    }
  });

  // Load on startup
  loadGeoJSON();
})();
