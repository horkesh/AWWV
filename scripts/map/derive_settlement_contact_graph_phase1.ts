/**
 * Derive Settlement Contact Graph (Phase 1 Canonical)
 * 
 * CANONICAL SCRIPT FOR PHASE 1 SETTLEMENT CONTACT ADJACENCY GRAPH
 * 
 * This script derives the canonical Phase 1 settlement contact graph from the
 * canonical settlement substrate. Adjacency represents CONTACT POTENTIAL ONLY.
 * 
 * Adjacency rule (CANONICAL, MUST MATCH FORAWWV.md):
 * Two settlements are adjacent if ANY of the following holds:
 * 1) They share a boundary segment of positive length (shared-border)
 * 2) They touch at a point (vertex contact)
 * 3) Their minimum boundary-to-boundary distance ≤ D0 (explicit local contact radius)
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no snapping, buffering, hulls, smoothing, unions.
 * Geometry is read-only.
 * 
 * Usage:
 *   npm run map:derive:contact:phase1
 *   or: tsx scripts/map/derive_settlement_contact_graph_phase1.ts
 * 
 * Outputs:
 *   - data/derived/settlement_contact_graph.json
 *   - data/derived/settlement_contact_graph.audit.json
 *   - data/derived/settlement_contact_graph.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, warnIfUnrecorded } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("derive Phase 1 canonical settlement contact adjacency graph");

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
  parameters: {
    D0: number;
  };
  nodes: Array<{ sid: string }>;
  edges: Array<{
    a: string;
    b: string;
    type: 'shared_border' | 'point_touch' | 'distance_contact';
    overlap_len?: number;
    min_dist?: number;
  }>;
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
  type: 'shared_border' | 'point_touch' | 'distance_contact';
  overlapLen?: number;
  minDist?: number;
}

interface Component {
  sids: string[];
  size: number;
}

interface AuditReport {
  schema_version: number;
  source: string;
  parameters: {
    D0: number;
  };
  counts: {
    nodes: number;
    edges_total: number;
    edges_shared_border: number;
    edges_point_touch: number;
    edges_distance_contact: number;
  };
  isolated: {
    count: number;
    percentage: number;
  };
  component_analysis: {
    component_count: number;
    largest_component_size: number;
    largest_component_percentage: number;
  };
  degree_stats: {
    min: number;
    max: number;
    median: number;
    p90: number;
  };
  top_settlements_by_degree: Array<{
    sid: string;
    degree: number;
  }>;
  determinism: {
    node_ordering: 'stable_sid_lexicographic';
    edge_ordering: 'stable_lexicographic_pair';
    no_timestamps: true;
    no_randomness: true;
  };
}

// CANONICAL PARAMETER: D0 (local contact radius)
// This is an explicit, deterministic parameter documented in audit outputs
// D0 must be small enough to represent "local contact" but large enough to
// capture meaningful adjacency relationships given coordinate precision
const D0 = 0.5; // Explicit constant, documented in audit

// Geometry processing parameters
const MAX_VERTS_PER_SETTLEMENT = 5000;
const GRID_DIVISOR = 64;
const EPS_FACTOR = 1e-7;

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
 * Compute EPS from dataset bounds
 */
function computeEPS(bbox: { minx: number; miny: number; maxx: number; maxy: number }): number {
  const width = bbox.maxx - bbox.minx;
  const height = bbox.maxy - bbox.miny;
  const maxDim = Math.max(width, height);
  
  let eps = maxDim * EPS_FACTOR;
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
 * Check if two settlements share a vertex (point-touch)
 */
function checkPointTouch(sampleA: Point[], sampleB: Point[], eps: number): boolean {
  const pointSetA = new Set<string>();
  for (const p of sampleA) {
    const key = `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
    pointSetA.add(key);
  }
  
  for (const p of sampleB) {
    const key = `${Math.round(p[0] / eps)},${Math.round(p[1] / eps)}`;
    if (pointSetA.has(key)) {
      return true;
    }
  }
  
  return false;
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
  
  // Extract settlements with geometry
  const settlements = new Map<string, SettlementData>();
  let missingSidCount = 0;
  let nonPolygonCount = 0;
  
  // Compute global bbox for EPS
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  for (const feature of substrateGeoJSON.features) {
    const sid = extractSid(feature.properties);
    if (!sid) {
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
    
    globalMinx = Math.min(globalMinx, bbox.minx);
    globalMiny = Math.min(globalMiny, bbox.miny);
    globalMaxx = Math.max(globalMaxx, bbox.maxx);
    globalMaxy = Math.max(globalMaxy, bbox.maxy);
    
    const boundarySample = extractBoundarySample(feature.geometry);
    const fullSegments = extractSegmentsFromGeometry(feature.geometry);
    
    settlements.set(sid, {
      sid,
      bbox,
      boundarySample,
      fullSegments
    });
  }
  
  const globalBbox = { minx: globalMinx, miny: globalMiny, maxx: globalMaxx, maxy: globalMaxy };
  const eps = computeEPS(globalBbox);
  
  process.stdout.write(`Loaded ${settlements.size} settlements\n`);
  process.stdout.write(`EPS: ${eps}\n`);
  process.stdout.write(`D0: ${D0}\n`);
  
  // Sort SIDs for deterministic ordering
  const sortedSids = Array.from(settlements.keys()).sort();
  
  // Build spatial grid for efficient neighbor finding
  const gridSize = Math.max(
    Math.ceil((globalMaxx - globalMinx) / GRID_DIVISOR),
    Math.ceil((globalMaxy - globalMiny) / GRID_DIVISOR)
  );
  const grid: Map<string, string[]> = new Map();
  
  for (const sid of sortedSids) {
    const s = settlements.get(sid)!;
    const cellXMin = Math.floor((s.bbox.minx - globalMinx) / gridSize);
    const cellXMax = Math.floor((s.bbox.maxx - globalMinx) / gridSize);
    const cellYMin = Math.floor((s.bbox.miny - globalMiny) / gridSize);
    const cellYMax = Math.floor((s.bbox.maxy - globalMiny) / gridSize);
    
    for (let cx = cellXMin; cx <= cellXMax; cx++) {
      for (let cy = cellYMin; cy <= cellYMax; cy++) {
        const key = `${cx},${cy}`;
        if (!grid.has(key)) {
          grid.set(key, []);
        }
        grid.get(key)!.push(sid);
      }
    }
  }
  
  // Detect adjacency
  const edges: ContactEdge[] = [];
  const processedPairs = new Set<string>();
  
  process.stdout.write(`Detecting adjacency...\n`);
  let checkedPairs = 0;
  let processedCount = 0;
  const totalSids = sortedSids.length;
  
  for (const sidA of sortedSids) {
    processedCount++;
    if (processedCount % 100 === 0) {
      process.stdout.write(`  Processed ${processedCount}/${totalSids} settlements, checked ${checkedPairs} pairs, found ${edges.length} edges...\n`);
    }
    const sA = settlements.get(sidA)!;
    
    // Find candidate neighbors via grid
    const candidateSids = new Set<string>();
    const cellXMin = Math.floor((sA.bbox.minx - globalMinx) / gridSize);
    const cellXMax = Math.floor((sA.bbox.maxx - globalMinx) / gridSize);
    const cellYMin = Math.floor((sA.bbox.miny - globalMiny) / gridSize);
    const cellYMax = Math.floor((sA.bbox.maxy - globalMiny) / gridSize);
    
    for (let cx = cellXMin - 1; cx <= cellXMax + 1; cx++) {
      for (let cy = cellYMin - 1; cy <= cellYMax + 1; cy++) {
        const key = `${cx},${cy}`;
        const cellSids = grid.get(key) || [];
        for (const sidB of cellSids) {
          if (sidB <= sidA) continue; // Only check each pair once
          candidateSids.add(sidB);
        }
      }
    }
    
    for (const sidB of candidateSids) {
      const pairKey = sidA < sidB ? `${sidA}|${sidB}` : `${sidB}|${sidA}`;
      if (processedPairs.has(pairKey)) {
        continue;
      }
      processedPairs.add(pairKey);
      
      const sB = settlements.get(sidB)!;
      
      // Quick bbox distance check
      const bboxDist = computeBboxDistance(sA.bbox, sB.bbox);
      if (bboxDist > D0 + 1e-6) {
        continue; // Too far, skip
      }
      
      checkedPairs++;
      
      // Check shared-border adjacency first (most restrictive)
      const overlapLen = computeOverlapLengthBetweenSettlements(sA.fullSegments, sB.fullSegments, eps);
      if (overlapLen > eps) {
        edges.push({
          a: sidA,
          b: sidB,
          type: 'shared_border',
          overlapLen
        });
        continue;
      }
      
      // If bbox distance is very small, likely point-touch or very close
      if (bboxDist < eps * 10) {
        // Check point-touch adjacency
        if (checkPointTouch(sA.boundarySample, sB.boundarySample, eps)) {
          edges.push({
            a: sidA,
            b: sidB,
            type: 'point_touch'
          });
          continue;
        }
      }
      
      // Check distance-contact adjacency (only if bbox distance suggests it's possible)
      if (bboxDist <= D0) {
        const boundaryDist = computeBoundaryDistance(sA.boundarySample, sB.boundarySample);
        if (boundaryDist <= D0) {
          edges.push({
            a: sidA,
            b: sidB,
            type: 'distance_contact',
            minDist: boundaryDist
          });
        }
      }
    }
  }
  
  process.stdout.write(`Checked ${checkedPairs} pairs\n`);
  process.stdout.write(`Found ${edges.length} edges\n`);
  
  // Sort edges deterministically
  edges.sort((e1, e2) => {
    const key1 = e1.a < e1.b ? `${e1.a}|${e1.b}` : `${e1.b}|${e1.a}`;
    const key2 = e2.a < e2.b ? `${e2.a}|${e2.b}` : `${e2.b}|${e2.a}`;
    return key1.localeCompare(key2);
  });
  
  // Build adjacency map for component analysis
  const adjacencyMap = new Map<string, Set<string>>();
  for (const sid of sortedSids) {
    adjacencyMap.set(sid, new Set<string>());
  }
  for (const edge of edges) {
    adjacencyMap.get(edge.a)!.add(edge.b);
    adjacencyMap.get(edge.b)!.add(edge.a);
  }
  
  // Find connected components
  const components = findConnectedComponents(sortedSids, adjacencyMap);
  
  // Compute degree statistics
  const degrees = sortedSids.map(sid => adjacencyMap.get(sid)!.size);
  degrees.sort((a, b) => a - b);
  const minDegree = degrees[0] || 0;
  const maxDegree = degrees[degrees.length - 1] || 0;
  const medianDegree = degrees.length > 0 
    ? degrees[Math.floor(degrees.length / 2)]
    : 0;
  const p90Degree = degrees.length > 0
    ? degrees[Math.floor(degrees.length * 0.9)]
    : 0;
  
  // Top settlements by degree
  const topSettlements = sortedSids
    .map(sid => ({ sid, degree: adjacencyMap.get(sid)!.size }))
    .sort((a, b) => {
      if (b.degree !== a.degree) {
        return b.degree - a.degree;
      }
      return a.sid.localeCompare(b.sid);
    })
    .slice(0, 10);
  
  // Count isolated settlements
  const isolatedCount = degrees.filter(d => d === 0).length;
  const isolatedPercentage = sortedSids.length > 0
    ? (isolatedCount / sortedSids.length) * 100
    : 0;
  
  // Count edges by type
  const edgesByType = {
    shared_border: edges.filter(e => e.type === 'shared_border').length,
    point_touch: edges.filter(e => e.type === 'point_touch').length,
    distance_contact: edges.filter(e => e.type === 'distance_contact').length
  };
  
  // Build output graph
  const graph: ContactGraph = {
    schema_version: 1,
    parameters: {
      D0
    },
    nodes: sortedSids.map(sid => ({ sid })),
    edges: edges.map(e => ({
      a: e.a,
      b: e.b,
      type: e.type,
      ...(e.overlapLen !== undefined ? { overlap_len: e.overlapLen } : {}),
      ...(e.minDist !== undefined ? { min_dist: e.minDist } : {})
    }))
  };
  
  // Build audit report
  const auditReport: AuditReport = {
    schema_version: 1,
    source: substratePath,
    parameters: {
      D0
    },
    counts: {
      nodes: sortedSids.length,
      edges_total: edges.length,
      edges_shared_border: edgesByType.shared_border,
      edges_point_touch: edgesByType.point_touch,
      edges_distance_contact: edgesByType.distance_contact
    },
    isolated: {
      count: isolatedCount,
      percentage: isolatedPercentage
    },
    component_analysis: {
      component_count: components.length,
      largest_component_size: components.length > 0 ? components[0].size : 0,
      largest_component_percentage: sortedSids.length > 0
        ? (components.length > 0 ? components[0].size / sortedSids.length * 100 : 0)
        : 0
    },
    degree_stats: {
      min: minDegree,
      max: maxDegree,
      median: medianDegree,
      p90: p90Degree
    },
    top_settlements_by_degree: topSettlements,
    determinism: {
      node_ordering: 'stable_sid_lexicographic',
      edge_ordering: 'stable_lexicographic_pair',
      no_timestamps: true,
      no_randomness: true
    }
  };
  
  // Write outputs
  process.stdout.write(`Writing ${outputPath}...\n`);
  writeFileSync(outputPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  
  process.stdout.write(`Writing ${auditJsonPath}...\n`);
  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2) + '\n', 'utf8');
  
  // Write text audit report
  const auditText = `SETTLEMENT CONTACT GRAPH AUDIT REPORT
Generated: Phase 1 Canonical Contact Graph Derivation

SOURCE
  ${substratePath}

PARAMETERS
  D0 (local contact radius): ${D0}
  EPS (coordinate tolerance): ${eps}

COUNTS
  Nodes (settlements): ${sortedSids.length}
  Edges (total): ${edges.length}
    - Shared border: ${edgesByType.shared_border}
    - Point touch: ${edgesByType.point_touch}
    - Distance contact: ${edgesByType.distance_contact}

ISOLATION
  Isolated settlements: ${isolatedCount} (${isolatedPercentage.toFixed(2)}%)

COMPONENT ANALYSIS
  Total components: ${components.length}
  Largest component: ${components.length > 0 ? components[0].size : 0} settlements (${sortedSids.length > 0 ? (components.length > 0 ? (components[0].size / sortedSids.length * 100).toFixed(2) : '0.00') : '0.00'}%)

DEGREE STATISTICS
  Min: ${minDegree}
  Max: ${maxDegree}
  Median: ${medianDegree}
  P90: ${p90Degree}

TOP 10 SETTLEMENTS BY DEGREE
${topSettlements.map((s, i) => `  ${i + 1}. ${s.sid}: ${s.degree} neighbors`).join('\n')}

DETERMINISM
  Node ordering: stable_sid_lexicographic
  Edge ordering: stable_lexicographic_pair
  No timestamps: true
  No randomness: true

ANOMALIES
  Missing SID features: ${missingSidCount}
  Non-polygon features: ${nonPolygonCount}
`;
  
  process.stdout.write(`Writing ${auditTxtPath}...\n`);
  writeFileSync(auditTxtPath, auditText, 'utf8');
  
  process.stdout.write(`Done.\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
