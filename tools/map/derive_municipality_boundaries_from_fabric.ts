/**
 * Derive Municipality Boundaries from Settlement Polygon Fabric
 * 
 * Extracts municipality boundaries by cancelling internal shared edges in the polygon fabric.
 * This avoids boolean union failures and naturally supports non-contiguous municipalities.
 * 
 * CRITICAL RULES:
 * - Do NOT assume polygon↔settlement 1:1 mapping
 * - Do NOT invent municipalities
 * - Municipality identity must come from explicit municipality reference field in polygon fabric
 * - Determinism is mandatory (stable ordering, no timestamps, no randomness)
 * - No boolean union - only edge cancellation
 * 
 * Inputs:
 * - data/derived/polygon_fabric.geojson (or polygon_fabric_with_mid.geojson if available)
 * - data/derived/settlements_meta.csv (for municipality names)
 * 
 * Outputs:
 * - data/derived/municipality_boundaries_from_fabric.geojson
 * - data/derived/municipality_boundaries_derivation_report.json
 * - data/derived/municipality_boundaries_unstitchable.csv
 * 
 * Usage:
 *   npm run map:derive:muni-boundaries-from-fabric
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Derive municipality boundaries by shared-edge cancellation on fabric (no union), deterministic");
loadLedger();
assertLedgerFresh("Derive municipality boundaries from polygon fabric via edge cancellation (no union)");

// ============================================================================
// Constants
// ============================================================================

const POLYGONS_FABRIC_PATH = resolve('data/derived/polygon_fabric.geojson');
const POLYGONS_WITH_MID_PATH = resolve('data/derived/polygon_fabric_with_mid.geojson');
const SETTLEMENTS_META_PATH = resolve('data/derived/settlements_meta.csv');
const OUTPUT_GEOJSON_PATH = resolve('data/derived/municipality_boundaries_from_fabric.geojson');
const OUTPUT_REPORT_PATH = resolve('data/derived/municipality_boundaries_derivation_report.json');
const OUTPUT_UNSTITCHABLE_CSV_PATH = resolve('data/derived/municipality_boundaries_unstitchable.csv');
const OUTPUT_VIEWER_PATH = resolve('data/derived/municipality_boundaries_viewer.html');
const COORDINATE_PRECISION = 3;

// ============================================================================
// Types
// ============================================================================

interface Edge {
  key: string;
  pointA: [number, number];
  pointB: [number, number];
  municipalities: Set<string>;
}

interface BoundarySegment {
  pointA: [number, number];
  pointB: [number, number];
  mun_id: string;
}

interface MunicipalityBoundary {
  mun_id: string;
  name: string | null;
  segments: BoundarySegment[];
  paths: number[][][]; // Array of paths, each path is array of [x,y] points
  segment_count: number;
  path_count: number;
  notes: string[];
}

interface DerivationReport {
  polygons_loaded: number;
  municipalities: number;
  eps: number;
  boundary_edges_total: number;
  per_muni: Array<{
    mun_id: string;
    polygon_count: number;
    boundary_segments: number;
    stitched_paths: number;
    notes?: string[];
  }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Compute bbox from polygon fabric
 */
function computeBboxFromFabric(fc: turf.FeatureCollection<turf.Polygon>): { width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const feature of fc.features) {
    const bbox = turf.bbox(feature);
    minX = Math.min(minX, bbox[0]);
    minY = Math.min(minY, bbox[1]);
    maxX = Math.max(maxX, bbox[2]);
    maxY = Math.max(maxY, bbox[3]);
  }
  
  return {
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Quantize coordinate to grid step
 */
function quantize(coord: number, eps: number): number {
  return Math.round(coord / eps) * eps;
}

/**
 * Create canonical edge key from two points
 */
function createEdgeKey(pointA: [number, number], pointB: [number, number]): string {
  // Normalize to ensure consistent ordering
  const [a, b] = pointA[0] < pointB[0] || (pointA[0] === pointB[0] && pointA[1] < pointB[1])
    ? [pointA, pointB]
    : [pointB, pointA];
  return `${a[0]},${a[1]}|${b[0]},${b[1]}`;
}

/**
 * Extract edges from polygon ring
 */
function extractEdgesFromRing(ring: number[][], eps: number): Array<{ pointA: [number, number]; pointB: [number, number] }> {
  const edges: Array<{ pointA: [number, number]; pointB: [number, number] }> = [];
  
  for (let i = 0; i < ring.length; i++) {
    const nextI = (i + 1) % ring.length;
    const pointA: [number, number] = [
      quantize(ring[i][0], eps),
      quantize(ring[i][1], eps)
    ];
    const pointB: [number, number] = [
      quantize(ring[nextI][0], eps),
      quantize(ring[nextI][1], eps)
    ];
    
    // Skip zero-length edges
    if (pointA[0] === pointB[0] && pointA[1] === pointB[1]) {
      continue;
    }
    
    edges.push({ pointA, pointB });
  }
  
  return edges;
}

/**
 * Stitch segments into paths
 */
function stitchSegmentsIntoPaths(segments: BoundarySegment[]): { paths: number[][][]; unstitchable: string[] } {
  if (segments.length === 0) {
    return { paths: [], unstitchable: [] };
  }
  
  const paths: number[][][] = [];
  const unstitchable: string[] = [];
  const used = new Set<number>();
  
  // Build endpoint to segment map
  const endpointMap = new Map<string, Array<{ segmentIdx: number; isStart: boolean }>>();
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const keyA = `${seg.pointA[0]},${seg.pointA[1]}`;
    const keyB = `${seg.pointB[0]},${seg.pointB[1]}`;
    
    if (!endpointMap.has(keyA)) {
      endpointMap.set(keyA, []);
    }
    if (!endpointMap.has(keyB)) {
      endpointMap.set(keyB, []);
    }
    
    endpointMap.get(keyA)!.push({ segmentIdx: i, isStart: true });
    endpointMap.get(keyB)!.push({ segmentIdx: i, isStart: false });
  }
  
  // Process all segments, building paths
  while (used.size < segments.length) {
    // Find first unused segment
    let startIdx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (!used.has(i)) {
        startIdx = i;
        break;
      }
    }
    
    if (startIdx === -1) break;
    
    const path: number[][] = [];
    let currentSegIdx = startIdx;
    let currentPoint: [number, number] | null = null;
    
    // Start path from first endpoint
    const startSeg = segments[startIdx];
    path.push([startSeg.pointA[0], startSeg.pointA[1]]);
    path.push([startSeg.pointB[0], startSeg.pointB[1]]);
    currentPoint = startSeg.pointB;
    used.add(startIdx);
    
    // Extend path forward
    let extended = true;
    while (extended) {
      extended = false;
      const currentKey = `${currentPoint[0]},${currentPoint[1]}`;
      const candidates = endpointMap.get(currentKey) || [];
      
      // Find next segment deterministically (lexicographic order by endpoint)
      let bestCandidate: { segmentIdx: number; isStart: boolean; nextPoint: [number, number] } | null = null;
      
      for (const candidate of candidates) {
        if (used.has(candidate.segmentIdx)) continue;
        
        const seg = segments[candidate.segmentIdx];
        const nextPoint = candidate.isStart ? seg.pointB : seg.pointA;
        const nextKey = `${nextPoint[0]},${nextPoint[1]}`;
        
        if (!bestCandidate || nextKey < `${bestCandidate.nextPoint[0]},${bestCandidate.nextPoint[1]}`) {
          bestCandidate = {
            segmentIdx: candidate.segmentIdx,
            isStart: candidate.isStart,
            nextPoint
          };
        }
      }
      
      if (bestCandidate) {
        const seg = segments[bestCandidate.segmentIdx];
        path.push([bestCandidate.nextPoint[0], bestCandidate.nextPoint[1]]);
        currentPoint = bestCandidate.nextPoint;
        used.add(bestCandidate.segmentIdx);
        extended = true;
      }
    }
    
    // Try to extend path backward from start
    currentPoint = [startSeg.pointA[0], startSeg.pointA[1]];
    extended = true;
    while (extended) {
      extended = false;
      const currentKey = `${currentPoint[0]},${currentPoint[1]}`;
      const candidates = endpointMap.get(currentKey) || [];
      
      let bestCandidate: { segmentIdx: number; isStart: boolean; prevPoint: [number, number] } | null = null;
      
      for (const candidate of candidates) {
        if (used.has(candidate.segmentIdx)) continue;
        
        const seg = segments[candidate.segmentIdx];
        const prevPoint = candidate.isStart ? seg.pointA : seg.pointB;
        const prevKey = `${prevPoint[0]},${prevPoint[1]}`;
        
        if (!bestCandidate || prevKey < `${bestCandidate.prevPoint[0]},${bestCandidate.prevPoint[1]}`) {
          bestCandidate = {
            segmentIdx: candidate.segmentIdx,
            isStart: candidate.isStart,
            prevPoint
          };
        }
      }
      
      if (bestCandidate) {
        path.unshift([bestCandidate.prevPoint[0], bestCandidate.prevPoint[1]]);
        currentPoint = bestCandidate.prevPoint;
        used.add(bestCandidate.segmentIdx);
        extended = true;
      }
    }
    
    if (path.length >= 2) {
      paths.push(path);
    }
  }
  
  // Collect unstitchable segments (unused) - should be rare
  for (let i = 0; i < segments.length; i++) {
    if (!used.has(i)) {
      unstitchable.push(`Segment ${i}: [${segments[i].pointA[0]},${segments[i].pointA[1]}] -> [${segments[i].pointB[0]},${segments[i].pointB[1]}]`);
    }
  }
  
  return { paths, unstitchable };
}

/**
 * Load municipality names from settlements_meta.csv
 */
async function loadMunicipalityNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const content = await readFile(SETTLEMENTS_META_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('sid,'));
    
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 4) {
        const mid = parts[2]?.trim();
        const name = parts[3]?.trim();
        if (mid && mid !== '' && name && name !== '') {
          if (!names.has(mid)) {
            names.set(mid, name);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Warning: Could not load municipality names: ${err instanceof Error ? err.message : String(err)}`);
  }
  return names;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Deriving municipality boundaries from settlement polygon fabric...\n');
  
  try {
    // Load polygon fabric (prefer with_mid if available)
    let polygonFC: turf.FeatureCollection<turf.Polygon> | null = null;
    let useMid = false;
    
    try {
      await access(POLYGONS_WITH_MID_PATH, constants.F_OK);
      const content = await readFile(POLYGONS_WITH_MID_PATH, 'utf8');
      polygonFC = JSON.parse(content);
      const polygonsWithMid = polygonFC.features.filter(f => f.properties?.mid != null && f.properties.mid !== '').length;
      if (polygonsWithMid > 0) {
        useMid = true;
        console.log(`Loaded ${polygonFC.features.length} polygons from ${POLYGONS_WITH_MID_PATH} (${polygonsWithMid} have mid)`);
      } else {
        throw new Error('No polygons with mid found');
      }
    } catch {
      // Fallback to polygon_fabric.geojson
      try {
        const content = await readFile(POLYGONS_FABRIC_PATH, 'utf8');
        polygonFC = JSON.parse(content);
        console.log(`Loaded ${polygonFC.features.length} polygons from ${POLYGONS_FABRIC_PATH}`);
      } catch (err) {
        throw new Error(`Failed to load polygon fabric: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // Compute bbox and EPS
    const bbox = computeBboxFromFabric(polygonFC);
    const maxDim = Math.max(bbox.width, bbox.height);
    const epsRaw = maxDim * 1e-7;
    const eps = Math.max(1e-6, Math.min(1e-3, epsRaw));
    
    console.log(`Normalization parameters:`);
    console.log(`  Bbox: width=${bbox.width.toFixed(3)}, height=${bbox.height.toFixed(3)}`);
    console.log(`  EPS: ${eps} (clamped from ${epsRaw})`);
    
    const municipalityNames = await loadMunicipalityNames();
    
    // Group polygons by municipality
    const polygonsByMuni = new Map<string, turf.Feature<turf.Polygon>[]>();
    
    for (const feature of polygonFC.features) {
      let muniId: string | null = null;
      
      if (useMid) {
        const mid = feature.properties?.mid;
        if (mid != null && mid !== '' && typeof mid === 'string') {
          muniId = String(mid).trim();
        }
      } else {
        const munCode = feature.properties?.mun_code;
        if (munCode != null && munCode !== '' && typeof munCode === 'string') {
          muniId = String(munCode).trim();
        }
      }
      
      if (muniId) {
        if (!polygonsByMuni.has(muniId)) {
          polygonsByMuni.set(muniId, []);
        }
        polygonsByMuni.get(muniId)!.push(feature);
      }
    }
    
    console.log(`\nMunicipalities with polygons: ${polygonsByMuni.size}`);
    
    // Build edge map with occurrence counts per municipality
    console.log('Building edge map...');
    const edgeMap = new Map<string, Edge>();
    const edgeCountsByMuni = new Map<string, Map<string, number>>(); // muniId -> edgeKey -> count
    
    for (const [muniId, polygons] of polygonsByMuni.entries()) {
      if (!edgeCountsByMuni.has(muniId)) {
        edgeCountsByMuni.set(muniId, new Map());
      }
      const counts = edgeCountsByMuni.get(muniId)!;
      
      for (const polygon of polygons) {
        const coords = polygon.geometry.coordinates;
        for (const ring of coords) {
          const edges = extractEdgesFromRing(ring, eps);
          
          for (const edge of edges) {
            const key = createEdgeKey(edge.pointA, edge.pointB);
            
            if (!edgeMap.has(key)) {
              edgeMap.set(key, {
                key,
                pointA: edge.pointA,
                pointB: edge.pointB,
                municipalities: new Set()
              });
            }
            
            edgeMap.get(key)!.municipalities.add(muniId);
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
      }
    }
    
    console.log(`Total edges in fabric: ${edgeMap.size}`);
    
    // Extract boundary edges (edges that appear in only one municipality or appear in multiple municipalities)
    console.log('Extracting boundary edges...');
    const boundarySegmentsByMuni = new Map<string, BoundarySegment[]>();
    
    for (const [key, edge] of edgeMap.entries()) {
      const muniSet = Array.from(edge.municipalities);
      
      // Boundary edge if:
      // 1. Appears in multiple municipalities (inter-municipality border)
      // 2. Appears only once in a municipality (outer boundary of fabric)
      // NOT boundary if: appears twice in same municipality (internal edge between adjacent polygons)
      
      if (muniSet.length > 1) {
        // Inter-municipality border - add to all municipalities
        for (const muniId of muniSet) {
          if (!boundarySegmentsByMuni.has(muniId)) {
            boundarySegmentsByMuni.set(muniId, []);
          }
          boundarySegmentsByMuni.get(muniId)!.push({
            pointA: edge.pointA,
            pointB: edge.pointB,
            mun_id: muniId
          });
        }
      } else if (muniSet.length === 1) {
        // Check if this edge appears multiple times in the same municipality
        const muniId = muniSet[0];
        const counts = edgeCountsByMuni.get(muniId);
        const count = counts?.get(key) || 0;
        
        // If appears only once, it's a boundary edge
        if (count === 1) {
          if (!boundarySegmentsByMuni.has(muniId)) {
            boundarySegmentsByMuni.set(muniId, []);
          }
          boundarySegmentsByMuni.get(muniId)!.push({
            pointA: edge.pointA,
            pointB: edge.pointB,
            mun_id: muniId
          });
        }
        // If appears twice or more, it's an internal edge (shared between adjacent polygons in same municipality) - skip
      }
    }
    
    console.log(`Municipalities with boundary edges: ${boundarySegmentsByMuni.size}`);
    
    // Stitch segments into paths for each municipality
    console.log('Stitching boundary segments into paths...');
    const boundaries: MunicipalityBoundary[] = [];
    const unstitchableIssues: Array<{ mun_id: string; issue: string; detail: string }> = [];
    let totalBoundaryEdges = 0;
    
    const sortedMuniIds = Array.from(polygonsByMuni.keys()).sort();
    
    for (const muniId of sortedMuniIds) {
      const segments = boundarySegmentsByMuni.get(muniId) || [];
      totalBoundaryEdges += segments.length;
      
      const { paths, unstitchable } = stitchSegmentsIntoPaths(segments);
      
      const name = municipalityNames.get(muniId) || null;
      const notes: string[] = [];
      
      if (unstitchable.length > 0) {
        notes.push(`${unstitchable.length} unstitchable segments`);
        for (const detail of unstitchable) {
          unstitchableIssues.push({
            mun_id: muniId,
            issue: 'unstitchable_segment',
            detail
          });
        }
      }
      
      if (paths.length === 0 && segments.length > 0) {
        notes.push('No paths could be stitched from segments');
      }
      
      boundaries.push({
        mun_id: muniId,
        name,
        segments,
        paths,
        segment_count: segments.length,
        path_count: paths.length,
        notes
      });
    }
    
    // Generate GeoJSON
    const features: turf.Feature<turf.MultiLineString>[] = [];
    let featureIndex = 0;
    
    for (const boundary of boundaries) {
      if (boundary.paths.length === 0) {
        continue; // Skip municipalities with no stitched paths
      }
      
      // Convert paths to MultiLineString coordinates
      const coordinates: number[][][] = boundary.paths.map(path =>
        path.map(pt => [pt[0], pt[1]])
      );
      
      const feature = turf.multiLineString(coordinates, {
        mun_id: boundary.mun_id,
        name: boundary.name,
        source: 'boundary_from_fabric_edges',
        eps: eps,
        segment_count: boundary.segment_count,
        path_count: boundary.path_count,
        feature_index: featureIndex++
      });
      
      features.push(feature);
    }
    
    const outputFC: turf.FeatureCollection<turf.MultiLineString> = {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: 'LOCAL_PIXELS_V2'
        }
      },
      features
    };
    
    await writeFile(OUTPUT_GEOJSON_PATH, JSON.stringify(outputFC, null, 2), 'utf8');
    console.log(`\n✓ Wrote ${features.length} municipality boundaries to ${OUTPUT_GEOJSON_PATH}`);
    
    // Generate report
    const report: DerivationReport = {
      polygons_loaded: polygonFC.features.length,
      municipalities: polygonsByMuni.size,
      eps: eps,
      boundary_edges_total: totalBoundaryEdges,
      per_muni: boundaries.map(b => ({
        mun_id: b.mun_id,
        polygon_count: polygonsByMuni.get(b.mun_id)?.length || 0,
        boundary_segments: b.segment_count,
        stitched_paths: b.path_count,
        notes: b.notes.length > 0 ? b.notes : undefined
      }))
    };
    
    await writeFile(OUTPUT_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`✓ Wrote derivation report to ${OUTPUT_REPORT_PATH}`);
    
    // Write unstitchable CSV
    if (unstitchableIssues.length > 0) {
      const csvLines = ['mun_id,issue,detail'];
      for (const issue of unstitchableIssues) {
        const detail = issue.detail.replace(/"/g, '""');
        csvLines.push(`${issue.mun_id},"${issue.issue}","${detail}"`);
      }
      await writeFile(OUTPUT_UNSTITCHABLE_CSV_PATH, csvLines.join('\n') + '\n', 'utf8');
      console.log(`✓ Wrote ${unstitchableIssues.length} unstitchable issues to ${OUTPUT_UNSTITCHABLE_CSV_PATH}`);
    } else {
      await writeFile(OUTPUT_UNSTITCHABLE_CSV_PATH, 'mun_id,issue,detail\n', 'utf8');
      console.log(`✓ Wrote empty unstitchable CSV (no issues)`);
    }
    
    // Generate viewer
    await generateViewer(outputFC, report);
    console.log(`✓ Generated viewer at ${OUTPUT_VIEWER_PATH}`);
    
    // Summary
    console.log(`\nSummary:`);
    console.log(`  Polygons loaded: ${report.polygons_loaded}`);
    console.log(`  Municipalities: ${report.municipalities}`);
    console.log(`  EPS: ${report.eps}`);
    console.log(`  Total boundary edges: ${report.boundary_edges_total}`);
    console.log(`  Municipalities with boundaries: ${features.length}`);
    console.log(`  Unstitchable issues: ${unstitchableIssues.length}`);
    
  } catch (err) {
    console.error('Error deriving municipality boundaries:', err);
    process.exit(1);
  }
}

/**
 * Generate HTML viewer
 */
async function generateViewer(
  geojson: turf.FeatureCollection<turf.MultiLineString>,
  report: DerivationReport
): Promise<void> {
  const geojsonData = JSON.stringify(geojson);
  const reportData = JSON.stringify(report);
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Boundaries from Fabric</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    
    #canvas-container {
      flex: 1;
      position: relative;
      background: #1a1a1a;
    }
    
    #map-canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    #sidebar {
      width: 300px;
      background: #2d2d2d;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    #sidebar-header {
      padding: 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #444;
    }
    
    #sidebar-header h1 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    
    #sidebar-header p {
      font-size: 12px;
      color: #aaa;
    }
    
    #sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    
    .section {
      margin-bottom: 24px;
    }
    
    .section h2 {
      font-size: 14px;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 12px;
    }
    
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #333;
    }
    
    .stat-label {
      color: #aaa;
    }
    
    .stat-value {
      font-weight: 600;
    }
    
    .toggle {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .toggle input {
      margin-right: 8px;
    }
    
    .toggle label {
      cursor: pointer;
    }
    
    #info-panel {
      background: #1a1a1a;
      padding: 12px;
      border-radius: 4px;
      margin-top: 16px;
      display: none;
    }
    
    #info-panel.visible {
      display: block;
    }
    
    #info-panel h3 {
      font-size: 14px;
      margin-bottom: 8px;
    }
    
    #info-panel p {
      font-size: 12px;
      margin: 4px 0;
      color: #ccc;
    }
  </style>
</head>
<body>
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Municipality Boundaries</h1>
      <p>Edge-derived from Polygon Fabric</p>
    </div>
    <div id="sidebar-content">
      <div class="section">
        <h2>Statistics</h2>
        <div class="stat">
          <span class="stat-label">Municipalities</span>
          <span class="stat-value">${report.municipalities}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Polygons loaded</span>
          <span class="stat-value">${report.polygons_loaded}</span>
        </div>
        <div class="stat">
          <span class="stat-label">EPS</span>
          <span class="stat-value">${report.eps}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Boundary edges</span>
          <span class="stat-value">${report.boundary_edges_total}</span>
        </div>
      </div>
      
      <div class="section">
        <h2>Layers</h2>
        <div class="toggle">
          <input type="checkbox" id="toggle-boundaries" checked>
          <label for="toggle-boundaries">Municipality Boundaries</label>
        </div>
      </div>
      
      <div id="info-panel">
        <h3>Municipality Info</h3>
        <p id="info-mun-id"></p>
        <p id="info-name"></p>
        <p id="info-segments"></p>
        <p id="info-paths"></p>
      </div>
    </div>
  </div>
  
  <div id="canvas-container">
    <canvas id="map-canvas"></canvas>
  </div>
  
  <script>
    const geojsonData = ${geojsonData};
    const reportData = ${reportData};
    
    const canvas = document.getElementById('map-canvas');
    const ctx = canvas.getContext('2d');
    const toggleBoundaries = document.getElementById('toggle-boundaries');
    const infoPanel = document.getElementById('info-panel');
    
    let bounds = null;
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let showBoundaries = true;
    
    // Calculate bounds
    function calculateBounds() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      for (const feature of geojsonData.features) {
        for (const path of feature.geometry.coordinates) {
          for (const [x, y] of path) {
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
        }
      }
      
      return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }
    
    // Initialize
    function init() {
      bounds = calculateBounds();
      resizeCanvas();
      fitToBounds();
      render();
    }
    
    function resizeCanvas() {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      render();
    }
    
    function fitToBounds() {
      const padding = 50;
      const scaleX = (canvas.width - padding * 2) / bounds.width;
      const scaleY = (canvas.height - padding * 2) / bounds.height;
      scale = Math.min(scaleX, scaleY);
      offsetX = (canvas.width - bounds.width * scale) / 2 - bounds.minX * scale;
      offsetY = (canvas.height - bounds.height * scale) / 2 - bounds.minY * scale;
    }
    
    function worldToScreen(x, y) {
      return {
        x: x * scale + offsetX,
        y: y * scale + offsetY
      };
    }
    
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (showBoundaries) {
        ctx.strokeStyle = '#51cf66';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        
        for (const feature of geojsonData.features) {
          for (const path of feature.geometry.coordinates) {
            if (path.length < 2) continue;
            
            ctx.beginPath();
            const start = worldToScreen(path[0][0], path[0][1]);
            ctx.moveTo(start.x, start.y);
            
            for (let i = 1; i < path.length; i++) {
              const pt = worldToScreen(path[i][0], path[i][1]);
              ctx.lineTo(pt.x, pt.y);
            }
            
            ctx.stroke();
          }
        }
      }
    }
    
    function findFeatureAt(x, y) {
      const worldX = (x - offsetX) / scale;
      const worldY = (y - offsetY) / scale;
      
      // Simple point-on-line check (within tolerance)
      const tolerance = 5 / scale;
      
      for (const feature of geojsonData.features) {
        for (const path of feature.geometry.coordinates) {
          for (let i = 0; i < path.length - 1; i++) {
            const [x1, y1] = path[i];
            const [x2, y2] = path[i + 1];
            
            // Distance from point to line segment
            const A = worldX - x1;
            const B = worldY - y1;
            const C = x2 - x1;
            const D = y2 - y1;
            const dot = A * C + B * D;
            const lenSq = C * C + D * D;
            let param = -1;
            if (lenSq !== 0) param = dot / lenSq;
            
            let xx, yy;
            if (param < 0) {
              xx = x1;
              yy = y1;
            } else if (param > 1) {
              xx = x2;
              yy = y2;
            } else {
              xx = x1 + param * C;
              yy = y1 + param * D;
            }
            
            const dx = worldX - xx;
            const dy = worldY - yy;
            const dist = Math.sqrt(dx * dx + dy * dy);
            
            if (dist < tolerance) {
              return feature;
            }
          }
        }
      }
      return null;
    }
    
    // Event handlers
    toggleBoundaries.addEventListener('change', (e) => {
      showBoundaries = e.target.checked;
      render();
    });
    
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    
    canvas.addEventListener('mousemove', (e) => {
      if (isDragging) {
        offsetX += e.clientX - lastX;
        offsetY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        render();
      } else {
        const feature = findFeatureAt(e.offsetX, e.offsetY);
        if (feature) {
          const props = feature.properties || {};
          document.getElementById('info-mun-id').textContent = 'Municipality ID: ' + (props.mun_id || 'N/A');
          document.getElementById('info-name').textContent = 'Name: ' + (props.name || 'N/A');
          document.getElementById('info-segments').textContent = 'Segments: ' + (props.segment_count || 0);
          document.getElementById('info-paths').textContent = 'Paths: ' + (props.path_count || 0);
          infoPanel.classList.add('visible');
        } else {
          infoPanel.classList.remove('visible');
        }
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
    });
    
    canvas.addEventListener('click', (e) => {
      const feature = findFeatureAt(e.offsetX, e.offsetY);
      if (feature) {
        const props = feature.properties || {};
        console.log('Clicked municipality:', props);
      }
    });
    
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const mouseX = e.offsetX;
      const mouseY = e.offsetY;
      const worldX = (mouseX - offsetX) / scale;
      const worldY = (mouseY - offsetY) / scale;
      
      scale *= delta;
      offsetX = mouseX - worldX * scale;
      offsetY = mouseY - worldY * scale;
      render();
    });
    
    window.addEventListener('resize', () => {
      resizeCanvas();
    });
    
    init();
  </script>
</body>
</html>`;
  
  await writeFile(OUTPUT_VIEWER_PATH, html, 'utf8');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
