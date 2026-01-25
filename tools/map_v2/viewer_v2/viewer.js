/**
 * Map v2 Viewer: Single municipality viewer with strict per-ring path handling
 * 
 * Mistake-log discipline: HTML viewer rendering: transform bounds must be frozen and never updated during draw
 */

// Mistake-log discipline (browser-compatible)
function checkMistakes() {
  console.log('Viewer initialized: HTML viewer rendering: transform bounds must be frozen and never updated during draw');
  console.log('RULE: Transform bounds must be computed once per render and never mutated. Diagnostics must be tracked in separate variables that do not feed into tx/ty.');
}

checkMistakes();

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const municipalitySelect = document.getElementById('municipality');
const showSalvagedCheckbox = document.getElementById('showSalvaged');
const maxRingsInput = document.getElementById('maxRings');
const flipYCheckbox = document.getElementById('flipY');

let municipalitiesMeta = [];
let settlementsMeta = [];
let settlementsGeoJSON = null;
let mapBounds = null;
let currentMunicipality = null;

// Resize canvas
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight - 120; // Account for controls and diagnostics
  draw();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

/**
 * Strict GeoJSON ring iterator
 * Supports Polygon and MultiPolygon
 * Yields only outer rings (ring[0]), ignores holes
 */
function* iterRings(feature) {
  const g = feature.geometry;
  if (!g) return;
  
  if (g.type === "Polygon") {
    // g.coordinates: [ ring0, ring1... ] each ring: [[x,y],...]
    // ring0 is outer, ring1+ are holes - we only use ring0
    if (g.coordinates && g.coordinates.length > 0) {
      yield g.coordinates[0];
    }
  } else if (g.type === "MultiPolygon") {
    // g.coordinates: [ polygon0, polygon1... ], polygon: [ ring0, ring1... ]
    for (const poly of g.coordinates) {
      if (poly && poly.length > 0) {
        yield poly[0]; // Only outer ring
      }
    }
  }
}

/**
 * Transform factory that creates frozen tx/ty functions
 * NEVER reads diagnostics variables - only frozen bounds + transform params
 */
function makeTransform(canvas, worldBounds, zoom, panX, panY, flipY) {
  const cw = canvas.width;
  const ch = canvas.height;

  const worldCx = (worldBounds.minX + worldBounds.maxX) * 0.5;
  const worldCy = (worldBounds.minY + worldBounds.maxY) * 0.5;

  const screenCx = cw * 0.5;
  const screenCy = ch * 0.5;

  const tx = (wx) => (wx - worldCx) * zoom + screenCx + panX;
  const ty = (wy) => {
    const y = (wy - worldCy) * zoom + screenCy + panY;
    return flipY ? (ch - y) : y;
  };

  return { tx, ty };
}

/**
 * Diagnostics tracking - completely separate from transform
 * NEVER feeds into tx/ty
 */
function diagPoint(wx, wy, sx, sy, diag) {
  if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(sx) || !Number.isFinite(sy)) {
    diag.nan++;
    return;
  }
  if (wx < diag.minWX) diag.minWX = wx;
  if (wy < diag.minWY) diag.minWY = wy;
  if (wx > diag.maxWX) diag.maxWX = wx;
  if (wy > diag.maxWY) diag.maxWY = wy;

  if (sx < diag.minSX) diag.minSX = sx;
  if (sy < diag.minSY) diag.minSY = sy;
  if (sx > diag.maxSX) diag.maxSX = sx;
  if (sy > diag.maxSY) diag.maxSY = sy;
}

// Load data
async function loadData() {
  try {
    const [muniRes, settRes, geoRes, boundsRes] = await Promise.all([
      fetch('data/derived_v2/municipalities_meta.json'),
      fetch('data/derived_v2/settlements_meta.json'),
      fetch('data/derived_v2/settlements_polygons.geojson'),
      fetch('data/derived_v2/map_bounds.json')
    ]);

    municipalitiesMeta = await muniRes.json();
    settlementsMeta = await settRes.json();
    settlementsGeoJSON = await geoRes.json();
    mapBounds = await boundsRes.json();

    // Populate municipality dropdown
    // Sort by geometry coverage (descending) for default selection
    const sorted = [...municipalitiesMeta].sort((a, b) => {
      const ratioA = a.total_settlements > 0 ? a.settlements_with_geometry / a.total_settlements : 0;
      const ratioB = b.total_settlements > 0 ? b.settlements_with_geometry / b.total_settlements : 0;
      return ratioB - ratioA;
    });

    municipalitySelect.innerHTML = '<option value="">-- Select Municipality --</option>';
    for (const muni of sorted) {
      const option = document.createElement('option');
      option.value = muni.mid;
      option.textContent = `${muni.name} (${muni.settlements_with_geometry}/${muni.total_settlements})`;
      municipalitySelect.appendChild(option);
    }

    // Select first municipality with high coverage
    if (sorted.length > 0 && sorted[0].settlements_with_geometry > 0) {
      municipalitySelect.value = sorted[0].mid;
      currentMunicipality = sorted[0].mid;
    }

    municipalitySelect.addEventListener('change', (e) => {
      currentMunicipality = e.target.value;
      draw();
    });

    showSalvagedCheckbox.addEventListener('change', () => {
      draw();
    });

    maxRingsInput.addEventListener('input', () => {
      draw();
    });

    flipYCheckbox.addEventListener('change', () => {
      draw();
    });

    draw();
  } catch (err) {
    console.error('Error loading data:', err);
    alert('Failed to load data. Check console for details.');
  }
}

// Draw function with frozen transform bounds
function draw() {
  if (!settlementsGeoJSON || !currentMunicipality || !mapBounds) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#333';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Select a municipality to view', canvas.width / 2, canvas.height / 2);
    return;
  }

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Filter features for current municipality
  const showSalvaged = showSalvagedCheckbox.checked;
  const features = settlementsGeoJSON.features.filter(f => {
    if (f.properties.mid !== currentMunicipality) return false;
    if (showSalvaged) {
      const method = f.properties.geometry_method;
      return method && method !== 'ring';
    }
    return true;
  });

  if (features.length === 0) {
    ctx.fillStyle = '#333';
    ctx.font = '16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No settlements to display', canvas.width / 2, canvas.height / 2);
    return;
  }

  // STEP 2: Freeze transform bounds ONCE per render (from map_bounds.json)
  const worldBounds = {
    minX: mapBounds.min_x,
    minY: mapBounds.min_y,
    maxX: mapBounds.max_x,
    maxY: mapBounds.max_y
  };

  // Bounds change detector
  const frozenKey = `${worldBounds.minX},${worldBounds.minY},${worldBounds.maxX},${worldBounds.maxY}`;
  if (window.__lastFrozenKey && window.__lastFrozenKey !== frozenKey) {
    console.warn("Bounds changed across renders (expected only if data/bounds file changed):", window.__lastFrozenKey, "->", frozenKey);
  }
  window.__lastFrozenKey = frozenKey;

  // Compute zoom/pan from frozen bounds
  const padding = 20;
  const scaleX = (canvas.width - padding * 2) / (worldBounds.maxX - worldBounds.minX);
  const scaleY = (canvas.height - padding * 2) / (worldBounds.maxY - worldBounds.minY);
  const zoom = Math.min(scaleX, scaleY);
  const panX = 0; // No pan for now
  const panY = 0;
  const flipY = flipYCheckbox.checked;

  // STEP 3: Create transform factory (frozen, never reads diagnostics)
  const { tx, ty } = makeTransform(canvas, worldBounds, zoom, panX, panY, flipY);

  // STEP 4: Separate diagnostics (never feeds into tx/ty)
  const diag = {
    minWX: +Infinity, minWY: +Infinity,
    maxWX: -Infinity, maxWY: -Infinity,
    minSX: +Infinity, minSY: +Infinity,
    maxSX: -Infinity, maxSY: -Infinity,
    nan: 0
  };

  // Drawing counters
  let featuresLoaded = features.length;
  let ringsDrawn = 0;
  let verticesDrawn = 0;
  let moveToCount = 0;
  let ringCount = 0;
  let firstFeatureId = null;

  const maxRings = parseInt(maxRingsInput.value) || 500;

  // STEP 6: One-time ring sample dump
  if (!window.__dumpedFirstRing && features.length > 0) {
    window.__dumpedFirstRing = true;
    const f0 = features[0];
    const r0 = [...iterRings(f0)][0];
    if (r0 && r0.length > 0) {
      console.log("FIRST RING SAMPLE (world):", r0.slice(0, 10));
    }
  }

  // STEP 5: Draw loop with frozen transform
  for (let featureIdx = 0; featureIdx < features.length; featureIdx++) {
    const feature = features[featureIdx];
    
    if (firstFeatureId === null) {
      firstFeatureId = feature.properties.sid || feature.properties.mid || feature.id || `feature_${featureIdx}`;
    }

    // Get metadata for styling
    const sid = feature.properties.sid;
    const meta = settlementsMeta.find(m => m.sid === sid);
    const method = feature.properties.geometry_method;

    // Determine style
    let fillStyle = 'rgba(120, 160, 200, 0.35)';
    let strokeStyle = 'rgba(0, 0, 0, 0.5)';
    let lineWidth = 1;

    if (method === 'convex_hull_salvage') {
      fillStyle = 'rgba(120, 160, 200, 0.2)';
      strokeStyle = 'rgba(100, 100, 200, 0.6)';
    } else if (method === 'convex_hull_salvage_high_inflation') {
      fillStyle = 'rgba(200, 100, 100, 0.2)';
      strokeStyle = 'rgba(200, 50, 50, 0.8)';
      lineWidth = 2;
    } else if (method === 'ring_simplified_salvage') {
      fillStyle = 'rgba(160, 200, 120, 0.3)';
      strokeStyle = 'rgba(100, 150, 100, 0.5)';
    }

    // Iterate over rings for this feature
    for (const ring of iterRings(feature)) {
      if (ringsDrawn >= maxRings) break;
      
      if (!ring || ring.length < 3) continue;
      
      ringCount++;
      
      // CRITICAL: beginPath INSIDE the ring loop
      ctx.beginPath();
      
      // Get first vertex
      const p0 = ring[0];
      if (!p0 || p0.length < 2) continue;
      
      const wx0 = p0[0];
      const wy0 = p0[1];
      
      // Transform using frozen tx/ty
      const sx0 = tx(wx0);
      const sy0 = ty(wy0);
      
      // Track diagnostics (separate from transform)
      diagPoint(wx0, wy0, sx0, sy0, diag);
      
      if (diag.nan > 0 && diag.nan <= 1) {
        // Only log first NaN to avoid spam
        console.error(`NaN vertex detected: feature ${featureIdx}, ring ${ringCount}, vertex 0: [${wx0}, ${wy0}]`);
      }
      
      // moveTo first vertex
      ctx.moveTo(sx0, sy0);
      moveToCount++;
      verticesDrawn++;
      
      // lineTo rest of vertices
      for (let i = 1; i < ring.length; i++) {
        const p = ring[i];
        if (!p || p.length < 2) continue;
        
        const wx = p[0];
        const wy = p[1];
        
        // Transform using frozen tx/ty
        const sx = tx(wx);
        const sy = ty(wy);
        
        // Track diagnostics (separate from transform)
        diagPoint(wx, wy, sx, sy, diag);
        
        if (diag.nan > 0 && diag.nan <= 1) {
          console.error(`NaN vertex detected: feature ${featureIdx}, ring ${ringCount}, vertex ${i}: [${wx}, ${wy}]`);
        }
        
        ctx.lineTo(sx, sy);
        verticesDrawn++;
      }
      
      // closePath and stroke
      ctx.closePath();
      ctx.fillStyle = fillStyle;
      ctx.fill();
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
      
      ringsDrawn++;
    }
    
    if (ringsDrawn >= maxRings) break;
  }

  // Fan-lines detector
  let fanLinesDetected = false;
  if (moveToCount < ringCount) {
    fanLinesDetected = true;
    console.error('APPEND_MISTAKE: Viewer connected polygons into one path');
    console.error(`moveToCount (${moveToCount}) < ringCount (${ringCount}) - polygons are being connected!`);
    
    // Show warning on canvas
    ctx.save();
    ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
    ctx.font = 'bold 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('WARNING: moveTo < ringCount (polygons are being connected)', canvas.width / 2, 50);
    ctx.restore();
  }

  // STEP 7: Nonlinear transform detector
  let transformCollapsed = false;
  const screenSpanX = diag.maxSX - diag.minSX;
  const screenSpanY = diag.maxSY - diag.minSY;
  if (screenSpanX < 5 || screenSpanY < 5) {
    transformCollapsed = true;
    console.warn('WARNING: screen span collapsed, transform likely wrong');
    console.warn(`Screen span: X=${screenSpanX.toFixed(2)}, Y=${screenSpanY.toFixed(2)}`);
    console.log('APPEND_MISTAKE: Viewer transform used mutable bounds');
  }

  // Draw diagnostics overlay (top-left)
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillRect(10, 10, 450, 240);
  ctx.fillStyle = '#fff';
  ctx.font = '12px monospace';
  ctx.textAlign = 'left';
  let y = 30;
  ctx.fillText(`Features loaded: ${featuresLoaded}`, 20, y); y += 20;
  ctx.fillText(`Rings drawn: ${ringsDrawn}`, 20, y); y += 20;
  ctx.fillText(`Vertices drawn: ${verticesDrawn}`, 20, y); y += 20;
  ctx.fillText(`moveTo calls: ${moveToCount}`, 20, y); y += 20;
  ctx.fillText(`World: [${diag.minWX.toFixed(2)}, ${diag.minWY.toFixed(2)}] to [${diag.maxWX.toFixed(2)}, ${diag.maxWY.toFixed(2)}]`, 20, y); y += 20;
  ctx.fillText(`Screen: [${diag.minSX.toFixed(0)}, ${diag.minSY.toFixed(0)}] to [${diag.maxSX.toFixed(0)}, ${diag.maxSY.toFixed(0)}]`, 20, y); y += 20;
  ctx.fillText(`NaN vertices: ${diag.nan}`, 20, y); y += 20;
  ctx.fillText(`First feature: ${firstFeatureId || 'none'}`, 20, y); y += 20;
  ctx.fillText(`Screen span: X=${screenSpanX.toFixed(1)}, Y=${screenSpanY.toFixed(1)}`, 20, y); y += 20;
  if (fanLinesDetected) {
    ctx.fillStyle = '#ff0000';
    ctx.fillText(`FAN-LINES DETECTED!`, 20, y); y += 20;
  }
  if (transformCollapsed) {
    ctx.fillStyle = '#ff0000';
    ctx.fillText(`TRANSFORM COLLAPSED!`, 20, y);
  }
  ctx.restore();
}

loadData();
