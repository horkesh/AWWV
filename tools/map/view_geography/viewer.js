/**
 * Canvas-based GeoJSON viewer for unified geography
 * Offline, no external dependencies
 */

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const warningEl = document.getElementById('warning');
const errorEl = document.getElementById('error');
const legendSettlements = document.getElementById('legendSettlements');
const legendMunicipalities = document.getElementById('legendMunicipalities');
const legendUnknown = document.getElementById('legendUnknown');

let geojson = null;
let bounds = null;
let transform = { scale: 1, tx: 0, ty: 0 };
let features = [];
let layerCounts = { settlement: 0, municipality: 0, unknown: 0 };
let allPropertyKeys = new Set();

// Layer type classification
function classifyLayerType(feature) {
  const props = feature.properties || {};
  
  // Rule 1: explicit layer property
  if (props.layer === 'settlement' || props.layer === 'municipality') {
    return props.layer;
  }
  
  // Rule 2: kind property (case-insensitive)
  if (props.kind) {
    const kindLower = String(props.kind).toLowerCase();
    if (kindLower === 'settlement') return 'settlement';
    if (kindLower === 'municipality') return 'municipality';
  }
  
  // Rule 3: feature_type or level (for compatibility with existing data)
  if (props.feature_type === 'settlement' || props.level === 'settlement') {
    return 'settlement';
  }
  if (props.feature_type === 'municipality' || props.level === 'municipality') {
    return 'municipality';
  }
  
  // Default: unknown
  return 'unknown';
}

// Collect property keys for diagnostics
function collectPropertyKeys(feature) {
  if (feature.properties) {
    Object.keys(feature.properties).forEach(key => allPropertyKeys.add(key));
  }
}

// Compute bounding box from all coordinates
function computeBounds(geojson) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  function visitPoint(coord) {
    const x = coord[0], y = coord[1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  
  geojson.features.forEach(feature => {
    const geom = feature.geometry;
    if (!geom || !geom.coordinates) return;
    
    if (geom.type === 'Point') {
      visitPoint(geom.coordinates);
    } else if (geom.type === 'LineString') {
      geom.coordinates.forEach(visitPoint);
    } else if (geom.type === 'Polygon') {
      geom.coordinates.forEach(ring => ring.forEach(visitPoint));
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates.forEach(poly => poly.forEach(ring => ring.forEach(visitPoint)));
    }
  });
  
  return { minX, minY, maxX, maxY };
}

// Fit bounds to canvas with padding
function fitToCanvas() {
  if (!bounds) return;
  
  const padding = 20;
  const width = canvas.width - padding * 2;
  const height = canvas.height - padding * 2;
  const bboxWidth = bounds.maxX - bounds.minX;
  const bboxHeight = bounds.maxY - bounds.minY;
  
  if (bboxWidth <= 0 || bboxHeight <= 0) {
    transform.scale = 1;
    transform.tx = padding;
    transform.ty = padding;
    return;
  }
  
  const scaleX = width / bboxWidth;
  const scaleY = height / bboxHeight;
  transform.scale = Math.min(scaleX, scaleY);
  
  // Center with padding
  const scaledWidth = bboxWidth * transform.scale;
  const scaledHeight = bboxHeight * transform.scale;
  transform.tx = padding + (width - scaledWidth) / 2 - bounds.minX * transform.scale;
  transform.ty = padding + (height - scaledHeight) / 2 - bounds.minY * transform.scale;
}

// Transform world coordinates to screen
function worldToScreen(x, y) {
  return [
    x * transform.scale + transform.tx,
    y * transform.scale + transform.ty
  ];
}

// Draw a polygon ring
function drawRing(ring) {
  if (ring.length === 0) return;
  const [firstX, firstY] = worldToScreen(ring[0][0], ring[0][1]);
  ctx.moveTo(firstX, firstY);
  for (let i = 1; i < ring.length; i++) {
    const [x, y] = worldToScreen(ring[i][0], ring[i][1]);
    ctx.lineTo(x, y);
  }
}

// Draw a feature
function drawFeature(feature) {
  const layerType = feature.layerType;
  const showSettlements = document.getElementById('showSettlements').checked;
  const showMunicipalities = document.getElementById('showMunicipalities').checked;
  const showUnknown = document.getElementById('showUnknown').checked;
  
  // Skip if layer is hidden
  if (layerType === 'settlement' && !showSettlements) return;
  if (layerType === 'municipality' && !showMunicipalities) return;
  if (layerType === 'unknown' && !showUnknown) return;
  
  const geom = feature.geometry;
  if (!geom || !geom.coordinates) return;
  
  ctx.beginPath();
  
  if (geom.type === 'Polygon') {
    drawRing(geom.coordinates[0]); // Exterior ring
    ctx.closePath();
  } else if (geom.type === 'MultiPolygon') {
    geom.coordinates.forEach(poly => {
      if (poly.length > 0) {
        drawRing(poly[0]); // Exterior ring of each polygon
        ctx.closePath();
      }
    });
  }
  
  // Set stroke style based on layer type
  if (layerType === 'municipality') {
    ctx.lineWidth = 2;
  } else if (layerType === 'settlement') {
    ctx.lineWidth = 1;
  } else {
    ctx.lineWidth = 1;
  }
  
  ctx.strokeStyle = '#000000';
  ctx.stroke();
}

// Main draw function
function draw() {
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw all features in sorted order
  features.forEach(feature => {
    drawFeature(feature);
  });
}

// Resize canvas to container
function resizeCanvas() {
  const container = document.getElementById('canvas-container');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;
  fitToCanvas();
  draw();
}

// Load and process GeoJSON
async function loadGeoJSON() {
  try {
    const response = await fetch('/data');
    if (!response.ok) {
      if (response.status === 404) {
        const errorData = await response.json();
        errorEl.textContent = `GeoJSON file not found. Expected paths: ${errorData.expected?.join(', ') || 'unknown'}`;
        errorEl.classList.add('show');
        return;
      }
      throw new Error(`HTTP ${response.status}`);
    }
    
    geojson = await response.json();
    
    if (!geojson.features || geojson.features.length === 0) {
      errorEl.textContent = 'GeoJSON has no features';
      errorEl.classList.add('show');
      return;
    }
    
    // Classify and process features
    features = geojson.features.map((feature, index) => {
      collectPropertyKeys(feature);
      const layerType = classifyLayerType(feature);
      layerCounts[layerType]++;
      
      // Extract stable sort keys
      const props = feature.properties || {};
      const municipalityId = props.municipality_id || props.mid || props.mun_id || '';
      const settlementId = props.settlement_id || props.sid || '';
      
      return {
        ...feature,
        layerType,
        sortKey: {
          layerTypeOrder: layerType === 'municipality' ? 0 : layerType === 'settlement' ? 1 : 2,
          municipalityId: String(municipalityId),
          settlementId: String(settlementId),
          index
        }
      };
    });
    
    // Stable sort: municipality first, then settlement, then unknown
    // Within each layer, sort by municipality_id, then settlement_id, then original index
    features.sort((a, b) => {
      const ka = a.sortKey;
      const kb = b.sortKey;
      if (ka.layerTypeOrder !== kb.layerTypeOrder) {
        return ka.layerTypeOrder - kb.layerTypeOrder;
      }
      if (ka.municipalityId !== kb.municipalityId) {
        return ka.municipalityId.localeCompare(kb.municipalityId);
      }
      if (ka.settlementId !== kb.settlementId) {
        return ka.settlementId.localeCompare(kb.settlementId);
      }
      return ka.index - kb.index;
    });
    
    // Compute bounds
    bounds = computeBounds(geojson);
    
    // Update legend
    legendSettlements.textContent = `Settlements: ${layerCounts.settlement}`;
    legendMunicipalities.textContent = `Municipalities: ${layerCounts.municipality}`;
    legendUnknown.textContent = `Unknown: ${layerCounts.unknown}`;
    
    // Show warning if unknowns exist
    if (layerCounts.unknown > 0) {
      warningEl.textContent = `${layerCounts.unknown} features could not be classified as settlement or municipality; showing only if 'Show unknown' is enabled.`;
      warningEl.classList.add('show');
    }
    
    // Console diagnostics
    const sortedKeys = Array.from(allPropertyKeys).sort();
    console.log('First 30 distinct property keys:', sortedKeys.slice(0, 30));
    console.log('Layer counts:', layerCounts);
    
    // Resize and draw
    resizeCanvas();
    
  } catch (err) {
    errorEl.textContent = `Error loading GeoJSON: ${err.message}`;
    errorEl.classList.add('show');
    console.error('Error loading GeoJSON:', err);
  }
}

// Event listeners
document.getElementById('showSettlements').addEventListener('change', draw);
document.getElementById('showMunicipalities').addEventListener('change', draw);
document.getElementById('showUnknown').addEventListener('change', draw);

window.addEventListener('resize', resizeCanvas);

// Initialize
loadGeoJSON();
