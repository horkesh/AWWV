/**
 * Dual-Layer Fit Viewer
 * 
 * Renders settlement fabric and municipality outlines together for visual fit verification.
 * Deterministic draw order, no geometry modification.
 */

(function() {
  'use strict';

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const showSettlementsCheck = document.getElementById('show-settlements');
  const showMuniOutlinesCheck = document.getElementById('show-muni-outlines');
  const showSettlementPointsCheck = document.getElementById('show-settlement-points');
  const showMuniPointsCheck = document.getElementById('show-muni-points');
  const muniSourceSvg = document.getElementById('muni-source-svg');
  const muniSourceFabric = document.getElementById('muni-source-fabric');
  const useCleanedFabricCheck = document.getElementById('use-cleaned-fabric');
  const fabricCleanGroup = document.getElementById('fabric-clean-group');
  const filterText = document.getElementById('filter-text');
  const focusSelect = document.getElementById('focus-select');
  const clipSettlementsCheck = document.getElementById('clip-settlements');
  const fitAllBtn = document.getElementById('fit-all');
  const statsDiv = document.getElementById('stats');
  const warningsDiv = document.getElementById('warnings');
  const errorDiv = document.getElementById('error');
  const diagnosticsDiv = document.getElementById('diagnostics');
  const propertyKeysDiv = document.getElementById('property-keys');

  let settlementsGeoJSON = null;
  let muniOutlinesGeoJSON = null;
  let settlementFeatures = [];
  let muniOutlineFeatures = [];
  let filteredMuniFeatures = [];
  
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
    muniOutlinesDrawn: 0,
    propertyKeys: new Set()
  };

  // Resize canvas
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    render();
  }

  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Classify settlement feature
  function isSettlementFeature(feature) {
    const props = feature.properties || {};
    
    // Rule 1: explicit feature_type
    if (props.feature_type === 'settlement') {
      return true;
    }
    
    // Rule 2: explicit layer property
    if (props.layer === 'settlement') {
      return true;
    }
    
    // Rule 3: kind property (case-insensitive)
    if (props.kind) {
      const kindLower = String(props.kind).toLowerCase();
      if (kindLower === 'settlement') {
        return true;
      }
    }
    
    return false;
  }

  // Collect property keys for diagnostics
  function collectPropertyKeys(feature) {
    if (feature.properties) {
      Object.keys(feature.properties).forEach(key => stats.propertyKeys.add(key));
    }
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

  // Compute bounds from features
  function computeBounds(features) {
    let first = true;
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    
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
    
    if (first) return null;
    return { minX, minY, maxX, maxY };
  }

  // Compute feature bounds
  function computeFeatureBounds(feature) {
    return computeBounds([feature]);
  }

  // Check if bounds intersect
  function boundsIntersect(bounds1, bounds2) {
    if (!bounds1 || !bounds2) return false;
    return !(bounds1.maxX < bounds2.minX || bounds1.minX > bounds2.maxX ||
             bounds1.maxY < bounds2.minY || bounds1.minY > bounds2.maxY);
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

  // Transform world to screen
  function worldToScreen(x, y) {
    return {
      x: x * viewScale + viewX,
      y: y * viewScale + viewY
    };
  }

  // Load both GeoJSON files
  async function loadData() {
    try {
      // Load settlements
      const settlementsResponse = await fetch('/settlements');
      if (!settlementsResponse.ok) {
        throw new Error(`Settlements: HTTP ${settlementsResponse.status}`);
      }
      settlementsGeoJSON = await settlementsResponse.json();
      
      if (!settlementsGeoJSON.features || !Array.isArray(settlementsGeoJSON.features)) {
        throw new Error('Invalid settlements GeoJSON: missing features array');
      }

      // Filter and classify settlement features
      settlementFeatures = [];
      for (const feature of settlementsGeoJSON.features) {
        collectPropertyKeys(feature);
        if (isSettlementFeature(feature)) {
          settlementFeatures.push(feature);
        } else {
          stats.settlementsIgnored++;
        }
      }

      // Sort settlements deterministically
      settlementFeatures.sort((a, b) => {
        const propsA = a.properties || {};
        const propsB = b.properties || {};
        const munIdA = String(propsA.municipality_id || propsA.mid || '');
        const munIdB = String(propsB.municipality_id || propsB.mid || '');
        const sidA = String(propsA.settlement_id || propsA.sid || '');
        const sidB = String(propsB.settlement_id || propsB.sid || '');
        const idxA = settlementFeatures.indexOf(a);
        const idxB = settlementFeatures.indexOf(b);
        
        if (munIdA !== munIdB) return munIdA.localeCompare(munIdB);
        if (sidA !== sidB) return sidA.localeCompare(sidB);
        return idxA - idxB;
      });

      // Load municipality outlines (based on source selection)
      const muniSource = muniSourceFabric.checked ? 'fabric' : 'svg';
      let muniEndpoint = muniSource === 'fabric' ? '/muni_fabric' : '/muni_outlines';
      
      // Check if cleaned fabric should be used
      if (muniSource === 'fabric' && useCleanedFabricCheck.checked) {
        muniEndpoint = '/muni_fabric_clean';
      }
      
      const muniResponse = await fetch(muniEndpoint);
      if (!muniResponse.ok) {
        throw new Error(`Municipality ${muniSource}: HTTP ${muniResponse.status}`);
      }
      muniOutlinesGeoJSON = await muniResponse.json();
      
      if (!muniOutlinesGeoJSON.features || !Array.isArray(muniOutlinesGeoJSON.features)) {
        throw new Error(`Invalid municipality ${muniSource} GeoJSON: missing features array`);
      }

      muniOutlineFeatures = muniOutlinesGeoJSON.features;
      
      // Sort municipality outlines deterministically
      // For fabric source: sort by municipality_id
      // For SVG source: sort by muni_key
      muniOutlineFeatures.sort((a, b) => {
        if (muniSource === 'fabric') {
          const idA = (a.properties?.municipality_id || '').toLowerCase();
          const idB = (b.properties?.municipality_id || '').toLowerCase();
          return idA.localeCompare(idB);
        } else {
          const keyA = (a.properties?.muni_key || '').toLowerCase();
          const keyB = (b.properties?.muni_key || '').toLowerCase();
          return keyA.localeCompare(keyB);
        }
      });

      // Populate focus dropdown
      focusSelect.innerHTML = '<option value="">-- Select --</option>';
      muniOutlineFeatures.forEach(feature => {
        const key = muniSource === 'fabric' 
          ? (feature.properties?.municipality_id || 'UNKNOWN')
          : (feature.properties?.muni_key || 'UNKNOWN');
        const option = document.createElement('option');
        option.value = key;
        option.textContent = key;
        focusSelect.appendChild(option);
      });
      
      // Check if cleaned file exists and set default
      if (muniSource === 'fabric') {
        // Try to fetch cleaned file to see if it exists
        fetch('/muni_fabric_clean').then(response => {
          if (response.ok) {
            useCleanedFabricCheck.checked = true;
          }
        }).catch(() => {
          // File doesn't exist, leave checkbox as is
        });
      }

      // Compute combined global bounds
      const allFeatures = [...settlementFeatures, ...muniOutlineFeatures];
      globalBounds = computeBounds(allFeatures);
      
      // Initial fit
      if (globalBounds) {
        fitToBounds(globalBounds);
      }
      
      updateStats();
      updateDiagnostics();
      applyFilter();
      render();
    } catch (err) {
      errorDiv.textContent = `Error loading data: ${err.message}`;
      errorDiv.style.display = 'block';
      console.error('Load error:', err);
    }
  }

  // Apply filter
  function applyFilter() {
    const filter = filterText.value.trim().toLowerCase();
    const muniSource = muniSourceFabric.checked ? 'fabric' : 'svg';
    
    if (filter === '') {
      filteredMuniFeatures = muniOutlineFeatures;
    } else {
      filteredMuniFeatures = muniOutlineFeatures.filter(feature => {
        const key = muniSource === 'fabric'
          ? (feature.properties?.municipality_id || '').toLowerCase()
          : (feature.properties?.muni_key || '').toLowerCase();
        return key.includes(filter);
      });
    }
    
    render();
  }

  // Update stats
  function updateStats() {
    stats.settlementsDrawn = settlementFeatures.length;
    stats.muniOutlinesDrawn = muniOutlineFeatures.length;
    
    const scale = viewScale.toFixed(4);
    
    statsDiv.textContent = 
      `Settlements: ${stats.settlementsDrawn} drawn, ${stats.settlementsIgnored} ignored\n` +
      `Municipality outlines: ${stats.muniOutlinesDrawn}\n` +
      `Scale: ${scale}x`;
    
    // Show warning if no settlements
    if (stats.settlementsDrawn === 0) {
      warningsDiv.innerHTML = '<div class="warning">WARNING: No settlement features found. Check property keys in diagnostics.</div>';
    } else {
      warningsDiv.innerHTML = '';
    }
  }

  // Update diagnostics
  function updateDiagnostics() {
    const keys = Array.from(stats.propertyKeys).sort();
    if (keys.length > 0) {
      propertyKeysDiv.textContent = keys.slice(0, 30).join(', ') + (keys.length > 30 ? '...' : '');
      diagnosticsDiv.style.display = 'block';
      console.log('Property keys seen (first 30):', keys.slice(0, 30));
    }
  }

  // Render
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Get which settlement features to render (consider clipping)
    let settlementsToRender = settlementFeatures;
    if (clipSettlementsCheck.checked && focusedMuniBounds) {
      settlementsToRender = settlementFeatures.filter(feature => {
        const featureBounds = computeFeatureBounds(feature);
        return boundsIntersect(featureBounds, focusedMuniBounds);
      });
    }

    // Render settlements
    if (showSettlementsCheck.checked) {
      ctx.strokeStyle = '#0066cc';
      ctx.lineWidth = 1;
      ctx.fillStyle = '#0066cc';
      
      for (const feature of settlementsToRender) {
        renderFeature(feature, false);
      }
      
      // Render settlement points
      if (showSettlementPointsCheck.checked) {
        for (const feature of settlementsToRender) {
          renderFeature(feature, true);
        }
      }
    }

    // Render municipality outlines
    if (showMuniOutlinesCheck.checked) {
      ctx.strokeStyle = '#cc0000';
      ctx.lineWidth = 2;
      ctx.fillStyle = '#cc0000';
      
      for (const feature of filteredMuniFeatures) {
        renderFeature(feature, false);
      }
      
      // Render municipality points
      if (showMuniPointsCheck.checked) {
        for (const feature of filteredMuniFeatures) {
          renderFeature(feature, true);
        }
      }
    }
  }

  // Render a feature
  function renderFeature(feature, pointsOnly) {
    const geometry = feature.geometry;
    
    if (geometry.type === 'LineString') {
      if (!pointsOnly) {
        renderLineString(geometry.coordinates);
      }
      if (showSettlementPointsCheck.checked || showMuniPointsCheck.checked) {
        renderPoints(geometry.coordinates);
      }
    } else if (geometry.type === 'MultiLineString') {
      for (const line of geometry.coordinates) {
        if (!pointsOnly) {
          renderLineString(line);
        }
        if (showSettlementPointsCheck.checked || showMuniPointsCheck.checked) {
          renderPoints(line);
        }
      }
    } else if (geometry.type === 'Polygon') {
      // Render exterior ring only
      if (geometry.coordinates[0]) {
        if (!pointsOnly) {
          renderLineString(geometry.coordinates[0]);
        }
        if (showSettlementPointsCheck.checked || showMuniPointsCheck.checked) {
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
          if (showSettlementPointsCheck.checked || showMuniPointsCheck.checked) {
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
    
    const mouseX = e.clientX;
    const mouseY = e.clientY;
    
    const worldX = (mouseX - viewX) / viewScale;
    const worldY = (mouseY - viewY) / viewScale;
    
    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    viewScale *= zoomFactor;
    viewScale = Math.max(0.01, Math.min(100, viewScale));
    
    viewX = mouseX - worldX * viewScale;
    viewY = mouseY - worldY * viewScale;
    
    render();
  });

  // UI handlers
  showSettlementsCheck.addEventListener('change', () => {
    updateStats();
    render();
  });
  showMuniOutlinesCheck.addEventListener('change', render);
  showSettlementPointsCheck.addEventListener('change', render);
  showMuniPointsCheck.addEventListener('change', render);
  filterText.addEventListener('input', applyFilter);
  clipSettlementsCheck.addEventListener('change', render);
  
  focusSelect.addEventListener('change', () => {
    const selected = focusSelect.value;
    if (!selected) {
      focusedMuniBounds = null;
      render();
      return;
    }
    
    const feature = muniOutlineFeatures.find(f => f.properties?.muni_key === selected);
    if (feature) {
      focusedMuniBounds = computeFeatureBounds(feature);
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

  // Load on startup
  loadData();
})();
