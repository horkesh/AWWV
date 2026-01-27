/**
 * Diagnose Touch Pairs: Point-Touch vs Shared Border Classification
 * 
 * VALIDATION-ONLY DIAGNOSTIC FOR PHASE 1 ADJACENCY GRAPH
 * 
 * This script classifies "touching" settlement pairs (boundaryDist=0) into:
 * - POINT_TOUCH_ONLY (no shared colinear overlap length)
 * - SHARED_BORDER (overlap length > 0)
 * 
 * This determines whether sparse adjacency is mostly correct (point touches only)
 * or a detection failure (shared borders not detected).
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances/overlap.
 * 
 * Usage:
 *   npm run map:diagnose:touchclass
 *   or: tsx scripts/map/diagnose_touch_pairs_point_vs_border.ts
 * 
 * Outputs:
 *   - data/derived/settlement_graph.touch_classification.audit.json
 *   - data/derived/settlement_graph.touch_classification.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 diagnostics: classify boundaryDist=0 near-miss pairs into point-touch vs shared-border-length and explain sparse adjacency");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface SettlementGraph {
  schema_version: number;
  source: string;
  nodes: number;
  edges: number;
  graph: Record<string, Array<{ sid: string; shared_border_length: number }>>;
  edge_list: Array<{ a: string; b: string; shared_border_length: number }>;
}

interface SettlementData {
  sid: string;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
  boundarySample: Point[];
  fullSegments: Array<{ p1: Point; p2: Point; len: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } }>;
}

interface Segment {
  p1: Point;
  p2: Point;
  len: number;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

interface TouchPair {
  a: string;
  b: string;
  boundaryDist: number;
  overlapLen: number;
  classification: 'POINT_TOUCH_ONLY' | 'SHARED_BORDER';
}

interface AuditReport {
  schema_version: number;
  source: string;
  v1_graph: string;
  v2_graph: string;
  counts: {
    evaluated_pairs: number;
    touching_pairs: number;
    point_touch_only_pairs: number;
    shared_border_pairs: number;
  };
  overlapLen_stats: {
    min: number;
    p50: number;
    p90: number;
    max: number;
  } | null;
  coverage: {
    shared_border_in_v1: number;
    shared_border_in_v2: number;
  };
  top_shared_border_pairs: Array<{ a: string; b: string; overlapLen: number }>;
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    vertex_cap_applied_count: number;
    skipped_large_geometry_count: number;
  };
}

// Parameters
const MAX_VERTS_PER_SETTLEMENT = 5000; // Higher cap for full segment extraction
const GRID_DIVISOR = 64;
const TINY_TOL_FACTOR = 10; // EPS / 10 for "touching" threshold

/**
 * Extract settlement ID from feature properties
 */
function extractSid(properties: Record<string, unknown>): string | null {
  if (properties.sid !== null && properties.sid !== undefined) {
    return String(properties.sid);
  }
  if (properties.settlement_id !== null && properties.settlement_id !== undefined) {
    return String(properties.settlement_id);
  }
  return null;
}

/**
 * Check if geometry is Polygon or MultiPolygon
 */
function isPolygonGeometry(geom: GeoJSONFeature['geometry']): boolean {
  return geom.type === 'Polygon' || geom.type === 'MultiPolygon';
}

/**
 * Compute bounding box for a polygon geometry
 */
function computeBbox(geom: GeoJSONFeature['geometry']): { minx: number; miny: number; maxx: number; maxy: number } | null {
  if (!isPolygonGeometry(geom)) {
    return null;
  }
  
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  
  function addPoint([x, y]: Point): void {
    if (isFinite(x) && isFinite(y)) {
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  }
  
  function processRing(ring: Ring): void {
    for (const point of ring) {
      addPoint(point);
    }
  }
  
  function processPolygon(poly: Polygon): void {
    for (const ring of poly) {
      processRing(ring);
    }
  }
  
  if (geom.type === 'Polygon') {
    processPolygon(geom.coordinates as Polygon);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates as MultiPolygon) {
      processPolygon(poly);
    }
  }
  
  if (minx === Infinity) {
    return null;
  }
  
  return { minx, miny, maxx, maxy };
}

/**
 * Extract boundary sample from polygon geometry (outer rings only, for boundary distance)
 */
function extractBoundarySample(geom: GeoJSONFeature['geometry']): Point[] {
  const allPoints: Point[] = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    if (polygon.length > 0) {
      const outerRing = polygon[0];
      allPoints.push(...outerRing);
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as MultiPolygon;
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        const outerRing = polygon[0];
        allPoints.push(...outerRing);
      }
    }
  }
  
  return allPoints;
}

/**
 * Extract all boundary segments from a polygon outer ring
 */
function extractSegmentsFromRing(ring: Ring): Array<{ p1: Point; p2: Point; len: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } }> {
  const segments: Array<{ p1: Point; p2: Point; len: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } }> = [];
  
  // Iterate consecutive pairs (ring is closed, so last point connects to first)
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    
    // Skip zero-length segments
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) {
      continue;
    }
    
    const bbox = {
      minx: Math.min(p1[0], p2[0]),
      miny: Math.min(p1[1], p2[1]),
      maxx: Math.max(p1[0], p2[0]),
      maxy: Math.max(p1[1], p2[1])
    };
    
    segments.push({ p1, p2, len, bbox });
  }
  
  return segments;
}

/**
 * Extract all boundary segments from a polygon geometry (outer rings only)
 */
function extractSegmentsFromGeometry(geom: GeoJSONFeature['geometry']): Array<{ p1: Point; p2: Point; len: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } }> {
  const segments: Array<{ p1: Point; p2: Point; len: number; bbox: { minx: number; miny: number; maxx: number; maxy: number } }> = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    if (polygon.length > 0) {
      const outerRing = polygon[0];
      segments.push(...extractSegmentsFromRing(outerRing));
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as MultiPolygon;
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        const outerRing = polygon[0];
        segments.push(...extractSegmentsFromRing(outerRing));
      }
    }
  }
  
  return segments;
}

/**
 * Compute EPS from dataset bounds (same formula as derive_settlement_graph_from_substrate.ts)
 */
function computeEPS(bbox: { minx: number; miny: number; maxx: number; maxy: number }): number {
  const width = bbox.maxx - bbox.minx;
  const height = bbox.maxy - bbox.miny;
  const maxDim = Math.max(width, height);
  
  let eps = maxDim * 1e-7;
  eps = Math.max(eps, 1e-9);
  eps = Math.min(eps, 1e-5);
  
  return eps;
}

/**
 * Compute bbox distance between two bounding boxes
 */
function computeBboxDistance(
  bboxA: { minx: number; miny: number; maxx: number; maxy: number },
  bboxB: { minx: number; miny: number; maxx: number; maxy: number }
): number {
  const dx = Math.max(0, Math.max(bboxA.minx - bboxB.maxx, bboxB.minx - bboxA.maxx));
  const dy = Math.max(0, Math.max(bboxA.miny - bboxB.maxy, bboxB.miny - bboxA.maxy));
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute point-to-segment distance
 */
function pointToSegmentDistance(p: Point, segStart: Point, segEnd: Point): number {
  const [px, py] = p;
  const [sx, sy] = segStart;
  const [ex, ey] = segEnd;
  
  const dx = ex - sx;
  const dy = ey - sy;
  const segLenSq = dx * dx + dy * dy;
  
  if (segLenSq === 0) {
    const dpx = px - sx;
    const dpy = py - sy;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  
  const t = Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / segLenSq));
  const projX = sx + t * dx;
  const projY = sy + t * dy;
  
  const dpx = px - projX;
  const dpy = py - projY;
  return Math.sqrt(dpx * dpx + dpy * dpy);
}

/**
 * Compute approximate boundary-to-boundary distance
 */
function computeBoundaryDistance(sampleA: Point[], sampleB: Point[]): number {
  let minDist = Infinity;
  
  // Distance from each point in A to segments in B
  for (let i = 0; i < sampleA.length; i++) {
    const pA = sampleA[i];
    for (let j = 0; j < sampleB.length - 1; j++) {
      const dist = pointToSegmentDistance(pA, sampleB[j], sampleB[j + 1]);
      minDist = Math.min(minDist, dist);
    }
    if (sampleB.length > 1) {
      const dist = pointToSegmentDistance(pA, sampleB[sampleB.length - 1], sampleB[0]);
      minDist = Math.min(minDist, dist);
    }
  }
  
  // Distance from each point in B to segments in A
  for (let i = 0; i < sampleB.length; i++) {
    const pB = sampleB[i];
    for (let j = 0; j < sampleA.length - 1; j++) {
      const dist = pointToSegmentDistance(pB, sampleA[j], sampleA[j + 1]);
      minDist = Math.min(minDist, dist);
    }
    if (sampleA.length > 1) {
      const dist = pointToSegmentDistance(pB, sampleA[sampleA.length - 1], sampleA[0]);
      minDist = Math.min(minDist, dist);
    }
  }
  
  return minDist === Infinity ? 0 : minDist;
}

/**
 * Check if two segment bboxes overlap
 */
function segmentBboxesOverlap(seg1: Segment, seg2: Segment): boolean {
  return !(seg1.bbox.maxx < seg2.bbox.minx || seg2.bbox.maxx < seg1.bbox.minx ||
           seg1.bbox.maxy < seg2.bbox.miny || seg2.bbox.maxy < seg1.bbox.miny);
}

/**
 * Compute cross product magnitude (for colinearity check)
 */
function crossProductMagnitude(p1: Point, p2: Point, p3: Point): number {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  
  const v1x = x2 - x1;
  const v1y = y2 - y1;
  const v2x = x3 - x1;
  const v2y = y3 - y1;
  
  return Math.abs(v1x * v2y - v1y * v2x);
}

/**
 * Compute perpendicular distance from point to line segment
 */
function pointToSegmentDistanceForColinear(p: Point, seg: Segment): number {
  const [px, py] = p;
  const [x1, y1] = seg.p1;
  const [x2, y2] = seg.p2;
  
  const dx = x2 - x1;
  const dy = y2 - y1;
  const segLenSq = dx * dx + dy * dy;
  
  if (segLenSq === 0) {
    const dpx = px - x1;
    const dpy = py - y1;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / segLenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  
  const dpx = px - projX;
  const dpy = py - projY;
  return Math.sqrt(dpx * dpx + dpy * dpy);
}

/**
 * Check if two segments are colinear within tolerance
 */
function areColinear(seg1: Segment, seg2: Segment, tol: number): boolean {
  const cross1 = crossProductMagnitude(seg1.p1, seg1.p2, seg2.p1);
  const cross2 = crossProductMagnitude(seg1.p1, seg1.p2, seg2.p2);
  
  if (cross1 > tol || cross2 > tol) {
    return false;
  }
  
  const dist1 = pointToSegmentDistanceForColinear(seg2.p1, seg1);
  const dist2 = pointToSegmentDistanceForColinear(seg2.p2, seg1);
  
  return dist1 <= tol && dist2 <= tol;
}

/**
 * Project point onto line defined by segment and return parameter t
 */
function projectPointOntoLine(p: Point, seg: Segment): number {
  const [px, py] = p;
  const [x1, y1] = seg.p1;
  const [x2, y2] = seg.p2;
  
  const dx = x2 - x1;
  const dy = y2 - y1;
  const segLenSq = dx * dx + dy * dy;
  
  if (segLenSq === 0) {
    return 0;
  }
  
  return ((px - x1) * dx + (py - y1) * dy) / segLenSq;
}

/**
 * Compute overlapping length between two colinear segments
 */
function computeOverlapLength(seg1: Segment, seg2: Segment): number {
  const t1_p1 = projectPointOntoLine(seg1.p1, seg1);
  const t1_p2 = projectPointOntoLine(seg1.p2, seg1);
  const t2_p1 = projectPointOntoLine(seg2.p1, seg1);
  const t2_p2 = projectPointOntoLine(seg2.p2, seg1);
  
  const seg1Min = Math.min(t1_p1, t1_p2);
  const seg1Max = Math.max(t1_p1, t1_p2);
  const seg1Span = seg1Max - seg1Min;
  
  if (seg1Span === 0) {
    return 0;
  }
  
  const t2Min = Math.min(t2_p1, t2_p2);
  const t2Max = Math.max(t2_p1, t2_p2);
  const norm2Min = (t2Min - seg1Min) / seg1Span;
  const norm2Max = (t2Max - seg1Min) / seg1Span;
  
  const overlapMin = Math.max(0, norm2Min);
  const overlapMax = Math.min(1, norm2Max);
  const overlapNorm = Math.max(0, overlapMax - overlapMin);
  
  return overlapNorm * seg1.len;
}

/**
 * Compute overlap length between two settlements
 */
function computeOverlapLengthBetweenSettlements(
  segsA: Segment[],
  segsB: Segment[],
  eps: number
): number {
  let totalOverlap = 0;
  const processedPairs = new Set<string>(); // Dedupe segment pairs
  
  for (const segA of segsA) {
    for (const segB of segsB) {
      // Fast reject: bbox overlap
      if (!segmentBboxesOverlap(segA, segB)) {
        continue;
      }
      
      // Create deterministic pair key
      const keyA = `${segA.p1[0]},${segA.p1[1]}|${segA.p2[0]},${segA.p2[1]}`;
      const keyB = `${segB.p1[0]},${segB.p1[1]}|${segB.p2[0]},${segB.p2[1]}`;
      const pairKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      
      if (processedPairs.has(pairKey)) {
        continue;
      }
      processedPairs.add(pairKey);
      
      // Check colinearity
      if (!areColinear(segA, segB, eps)) {
        continue;
      }
      
      // Compute overlap
      try {
        const overlap = computeOverlapLength(segA, segB);
        if (overlap > 0) {
          totalOverlap += overlap;
        }
      } catch (err) {
        // Skip on numeric issues
        continue;
      }
    }
  }
  
  return totalOverlap;
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const graphV1Path = resolve('data/derived/settlement_graph.json');
  const graphV2Path = resolve('data/derived/settlement_graph_v2.json');
  const outputJsonPath = resolve('data/derived/settlement_graph.touch_classification.audit.json');
  const outputTxtPath = resolve('data/derived/settlement_graph.touch_classification.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputJsonPath), { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrateGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrateGeoJSON.type}`);
  }
  
  // Load graphs
  process.stdout.write(`Loading ${graphV1Path}...\n`);
  const graphV1Content = readFileSync(graphV1Path, 'utf8');
  const graphV1 = JSON.parse(graphV1Content) as SettlementGraph;
  
  process.stdout.write(`Loading ${graphV2Path}...\n`);
  const graphV2Content = readFileSync(graphV2Path, 'utf8');
  const graphV2 = JSON.parse(graphV2Content) as SettlementGraph;
  
  // Build adjacency sets for coverage check
  const v1Adjacent = new Set<string>();
  for (const edge of graphV1.edge_list) {
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    v1Adjacent.add(key);
  }
  
  const v2Adjacent = new Set<string>();
  for (const edge of graphV2.edge_list) {
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    v2Adjacent.add(key);
  }
  
  // Compute global bbox and EPS
  process.stdout.write(`Computing global bounding box...\n`);
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  for (const feature of substrateGeoJSON.features) {
    if (!isPolygonGeometry(feature.geometry)) {
      continue;
    }
    const bbox = computeBbox(feature.geometry);
    if (bbox) {
      globalMinx = Math.min(globalMinx, bbox.minx);
      globalMiny = Math.min(globalMiny, bbox.miny);
      globalMaxx = Math.max(globalMaxx, bbox.maxx);
      globalMaxy = Math.max(globalMaxy, bbox.maxy);
    }
  }
  
  const globalBbox = { minx: globalMinx, miny: globalMiny, maxx: globalMaxx, maxy: globalMaxy };
  const eps = computeEPS(globalBbox);
  const tinyTol = eps / TINY_TOL_FACTOR;
  const cellSize = Math.max(globalBbox.maxx - globalBbox.minx, globalBbox.maxy - globalBbox.miny) / GRID_DIVISOR;
  
  process.stdout.write(`EPS: ${eps}\n`);
  process.stdout.write(`Tiny tolerance: ${tinyTol}\n`);
  process.stdout.write(`Grid cell size: ${cellSize}\n`);
  
  // Extract settlement data
  process.stdout.write(`Extracting settlement data...\n`);
  const settlements = new Map<string, SettlementData>();
  let missingSidCount = 0;
  let nonPolygonCount = 0;
  let vertexCapAppliedCount = 0;
  let skippedLargeGeometryCount = 0;
  
  for (const feature of substrateGeoJSON.features) {
    const sid = extractSid(feature.properties);
    if (sid === null) {
      missingSidCount++;
      continue;
    }
    
    if (!isPolygonGeometry(feature.geometry)) {
      nonPolygonCount++;
      continue;
    }
    
    const bbox = computeBbox(feature.geometry);
    if (!bbox) {
      continue;
    }
    
    const boundarySample = extractBoundarySample(feature.geometry);
    let fullSegments = extractSegmentsFromGeometry(feature.geometry);
    
    // Apply vertex cap if needed
    if (boundarySample.length > MAX_VERTS_PER_SETTLEMENT) {
      vertexCapAppliedCount++;
      // For overlap computation, we still need full segments, but cap the boundary sample
      // Actually, we'll skip large geometries for overlap computation
      skippedLargeGeometryCount++;
      fullSegments = []; // Skip overlap computation for very large geometries
    }
    
    settlements.set(sid, {
      sid,
      bbox,
      boundarySample,
      fullSegments
    });
  }
  
  process.stdout.write(`Extracted ${settlements.size} settlements\n`);
  process.stdout.write(`Missing SID: ${missingSidCount}\n`);
  process.stdout.write(`Non-polygon: ${nonPolygonCount}\n`);
  process.stdout.write(`Vertex cap applied: ${vertexCapAppliedCount}\n`);
  process.stdout.write(`Skipped large geometry: ${skippedLargeGeometryCount}\n`);
  
  // Build spatial grid index
  process.stdout.write(`Building spatial grid index...\n`);
  const grid = new Map<string, string[]>();
  
  for (const [sid, data] of settlements.entries()) {
    const minI = Math.floor((data.bbox.minx - globalBbox.minx) / cellSize);
    const maxI = Math.floor((data.bbox.maxx - globalBbox.minx) / cellSize);
    const minJ = Math.floor((data.bbox.miny - globalBbox.miny) / cellSize);
    const maxJ = Math.floor((data.bbox.maxy - globalBbox.miny) / cellSize);
    
    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const cellKey = `${i},${j}`;
        if (!grid.has(cellKey)) {
          grid.set(cellKey, []);
        }
        grid.get(cellKey)!.push(sid);
      }
    }
  }
  
  process.stdout.write(`Grid has ${grid.size} cells\n`);
  
  // Find candidate pairs with bboxDist == 0
  process.stdout.write(`Finding candidate pairs (bboxDist == 0)...\n`);
  const candidatePairs = new Set<string>();
  
  for (const [cellKey, sids] of grid.entries()) {
    // Sort for deterministic iteration
    const sortedSids = [...sids].sort();
    for (let i = 0; i < sortedSids.length; i++) {
      for (let j = i + 1; j < sortedSids.length; j++) {
        const sidA = sortedSids[i];
        const sidB = sortedSids[j];
        
        const dataA = settlements.get(sidA)!;
        const dataB = settlements.get(sidB)!;
        
        const bboxDist = computeBboxDistance(dataA.bbox, dataB.bbox);
        if (bboxDist === 0) {
          const pairKey = sidA < sidB ? `${sidA}|${sidB}` : `${sidB}|${sidA}`;
          candidatePairs.add(pairKey);
        }
      }
    }
  }
  
  process.stdout.write(`Found ${candidatePairs.size} candidate pairs\n`);
  
  // Evaluate pairs
  process.stdout.write(`Evaluating pairs...\n`);
  const touchPairs: TouchPair[] = [];
  let evaluatedCount = 0;
  
  for (const pairKey of Array.from(candidatePairs).sort()) {
    const [sidA, sidB] = pairKey.split('|');
    const dataA = settlements.get(sidA)!;
    const dataB = settlements.get(sidB)!;
    
    evaluatedCount++;
    
    // Compute boundary distance
    const boundaryDist = computeBoundaryDistance(dataA.boundarySample, dataB.boundarySample);
    
    // Only process "touching" pairs
    if (boundaryDist > tinyTol) {
      continue;
    }
    
    // Compute overlap length (if segments available)
    let overlapLen = 0;
    if (dataA.fullSegments.length > 0 && dataB.fullSegments.length > 0) {
      overlapLen = computeOverlapLengthBetweenSettlements(dataA.fullSegments, dataB.fullSegments, eps);
    }
    
    // Classify
    const classification: 'POINT_TOUCH_ONLY' | 'SHARED_BORDER' = overlapLen > 0 ? 'SHARED_BORDER' : 'POINT_TOUCH_ONLY';
    
    touchPairs.push({
      a: sidA,
      b: sidB,
      boundaryDist,
      overlapLen,
      classification
    });
  }
  
  process.stdout.write(`Evaluated ${evaluatedCount} pairs\n`);
  process.stdout.write(`Found ${touchPairs.length} touching pairs\n`);
  
  // Classify
  const pointTouchOnly = touchPairs.filter(p => p.classification === 'POINT_TOUCH_ONLY');
  const sharedBorder = touchPairs.filter(p => p.classification === 'SHARED_BORDER');
  
  process.stdout.write(`Point-touch only: ${pointTouchOnly.length}\n`);
  process.stdout.write(`Shared border: ${sharedBorder.length}\n`);
  
  // Compute overlap length stats for shared border pairs
  const overlapLengths = sharedBorder.map(p => p.overlapLen).sort((a, b) => a - b);
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  };
  const p90 = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const idx = Math.floor(arr.length * 0.9);
    return arr[Math.min(idx, arr.length - 1)];
  };
  
  const overlapLenStats = overlapLengths.length > 0 ? {
    min: overlapLengths[0],
    p50: median(overlapLengths),
    p90: p90(overlapLengths),
    max: overlapLengths[overlapLengths.length - 1]
  } : null;
  
  // Check coverage
  let sharedBorderInV1 = 0;
  let sharedBorderInV2 = 0;
  
  for (const pair of sharedBorder) {
    const pairKey = pair.a < pair.b ? `${pair.a}|${pair.b}` : `${pair.b}|${pair.a}`;
    if (v1Adjacent.has(pairKey)) {
      sharedBorderInV1++;
    }
    if (v2Adjacent.has(pairKey)) {
      sharedBorderInV2++;
    }
  }
  
  // Top shared border pairs
  const topSharedBorder = sharedBorder
    .map(p => ({ a: p.a, b: p.b, overlapLen: p.overlapLen }))
    .sort((p1, p2) => {
      if (p2.overlapLen !== p1.overlapLen) {
        return p2.overlapLen - p1.overlapLen;
      }
      const aCompare = p1.a.localeCompare(p2.a);
      if (aCompare !== 0) {
        return aCompare;
      }
      return p1.b.localeCompare(p2.b);
    })
    .slice(0, 50);
  
  // Build audit report
  const auditReport: AuditReport = {
    schema_version: 1,
    source: substratePath,
    v1_graph: graphV1Path,
    v2_graph: graphV2Path,
    counts: {
      evaluated_pairs: evaluatedCount,
      touching_pairs: touchPairs.length,
      point_touch_only_pairs: pointTouchOnly.length,
      shared_border_pairs: sharedBorder.length
    },
    overlapLen_stats: overlapLenStats,
    coverage: {
      shared_border_in_v1: sharedBorderInV1,
      shared_border_in_v2: sharedBorderInV2
    },
    top_shared_border_pairs: topSharedBorder,
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      vertex_cap_applied_count: vertexCapAppliedCount,
      skipped_large_geometry_count: skippedLargeGeometryCount
    }
  };
  
  // Write JSON audit
  writeFileSync(outputJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit report to ${outputJsonPath}\n`);
  
  // Write TXT audit
  const txtLines: string[] = [];
  txtLines.push('TOUCH PAIRS CLASSIFICATION: POINT-TOUCH vs SHARED-BORDER');
  txtLines.push('===========================================================');
  txtLines.push('');
  txtLines.push('COUNTS:');
  txtLines.push(`  Evaluated pairs (bboxDist == 0): ${auditReport.counts.evaluated_pairs}`);
  txtLines.push(`  Touching pairs (boundaryDist <= ${tinyTol.toFixed(10)}): ${auditReport.counts.touching_pairs}`);
  txtLines.push(`  Point-touch only: ${auditReport.counts.point_touch_only_pairs}`);
  txtLines.push(`  Shared border: ${auditReport.counts.shared_border_pairs}`);
  txtLines.push('');
  
  if (auditReport.overlapLen_stats) {
    txtLines.push('OVERLAP LENGTH STATISTICS (shared border pairs):');
    txtLines.push(`  Min: ${auditReport.overlapLen_stats.min.toFixed(6)}`);
    txtLines.push(`  Median (p50): ${auditReport.overlapLen_stats.p50.toFixed(6)}`);
    txtLines.push(`  p90: ${auditReport.overlapLen_stats.p90.toFixed(6)}`);
    txtLines.push(`  Max: ${auditReport.overlapLen_stats.max.toFixed(6)}`);
    txtLines.push('');
  }
  
  txtLines.push('COVERAGE:');
  txtLines.push(`  Shared border pairs in v1 graph: ${auditReport.coverage.shared_border_in_v1} / ${auditReport.counts.shared_border_pairs}`);
  txtLines.push(`  Shared border pairs in v2 graph: ${auditReport.coverage.shared_border_in_v2} / ${auditReport.counts.shared_border_pairs}`);
  txtLines.push('');
  
  txtLines.push('TOP SHARED BORDER PAIRS (top 50 by overlap length):');
  for (const pair of auditReport.top_shared_border_pairs) {
    txtLines.push(`  ${pair.a} <-> ${pair.b}: ${pair.overlapLen.toFixed(6)}`);
  }
  txtLines.push('');
  
  txtLines.push('ANOMALIES:');
  txtLines.push(`  Missing SID features: ${auditReport.anomalies.missing_sid_features_count}`);
  txtLines.push(`  Non-polygon features: ${auditReport.anomalies.non_polygon_features_count}`);
  txtLines.push(`  Vertex cap applied: ${auditReport.anomalies.vertex_cap_applied_count}`);
  txtLines.push(`  Skipped large geometry: ${auditReport.anomalies.skipped_large_geometry_count}`);
  txtLines.push('');
  
  txtLines.push('INTERPRETATION:');
  if (auditReport.counts.shared_border_pairs > 0) {
    const v1Coverage = auditReport.counts.shared_border_pairs > 0 
      ? (auditReport.coverage.shared_border_in_v1 / auditReport.counts.shared_border_pairs * 100).toFixed(1)
      : '0.0';
    const v2Coverage = auditReport.counts.shared_border_pairs > 0
      ? (auditReport.coverage.shared_border_in_v2 / auditReport.counts.shared_border_pairs * 100).toFixed(1)
      : '0.0';
    
    txtLines.push(`  Found ${auditReport.counts.shared_border_pairs} pairs with shared border length > 0.`);
    txtLines.push(`  v1 graph covers ${v1Coverage}% of shared border pairs.`);
    txtLines.push(`  v2 graph covers ${v2Coverage}% of shared border pairs.`);
    
    if (auditReport.coverage.shared_border_in_v1 < auditReport.counts.shared_border_pairs * 0.5 ||
        auditReport.coverage.shared_border_in_v2 < auditReport.counts.shared_border_pairs * 0.5) {
      txtLines.push(`  => Detection issue: many shared borders not detected. Consider v3 algorithm.`);
    } else {
      txtLines.push(`  => Detection appears adequate.`);
    }
  } else {
    txtLines.push(`  No shared border pairs found. Sparse adjacency is likely due to point-touch only.`);
  }
  
  if (auditReport.counts.point_touch_only_pairs > auditReport.counts.shared_border_pairs * 2) {
    txtLines.push(`  Point-touch dominates (${auditReport.counts.point_touch_only_pairs} vs ${auditReport.counts.shared_border_pairs}).`);
    txtLines.push(`  Geometry may not support shared-length adjacency. Consider allowing point-touch or shifting Phase 1 adjacency source.`);
  }
  
  writeFileSync(outputTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit report to ${outputTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Evaluated pairs: ${auditReport.counts.evaluated_pairs}\n`);
  process.stdout.write(`  Touching pairs: ${auditReport.counts.touching_pairs}\n`);
  process.stdout.write(`  Point-touch only: ${auditReport.counts.point_touch_only_pairs}\n`);
  process.stdout.write(`  Shared border: ${auditReport.counts.shared_border_pairs}\n`);
  if (auditReport.overlapLen_stats) {
    process.stdout.write(`  Overlap length: min=${auditReport.overlapLen_stats.min.toFixed(6)}, median=${auditReport.overlapLen_stats.p50.toFixed(6)}, max=${auditReport.overlapLen_stats.max.toFixed(6)}\n`);
  }
  process.stdout.write(`  Coverage: v1=${auditReport.coverage.shared_border_in_v1}/${auditReport.counts.shared_border_pairs}, v2=${auditReport.coverage.shared_border_in_v2}/${auditReport.counts.shared_border_pairs}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
