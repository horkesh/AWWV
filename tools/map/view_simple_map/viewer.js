/**
 * Simple Map Viewer
 * 
 * Renders settlement polygons and municipality borders together.
 * Deterministic draw order, no geometry modification.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const showSettlementsCheck = document.getElementById('show-settlements');
  const showMuniBordersCheck = document.getElementById('show-muni-borders');
  const showSettlementPointsCheck = document.getElementById('show-settlement-points');
  const showMuniPointsCheck = document.getElementById('show-muni-points');
  const focusSelect = document.getElementById('focus-select');
  const fitAllBtn = document.getElementById('fit-all');
  const statsDiv = document.getElementById('stats');
  const warningsDiv = document.getElementById('warnings');
  const errorDiv = document.getElementById('error');

  let settlementsGeoJSON = null;
  let muniBordersGeoJSON = null;
  let settlementFeatures = [];
  let muniBorderFeatures = [];
  
  // View state
  let viewX = 0;
  let viewY = 0;
  let viewScale = 1;
  let globalBounds = null;
  let focusedMuniBounds = null;

  // Pan/zoom state
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartViewX = 0;
  let dragStartViewY = 0;

  // Statistics
  let stats = {
    settlementsDrawn: 0,
    settlementsIgnored: 0,
    muniBordersDrawn: 0,
    unsupportedGeometryTypes: {}
  };

  // Resize canvas
  function resizeCanvas() {
    if (!canvas) {
      console.error('Canvas element not found');
      return;
    }
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (ctx) {
      render();
    }
  }

  // Check if elements exist
  if (!canvas || !ctx) {
    const errorMsg = 'Canvas or context not found. Check browser console for errors.';
    if (errorDiv) {
      errorDiv.textContent = errorMsg;
      errorDiv.style.display = 'block';
    }
    console.error(errorMsg);
    if (statsDiv) {
      statsDiv.textContent = errorMsg;
    }
  } else {
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
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
    } else if (geom.type === 'LineString') {
      coords = geom.coordinates || [];
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) {
        coords.push(...line);
      }
    } else if (geom.type === 'Point') {
      coords = [geom.coordinates];
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

  // Compute combined bounds
  function computeBounds(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    
    for (const feature of features) {
      const bounds = computeFeatureBounds(feature);
      if (bounds) {
        minX = Math.min(minX, bounds.minX);
        minY = Math.min(minY, bounds.minY);
        maxX = Math.max(maxX, bounds.maxX);
        maxY = Math.max(maxY, bounds.maxY);
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

  // Transform world to screen
  function worldToScreen(x, y) {
    return {
      x: x * viewScale + viewX,
      y: y * viewScale + viewY
    };
  }

  // Render polygon outline
  function renderPolygon(coords, isPoint) {
    if (coords.length < 2) return;
    
    ctx.beginPath();
    const first = worldToScreen(coords[0][0], coords[0][1]);
    ctx.moveTo(first.x, first.y);
    
    for (let i = 1; i < coords.length; i++) {
      const pt = worldToScreen(coords[i][0], coords[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    if (isPoint) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }

  // Render line string
  function renderLineString(coords, isPoint) {
    if (coords.length < 2) return;
    
    ctx.beginPath();
    const first = worldToScreen(coords[0][0], coords[0][1]);
    ctx.moveTo(first.x, first.y);
    
    for (let i = 1; i < coords.length; i++) {
      const pt = worldToScreen(coords[i][0], coords[i][1]);
      ctx.lineTo(pt.x, pt.y);
    }
    
    if (isPoint) {
      ctx.fill();
    } else {
      ctx.stroke();
    }
  }

  // Render feature
  function renderFeature(feature, pointsOnly) {
    const geom = feature.geometry;
    
    if (geom.type === 'Polygon') {
      if (pointsOnly) {
        // Render points only
        for (const ring of geom.coordinates) {
          for (const coord of ring) {
            const pt = worldToScreen(coord[0], coord[1]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        // Render outline only (outer ring)
        if (geom.coordinates[0]) {
          renderPolygon(geom.coordinates[0], false);
        }
      }
    } else if (geom.type === 'MultiPolygon') {
      if (pointsOnly) {
        for (const poly of geom.coordinates) {
          for (const ring of poly) {
            for (const coord of ring) {
              const pt = worldToScreen(coord[0], coord[1]);
              ctx.beginPath();
              ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
              ctx.fill();
            }
          }
        }
      } else {
        // Render outlines only (outer rings)
        for (const poly of geom.coordinates) {
          if (poly[0]) {
            renderPolygon(poly[0], false);
          }
        }
      }
    } else if (geom.type === 'LineString') {
      if (pointsOnly) {
        for (const coord of geom.coordinates) {
          const pt = worldToScreen(coord[0], coord[1]);
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        renderLineString(geom.coordinates, false);
      }
    } else if (geom.type === 'MultiLineString') {
      if (pointsOnly) {
        for (const line of geom.coordinates) {
          for (const coord of line) {
            const pt = worldToScreen(coord[0], coord[1]);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } else {
        for (const line of geom.coordinates) {
          renderLineString(line, false);
        }
      }
    } else {
      // Unsupported geometry type
      const type = geom.type || 'unknown';
      stats.unsupportedGeometryTypes[type] = (stats.unsupportedGeometryTypes[type] || 0) + 1;
    }
  }

  // Load data
  async function loadData() {
    try {
      console.log('Loading settlements...');
      // Load settlements
      const settlementsResponse = await fetch('/settlements');
      if (!settlementsResponse.ok) {
        const errorText = await settlementsResponse.text();
        throw new Error(`Settlements: HTTP ${settlementsResponse.status} - ${errorText}`);
      }
      settlementsGeoJSON = await settlementsResponse.json();
      console.log('Settlements loaded:', settlementsGeoJSON?.features?.length || 0, 'features');
      
      if (!settlementsGeoJSON.features || !Array.isArray(settlementsGeoJSON.features)) {
        throw new Error('Invalid settlements GeoJSON: missing features array');
      }

      settlementFeatures = settlementsGeoJSON.features.filter(feature => {
        const geom = feature.geometry;
        return geom.type === 'Polygon' || geom.type === 'MultiPolygon';
      });

      // Sort settlements deterministically: by municipality_id (or mun_id), then by original index
      settlementFeatures.sort((a, b) => {
        const propsA = a.properties || {};
        const propsB = b.properties || {};
        const munIdA = String(propsA.municipality_id || propsA.mun_id || '');
        const munIdB = String(propsB.municipality_id || propsB.mun_id || '');
        const idxA = settlementsGeoJSON.features.indexOf(a);
        const idxB = settlementsGeoJSON.features.indexOf(b);
        
        if (munIdA !== munIdB) return munIdA.localeCompare(munIdB);
        return idxA - idxB;
      });

      // Load municipality borders
      console.log('Loading municipality borders...');
      const muniResponse = await fetch('/muni');
      if (!muniResponse.ok) {
        const errorText = await muniResponse.text();
        throw new Error(`Municipality borders: HTTP ${muniResponse.status} - ${errorText}`);
      }
      muniBordersGeoJSON = await muniResponse.json();
      console.log('Municipality borders loaded:', muniBordersGeoJSON?.features?.length || 0, 'features');
      
      if (!muniBordersGeoJSON.features || !Array.isArray(muniBordersGeoJSON.features)) {
        throw new Error('Invalid municipality borders GeoJSON: missing features array');
      }

      muniBorderFeatures = muniBordersGeoJSON.features.filter(feature => {
        const geom = feature.geometry;
        return geom.type === 'LineString' || geom.type === 'MultiLineString';
      });

      // Sort municipality borders deterministically: by municipality_id
      muniBorderFeatures.sort((a, b) => {
        const idA = String((a.properties?.municipality_id || '')).toLowerCase();
        const idB = String((b.properties?.municipality_id || '')).toLowerCase();
        return idA.localeCompare(idB);
      });

      // Populate focus dropdown
      focusSelect.innerHTML = '<option value="">-- Select --</option>';
      muniBorderFeatures.forEach(feature => {
        const muniId = feature.properties?.municipality_id || 'UNKNOWN';
        const option = document.createElement('option');
        option.value = muniId;
        option.textContent = muniId;
        focusSelect.appendChild(option);
      });

      // Compute combined global bounds
      const allFeatures = [...settlementFeatures, ...muniBorderFeatures];
      globalBounds = computeBounds(allFeatures);
      
      // Initial fit
      if (globalBounds) {
        fitToBounds(globalBounds);
      }
      
      updateStats();
      render();
      console.log('Data loaded successfully');
    } catch (err) {
      const errorMsg = `Error loading data: ${err.message}`;
      errorDiv.textContent = errorMsg;
      errorDiv.style.display = 'block';
      console.error('Load error:', err);
      statsDiv.textContent = errorMsg;
    }
  }

  // Update stats
  function updateStats() {
    stats.settlementsDrawn = settlementFeatures.length;
    stats.settlementsIgnored = (settlementsGeoJSON?.features?.length || 0) - settlementFeatures.length;
    stats.muniBordersDrawn = muniBorderFeatures.length;
    
    const scale = viewScale.toFixed(4);
    
    let statsText = 
      `Settlements: ${stats.settlementsDrawn} drawn`;
    if (stats.settlementsIgnored > 0) {
      statsText += `, ${stats.settlementsIgnored} ignored`;
    }
    statsText += `\nMunicipality borders: ${stats.muniBordersDrawn}\nScale: ${scale}x`;
    
    if (Object.keys(stats.unsupportedGeometryTypes).length > 0) {
      statsText += `\nUnsupported types: ${Object.keys(stats.unsupportedGeometryTypes).join(', ')}`;
    }
    
    statsDiv.textContent = statsText;
    
    // Show warnings
    let warnings = [];
    if (stats.settlementsDrawn === 0) {
      warnings.push('WARNING: No settlement features found');
    }
    if (stats.muniBordersDrawn === 0) {
      warnings.push('WARNING: No municipality border features found');
    }
    if (Object.keys(stats.unsupportedGeometryTypes).length > 0) {
      warnings.push(`WARNING: Unsupported geometry types detected: ${Object.keys(stats.unsupportedGeometryTypes).join(', ')}`);
    }
    
    if (warnings.length > 0) {
      warningsDiv.innerHTML = warnings.map(w => `<div class="warning">${w}</div>`).join('');
    } else {
      warningsDiv.innerHTML = '';
    }
  }

  // Render
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Render settlements
    if (showSettlementsCheck.checked) {
      ctx.strokeStyle = '#0066cc';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#0066cc';
      
      for (const feature of settlementFeatures) {
        renderFeature(feature, false);
      }
      
      // Render settlement points
      if (showSettlementPointsCheck.checked) {
        for (const feature of settlementFeatures) {
          renderFeature(feature, true);
        }
      }
    }
    
    // Render municipality borders (on top)
    if (showMuniBordersCheck.checked) {
      ctx.strokeStyle = '#cc0000';
      ctx.lineWidth = 2;
      ctx.fillStyle = '#cc0000';
      
      for (const feature of muniBorderFeatures) {
        renderFeature(feature, false);
      }
      
      // Render muni points
      if (showMuniPointsCheck.checked) {
        for (const feature of muniBorderFeatures) {
          renderFeature(feature, true);
        }
      }
    }
  }

  // Pan/zoom handlers
  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartViewX = viewX;
    dragStartViewY = viewY;
    canvas.style.cursor = 'grabbing';
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
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('mouseleave', () => {
    isDragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    // Convert screen to world coordinates before zoom
    const worldX = (mouseX - viewX) / viewScale;
    const worldY = (mouseY - viewY) / viewScale;
    
    // Zoom
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    viewScale *= zoomFactor;
    viewScale = Math.max(0.01, Math.min(1000, viewScale));
    
    // Adjust view position to zoom around cursor
    viewX = mouseX - worldX * viewScale;
    viewY = mouseY - worldY * viewScale;
    
    render();
    updateStats();
  });

  // Control handlers
  showSettlementsCheck.addEventListener('change', render);
  showMuniBordersCheck.addEventListener('change', render);
  showSettlementPointsCheck.addEventListener('change', render);
  showMuniPointsCheck.addEventListener('change', render);

  focusSelect.addEventListener('change', () => {
    const selectedId = focusSelect.value;
    if (!selectedId) {
      focusedMuniBounds = null;
      if (globalBounds) {
        fitToBounds(globalBounds);
      }
      return;
    }
    
    // Find municipality feature
    const muniFeature = muniBorderFeatures.find(f => 
      String(f.properties?.municipality_id || '') === selectedId
    );
    
    if (muniFeature) {
      focusedMuniBounds = computeFeatureBounds(muniFeature);
      if (focusedMuniBounds) {
        fitToBounds(focusedMuniBounds);
      }
    }
  });

  fitAllBtn.addEventListener('click', () => {
    focusedMuniBounds = null;
    if (globalBounds) {
      fitToBounds(globalBounds);
    }
  });

  // Load data on startup (only if canvas is available)
  if (canvas && ctx) {
    loadData();
  } else {
    console.error('Cannot load data: canvas not available');
  }
})();
