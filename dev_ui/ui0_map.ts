/**
 * UI-0.1: Map Substrate Viewer (Read-only, Outlines-first)
 * 
 * Read-only viewer for settlement polygon outlines.
 * No engine changes, no state modification, no disk writes.
 */

// Types
interface FeatureRecord {
  sid: string;
  geomType: 'Polygon' | 'MultiPolygon';
  coords: any; // Use any to avoid TS typing issues with sanitized coords
  rawBounds: { minX: number; minY: number; maxX: number; maxY: number };
  ringCount: number;
  outerVertices: number;
  centroidX: number;
  centroidY: number;
  // Regime classification (diagnostic, computed after clustering)
  clusterLabel?: 'MAIN' | 'STRAY';
  scaleLabel?: 'TINY' | 'SMALL' | 'NORMAL' | 'HUGE';
  shapeLabel?: 'SKINNY' | 'OK';
  locationLabel?: 'INSIDE_MAIN_BOUNDS' | 'OUTSIDE_MAIN_BOUNDS';
  suspect?: boolean;
  severity?: number;
}

// State
interface ViewState {
  features: FeatureRecord[];
  selectedSid: string | null;
  zoom: number;
  panX: number;
  panY: number;
  baseScale: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  showFills: boolean;
  droppedPoints: number;
  droppedRings: number;
  skippedFeatures: number;
  hideOutliers: boolean;
  outlierThresholdK: number;
  outliers: Set<string>;
  outlierRanked: Array<{ sid: string; d: number; cx: number; cy: number }>;
  inlierCount: number;
  outlierCount: number;
  clusterModeEnabled: boolean;
  hideStrayCluster: boolean;
  clusterA: Set<string>;
  clusterB: Set<string>;
  strayCluster: 'A' | 'B' | null;
  clusterStats: {
    A: { count: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } };
    B: { count: number; bounds: { minX: number; minY: number; maxX: number; maxY: number } };
  };
  straySidsSorted: string[];
  mainSidsSorted: string[];
  highlightSuspects: boolean;
  searchQuery: string;
  searchMatches: string[];
  regimeStats: {
    scaleCounts: { TINY: number; SMALL: number; NORMAL: number; HUGE: number };
    shapeCounts: { SKINNY: number; OK: number };
    locationCounts: { INSIDE_MAIN_BOUNDS: number; OUTSIDE_MAIN_BOUNDS: number };
    suspectCount: number;
  };
}

const state: ViewState = {
  features: [],
  selectedSid: null,
  zoom: 1,
  panX: 0,
  panY: 0,
  baseScale: 1,
  minX: 0,
  minY: 0,
  maxX: 0,
  maxY: 0,
  showFills: false,
  droppedPoints: 0,
  droppedRings: 0,
  skippedFeatures: 0,
  hideOutliers: false,
  outlierThresholdK: 8,
  outliers: new Set<string>(),
  outlierRanked: [],
  inlierCount: 0,
  outlierCount: 0,
  clusterModeEnabled: false, // Disabled for clean view - show all settlements
  hideStrayCluster: false,
  clusterA: new Set<string>(),
  clusterB: new Set<string>(),
  strayCluster: null,
  clusterStats: {
    A: { count: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
    B: { count: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
  },
  straySidsSorted: [],
  mainSidsSorted: [],
  highlightSuspects: true,
  searchQuery: '',
  searchMatches: [],
  regimeStats: {
    scaleCounts: { TINY: 0, SMALL: 0, NORMAL: 0, HUGE: 0 },
    shapeCounts: { SKINNY: 0, OK: 0 },
    locationCounts: { INSIDE_MAIN_BOUNDS: 0, OUTSIDE_MAIN_BOUNDS: 0 },
    suspectCount: 0
  }
};

// DOM elements
const canvas = document.getElementById('map') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const fitToViewBtn = document.getElementById('fit-to-view') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const showFillsCheckbox = document.getElementById('show-fills') as HTMLInputElement;
const zoomReadout = document.getElementById('zoom-readout') as HTMLDivElement;
const statusInfo = document.getElementById('status-info') as HTMLDivElement;
const selectionInfo = document.getElementById('selection-info') as HTMLDivElement;

// Interaction state
let isPanning = false;
let panStartX = 0;
let panStartY = 0;
let panStartPanX = 0;
let panStartPanY = 0;
let spacePressed = false;

// Helper: Convert value to finite number or null
function toFiniteNumber(v: any): number | null {
  if (typeof v === 'number') {
    return isFinite(v) ? v : null;
  }
  if (typeof v === 'string') {
    const num = parseFloat(v);
    return isFinite(num) ? num : null;
  }
  return null;
}

// Helper: Sanitize a ring, keeping only valid finite points
function sanitizeRing(ringRaw: any[]): [number, number][] {
  const valid: [number, number][] = [];
  for (const point of ringRaw) {
    if (!Array.isArray(point) || point.length < 2) {
      state.droppedPoints++;
      continue;
    }
    const x = toFiniteNumber(point[0]);
    const y = toFiniteNumber(point[1]);
    if (x !== null && y !== null) {
      valid.push([x, y]);
    } else {
      state.droppedPoints++;
    }
  }
  return valid;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function computeCentroidForFeature(geomType: 'Polygon' | 'MultiPolygon', coords: any): { cx: number; cy: number } {
  // Deterministic, simple centroid: average of points in outer rings.
  let sumX = 0;
  let sumY = 0;
  let n = 0;

  if (geomType === 'Polygon') {
    const rings = coords as [number, number][][];
    const outer = rings[0] ?? [];
    for (const [x, y] of outer) {
      sumX += x;
      sumY += y;
      n++;
    }
  } else {
    const polys = coords as [number, number][][][];
    for (const poly of polys) {
      const outer = poly[0] ?? [];
      for (const [x, y] of outer) {
        sumX += x;
        sumY += y;
        n++;
      }
    }
  }

  if (n === 0) return { cx: 0, cy: 0 };
  return { cx: sumX / n, cy: sumY / n };
}

function recomputeOutliers(features: FeatureRecord[]) {
  const cxList = features.map(f => f.centroidX);
  const cyList = features.map(f => f.centroidY);
  const medX = median(cxList);
  const medY = median(cyList);

  const dList = features.map(f => Math.hypot(f.centroidX - medX, f.centroidY - medY));
  const medianD = median(dList);
  const absDev = dList.map(d => Math.abs(d - medianD));
  const mad = median(absDev);

  const outliers = new Set<string>();
  const ranked: Array<{ sid: string; d: number; cx: number; cy: number }> = [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const d = dList[i];
    const robustOutlier = mad === 0 ? d > medianD : d > (medianD + state.outlierThresholdK * mad);
    const simpleOutlier = medianD > 0 ? d > (3 * medianD) : false;
    const isOutlier = robustOutlier || simpleOutlier;
    if (isOutlier) {
      outliers.add(f.sid);
      ranked.push({ sid: f.sid, d, cx: f.centroidX, cy: f.centroidY });
    }
  }

  ranked.sort((a, b) => {
    if (b.d !== a.d) return b.d - a.d;
    return a.sid.localeCompare(b.sid);
  });

  state.outliers = outliers;
  state.outlierRanked = ranked;
  state.outlierCount = outliers.size;
  state.inlierCount = features.length - outliers.size;
}

// Deterministic 2-means clustering
function computeClusters(features: FeatureRecord[]): { clusterA: Set<string>; clusterB: Set<string> } {
  if (features.length < 2) {
    const clusterA = new Set<string>();
    const clusterB = new Set<string>();
    if (features.length === 1) clusterA.add(features[0].sid);
    return { clusterA, clusterB };
  }

  // Deterministic seed selection: farthest pair
  // Seed1: minimum (centroidX + centroidY), tie-break by sid asc
  let seed1Idx = 0;
  let minSum = features[0].centroidX + features[0].centroidY;
  for (let i = 1; i < features.length; i++) {
    const sum = features[i].centroidX + features[i].centroidY;
    if (sum < minSum || (sum === minSum && features[i].sid.localeCompare(features[seed1Idx].sid) < 0)) {
      minSum = sum;
      seed1Idx = i;
    }
  }

  // Seed2: maximum squared distance from seed1, tie-break by sid asc
  const seed1 = features[seed1Idx];
  let seed2Idx = 0;
  let maxDistSq = 0;
  for (let i = 0; i < features.length; i++) {
    if (i === seed1Idx) continue;
    const dx = features[i].centroidX - seed1.centroidX;
    const dy = features[i].centroidY - seed1.centroidY;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxDistSq || (distSq === maxDistSq && features[i].sid.localeCompare(features[seed2Idx].sid) < 0)) {
      maxDistSq = distSq;
      seed2Idx = i;
    }
  }

  // Initialize means
  let meanA = { x: seed1.centroidX, y: seed1.centroidY };
  let meanB = { x: features[seed2Idx].centroidX, y: features[seed2Idx].centroidY };

  // Fixed 10 iterations
  let clusterA = new Set<string>();
  let clusterB = new Set<string>();

  for (let iter = 0; iter < 10; iter++) {
    clusterA.clear();
    clusterB.clear();

    // Assign each feature to nearest mean (tie-break: assign to A)
    for (const f of features) {
      const dxA = f.centroidX - meanA.x;
      const dyA = f.centroidY - meanA.y;
      const distSqA = dxA * dxA + dyA * dyA;

      const dxB = f.centroidX - meanB.x;
      const dyB = f.centroidY - meanB.y;
      const distSqB = dxB * dxB + dyB * dyB;

      if (distSqA <= distSqB) {
        clusterA.add(f.sid);
      } else {
        clusterB.add(f.sid);
      }
    }

    // Recompute means (if cluster empty, keep previous mean)
    let sumAX = 0, sumAY = 0, countA = 0;
    let sumBX = 0, sumBY = 0, countB = 0;

    for (const f of features) {
      if (clusterA.has(f.sid)) {
        sumAX += f.centroidX;
        sumAY += f.centroidY;
        countA++;
      } else {
        sumBX += f.centroidX;
        sumBY += f.centroidY;
        countB++;
      }
    }

    if (countA > 0) {
      meanA = { x: sumAX / countA, y: sumAY / countA };
    }
    if (countB > 0) {
      meanB = { x: sumBX / countB, y: sumBY / countB };
    }
  }

  return { clusterA, clusterB };
}

function computeClusterBounds(features: FeatureRecord[], clusterSet: Set<string>): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;

  for (const f of features) {
    if (clusterSet.has(f.sid)) {
      found = true;
      minX = Math.min(minX, f.rawBounds.minX);
      minY = Math.min(minY, f.rawBounds.minY);
      maxX = Math.max(maxX, f.rawBounds.maxX);
      maxY = Math.max(maxY, f.rawBounds.maxY);
    }
  }

  if (!found) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  return { minX, minY, maxX, maxY };
}

function recomputeClusters(features: FeatureRecord[]) {
  if (!state.clusterModeEnabled || features.length < 2) {
    state.clusterA.clear();
    state.clusterB.clear();
    state.strayCluster = null;
    state.clusterStats = {
      A: { count: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } },
      B: { count: 0, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }
    };
    state.straySidsSorted = [];
    state.mainSidsSorted = [];
    return;
  }

  const { clusterA, clusterB } = computeClusters(features);
  state.clusterA = clusterA;
  state.clusterB = clusterB;

  // Compute bounds for each cluster
  const boundsA = computeClusterBounds(features, clusterA);
  const boundsB = computeClusterBounds(features, clusterB);
  const areaA = (boundsA.maxX - boundsA.minX) * (boundsA.maxY - boundsA.minY);
  const areaB = (boundsB.maxX - boundsB.minX) * (boundsB.maxY - boundsB.minY);

  // Determine main vs stray: larger count wins, tie-break by larger area, then A
  let mainCluster: 'A' | 'B';
  let strayCluster: 'A' | 'B';
  
  if (clusterA.size > clusterB.size) {
    mainCluster = 'A';
    strayCluster = 'B';
  } else if (clusterB.size > clusterA.size) {
    mainCluster = 'B';
    strayCluster = 'A';
  } else {
    // Equal count, use area
    if (areaA > areaB) {
      mainCluster = 'A';
      strayCluster = 'B';
    } else if (areaB > areaA) {
      mainCluster = 'B';
      strayCluster = 'A';
    } else {
      // Still equal, default to A as main
      mainCluster = 'A';
      strayCluster = 'B';
    }
  }

  state.strayCluster = strayCluster;
  state.clusterStats = {
    A: { count: clusterA.size, bounds: boundsA },
    B: { count: clusterB.size, bounds: boundsB }
  };

  // Sort SIDs deterministically
  const straySet = strayCluster === 'A' ? clusterA : clusterB;
  const mainSet = mainCluster === 'A' ? clusterA : clusterB;
  
  state.straySidsSorted = features
    .filter(f => straySet.has(f.sid))
    .map(f => f.sid)
    .sort((a, b) => a.localeCompare(b));
  
  state.mainSidsSorted = features
    .filter(f => mainSet.has(f.sid))
    .map(f => f.sid)
    .sort((a, b) => a.localeCompare(b));
}

// Regime classification constants (deterministic thresholds)
const SCALE_TINY_THRESHOLD = 1000;  // A < medianA / 1000
const SCALE_SMALL_THRESHOLD = 100;  // A < medianA / 100
const SCALE_HUGE_THRESHOLD = 100;   // A > medianA * 100
const SHAPE_SKINNY_THRESHOLD = 50;  // aspect ratio > 50
const LOCATION_PADDING = 0.1;       // 10% padding for main bounds check

function computeRegimeClassification(features: FeatureRecord[]) {
  if (features.length === 0) {
    console.warn('computeRegimeClassification: No features provided');
    return;
  }

  // Get main cluster features for reference stats
  const mainFeatures = getMainClusterFeatures();
  if (mainFeatures.length === 0) {
    console.warn('computeRegimeClassification: No main features found');
    return;
  }
  
  console.log(`computeRegimeClassification: Processing ${features.length} features, ${mainFeatures.length} main features, strayCluster=${state.strayCluster}`);

  // Compute main cluster bounds (either from cluster stats or from main features directly)
  let mainBounds: { minX: number; minY: number; maxX: number; maxY: number };
  if (state.strayCluster !== null) {
    // Use cluster stats if stray cluster exists
    mainBounds = state.clusterStats[state.strayCluster === 'A' ? 'B' : 'A'].bounds;
  } else {
    // Compute bounds from all features if no stray cluster
    mainBounds = computeBounds(mainFeatures);
  }

  const mainAreas: number[] = [];
  const mainWidths: number[] = [];
  const mainHeights: number[] = [];

  for (const f of mainFeatures) {
    const w = f.rawBounds.maxX - f.rawBounds.minX;
    const h = f.rawBounds.maxY - f.rawBounds.minY;
    const A = w * h;
    mainAreas.push(A);
    mainWidths.push(w);
    mainHeights.push(h);
  }

  const medianA = median(mainAreas);
  const medianW = median(mainWidths);
  const medianH = median(mainHeights);

  // Expand main bounds by padding
  let boundsW = mainBounds.maxX - mainBounds.minX;
  let boundsH = mainBounds.maxY - mainBounds.minY;
  
  // Handle edge case where bounds might be invalid
  if (!isFinite(boundsW) || !isFinite(boundsH) || boundsW <= 0 || boundsH <= 0) {
    console.warn('computeRegimeClassification: Invalid bounds, using feature bounds directly');
    // Use overall bounds as fallback
    mainBounds = computeBounds(features);
    boundsW = mainBounds.maxX - mainBounds.minX;
    boundsH = mainBounds.maxY - mainBounds.minY;
  }
  
  const expandedMinX = mainBounds.minX - (boundsW > 0 ? boundsW * LOCATION_PADDING : 0);
  const expandedMinY = mainBounds.minY - (boundsH > 0 ? boundsH * LOCATION_PADDING : 0);
  const expandedMaxX = mainBounds.maxX + (boundsW > 0 ? boundsW * LOCATION_PADDING : 0);
  const expandedMaxY = mainBounds.maxY + (boundsH > 0 ? boundsH * LOCATION_PADDING : 0);

  // Classify each feature
  const scaleCounts = { TINY: 0, SMALL: 0, NORMAL: 0, HUGE: 0 };
  const shapeCounts = { SKINNY: 0, OK: 0 };
  const locationCounts = { INSIDE_MAIN_BOUNDS: 0, OUTSIDE_MAIN_BOUNDS: 0 };
  let suspectCount = 0;

  for (const f of features) {
    // Cluster label
    const clusterLabel: 'MAIN' | 'STRAY' = 
      (state.strayCluster !== null && 
       (state.strayCluster === 'A' ? state.clusterA : state.clusterB).has(f.sid))
      ? 'STRAY' : 'MAIN';

    // Compute feature dimensions
    const w = f.rawBounds.maxX - f.rawBounds.minX;
    const h = f.rawBounds.maxY - f.rawBounds.minY;
    const A = w * h;
    const aspectRatio = (w === 0 || h === 0) ? 0 : Math.max(w / h, h / w);

    // Scale label
    let scaleLabel: 'TINY' | 'SMALL' | 'NORMAL' | 'HUGE';
    if (medianA === 0) {
      scaleLabel = 'NORMAL';
    } else if (A < medianA / SCALE_TINY_THRESHOLD) {
      scaleLabel = 'TINY';
    } else if (A < medianA / SCALE_SMALL_THRESHOLD) {
      scaleLabel = 'SMALL';
    } else if (A > medianA * SCALE_HUGE_THRESHOLD) {
      scaleLabel = 'HUGE';
    } else {
      scaleLabel = 'NORMAL';
    }

    // Shape label
    const shapeLabel: 'SKINNY' | 'OK' = aspectRatio > SHAPE_SKINNY_THRESHOLD ? 'SKINNY' : 'OK';

    // Location label
    const locationLabel: 'INSIDE_MAIN_BOUNDS' | 'OUTSIDE_MAIN_BOUNDS' =
      (f.centroidX >= expandedMinX && f.centroidX <= expandedMaxX &&
       f.centroidY >= expandedMinY && f.centroidY <= expandedMaxY)
      ? 'INSIDE_MAIN_BOUNDS' : 'OUTSIDE_MAIN_BOUNDS';

    // Suspect detection
    const suspect = 
      clusterLabel === 'STRAY' ||
      scaleLabel === 'TINY' ||
      scaleLabel === 'HUGE' ||
      shapeLabel === 'SKINNY' ||
      locationLabel === 'OUTSIDE_MAIN_BOUNDS';

    // Severity score (deterministic)
    let severity = 0;
    if (clusterLabel === 'STRAY') severity += 1000;
    if (scaleLabel === 'HUGE') severity += 100;
    if (scaleLabel === 'TINY') severity += 80;
    if (scaleLabel === 'SMALL') severity += 20;
    if (shapeLabel === 'SKINNY') severity += 50;
    if (locationLabel === 'OUTSIDE_MAIN_BOUNDS') severity += 40;

    // Assign to feature
    (f as any).clusterLabel = clusterLabel;
    (f as any).scaleLabel = scaleLabel;
    (f as any).shapeLabel = shapeLabel;
    (f as any).locationLabel = locationLabel;
    (f as any).suspect = suspect;
    (f as any).severity = severity;

    // Update counts
    scaleCounts[scaleLabel]++;
    shapeCounts[shapeLabel]++;
    locationCounts[locationLabel]++;
    if (suspect) suspectCount++;
  }

  state.regimeStats = {
    scaleCounts,
    shapeCounts,
    locationCounts,
    suspectCount
  };
}

function getRenderableFeatures(): FeatureRecord[] {
  let features = state.features;
  
  // Filter by outliers if enabled - DISABLED for clean view
  // All settlements are shown without outlier filtering
  // if (state.hideOutliers) {
  //   features = features.filter(f => !state.outliers.has(f.sid));
  // }
  
  // Filter by stray cluster if enabled - DISABLED for clean view
  // All settlements are shown without cluster filtering
  // if (state.clusterModeEnabled && state.hideStrayCluster && state.strayCluster !== null) {
  //   const straySet = state.strayCluster === 'A' ? state.clusterA : state.clusterB;
  //   features = features.filter(f => !straySet.has(f.sid));
  // }
  
  return features;
}

function getMainClusterFeatures(): FeatureRecord[] {
  if (!state.clusterModeEnabled || state.strayCluster === null) {
    return state.features;
  }
  const mainSet = state.strayCluster === 'A' ? state.clusterB : state.clusterA;
  return state.features.filter(f => mainSet.has(f.sid));
}

function getStrayClusterFeatures(): FeatureRecord[] {
  if (!state.clusterModeEnabled || state.strayCluster === null) {
    return [];
  }
  const straySet = state.strayCluster === 'A' ? state.clusterA : state.clusterB;
  return state.features.filter(f => straySet.has(f.sid));
}

function panToFeatureSid(sid: string) {
  const f = state.features.find(ff => ff.sid === sid);
  if (!f) return;
  const [sx, sy] = project(f.centroidX, f.centroidY);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  state.panX += (cx - sx);
  state.panY += (cy - sy);
}

function jumpToSid(sid: string) {
  const f = state.features.find(ff => ff.sid === sid);
  if (!f) return;

  // Auto-disable hiding if feature is hidden
  if (state.hideOutliers && state.outliers.has(sid)) {
    state.hideOutliers = false;
    const cb = document.getElementById('hide-outliers') as HTMLInputElement | null;
    if (cb) cb.checked = false;
  }

  if (state.clusterModeEnabled && state.hideStrayCluster && state.strayCluster !== null) {
    const straySet = state.strayCluster === 'A' ? state.clusterA : state.clusterB;
    if (straySet.has(sid)) {
      state.hideStrayCluster = false;
      const cb = document.getElementById('hide-stray-cluster') as HTMLInputElement | null;
      if (cb) cb.checked = false;
    }
  }

  // Select and pan to feature
  state.selectedSid = sid;
  panToFeatureSid(sid);
  fitToView();
  draw();
  updateInspector();
}

function searchSids(query: string): string[] {
  if (!query || query.trim() === '') return [];
  const q = query.trim().toLowerCase();
  const matches: string[] = [];
  
  for (const f of state.features) {
    if (f.sid.toLowerCase().includes(q)) {
      matches.push(f.sid);
    }
  }
  
  // Deterministic sort
  matches.sort((a, b) => a.localeCompare(b));
  return matches.slice(0, 10); // Top 10 matches
}

// Determine GeoJSON URL based on query parameter
// Default: canonical file. Legacy ?regen=1 now also points to canonical (regenerated map is canonical).
function getGeoJSONUrl(): string {
  const urlParams = new URLSearchParams(window.location.search);
  const useRepaired = urlParams.get('repaired') === '1';
  // Legacy ?regen=1 parameter kept for compatibility but now loads canonical
  // (regenerated map has been promoted to canonical)
  return useRepaired 
    ? '/data/derived/settlements_polygons.repaired.geojson'
    : '/data/derived/settlements_polygons.geojson';
}

// Load GeoJSON
async function loadGeoJSON(): Promise<FeatureRecord[]> {
  const geoJsonUrl = getGeoJSONUrl();
  const response = await fetch(geoJsonUrl);
  if (!response.ok) {
    if (response.status === 404) {
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('repaired') === '1') {
        throw new Error('No repaired file found. Run `npm run map:repair` to generate it.');
      }
      throw new Error('Canonical map file not found. Ensure the map pipeline has been run.');
    }
    throw new Error(`Failed to fetch GeoJSON: ${response.status} ${response.statusText}`);
  }
  const geojson: GeoJSON.FeatureCollection = await response.json();
  const features: FeatureRecord[] = [];

  // Reset counters
  state.droppedPoints = 0;
  state.droppedRings = 0;
  state.skippedFeatures = 0;

  for (const feature of geojson.features) {
    const sid = feature.properties?.sid;
    if (!sid) {
      state.skippedFeatures++;
      continue;
    }

    const sidStr = String(sid);
    const geom = feature.geometry;

    if (geom.type === 'Polygon') {
      const coordsRaw = geom.coordinates;
      const rings: [number, number][][] = [];
      
      // Sanitize each ring
      for (const ringRaw of coordsRaw) {
        const sanitized = sanitizeRing(ringRaw);
        if (sanitized.length >= 3) {
          rings.push(sanitized);
        } else {
          state.droppedRings++;
        }
      }

      // Skip feature if no valid rings
      if (rings.length === 0) {
        state.skippedFeatures++;
        continue;
      }

      // Compute bounds from first ring
      const outerRing = rings[0];
      const bounds = computeRingBounds(outerRing);
      const { cx, cy } = computeCentroidForFeature('Polygon', rings);
      
      features.push({
        sid: sidStr,
        geomType: 'Polygon',
        coords: rings,
        rawBounds: bounds,
        ringCount: rings.length,
        outerVertices: outerRing.length,
        centroidX: cx,
        centroidY: cy
      } as FeatureRecord);
    } else if (geom.type === 'MultiPolygon') {
      const coordsRaw = geom.coordinates;
      const polygons: [number, number][][][] = [];
      let maxOuterVertices = 0;
      let totalRings = 0;
      let overallBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

      // Sanitize each polygon
      for (const polygonRaw of coordsRaw) {
        const rings: [number, number][][] = [];
        
        for (const ringRaw of polygonRaw) {
          const sanitized = sanitizeRing(ringRaw);
          if (sanitized.length >= 3) {
            rings.push(sanitized);
            totalRings++;
            const ringBounds = computeRingBounds(sanitized);
            overallBounds.minX = Math.min(overallBounds.minX, ringBounds.minX);
            overallBounds.minY = Math.min(overallBounds.minY, ringBounds.minY);
            overallBounds.maxX = Math.max(overallBounds.maxX, ringBounds.maxX);
            overallBounds.maxY = Math.max(overallBounds.maxY, ringBounds.maxY);
          } else {
            state.droppedRings++;
          }
        }

        // Keep polygon if it has at least one valid ring
        if (rings.length > 0) {
          polygons.push(rings);
          if (rings[0]) {
            maxOuterVertices = Math.max(maxOuterVertices, rings[0].length);
          }
        }
      }

      // Skip feature if no valid polygons
      if (polygons.length === 0) {
        state.skippedFeatures++;
        continue;
      }

      const { cx, cy } = computeCentroidForFeature('MultiPolygon', polygons);
      features.push({
        sid: sidStr,
        geomType: 'MultiPolygon',
        coords: polygons,
        rawBounds: overallBounds,
        ringCount: totalRings,
        outerVertices: maxOuterVertices,
        centroidX: cx,
        centroidY: cy
      } as FeatureRecord);
    }
  }

  // Deterministic sort by sid (string compare ONLY)
  features.sort((a, b) => a.sid.localeCompare(b.sid));

  // Deterministic outlier detection (centroid-based) - DISABLED for clean view
  // All settlements are shown without filtering
  // To re-enable: uncomment the line below and set hideOutliers: true in state
  // recomputeOutliers(features);
  
  // Clear outlier sets to ensure nothing is filtered
  state.outliers.clear();
  state.outlierCount = 0;
  state.inlierCount = features.length;

  // Deterministic 2-cluster detection - DISABLED for clean view
  // All settlements are shown without cluster filtering
  // To re-enable: uncomment the line below and set clusterModeEnabled: true, hideStrayCluster: true in state
  // recomputeClusters(features);
  
  // Clear cluster sets to ensure nothing is filtered
  state.clusterA.clear();
  state.clusterB.clear();
  state.strayCluster = null;

  // Regime classification (diagnostic)
  try {
    computeRegimeClassification(features);
  } catch (err) {
    console.error('Error in computeRegimeClassification:', err);
    // Ensure all features have at least default labels even if classification fails
    for (const f of features) {
      if (!(f as any).clusterLabel) (f as any).clusterLabel = 'MAIN';
      if (!(f as any).scaleLabel) (f as any).scaleLabel = 'NORMAL';
      if (!(f as any).shapeLabel) (f as any).shapeLabel = 'OK';
      if (!(f as any).locationLabel) (f as any).locationLabel = 'INSIDE_MAIN_BOUNDS';
      if ((f as any).suspect === undefined) (f as any).suspect = false;
    }
  }

  return features;
}

// Compute bounds for a ring
function computeRingBounds(ring: [number, number][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

// Compute overall bounds from features
function computeBounds(features: FeatureRecord[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (features.length === 0) {
    return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const feature of features) {
    minX = Math.min(minX, feature.rawBounds.minX);
    minY = Math.min(minY, feature.rawBounds.minY);
    maxX = Math.max(maxX, feature.rawBounds.maxX);
    maxY = Math.max(maxY, feature.rawBounds.maxY);
  }
  return { minX, minY, maxX, maxY };
}

// Project source coordinates to screen coordinates
function project(x: number, y: number): [number, number] {
  const sx = (x - state.minX) * state.baseScale * state.zoom + state.panX;
  const sy = (y - state.minY) * state.baseScale * state.zoom + state.panY;
  return [sx, sy];
}

// Unproject screen coordinates to source coordinates
function unproject(sx: number, sy: number): [number, number] {
  const x = (sx - state.panX) / (state.baseScale * state.zoom) + state.minX;
  const y = (sy - state.panY) / (state.baseScale * state.zoom) + state.minY;
  return [x, y];
}

// Fit to view
function fitToView() {
  // Use all features for bounds - no cluster filtering
  // DISABLED: Use main cluster bounds when hiding stray cluster
  let featuresForBounds: FeatureRecord[];
  // if (state.clusterModeEnabled && state.hideStrayCluster && state.strayCluster !== null) {
  //   featuresForBounds = getMainClusterFeatures();
  // } else {
    featuresForBounds = getRenderableFeatures();
  // }
  
  if (featuresForBounds.length === 0) return;

  const padding = 40;
  const bounds = computeBounds(featuresForBounds);
  const width = canvas.width;
  const height = canvas.height;

  const dataWidth = bounds.maxX - bounds.minX;
  const dataHeight = bounds.maxY - bounds.minY;

  if (dataWidth <= 0 || dataHeight <= 0) {
    state.baseScale = 1;
    state.zoom = 1;
    state.panX = width / 2;
    state.panY = height / 2;
  } else {
    const scaleX = (width - padding * 2) / dataWidth;
    const scaleY = (height - padding * 2) / dataHeight;
    state.baseScale = Math.min(scaleX, scaleY);
    state.zoom = 1;
    // Center the data: project(minX) should be at padding, project(maxX) at width-padding
    // project(x) = (x - minX) * baseScale + panX
    // For minX: panX = padding
    // For maxX: (maxX - minX) * baseScale + panX = width - padding
    // So: dataWidth * baseScale + padding = width - padding
    // This is satisfied by our baseScale calculation
    state.panX = padding;
    state.panY = padding;
  }

  state.minX = bounds.minX;
  state.minY = bounds.minY;
  state.maxX = bounds.maxX;
  state.maxY = bounds.maxY;

  draw();
  updateInspector();
}

// Reset view
function resetView() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  fitToView();
}

// Build Path2D for a feature
function buildPath(feature: FeatureRecord): Path2D {
  const path = new Path2D();

  if (feature.geomType === 'Polygon') {
    const coords = feature.coords as [number, number][][];
    for (const ring of coords) {
      if (ring.length === 0) continue;
      const [sx, sy] = project(ring[0][0], ring[0][1]);
      path.moveTo(sx, sy);
      for (let i = 1; i < ring.length; i++) {
        const [sx, sy] = project(ring[i][0], ring[i][1]);
        path.lineTo(sx, sy);
      }
      path.closePath();
    }
  } else if (feature.geomType === 'MultiPolygon') {
    const coords = feature.coords as [number, number][][][];
    for (const polygon of coords) {
      for (const ring of polygon) {
        if (ring.length === 0) continue;
        const [sx, sy] = project(ring[0][0], ring[0][1]);
        path.moveTo(sx, sy);
        for (let i = 1; i < ring.length; i++) {
          const [sx, sy] = project(ring[i][0], ring[i][1]);
          path.lineTo(sx, sy);
        }
        path.closePath();
      }
    }
  }

  return path;
}

// Compute approximate screen area of a feature
function computeScreenArea(feature: FeatureRecord): number {
  // Use outer ring bounds transformed to screen space
  const [minX, minY] = project(feature.rawBounds.minX, feature.rawBounds.minY);
  const [maxX, maxY] = project(feature.rawBounds.maxX, feature.rawBounds.maxY);
  const width = maxX - minX;
  const height = maxY - minY;
  return Math.abs(width * height);
}

// Pick settlement at screen coordinates
function pick(mouseX: number, mouseY: number): string | null {
  // Only pick from currently visible features
  const visibleFeatures = getRenderableFeatures();
  // DISABLED - no stray cluster separation in clean view
  // const strayFeatures = state.clusterModeEnabled && !state.hideStrayCluster && state.strayCluster !== null
  //   ? getStrayClusterFeatures()
  //   : [];
  const strayFeatures: FeatureRecord[] = [];
  const allVisible = [...visibleFeatures, ...strayFeatures];

  // Iterate in reverse order (topmost first) and find smallest area match
  let bestMatch: { sid: string; area: number } | null = null;

  for (let i = allVisible.length - 1; i >= 0; i--) {
    const feature = allVisible[i];
    
    // Quick bbox prefilter
    const [minX, minY] = project(feature.rawBounds.minX, feature.rawBounds.minY);
    const [maxX, maxY] = project(feature.rawBounds.maxX, feature.rawBounds.maxY);
    if (mouseX < minX || mouseX > maxX || mouseY < minY || mouseY > maxY) {
      continue;
    }

    // Build path and test point
    const path = buildPath(feature);
    if (ctx.isPointInPath(path, mouseX, mouseY)) {
      const area = computeScreenArea(feature);
      if (!bestMatch || area < bestMatch.area) {
        bestMatch = { sid: feature.sid, area };
      }
    }
  }

  return bestMatch ? bestMatch.sid : null;
}

// Draw
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Get features to render
  const renderable = getRenderableFeatures();
  // DISABLED - no stray cluster separation in clean view
  // const strayFeatures = state.clusterModeEnabled && !state.hideStrayCluster && state.strayCluster !== null
  //   ? getStrayClusterFeatures()
  //   : [];
  const strayFeatures: FeatureRecord[] = [];

  // Draw fills if enabled (only for main/inlier features, never for stray)
  if (state.showFills) {
    ctx.fillStyle = '#e8f4f8';
    for (const feature of renderable) {
      const path = buildPath(feature);
      ctx.fill(path);
    }
  }

  // Draw main/inlier outlines
  for (const feature of renderable) {
    if (feature.sid === state.selectedSid) {
      ctx.strokeStyle = '#007bff';
      ctx.lineWidth = 2;
    } else if (state.highlightSuspects && (feature as any).suspect) {
      // Highlight suspects in orange (main cluster) or red (stray cluster)
      const isStray = (feature as any).clusterLabel === 'STRAY';
      ctx.strokeStyle = isStray ? 'rgba(255, 0, 0, 0.5)' : 'rgba(255, 165, 0, 0.35)';
      ctx.lineWidth = 1.5;
    } else {
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
    }
    const path = buildPath(feature);
    ctx.stroke(path);
  }

  // Draw stray cluster (outline-only, red tint, never filled)
  // DISABLED - no stray cluster highlighting in clean view
  // if (strayFeatures.length > 0) {
  //   ctx.strokeStyle = 'rgba(255, 0, 0, 0.25)';
  //   ctx.lineWidth = 1;
  //   for (const feature of strayFeatures) {
  //     if (feature.sid === state.selectedSid) {
  //       ctx.strokeStyle = 'rgba(255, 0, 0, 0.5)';
  //       ctx.lineWidth = 2;
  //     } else {
  //       ctx.strokeStyle = 'rgba(255, 0, 0, 0.25)';
  //       ctx.lineWidth = 1;
  //     }
  //     const path = buildPath(feature);
  //     ctx.stroke(path);
  //   }
  // }

  // Draw outliers (debug style), outlines only even if fills enabled
  // DISABLED - no outlier highlighting in clean view
  // if (!state.hideOutliers) {
  //   const outlierFeatures = state.features.filter(f => state.outliers.has(f.sid));
  //   if (outlierFeatures.length > 0) {
  //     ctx.strokeStyle = 'rgba(255, 0, 0, 0.25)';
  //     ctx.lineWidth = 1;
  //     for (const feature of outlierFeatures) {
  //       const path = buildPath(feature);
  //       ctx.stroke(path);
  //     }
  //   }
  // }

  // Update zoom readout
  zoomReadout.textContent = `Zoom: x${state.zoom.toFixed(2)}`;
}

// Update inspector
function updateInspector() {
  // Status section
  const polygonCount = state.features.filter(f => f.geomType === 'Polygon').length;
  const multipolygonCount = state.features.filter(f => f.geomType === 'MultiPolygon').length;
  const topOutliers = state.outlierRanked.slice(0, 10);
  
  // Get suspect features sorted by severity
  const suspectFeatures = state.features
    .filter(f => (f as any).suspect)
    .sort((a, b) => {
      const sevA = (a as any).severity || 0;
      const sevB = (b as any).severity || 0;
      if (sevB !== sevA) return sevB - sevA;
      return a.sid.localeCompare(b.sid);
    })
    .slice(0, 50);

  // Diagnostics section
  const diagnosticsSection = `
    <div class="status-item" style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd;"><b>Diagnostics</b></div>
    <div class="status-item">Total features: ${state.features.length}</div>
    <div class="status-item">MAIN cluster: ${state.clusterStats[state.strayCluster === 'A' ? 'B' : 'A'].count}</div>
    <div class="status-item">STRAY cluster: ${state.clusterStats[state.strayCluster === 'A' ? 'A' : 'B'].count}</div>
    <div class="status-item"><b>Suspect count: ${state.regimeStats.suspectCount}</b></div>
    <div class="status-item" style="margin-top:8px;"><b>Scale breakdown:</b></div>
    <div class="status-item" style="padding-left:12px;font-size:11px;">
      TINY: ${state.regimeStats.scaleCounts.TINY}, SMALL: ${state.regimeStats.scaleCounts.SMALL}, 
      NORMAL: ${state.regimeStats.scaleCounts.NORMAL}, HUGE: ${state.regimeStats.scaleCounts.HUGE}
    </div>
    <div class="status-item"><b>Shape breakdown:</b></div>
    <div class="status-item" style="padding-left:12px;font-size:11px;">
      SKINNY: ${state.regimeStats.shapeCounts.SKINNY}, OK: ${state.regimeStats.shapeCounts.OK}
    </div>
    <div class="status-item"><b>Location breakdown:</b></div>
    <div class="status-item" style="padding-left:12px;font-size:11px;">
      INSIDE: ${state.regimeStats.locationCounts.INSIDE_MAIN_BOUNDS}, 
      OUTSIDE: ${state.regimeStats.locationCounts.OUTSIDE_MAIN_BOUNDS}
    </div>
    <div class="status-item" style="margin-top:8px;">
      <button id="copy-suspects-tsv" style="padding:6px 12px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;margin-right:8px;">Copy suspects (TSV)</button>
      <button id="download-suspects-csv" style="padding:6px 12px;background:#28a745;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Download suspects.csv</button>
    </div>
    ${suspectFeatures.length > 0 ? `
      <div class="status-item" style="margin-top:8px;"><b>Suspects (top 50 by severity)</b></div>
      <div class="status-item" id="suspect-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;">
        ${suspectFeatures.map(f => {
          const r = f as any;
          return `
            <div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;border-bottom:1px solid #eee;">
              <a href="#" data-suspect-sid="${f.sid}" style="font-family:monospace;text-decoration:none;color:#007bff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.sid}</a>
              <span style="font-family:monospace;color:#666;flex-shrink:0;font-size:11px;">${r.clusterLabel}|${r.scaleLabel}|${r.shapeLabel.substring(0,3)}|${r.locationLabel.substring(0,5)}</span>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}
  `;

  // Cluster diagnostics
  const clusterSection = state.clusterModeEnabled && state.strayCluster !== null ? `
    <div class="status-item" style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd;"><b>Cluster Diagnostics</b></div>
    <div class="status-item">Cluster A: ${state.clusterStats.A.count} features</div>
    <div class="status-item" style="font-size:11px;padding-left:12px;">Bounds: [${state.clusterStats.A.bounds.minX.toFixed(2)}, ${state.clusterStats.A.bounds.minY.toFixed(2)}] to [${state.clusterStats.A.bounds.maxX.toFixed(2)}, ${state.clusterStats.A.bounds.maxY.toFixed(2)}]</div>
    <div class="status-item">Cluster B: ${state.clusterStats.B.count} features</div>
    <div class="status-item" style="font-size:11px;padding-left:12px;">Bounds: [${state.clusterStats.B.bounds.minX.toFixed(2)}, ${state.clusterStats.B.bounds.minY.toFixed(2)}] to [${state.clusterStats.B.bounds.maxX.toFixed(2)}, ${state.clusterStats.B.bounds.maxY.toFixed(2)}]</div>
    <div class="status-item">Main cluster: ${state.strayCluster === 'A' ? 'B' : 'A'}</div>
    <div class="status-item">Stray cluster: ${state.strayCluster}</div>
    <div class="status-item">Hide stray cluster: ${state.hideStrayCluster}</div>
    ${state.straySidsSorted.length > 0 ? `
      <div class="status-item" style="margin-top:8px;"><b>Stray SIDs (${Math.min(50, state.straySidsSorted.length)} shown)</b></div>
      <div class="status-item" id="stray-list" style="display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto;">
        ${state.straySidsSorted.slice(0, 50).map(sid => `
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <a href="#" data-stray-sid="${sid}" style="font-family:monospace;text-decoration:none;color:#007bff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${sid}</a>
          </div>
        `).join('')}
      </div>
      <button id="copy-stray-sids" style="margin-top:8px;padding:6px 12px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;">Copy stray SIDs</button>
    ` : ``}
  ` : '';

  statusInfo.innerHTML = `
    <div class="status-item">Total settlements: ${state.features.length}</div>
    <div class="status-item">Polygons: ${polygonCount}</div>
    <div class="status-item">MultiPolygons: ${multipolygonCount}</div>
    <div class="status-item">Inliers: ${state.inlierCount}</div>
    <div class="status-item">Outliers: ${state.outlierCount} (detection disabled - all settlements shown)</div>
    <div class="status-item">Hide outliers: ${state.hideOutliers} (disabled)</div>
    ${diagnosticsSection}
    ${clusterSection}
    <div class="status-item" style="margin-top:12px;padding-top:12px;border-top:1px solid #ddd;">Skipped features: ${state.skippedFeatures}</div>
    <div class="status-item">Dropped rings: ${state.droppedRings}</div>
    <div class="status-item">Dropped points: ${state.droppedPoints}</div>
    <div class="status-item">Bounds: [${state.minX.toFixed(2)}, ${state.minY.toFixed(2)}] to [${state.maxX.toFixed(2)}, ${state.maxY.toFixed(2)}]</div>
    ${topOutliers.length > 0 ? `
      <div class="status-item" style="margin-top:8px;color:#333;"><b>Top outliers</b></div>
      <div class="status-item" id="outlier-list" style="display:flex;flex-direction:column;gap:4px;">
        ${topOutliers.map(o => `
          <div style="display:flex;justify-content:space-between;gap:8px;">
            <a href="#" data-sid="${o.sid}" style="font-family:monospace;text-decoration:none;color:#007bff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${o.sid}</a>
            <span style="font-family:monospace;color:#666;flex-shrink:0;">${o.d.toFixed(2)}</span>
          </div>
        `).join('')}
      </div>
    ` : ``}
  `;

  // Wire outlier list clicks (read-only)
  const outlierList = document.getElementById('outlier-list');
  if (outlierList) {
    outlierList.querySelectorAll('a[data-sid]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const sid = (e.currentTarget as HTMLAnchorElement).dataset.sid;
        if (!sid) return;
        if (state.hideOutliers && state.outliers.has(sid)) {
          state.hideOutliers = false;
          // sync checkbox if present
          const cb = document.getElementById('hide-outliers') as HTMLInputElement | null;
          if (cb) cb.checked = state.hideOutliers;
          fitToView();
        }
        state.selectedSid = sid;
        panToFeatureSid(sid);
        draw();
        updateInspector();
      });
    });
  }

  // Wire stray cluster list clicks (read-only)
  const strayList = document.getElementById('stray-list');
  if (strayList) {
    strayList.querySelectorAll('a[data-stray-sid]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const sid = (e.currentTarget as HTMLAnchorElement).dataset.straySid;
        if (!sid) return;
        // Auto-disable hideStrayCluster if clicking a stray feature
        if (state.hideStrayCluster && state.strayCluster !== null) {
          const straySet = state.strayCluster === 'A' ? state.clusterA : state.clusterB;
          if (straySet.has(sid)) {
            state.hideStrayCluster = false;
            const cb = document.getElementById('hide-stray-cluster') as HTMLInputElement | null;
            if (cb) cb.checked = state.hideStrayCluster;
            fitToView();
          }
        }
        state.selectedSid = sid;
        panToFeatureSid(sid);
        draw();
        updateInspector();
      });
    });
  }

  // Wire copy stray SIDs button
  const copyBtn = document.getElementById('copy-stray-sids');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (state.straySidsSorted.length === 0) return;
      try {
        await navigator.clipboard.writeText(state.straySidsSorted.join('\n'));
        const originalText = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      }
    });
  }

  // Wire suspect list clicks
  const suspectList = document.getElementById('suspect-list');
  if (suspectList) {
    suspectList.querySelectorAll('a[data-suspect-sid]').forEach((a) => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const sid = (e.currentTarget as HTMLAnchorElement).dataset.suspectSid;
        if (sid) jumpToSid(sid);
      });
    });
  }

  // Wire copy suspects TSV button
  const copySuspectsBtn = document.getElementById('copy-suspects-tsv');
  if (copySuspectsBtn) {
    copySuspectsBtn.addEventListener('click', async () => {
      const suspects = state.features.filter(f => (f as any).suspect)
        .sort((a, b) => a.sid.localeCompare(b.sid));
      
      if (suspects.length === 0) return;

      const header = 'sid\tclusterLabel\tscaleLabel\tshapeLabel\tlocationLabel\tcentroidX\tcentroidY\tminX\tminY\tmaxX\tmaxY\tw\th\tA\n';
      const rows = suspects.map(f => {
        const r = f as any;
        const w = f.rawBounds.maxX - f.rawBounds.minX;
        const h = f.rawBounds.maxY - f.rawBounds.minY;
        const A = w * h;
        return `${f.sid}\t${r.clusterLabel}\t${r.scaleLabel}\t${r.shapeLabel}\t${r.locationLabel}\t${f.centroidX.toFixed(6)}\t${f.centroidY.toFixed(6)}\t${f.rawBounds.minX.toFixed(6)}\t${f.rawBounds.minY.toFixed(6)}\t${f.rawBounds.maxX.toFixed(6)}\t${f.rawBounds.maxY.toFixed(6)}\t${w.toFixed(6)}\t${h.toFixed(6)}\t${A.toFixed(6)}`;
      }).join('\n');

      try {
        await navigator.clipboard.writeText(header + rows);
        const originalText = copySuspectsBtn.textContent;
        copySuspectsBtn.textContent = 'Copied!';
        setTimeout(() => {
          copySuspectsBtn.textContent = originalText;
        }, 2000);
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
      }
    });
  }

  // Wire download suspects CSV button
  const downloadSuspectsBtn = document.getElementById('download-suspects-csv');
  if (downloadSuspectsBtn) {
    // Remove any existing listeners by cloning the button
    const newBtn = downloadSuspectsBtn.cloneNode(true) as HTMLButtonElement;
    downloadSuspectsBtn.parentNode?.replaceChild(newBtn, downloadSuspectsBtn);
    
    newBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      
      try {
        const suspects = state.features.filter(f => (f as any).suspect)
          .sort((a, b) => a.sid.localeCompare(b.sid));
        
        console.log(`Download button clicked. Found ${suspects.length} suspects out of ${state.features.length} total features.`);
        console.log(`Regime stats:`, state.regimeStats);
        console.log(`Stray cluster:`, state.strayCluster);
        console.log(`Cluster stats:`, state.clusterStats);
        
        // Debug: check a few features to see if suspect flag is set
        const sampleFeatures = state.features.slice(0, 5);
        console.log('Sample features suspect flags:', sampleFeatures.map(f => ({
          sid: f.sid,
          suspect: (f as any).suspect,
          clusterLabel: (f as any).clusterLabel,
          scaleLabel: (f as any).scaleLabel,
          shapeLabel: (f as any).shapeLabel,
          locationLabel: (f as any).locationLabel
        })));
        
        if (suspects.length === 0) {
          console.warn('No suspects to download');
          const suspectCount = state.regimeStats?.suspectCount ?? 0;
          
          // Offer to download all features if no suspects found
          if (suspectCount === 0 && state.features.length > 0) {
            const downloadAll = confirm(
              `No suspects detected (${state.features.length} total features). ` +
              `This may mean:\n` +
              `1. The data is clean (no problematic features)\n` +
              `2. Suspect detection hasn't run yet\n` +
              `3. Detection thresholds are too strict\n\n` +
              `Would you like to download ALL features for analysis instead?`
            );
            
            if (downloadAll) {
              // Download all features with same format
              const header = 'sid,clusterLabel,scaleLabel,shapeLabel,locationLabel,centroidX,centroidY,minX,minY,maxX,maxY,w,h,A\n';
              const rows = state.features.map(f => {
                const r = f as any;
                const w = f.rawBounds.maxX - f.rawBounds.minX;
                const h = f.rawBounds.maxY - f.rawBounds.minY;
                const A = w * h;
                const escapeCsv = (val: any) => {
                  const str = String(val ?? '');
                  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                    return `"${str.replace(/"/g, '""')}"`;
                  }
                  return str;
                };
                return `${escapeCsv(f.sid)},${escapeCsv(r.clusterLabel ?? 'UNKNOWN')},${escapeCsv(r.scaleLabel ?? 'UNKNOWN')},${escapeCsv(r.shapeLabel ?? 'UNKNOWN')},${escapeCsv(r.locationLabel ?? 'UNKNOWN')},${f.centroidX.toFixed(6)},${f.centroidY.toFixed(6)},${f.rawBounds.minX.toFixed(6)},${f.rawBounds.minY.toFixed(6)},${f.rawBounds.maxX.toFixed(6)},${f.rawBounds.maxY.toFixed(6)},${w.toFixed(6)},${h.toFixed(6)},${A.toFixed(6)}`;
              }).join('\n');
              
              const csv = header + rows;
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'all_features.csv';
              a.style.display = 'none';
              document.body.appendChild(a);
              a.click();
              setTimeout(() => {
                if (a.parentNode) document.body.removeChild(a);
                URL.revokeObjectURL(url);
              }, 200);
              console.log(`Downloaded all_features.csv with ${state.features.length} features`);
              return;
            }
          }
          
          const message = suspectCount > 0 
            ? `No suspects found in filtered list, but regime stats show ${suspectCount} suspects. This may indicate a bug in suspect detection. Check console for details.`
            : 'No suspects found. There may be no problematic features detected, or suspect classification may not have run yet. Check console for details.';
          alert(message);
          return;
        }

        const header = 'sid,clusterLabel,scaleLabel,shapeLabel,locationLabel,centroidX,centroidY,minX,minY,maxX,maxY,w,h,A\n';
        const rows = suspects.map(f => {
          const r = f as any;
          const w = f.rawBounds.maxX - f.rawBounds.minX;
          const h = f.rawBounds.maxY - f.rawBounds.minY;
          const A = w * h;
          // Escape any commas in the data (though SIDs shouldn't have them)
          const escapeCsv = (val: any) => {
            const str = String(val ?? '');
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
              return `"${str.replace(/"/g, '""')}"`;
            }
            return str;
          };
          return `${escapeCsv(f.sid)},${escapeCsv(r.clusterLabel)},${escapeCsv(r.scaleLabel)},${escapeCsv(r.shapeLabel)},${escapeCsv(r.locationLabel)},${f.centroidX.toFixed(6)},${f.centroidY.toFixed(6)},${f.rawBounds.minX.toFixed(6)},${f.rawBounds.minY.toFixed(6)},${f.rawBounds.maxX.toFixed(6)},${f.rawBounds.maxY.toFixed(6)},${w.toFixed(6)},${h.toFixed(6)},${A.toFixed(6)}`;
        }).join('\n');

        const csv = header + rows;
        console.log(`Generated CSV: ${csv.length} characters, ${suspects.length} rows`);
        
        // Try blob method first
        try {
          const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'suspects.csv';
          a.style.display = 'none';
          document.body.appendChild(a);
          
          // Force a synchronous click
          const clickEvent = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            view: window
          });
          a.dispatchEvent(clickEvent);
          
          // Also try the direct click method
          if (document.activeElement !== a) {
            a.click();
          }
          
          // Clean up after a delay
          setTimeout(() => {
            if (a.parentNode) {
              document.body.removeChild(a);
            }
            URL.revokeObjectURL(url);
          }, 200);
          
          console.log(`Download triggered for suspects.csv with ${suspects.length} suspects`);
        } catch (blobErr) {
          console.warn('Blob method failed, trying data URL:', blobErr);
          // Fallback: use data URL
          const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = 'suspects.csv';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            if (a.parentNode) {
              document.body.removeChild(a);
            }
          }, 200);
        }
      } catch (err) {
        console.error('Failed to download suspects CSV:', err);
        alert(`Failed to download CSV: ${err instanceof Error ? err.message : String(err)}\n\nCheck the browser console for details.`);
      }
    });
  } else {
    console.warn('Download suspects CSV button not found in DOM');
  }

  // Selection section
  if (state.selectedSid) {
    const feature = state.features.find(f => f.sid === state.selectedSid);
    if (feature) {
      selectionInfo.innerHTML = `
        <div class="info-row">
          <span class="info-label">SID:</span>
          <span class="info-value">${feature.sid}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Geometry Type:</span>
          <span class="info-value">${feature.geomType}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Ring Count:</span>
          <span class="info-value">${feature.ringCount}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Outer Vertices:</span>
          <span class="info-value">${feature.outerVertices}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Min X:</span>
          <span class="info-value">${feature.rawBounds.minX.toFixed(6)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Min Y:</span>
          <span class="info-value">${feature.rawBounds.minY.toFixed(6)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Max X:</span>
          <span class="info-value">${feature.rawBounds.maxX.toFixed(6)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Max Y:</span>
          <span class="info-value">${feature.rawBounds.maxY.toFixed(6)}</span>
        </div>
      `;
    } else {
      selectionInfo.innerHTML = '<div class="no-selection">No settlement selected</div>';
    }
  } else {
    selectionInfo.innerHTML = '<div class="no-selection">No settlement selected</div>';
  }
}

// Resize canvas
function resizeCanvas() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  draw();
}

function ensureHideOutliersControl() {
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;
  if (document.getElementById('hide-outliers')) return;

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'hide-outliers';
  cb.checked = state.hideOutliers;
  const span = document.createElement('span');
  span.textContent = 'Hide outliers (diagnostic)';
  label.appendChild(cb);
  label.appendChild(span);

  // Insert next to the existing fills toggle if present
  const fills = document.getElementById('show-fills');
  if (fills && fills.parentElement) {
    fills.parentElement.insertAdjacentElement('afterend', label);
  } else {
    topBar.appendChild(label);
  }

  cb.addEventListener('change', () => {
    state.hideOutliers = cb.checked;
    fitToView();
    draw();
    updateInspector();
  });
}

function ensureHideStrayClusterControl() {
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;
  if (document.getElementById('hide-stray-cluster')) return;

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'hide-stray-cluster';
  cb.checked = state.hideStrayCluster;
  const span = document.createElement('span');
  span.textContent = 'Hide stray cluster (diagnostic)';
  label.appendChild(cb);
  label.appendChild(span);

  // Insert after hide-outliers if present, otherwise after show-fills
  const hideOutliers = document.getElementById('hide-outliers');
  if (hideOutliers && hideOutliers.parentElement) {
    hideOutliers.parentElement.insertAdjacentElement('afterend', label);
  } else {
    const fills = document.getElementById('show-fills');
    if (fills && fills.parentElement) {
      fills.parentElement.insertAdjacentElement('afterend', label);
    } else {
      topBar.appendChild(label);
    }
  }

  cb.addEventListener('change', () => {
    state.hideStrayCluster = cb.checked;
    fitToView();
    draw();
    updateInspector();
  });
}

function ensureSearchControls() {
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;
  if (document.getElementById('search-input')) return;

  const searchContainer = document.createElement('div');
  searchContainer.style.display = 'flex';
  searchContainer.style.alignItems = 'center';
  searchContainer.style.gap = '6px';
  searchContainer.style.position = 'relative';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'search-input';
  input.placeholder = 'Find SID...';
  input.style.padding = '4px 8px';
  input.style.border = '1px solid #ddd';
  input.style.borderRadius = '4px';
  input.style.fontSize = '13px';
  input.style.width = '200px';

  const goBtn = document.createElement('button');
  goBtn.textContent = 'Go';
  goBtn.style.padding = '4px 12px';
  goBtn.style.fontSize = '13px';

  const matchesDiv = document.createElement('div');
  matchesDiv.id = 'search-matches';
  matchesDiv.style.display = 'none';
  matchesDiv.style.position = 'absolute';
  matchesDiv.style.top = '100%';
  matchesDiv.style.left = '0';
  matchesDiv.style.right = '0';
  matchesDiv.style.background = 'white';
  matchesDiv.style.border = '1px solid #ddd';
  matchesDiv.style.borderRadius = '4px';
  matchesDiv.style.maxHeight = '200px';
  matchesDiv.style.overflowY = 'auto';
  matchesDiv.style.zIndex = '1000';
  matchesDiv.style.marginTop = '4px';
  matchesDiv.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';

  searchContainer.appendChild(input);
  searchContainer.appendChild(goBtn);
  searchContainer.appendChild(matchesDiv);

  // Insert before zoom readout
  const zoomReadout = document.getElementById('zoom-readout');
  if (zoomReadout && zoomReadout.parentElement) {
    zoomReadout.parentElement.insertBefore(searchContainer, zoomReadout);
  } else {
    topBar.appendChild(searchContainer);
  }

  const updateMatches = () => {
    const query = input.value.trim();
    if (query === '') {
      matchesDiv.style.display = 'none';
      state.searchMatches = [];
      return;
    }

    const matches = searchSids(query);
    state.searchMatches = matches;
    state.searchQuery = query;

    if (matches.length === 0) {
      matchesDiv.style.display = 'none';
      return;
    }

    matchesDiv.innerHTML = matches.map(sid => `
      <div style="padding:6px 8px;cursor:pointer;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;" 
           data-search-sid="${sid}">${sid}</div>
    `).join('');

    matchesDiv.style.display = 'block';

    // Wire clicks
    matchesDiv.querySelectorAll('[data-search-sid]').forEach(el => {
      el.addEventListener('click', () => {
        const sid = (el as HTMLElement).dataset.searchSid;
        if (sid) {
          jumpToSid(sid);
          input.value = '';
          matchesDiv.style.display = 'none';
        }
      });
    });
  };

  input.addEventListener('input', updateMatches);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim();
      if (query) {
        const matches = searchSids(query);
        if (matches.length === 1) {
          jumpToSid(matches[0]);
          input.value = '';
          matchesDiv.style.display = 'none';
        } else if (matches.length > 1) {
          updateMatches();
        }
      }
    } else if (e.key === 'Escape') {
      matchesDiv.style.display = 'none';
    }
  });

  goBtn.addEventListener('click', () => {
    const query = input.value.trim();
    if (query) {
      const matches = searchSids(query);
      if (matches.length === 1) {
        jumpToSid(matches[0]);
        input.value = '';
        matchesDiv.style.display = 'none';
      } else if (matches.length > 1) {
        updateMatches();
      }
    }
  });

  // Close matches when clicking outside
  document.addEventListener('click', (e) => {
    if (!searchContainer.contains(e.target as Node)) {
      matchesDiv.style.display = 'none';
    }
  });
}

function ensureHighlightSuspectsControl() {
  const topBar = document.getElementById('top-bar');
  if (!topBar) return;
  if (document.getElementById('highlight-suspects')) return;

  const label = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'highlight-suspects';
  cb.checked = state.highlightSuspects;
  const span = document.createElement('span');
  span.textContent = 'Highlight suspects';
  label.appendChild(cb);
  label.appendChild(span);

  const hideStray = document.getElementById('hide-stray-cluster');
  if (hideStray && hideStray.parentElement) {
    hideStray.parentElement.insertAdjacentElement('afterend', label);
  } else {
    topBar.appendChild(label);
  }

  cb.addEventListener('change', () => {
    state.highlightSuspects = cb.checked;
    draw();
  });
}

// Event handlers
fitToViewBtn.addEventListener('click', fitToView);
resetBtn.addEventListener('click', resetView);

showFillsCheckbox.addEventListener('change', () => {
  state.showFills = showFillsCheckbox.checked;
  draw();
});

// Pan: Middle mouse drag OR Space + Left drag
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1 || (e.button === 0 && spacePressed)) {
    e.preventDefault();
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartPanX = state.panX;
    panStartPanY = state.panY;
    canvas.classList.add('panning');
  } else if (e.button === 0) {
    // Left click for selection
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const selectedSid = pick(mouseX, mouseY);
    state.selectedSid = selectedSid;
    
    // Auto-disable hideStrayCluster if a stray feature is selected
    if (selectedSid && state.clusterModeEnabled && state.hideStrayCluster && state.strayCluster !== null) {
      const straySet = state.strayCluster === 'A' ? state.clusterA : state.clusterB;
      if (straySet.has(selectedSid)) {
        state.hideStrayCluster = false;
        const cb = document.getElementById('hide-stray-cluster') as HTMLInputElement | null;
        if (cb) cb.checked = state.hideStrayCluster;
        fitToView();
      }
    }
    
    draw();
    updateInspector();
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (isPanning) {
    const dx = e.clientX - panStartX;
    const dy = e.clientY - panStartY;
    state.panX = panStartPanX + dx;
    state.panY = panStartPanY + dy;
    draw();
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (e.button === 1 || (e.button === 0 && spacePressed)) {
    isPanning = false;
    canvas.classList.remove('panning');
  }
});

canvas.addEventListener('mouseleave', () => {
  isPanning = false;
  canvas.classList.remove('panning');
});

// Prevent context menu on middle click
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

// Zoom: mouse wheel centered on cursor
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  // Get mouse position in source coordinates before zoom
  const [sourceX, sourceY] = unproject(mouseX, mouseY);

  // Adjust zoom
  const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
  state.zoom = Math.max(0.1, Math.min(10, state.zoom * zoomFactor));

  // Get mouse position in source coordinates after zoom
  const [newSourceX, newSourceY] = unproject(mouseX, mouseY);

  // Adjust pan to keep mouse position fixed
  const dx = (newSourceX - sourceX) * state.baseScale * state.zoom;
  const dy = (newSourceY - sourceY) * state.baseScale * state.zoom;
  state.panX -= dx;
  state.panY -= dy;

  draw();
  updateInspector();
});

// Space key for panning
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    spacePressed = true;
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    spacePressed = false;
  }
});

// Window resize
window.addEventListener('resize', resizeCanvas);

// Initialize
async function init() {
  try {
    ensureHideOutliersControl();
    ensureHideStrayClusterControl();
    ensureSearchControls();
    ensureHighlightSuspectsControl();
    state.features = await loadGeoJSON();
    const bounds = computeBounds(state.features);
    state.minX = bounds.minX;
    state.minY = bounds.minY;
    state.maxX = bounds.maxX;
    state.maxY = bounds.maxY;
    
    resizeCanvas();
    fitToView();
    updateInspector();
  } catch (error) {
    console.error('Failed to load map data:', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    statusInfo.innerHTML = `<div style="color: red; padding: 12px; background: #ffe6e6; border: 1px solid #ff9999; border-radius: 4px; margin: 8px 0;"><strong>Error loading map data:</strong><br>${errorMessage}</div>`;
  }
}

init();
