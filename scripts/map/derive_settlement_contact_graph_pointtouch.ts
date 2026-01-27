/**
 * Derive Settlement Contact Graph (Shared Border + Point Touch)
 * 
 * VALIDATION-ONLY DIAGNOSTIC FOR PHASE 1 ADJACENCY GRAPH
 * 
 * This script derives a "contact graph" that includes BOTH:
 * - SHARED_BORDER edges (overlapLen > 0)
 * - POINT_TOUCH edges (boundaryDist <= tinyTol and overlapLen == 0)
 * 
 * This is used to judge whether point-touch should be considered adjacency
 * in later systems by reporting connectivity (components, largest component size).
 * 
 * This must NOT replace or modify:
 * - data/derived/settlement_graph.json (v1, shared-border-only)
 * - data/derived/settlement_graph_v2.json (v2, shared-border-only, robust)
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances/overlap.
 * 
 * Usage:
 *   npm run map:derive:contact
 *   or: tsx scripts/map/derive_settlement_contact_graph_pointtouch.ts
 * 
 * Outputs:
 *   - data/derived/settlement_contact_graph.json
 *   - data/derived/settlement_contact_graph.audit.json
 *   - data/derived/settlement_contact_graph.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 diagnostics: derive settlement contact graph including point-touch edges and report component connectivity without changing canonical adjacency graph");

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

interface ContactGraph {
  schema_version: number;
  source: string;
  nodes: number;
  edges_total: number;
  edges_shared_border: number;
  edges_point_touch: number;
  edge_list: Array<{
    a: string;
    b: string;
    type: 'shared_border' | 'point_touch';
    overlap_len: number;
    boundary_dist: number;
  }>;
  graph: Record<string, Array<{
    sid: string;
    type: 'shared_border' | 'point_touch';
    overlap_len: number;
    boundary_dist: number;
  }>>;
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

interface ContactEdge {
  a: string;
  b: string;
  type: 'shared_border' | 'point_touch';
  overlapLen: number;
  boundaryDist: number;
}

interface Component {
  sids: string[];
  size: number;
}

interface AuditReport {
  schema_version: number;
  source: string;
  counts: {
    nodes: number;
    edges_total: number;
    edges_shared_border: number;
    edges_point_touch: number;
  };
  degree_stats: {
    overall: { min: number; p50: number; p90: number; max: number };
    shared_border: { min: number; p50: number; p90: number; max: number };
    point_touch: { min: number; p50: number; p90: number; max: number };
  };
  component_analysis: {
    component_count: number;
    largest_component_size: number;
    top_components_sizes: number[];
  };
  isolated: {
    shared_border_only: number;
    shared_border_plus_point_touch: number;
  };
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    skipped_pairs_due_to_caps: number;
  };
}

// Parameters
const MAX_VERTS_PER_SETTLEMENT = 5000;
const GRID_DIVISOR = 64;
const TINY_TOL_FACTOR = 10;

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
 * Extract boundary sample from polygon geometry (outer rings only)
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
  
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    
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
  const processedPairs = new Set<string>();
  
  for (const segA of segsA) {
    for (const segB of segsB) {
      if (!segmentBboxesOverlap(segA, segB)) {
        continue;
      }
      
      const keyA = `${segA.p1[0]},${segA.p1[1]}|${segA.p2[0]},${segA.p2[1]}`;
      const keyB = `${segB.p1[0]},${segB.p1[1]}|${segB.p2[0]},${segB.p2[1]}`;
      const pairKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
      
      if (processedPairs.has(pairKey)) {
        continue;
      }
      processedPairs.add(pairKey);
      
      if (!areColinear(segA, segB, eps)) {
        continue;
      }
      
      try {
        const overlap = computeOverlapLength(segA, segB);
        if (overlap > 0) {
          totalOverlap += overlap;
        }
      } catch (err) {
        continue;
      }
    }
  }
  
  return totalOverlap;
}

/**
 * Find connected components using BFS
 */
function findConnectedComponents(
  allSids: string[],
  adjacencyMap: Map<string, Set<string>>
): Component[] {
  const visited = new Set<string>();
  const components: Component[] = [];
  
  for (const startSid of allSids) {
    if (visited.has(startSid)) {
      continue;
    }
    
    const component: string[] = [];
    const queue: string[] = [startSid];
    visited.add(startSid);
    
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      
      const neighbors = adjacencyMap.get(current) || new Set<string>();
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    
    component.sort();
    components.push({ sids: component, size: component.length });
  }
  
  components.sort((a, b) => {
    if (b.size !== a.size) {
      return b.size - a.size;
    }
    if (a.sids.length === 0) return 1;
    if (b.sids.length === 0) return -1;
    return a.sids[0].localeCompare(b.sids[0]);
  });
  
  return components;
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const outputPath = resolve('data/derived/settlement_contact_graph.json');
  const auditJsonPath = resolve('data/derived/settlement_contact_graph.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_contact_graph.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrateGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrateGeoJSON.type}`);
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
  let skippedPairsDueToCaps = 0;
  
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
    
    if (boundarySample.length > MAX_VERTS_PER_SETTLEMENT) {
      fullSegments = [];
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
  
  // Evaluate pairs and build contact edges
  process.stdout.write(`Evaluating pairs and building contact graph...\n`);
  const contactEdges: ContactEdge[] = [];
  const allSids = Array.from(settlements.keys()).sort();
  
  for (const pairKey of Array.from(candidatePairs).sort()) {
    const [sidA, sidB] = pairKey.split('|');
    const dataA = settlements.get(sidA)!;
    const dataB = settlements.get(sidB)!;
    
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
    } else {
      skippedPairsDueToCaps++;
    }
    
    // Classify edge type
    let edgeType: 'shared_border' | 'point_touch';
    if (overlapLen > 0) {
      edgeType = 'shared_border';
    } else {
      edgeType = 'point_touch';
    }
    
    contactEdges.push({
      a: sidA,
      b: sidB,
      type: edgeType,
      overlapLen,
      boundaryDist
    });
  }
  
  process.stdout.write(`Found ${contactEdges.length} contact edges\n`);
  process.stdout.write(`  Shared border: ${contactEdges.filter(e => e.type === 'shared_border').length}\n`);
  process.stdout.write(`  Point touch: ${contactEdges.filter(e => e.type === 'point_touch').length}\n`);
  
  // Build graph structure
  process.stdout.write(`Building graph structure...\n`);
  const graph: Record<string, Array<{ sid: string; type: 'shared_border' | 'point_touch'; overlap_len: number; boundary_dist: number }>> = {};
  
  for (const sid of allSids) {
    graph[sid] = [];
  }
  
  for (const edge of contactEdges) {
    graph[edge.a].push({
      sid: edge.b,
      type: edge.type,
      overlap_len: edge.overlapLen,
      boundary_dist: edge.boundaryDist
    });
    graph[edge.b].push({
      sid: edge.a,
      type: edge.type,
      overlap_len: edge.overlapLen,
      boundary_dist: edge.boundaryDist
    });
  }
  
  // Sort neighbors by sid (deterministic)
  for (const sid of allSids) {
    graph[sid].sort((a, b) => a.sid.localeCompare(b.sid));
  }
  
  // Build edge list (sorted, deterministic)
  const edgeList = contactEdges.map(e => ({
    a: e.a < e.b ? e.a : e.b,
    b: e.a < e.b ? e.b : e.a,
    type: e.type,
    overlap_len: e.overlapLen,
    boundary_dist: e.boundaryDist
  }));
  
  edgeList.sort((e1, e2) => {
    const aCompare = e1.a.localeCompare(e2.a);
    if (aCompare !== 0) {
      return aCompare;
    }
    return e1.b.localeCompare(e2.b);
  });
  
  // Build output graph
  const outputGraph: ContactGraph = {
    schema_version: 1,
    source: 'data/derived/settlements_substrate.geojson',
    nodes: allSids.length,
    edges_total: edgeList.length,
    edges_shared_border: edgeList.filter(e => e.type === 'shared_border').length,
    edges_point_touch: edgeList.filter(e => e.type === 'point_touch').length,
    edge_list: edgeList,
    graph
  };
  
  // Compute degree statistics
  const degrees = allSids.map(sid => graph[sid].length);
  degrees.sort((a, b) => a - b);
  
  const sharedBorderDegrees = allSids.map(sid => 
    graph[sid].filter(n => n.type === 'shared_border').length
  ).sort((a, b) => a - b);
  
  const pointTouchDegrees = allSids.map(sid => 
    graph[sid].filter(n => n.type === 'point_touch').length
  ).sort((a, b) => a - b);
  
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
  
  // Build adjacency map for component analysis
  const adjacencyMap = new Map<string, Set<string>>();
  for (const sid of allSids) {
    adjacencyMap.set(sid, new Set());
  }
  for (const edge of contactEdges) {
    adjacencyMap.get(edge.a)!.add(edge.b);
    adjacencyMap.get(edge.b)!.add(edge.a);
  }
  
  // Find connected components
  process.stdout.write(`Computing connected components...\n`);
  const components = findConnectedComponents(allSids, adjacencyMap);
  
  // Count isolated settlements
  const isolatedSharedBorderOnly = allSids.filter(sid => 
    graph[sid].filter(n => n.type === 'shared_border').length === 0
  ).length;
  
  const isolatedContactGraph = allSids.filter(sid => 
    graph[sid].length === 0
  ).length;
  
  // Build audit report
  const auditReport: AuditReport = {
    schema_version: 1,
    source: substratePath,
    counts: {
      nodes: allSids.length,
      edges_total: edgeList.length,
      edges_shared_border: outputGraph.edges_shared_border,
      edges_point_touch: outputGraph.edges_point_touch
    },
    degree_stats: {
      overall: {
        min: degrees.length > 0 ? degrees[0] : 0,
        p50: median(degrees),
        p90: p90(degrees),
        max: degrees.length > 0 ? degrees[degrees.length - 1] : 0
      },
      shared_border: {
        min: sharedBorderDegrees.length > 0 ? sharedBorderDegrees[0] : 0,
        p50: median(sharedBorderDegrees),
        p90: p90(sharedBorderDegrees),
        max: sharedBorderDegrees.length > 0 ? sharedBorderDegrees[sharedBorderDegrees.length - 1] : 0
      },
      point_touch: {
        min: pointTouchDegrees.length > 0 ? pointTouchDegrees[0] : 0,
        p50: median(pointTouchDegrees),
        p90: p90(pointTouchDegrees),
        max: pointTouchDegrees.length > 0 ? pointTouchDegrees[pointTouchDegrees.length - 1] : 0
      }
    },
    component_analysis: {
      component_count: components.length,
      largest_component_size: components.length > 0 ? components[0].size : 0,
      top_components_sizes: components.slice(0, 20).map(c => c.size)
    },
    isolated: {
      shared_border_only: isolatedSharedBorderOnly,
      shared_border_plus_point_touch: isolatedContactGraph
    },
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      skipped_pairs_due_to_caps: skippedPairsDueToCaps
    }
  };
  
  // Write output graph
  writeFileSync(outputPath, JSON.stringify(outputGraph, null, 2), 'utf8');
  process.stdout.write(`Wrote contact graph to ${outputPath}\n`);
  
  // Write audit JSON
  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditJsonPath}\n`);
  
  // Write audit TXT
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENT CONTACT GRAPH AUDIT (Shared Border + Point Touch)');
  txtLines.push('==============================================================');
  txtLines.push('');
  txtLines.push('COUNTS:');
  txtLines.push(`  Nodes: ${auditReport.counts.nodes}`);
  txtLines.push(`  Edges total: ${auditReport.counts.edges_total}`);
  txtLines.push(`  Edges shared border: ${auditReport.counts.edges_shared_border}`);
  txtLines.push(`  Edges point touch: ${auditReport.counts.edges_point_touch}`);
  txtLines.push('');
  txtLines.push('DEGREE STATISTICS:');
  txtLines.push('  Overall:');
  txtLines.push(`    Min: ${auditReport.degree_stats.overall.min}`);
  txtLines.push(`    Median (p50): ${auditReport.degree_stats.overall.p50}`);
  txtLines.push(`    p90: ${auditReport.degree_stats.overall.p90}`);
  txtLines.push(`    Max: ${auditReport.degree_stats.overall.max}`);
  txtLines.push('  Shared border:');
  txtLines.push(`    Min: ${auditReport.degree_stats.shared_border.min}`);
  txtLines.push(`    Median (p50): ${auditReport.degree_stats.shared_border.p50}`);
  txtLines.push(`    p90: ${auditReport.degree_stats.shared_border.p90}`);
  txtLines.push(`    Max: ${auditReport.degree_stats.shared_border.max}`);
  txtLines.push('  Point touch:');
  txtLines.push(`    Min: ${auditReport.degree_stats.point_touch.min}`);
  txtLines.push(`    Median (p50): ${auditReport.degree_stats.point_touch.p50}`);
  txtLines.push(`    p90: ${auditReport.degree_stats.point_touch.p90}`);
  txtLines.push(`    Max: ${auditReport.degree_stats.point_touch.max}`);
  txtLines.push('');
  txtLines.push('COMPONENT ANALYSIS:');
  txtLines.push(`  Component count: ${auditReport.component_analysis.component_count}`);
  txtLines.push(`  Largest component size: ${auditReport.component_analysis.largest_component_size}`);
  txtLines.push(`  Top component sizes (top 20): ${auditReport.component_analysis.top_components_sizes.join(', ')}`);
  txtLines.push('');
  txtLines.push('ISOLATED SETTLEMENTS:');
  txtLines.push(`  Shared border only: ${auditReport.isolated.shared_border_only}`);
  txtLines.push(`  Shared border + point touch: ${auditReport.isolated.shared_border_plus_point_touch}`);
  txtLines.push(`  Isolated reduction: ${auditReport.isolated.shared_border_only - auditReport.isolated.shared_border_plus_point_touch}`);
  txtLines.push('');
  txtLines.push('ANOMALIES:');
  txtLines.push(`  Missing SID features: ${auditReport.anomalies.missing_sid_features_count}`);
  txtLines.push(`  Non-polygon features: ${auditReport.anomalies.non_polygon_features_count}`);
  txtLines.push(`  Skipped pairs due to caps: ${auditReport.anomalies.skipped_pairs_due_to_caps}`);
  txtLines.push('');
  txtLines.push('INTERPRETATION:');
  if (auditReport.component_analysis.largest_component_size > auditReport.counts.nodes * 0.5) {
    txtLines.push(`  Largest component contains ${auditReport.component_analysis.largest_component_size} settlements (${(auditReport.component_analysis.largest_component_size / auditReport.counts.nodes * 100).toFixed(1)}% of all settlements).`);
    txtLines.push(`  => Contact graph (shared border + point touch) yields a mostly-connected fabric.`);
  } else {
    txtLines.push(`  Largest component contains ${auditReport.component_analysis.largest_component_size} settlements (${(auditReport.component_analysis.largest_component_size / auditReport.counts.nodes * 100).toFixed(1)}% of all settlements).`);
    txtLines.push(`  => Contact graph remains fragmented even with point-touch edges.`);
  }
  
  const isolatedReduction = auditReport.isolated.shared_border_only - auditReport.isolated.shared_border_plus_point_touch;
  if (isolatedReduction > 0) {
    txtLines.push(`  Point-touch edges reduce isolated settlements by ${isolatedReduction} (from ${auditReport.isolated.shared_border_only} to ${auditReport.isolated.shared_border_plus_point_touch}).`);
  }
  
  if (auditReport.isolated.shared_border_plus_point_touch < auditReport.isolated.shared_border_only * 0.5) {
    txtLines.push(`  => Point-touch makes the graph significantly more connected. Consider allowing point-touch in Phase 1 adjacency definition.`);
  } else if (auditReport.isolated.shared_border_plus_point_touch === auditReport.isolated.shared_border_only) {
    txtLines.push(`  => Point-touch does not reduce isolated settlements. Shared-border-only adjacency appears adequate.`);
  }
  
  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Nodes: ${auditReport.counts.nodes}\n`);
  process.stdout.write(`  Edges total: ${auditReport.counts.edges_total}\n`);
  process.stdout.write(`  Edges shared border: ${auditReport.counts.edges_shared_border}\n`);
  process.stdout.write(`  Edges point touch: ${auditReport.counts.edges_point_touch}\n`);
  process.stdout.write(`  Components: ${auditReport.component_analysis.component_count}\n`);
  process.stdout.write(`  Largest component: ${auditReport.component_analysis.largest_component_size}\n`);
  process.stdout.write(`  Isolated (shared border only): ${auditReport.isolated.shared_border_only}\n`);
  process.stdout.write(`  Isolated (shared border + point touch): ${auditReport.isolated.shared_border_plus_point_touch}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
