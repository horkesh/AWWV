/**
 * Build Substrate Viewer Index
 * 
 * CANONICAL SCRIPT FOR PHASE 0 SUBSTRATE VIEWER
 * 
 * This script is canonical for Phase 0 settlement substrate viewer. It creates
 * a lightweight lookup table keyed by sid for the substrate viewer and joins
 * settlement-level census data from bih_census_1991.json.
 * 
 * Usage:
 *   npm run map:viewer:substrate:index
 *   or: tsx scripts/map/build_substrate_viewer_index.ts
 * 
 * Outputs:
 *   - data/derived/substrate_viewer/data_index.json (canonical Phase 0 viewer index)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Finalize viewer robustness and mistake-guard closure: ensure file:// detection exists in canonical viewer output and mark past mistakes as addressed to stop repeated warnings");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    name?: string | null;
    municipality_id?: string | null;
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface CensusSettlement {
  p?: number[]; // [total, bosniak, croat, serb, other] or ambiguous
  [key: string]: unknown;
}

interface CensusData {
  settlements?: Record<string, CensusSettlement>;
  naselja?: Record<string, CensusSettlement>;
  settlement?: Record<string, CensusSettlement>;
  naselje?: Record<string, CensusSettlement>;
  [key: string]: unknown;
}

interface SettlementIndexEntry {
  name: string | null;
  municipality_id: string | null;
  bbox: [number, number, number, number];
  centroid: [number, number];
  majority: 'bosniak' | 'serb' | 'croat' | 'other' | 'unknown';
  shares: {
    bosniak: number;
    croat: number;
    serb: number;
    other: number;
  };
  provenance: 'settlement' | 'no_settlement_census' | 'ambiguous_ordering';
}

interface ViewerIndex {
  meta: {
    geometry_path: string;
    census_path: string;
    settlement_census_key: string | null;
    ordering_mode: 'named' | 'ambiguous' | 'missing';
    counts: {
      features: number;
      matched_settlement_census: number;
      unknown: number;
      majority: {
        bosniak: number;
        serb: number;
        croat: number;
        other: number;
        unknown: number;
      };
    };
    global_bbox: [number, number, number, number];
  };
  by_sid: Record<string, SettlementIndexEntry>;
}

/**
 * Compute bbox for a feature
 */
function computeBbox(coords: Polygon | MultiPolygon): { minx: number; miny: number; maxx: number; maxy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const processRing = (ring: Ring) => {
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [x, y] = pt;
      if (!isFinite(x) || !isFinite(y)) continue;
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  };

  const isMultiPolygon = Array.isArray(coords) && 
                         coords.length > 0 && 
                         Array.isArray(coords[0]) && 
                         coords[0].length > 0 && 
                         Array.isArray(coords[0][0]) && 
                         coords[0][0].length > 0 && 
                         Array.isArray(coords[0][0][0]);

  if (isMultiPolygon) {
    for (const poly of coords as MultiPolygon) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        processRing(ring);
      }
    }
  } else {
    for (const ring of coords as Polygon) {
      if (!Array.isArray(ring)) continue;
      processRing(ring);
    }
  }

  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  }

  return { minx, miny, maxx, maxy };
}

/**
 * Compute centroid (bbox center)
 */
function computeCentroid(bbox: { minx: number; miny: number; maxx: number; maxy: number }): [number, number] {
  return [
    (bbox.minx + bbox.maxx) / 2,
    (bbox.miny + bbox.maxy) / 2
  ];
}

/**
 * Detect settlement-level census table
 */
function detectSettlementCensusTable(census: CensusData, substrateSids: Set<string>): {
  key: string | null;
  table: Record<string, CensusSettlement> | null;
  overlap: number;
} {
  // Prefer explicit keys
  const explicitKeys = ['settlements', 'naselja', 'settlement', 'naselje'];
  for (const key of explicitKeys) {
    const table = census[key] as Record<string, CensusSettlement> | undefined;
    if (table && typeof table === 'object') {
      const overlap = Object.keys(table).filter(sid => substrateSids.has(sid)).length;
      if (overlap > 0) {
        return { key, table, overlap };
      }
    }
  }

  // Otherwise scan top-level objects with p arrays (len >= 5)
  let bestCandidate: { key: string; table: Record<string, CensusSettlement>; overlap: number } | null = null;
  
  for (const [key, value] of Object.entries(census)) {
    if (explicitKeys.includes(key)) continue; // Already checked
    if (key === 'metadata' || key === 'municipalities') continue; // Skip known non-settlement keys
    
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const table = value as Record<string, unknown>;
      // Check if values have p arrays
      let hasPArrays = false;
      let overlap = 0;
      
      for (const [sid, record] of Object.entries(table)) {
        if (substrateSids.has(sid)) {
          overlap++;
        }
        if (record && typeof record === 'object') {
          const rec = record as Record<string, unknown>;
          if (Array.isArray(rec.p) && rec.p.length >= 5) {
            hasPArrays = true;
          }
        }
      }
      
      if (hasPArrays && overlap > 0) {
        if (!bestCandidate || overlap > bestCandidate.overlap || 
            (overlap === bestCandidate.overlap && key < bestCandidate.key)) {
          bestCandidate = { key, table: table as Record<string, CensusSettlement>, overlap };
        }
      }
    }
  }
  
  if (bestCandidate) {
    return bestCandidate;
  }
  
  return { key: null, table: null, overlap: 0 };
}

/**
 * Validate p-sum: p[0] == p[1] + p[2] + p[3] + p[4]
 */
function validatePSum(p: number[]): boolean {
  if (!Array.isArray(p) || p.length < 5) return false;
  const total = p[0];
  const sum = p[1] + p[2] + p[3] + p[4];
  return Math.abs(total - sum) < 0.5; // Allow small floating point errors
}

/**
 * Compute majority ethnicity with deterministic tie-breaking
 */
function computeMajority(p: number[]): 'bosniak' | 'serb' | 'croat' | 'other' {
  if (!Array.isArray(p) || p.length < 5) return 'other';
  
  const bosniak = p[1] || 0;
  const croat = p[2] || 0;
  const serb = p[3] || 0;
  const other = p[4] || 0;
  
  const max = Math.max(bosniak, serb, croat, other);
  
  // Tie-breaking: bosniak > serb > croat > other
  if (bosniak === max) return 'bosniak';
  if (serb === max) return 'serb';
  if (croat === max) return 'croat';
  return 'other';
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const censusPath = resolve('data/source/bih_census_1991.json');
  const outputDir = resolve('data/derived/substrate_viewer');
  const outputPath = resolve(outputDir, 'data_index.json');
  const htmlPath = resolve(outputDir, 'index.html');
  const viewerJsPath = resolve(outputDir, 'viewer.js');
  
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrateGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrateGeoJSON.type}`);
  }
  
  const features = substrateGeoJSON.features;
  process.stdout.write(`Loaded ${features.length} features\n`);
  
  // Load census
  process.stdout.write(`Loading ${censusPath}...\n`);
  const censusContent = readFileSync(censusPath, 'utf8');
  const census = JSON.parse(censusContent) as CensusData;
  process.stdout.write(`Loaded census data\n`);
  
  // Extract substrate SIDs and census IDs
  // SVG-derived substrate uses census_id for matching; master-derived uses sid directly
  const substrateSids = new Set<string>();
  const substrateCensusIds = new Set<string>();
  for (const feature of features) {
    if (feature.properties.sid) {
      substrateSids.add(String(feature.properties.sid));
    }
    // SVG-derived substrate has census_id field
    if (feature.properties.census_id) {
      const censusId = String(feature.properties.census_id);
      substrateCensusIds.add(censusId);
      // Also add to substrateSids for backwards compatibility (census table lookup)
      substrateSids.add(censusId);
    }
  }
  
  // Detect settlement-level census table (use census IDs if available, otherwise SIDs)
  process.stdout.write(`Detecting settlement-level census table...\n`);
  const censusDetection = detectSettlementCensusTable(census, substrateCensusIds.size > 0 ? substrateCensusIds : substrateSids);
  
  if (!censusDetection.table) {
    process.stdout.write(`WARNING: No settlement-level census table found\n`);
    appendMistake({
      key: 'substrate.viewer.missing_settlement_census',
      date: '2026-01-26',
      title: 'Substrate viewer: settlement-level census table missing',
      description: `No settlement-level census table found in bih_census_1991.json. Viewer will show all settlements as Unknown.`,
      correctiveAction: 'Verify census file structure. If settlement-level census is truly missing, docs/FORAWWV.md may require an addendum about demographic data granularity assumptions.'
    });
  }
  
  // Validate ordering if table exists
  let orderingMode: 'named' | 'ambiguous' | 'missing' = 'missing';
  let pSumFailCount = 0;
  let pSumPassCount = 0;
  
  if (censusDetection.table) {
    process.stdout.write(`Validating census ordering (p-sum checks)...\n`);
    for (const [sid, record] of Object.entries(censusDetection.table)) {
      if (!substrateSids.has(sid)) continue;
      if (record.p && Array.isArray(record.p) && record.p.length >= 5) {
        if (validatePSum(record.p)) {
          pSumPassCount++;
        } else {
          pSumFailCount++;
        }
      }
    }
    
    const totalMatched = pSumPassCount + pSumFailCount;
    const failRate = totalMatched > 0 ? pSumFailCount / totalMatched : 0;
    
    if (failRate > 0.1) {
      orderingMode = 'ambiguous';
      process.stdout.write(`WARNING: Census ordering ambiguous (${(failRate * 100).toFixed(1)}% p-sum failures)\n`);
      appendMistake({
        key: 'substrate.viewer.ambiguous_census_ordering',
        date: '2026-01-26',
        title: 'Substrate viewer: settlement-level census ordering ambiguous',
        description: `Settlement-level census p-sum validation failed for ${(failRate * 100).toFixed(1)}% of matched settlements. Ordering treated as ambiguous.`,
        correctiveAction: 'Viewer will color all settlements as Unknown and display warning banner. docs/FORAWWV.md may require an addendum about census data encoding assumptions.'
      });
    } else {
      orderingMode = 'named';
      process.stdout.write(`Census ordering validated: [total, bosniak, croat, serb, other]\n`);
    }
  }
  
  // Build index
  const bySid: Record<string, SettlementIndexEntry> = {};
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  const majorityCounts = {
    bosniak: 0,
    serb: 0,
    croat: 0,
    other: 0,
    unknown: 0
  };
  
  let matchedSettlementCensus = 0;
  let unknownCount = 0;
  
  for (const feature of features) {
    const sid = String(feature.properties.sid);
    // SVG-derived substrate: use census_id for matching; master-derived: use sid directly
    const censusIdForMatching = feature.properties.census_id ? String(feature.properties.census_id) : sid;
    const name = feature.properties.name || feature.properties.settlement_name || null;
    const municipalityId = feature.properties.municipality_id || null;
    
    // Compute bbox and centroid
    const bbox = computeBbox(feature.geometry.coordinates);
    const centroid = computeCentroid(bbox);
    
    // Update global bbox
    globalMinx = Math.min(globalMinx, bbox.minx);
    globalMiny = Math.min(globalMiny, bbox.miny);
    globalMaxx = Math.max(globalMaxx, bbox.maxx);
    globalMaxy = Math.max(globalMaxy, bbox.maxy);
    
    // Join census
    let majority: 'bosniak' | 'serb' | 'croat' | 'other' | 'unknown' = 'unknown';
    let shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
    let provenance: 'settlement' | 'no_settlement_census' | 'ambiguous_ordering' = 'no_settlement_census';
    
    if (censusDetection.table && orderingMode !== 'missing') {
      const censusRecord = censusDetection.table[censusIdForMatching];
      if (censusRecord && censusRecord.p && Array.isArray(censusRecord.p) && censusRecord.p.length >= 5) {
        if (orderingMode === 'named' && validatePSum(censusRecord.p)) {
          // Valid ordering: [total, bosniak, croat, serb, other]
          const total = censusRecord.p[0];
          if (total > 0) {
            shares = {
              bosniak: censusRecord.p[1] / total,
              croat: censusRecord.p[2] / total,
              serb: censusRecord.p[3] / total,
              other: censusRecord.p[4] / total
            };
          }
          majority = computeMajority(censusRecord.p);
          provenance = 'settlement';
          matchedSettlementCensus++;
        } else {
          // Ambiguous ordering
          provenance = 'ambiguous_ordering';
          majority = 'unknown';
          unknownCount++;
        }
      } else {
        // No census record
        provenance = 'no_settlement_census';
        majority = 'unknown';
        unknownCount++;
      }
    } else {
      // No census table or missing
      provenance = 'no_settlement_census';
      majority = 'unknown';
      unknownCount++;
    }
    
    majorityCounts[majority]++;
    
    bySid[sid] = {
      name,
      municipality_id: municipalityId,
      bbox: [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy],
      centroid,
      majority,
      shares,
      provenance
    };
  }
  
  // Sort by_sid keys deterministically
  const sortedSids = Object.keys(bySid).sort((a, b) => a.localeCompare(b));
  const sortedBySid: Record<string, SettlementIndexEntry> = {};
  for (const sid of sortedSids) {
    sortedBySid[sid] = bySid[sid];
  }
  
  // Build index
  const index: ViewerIndex = {
    meta: {
      geometry_path: '/data/derived/settlements_substrate.geojson',
      census_path: '/data/source/bih_census_1991.json',
      settlement_census_key: censusDetection.key,
      ordering_mode: orderingMode,
      counts: {
        features: features.length,
        matched_settlement_census: matchedSettlementCensus,
        unknown: unknownCount,
        majority: majorityCounts
      },
      global_bbox: [globalMinx, globalMiny, globalMaxx, globalMaxy]
    },
    by_sid: sortedBySid
  };
  
  // Write output
  writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf8');
  process.stdout.write(`Wrote index to ${outputPath}\n`);
  
  // Generate HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Settlement Substrate Viewer</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      overflow: hidden;
      height: 100vh;
    }
    #canvas-container {
      position: relative;
      width: 100vw;
      height: 100vh;
    }
    #canvas {
      display: block;
      cursor: grab;
      background: #f5f5f5;
    }
    #canvas.dragging {
      cursor: grabbing;
    }
    #controls {
      position: absolute;
      top: 10px;
      left: 10px;
      background: white;
      padding: 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      z-index: 10;
      max-width: 300px;
      max-height: 90vh;
      overflow-y: auto;
      font-size: 12px;
    }
    .control-group {
      margin-bottom: 12px;
    }
    .control-group:last-child {
      margin-bottom: 0;
    }
    label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
    }
    input[type="checkbox"], input[type="text"] {
      margin-right: 6px;
    }
    input[type="text"] {
      width: 100%;
      padding: 4px;
      border: 1px solid #ccc;
      border-radius: 3px;
      font-size: 12px;
    }
    button {
      padding: 6px 12px;
      background: #007bff;
      color: white;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 12px;
      width: 100%;
    }
    button:hover {
      background: #0056b3;
    }
    .legend {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid #ddd;
    }
    .legend-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
      font-size: 11px;
    }
    .legend-color {
      display: inline-block;
      width: 16px;
      height: 16px;
      margin-right: 6px;
      border: 1px solid #333;
      vertical-align: middle;
    }
    .tooltip {
      position: absolute;
      background: rgba(0, 0, 0, 0.85);
      color: white;
      padding: 8px;
      border-radius: 4px;
      font-size: 11px;
      pointer-events: none;
      z-index: 1000;
      max-width: 250px;
      display: none;
    }
    .tooltip-line {
      margin-bottom: 2px;
    }
    .tooltip-line:last-child {
      margin-bottom: 0;
    }
    .hint {
      margin-top: 12px;
      padding: 8px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 3px;
      font-size: 11px;
      color: #856404;
    }
    .warning-banner {
      margin-top: 12px;
      padding: 8px;
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      border-radius: 3px;
      font-size: 11px;
      color: #721c24;
      display: none;
    }
    .warning-banner.show {
      display: block;
    }
    .error-box {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 24px;
      border: 2px solid #dc3545;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 10000;
      max-width: 500px;
      font-size: 14px;
    }
    .error-box h2 {
      color: #dc3545;
      margin-bottom: 12px;
      font-size: 18px;
    }
    .error-box p {
      margin-bottom: 8px;
      line-height: 1.5;
    }
    .error-box code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: monospace;
    }
    .error-box ol {
      margin-left: 20px;
      margin-top: 8px;
    }
    .error-box li {
      margin-bottom: 4px;
    }
  </style>
</head>
<body>
  <div id="canvas-container">
    <canvas id="canvas"></canvas>
    <div id="tooltip" class="tooltip"></div>
    <div id="controls">
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-ethnicity" checked>
          Color by settlement majority ethnicity
        </label>
        <div style="font-size: 10px; color: #666; margin-top: 2px;">
          Coloring uses settlement-level majority only. Settlements without settlement-level census data are shown as Unknown.
        </div>
      </div>
      <div class="control-group">
        <label>
          <input type="checkbox" id="show-unknown-only">
          Show Unknown only
        </label>
      </div>
      <div class="control-group">
        <label>SID filter (substring):</label>
        <input type="text" id="filter-sid" placeholder="(empty for all)">
      </div>
      <div class="control-group">
        <button id="reset-view">Reset View</button>
      </div>
      <div class="warning-banner" id="warning-banner"></div>
      <div class="legend" id="legend"></div>
    </div>
    <div id="error-box" class="error-box" style="display: none;"></div>
  </div>
  <script src="./viewer.js"></script>
</body>
</html>`;
  
  writeFileSync(htmlPath, html, 'utf8');
  process.stdout.write(`Wrote HTML to ${htmlPath}\n`);
  
  // Generate viewer.js with file:// detection
  const viewerJs = `/**
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
  const errorBox = document.getElementById('error-box');

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
    return \`rgba(\${r}, \${g}, \${b}, \${opacity})\`;
  }

  const STROKE_COLOR = 'rgba(0, 0, 0, 0.5)';
  const STROKE_WIDTH = 1;

  // Show file:// protocol error
  function showFileProtocolError() {
    errorBox.innerHTML = \`
      <h2>Cannot Load Data</h2>
      <p><strong>Browsers block fetch() requests from file:// protocol for security.</strong></p>
      <p>To view this map, you need to run a local web server:</p>
      <ol>
        <li>Open a terminal in the repository root directory</li>
        <li>Run: <code>npx http-server -p 8080</code></li>
        <li>Open: <code>http://localhost:8080/data/derived/substrate_viewer/index.html</code></li>
      </ol>
    \`;
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
    html += \`<div class="tooltip-line"><strong>SID:</strong> \${sid}</div>\`;
    
    if (indexEntry && indexEntry.name) {
      html += \`<div class="tooltip-line"><strong>Name:</strong> \${indexEntry.name}</div>\`;
    }
    
    // Provenance
    if (indexEntry && indexEntry.provenance) {
      html += \`<div class="tooltip-line"><strong>Provenance:</strong> \${indexEntry.provenance}</div>\`;
    }
    
    // Majority
    if (indexEntry && indexEntry.majority) {
      html += \`<div class="tooltip-line"><strong>Majority:</strong> \${indexEntry.majority}</div>\`;
    } else {
      html += \`<div class="tooltip-line"><strong>Majority:</strong> unknown</div>\`;
    }
    
    // Composition breakdown (when ordering_mode is "named")
    if (indexEntry && indexEntry.shares && dataIndex && dataIndex.meta.ordering_mode === 'named') {
      html += '<div class="tooltip-line"><strong>Composition:</strong></div>';
      const shares = indexEntry.shares;
      if (shares.bosniak !== undefined) html += \`<div class="tooltip-line">  Bosniak: \${(shares.bosniak * 100).toFixed(1)}%</div>\`;
      if (shares.croat !== undefined) html += \`<div class="tooltip-line">  Croat: \${(shares.croat * 100).toFixed(1)}%</div>\`;
      if (shares.serb !== undefined) html += \`<div class="tooltip-line">  Serb: \${(shares.serb * 100).toFixed(1)}%</div>\`;
      if (shares.other !== undefined) html += \`<div class="tooltip-line">  Other: \${(shares.other * 100).toFixed(1)}%</div>\`;
    }
    
    // If unknown, show why
    if (indexEntry && indexEntry.majority === 'unknown') {
      if (indexEntry.provenance === 'no_settlement_census') {
        html += \`<div class="tooltip-line" style="color: #ffcccc;"><strong>Reason:</strong> No settlement-level census data</div>\`;
      } else if (indexEntry.provenance === 'ambiguous_ordering') {
        html += \`<div class="tooltip-line" style="color: #ffcccc;"><strong>Reason:</strong> Census ordering ambiguous</div>\`;
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
        html += \`<div class="legend-item">
          <span><span class="legend-color" style="background: \${colorHex}"></span>\${label}</span>
          <span>\${count}</span>
        </div>\`;
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
    // Detect file:// protocol and show in-page error
    if (window.location.protocol === 'file:') {
      showFileProtocolError();
      console.error('CORS error: file:// protocol detected. Use a local web server instead.');
      return;
    }
    
    try {
      // Load geometry
      const geoResponse = await fetch(dataIndex.meta.geometry_path);
      if (!geoResponse.ok) {
        throw new Error(\`Failed to load geometry: \${geoResponse.statusText}\`);
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
      if (window.location.protocol === 'file:') {
        showFileProtocolError();
      } else {
        const errorMsg = \`Failed to load data: \${err instanceof Error ? err.message : String(err)}\`;
        errorBox.innerHTML = \`<h2>Error Loading Data</h2><p>\${errorMsg}</p>\`;
        errorBox.style.display = 'block';
      }
    }
  }

  // Load index first, then geometry
  // Detect file:// protocol before attempting fetch
  if (window.location.protocol === 'file:') {
    showFileProtocolError();
  } else {
    fetch('./data_index.json')
      .then(response => {
        if (!response.ok) {
          throw new Error(\`Failed to load index: \${response.statusText}\`);
        }
        return response.json();
      })
      .then(index => {
        dataIndex = index;
        return loadData();
      })
      .catch(err => {
        console.error('Error loading index:', err);
        if (window.location.protocol === 'file:') {
          showFileProtocolError();
        } else {
          const errorMsg = \`Failed to load index: \${err instanceof Error ? err.message : String(err)}\`;
          errorBox.innerHTML = \`<h2>Error Loading Index</h2><p>\${errorMsg}</p>\`;
          errorBox.style.display = 'block';
        }
      });
  }

})();`;
  
  writeFileSync(viewerJsPath, viewerJs, 'utf8');
  process.stdout.write(`Wrote viewer.js to ${viewerJsPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Features: ${index.meta.counts.features}\n`);
  process.stdout.write(`  Settlement census key: ${index.meta.settlement_census_key || 'null'}\n`);
  process.stdout.write(`  Ordering mode: ${index.meta.ordering_mode}\n`);
  process.stdout.write(`  Matched settlement census: ${index.meta.counts.matched_settlement_census}\n`);
  process.stdout.write(`  Unknown: ${index.meta.counts.unknown}\n`);
  process.stdout.write(`  Majority counts: bosniak=${index.meta.counts.majority.bosniak}, serb=${index.meta.counts.majority.serb}, croat=${index.meta.counts.majority.croat}, other=${index.meta.counts.majority.other}, unknown=${index.meta.counts.majority.unknown}\n`);
  process.stdout.write(`  Global bbox: [${globalMinx.toFixed(6)}, ${globalMiny.toFixed(6)}, ${globalMaxx.toFixed(6)}, ${globalMaxy.toFixed(6)}]\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
