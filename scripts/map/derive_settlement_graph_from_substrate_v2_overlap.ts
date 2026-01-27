/**
 * Derive Settlement Adjacency Graph from Settlement Substrate (v2: Overlap Detection)
 * 
 * CANONICAL SCRIPT FOR PHASE 1 SETTLEMENT ADJACENCY GRAPH (v2)
 * 
 * This script derives a deterministic, undirected adjacency graph where edges
 * exist ONLY when two settlement polygons share a boundary segment (shared border
 * length > 0). Unlike v1, this version detects shared borders even when the shared
 * boundary is split differently across polygons (robust to different vertex splits).
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no unions, hulls, buffering, smoothing, repair, simplification.
 * Coordinate quantization is used ONLY for robust segment matching, derived
 * deterministically from the dataset bounds and applied uniformly (does not modify
 * or write geometry).
 * 
 * Usage:
 *   npm run map:derive:graph:v2
 *   or: tsx scripts/map/derive_settlement_graph_from_substrate_v2_overlap.ts
 * 
 * Outputs:
 *   - data/derived/settlement_graph_v2.json (canonical Phase 1 adjacency graph v2)
 *   - data/derived/settlement_graph_v2.audit.json
 *   - data/derived/settlement_graph_v2.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 v2: derive settlement adjacency by detecting overlapping colinear border segments (robust to different vertex splits) without changing Phase 0 canon or v1 outputs");

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

interface GraphNode {
  sid: string;
  neighbors: Array<{ sid: string; shared_border_length: number }>;
}

interface GraphEdge {
  a: string;
  b: string;
  shared_border_length: number;
}

interface SettlementGraph {
  schema_version: number;
  source: string;
  nodes: number;
  edges: number;
  graph: Record<string, Array<{ sid: string; shared_border_length: number }>>;
  edge_list: GraphEdge[];
}

interface Segment {
  p1: Point;
  p2: Point;
  len: number;
  sid: string;
  bbox: { minx: number; miny: number; maxx: number; maxy: number };
}

interface AuditReport {
  counts: {
    nodes: number;
    edges: number;
    isolated_count: number;
  };
  degree_stats: {
    min: number;
    p50: number;
    p90: number;
    max: number;
  };
  top_degree: Array<{ sid: string; degree: number }>;
  top_shared_border_edges: Array<{ a: string; b: string; length: number }>;
  isolated: string[];
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    segment_comparisons_performed: number;
    skipped_due_to_numeric_issues: number;
  };
}

/**
 * Extract settlement ID from feature properties
 */
function extractSid(properties: Record<string, unknown>): string | null {
  // Prefer sid, then settlement_id
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
 * Compute bounding box for all features
 */
function computeGlobalBbox(features: GeoJSONFeature[]): { minx: number; miny: number; maxx: number; maxy: number } | null {
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
  
  for (const feature of features) {
    if (!isPolygonGeometry(feature.geometry)) {
      continue;
    }
    
    if (feature.geometry.type === 'Polygon') {
      processPolygon(feature.geometry.coordinates as Polygon);
    } else if (feature.geometry.type === 'MultiPolygon') {
      for (const poly of feature.geometry.coordinates as MultiPolygon) {
        processPolygon(poly);
      }
    }
  }
  
  if (minx === Infinity) {
    return null;
  }
  
  return { minx, miny, maxx, maxy };
}

/**
 * Compute EPS (quantization grid size) deterministically from dataset bounds
 */
function computeEPS(bbox: { minx: number; miny: number; maxx: number; maxy: number }): number {
  const width = bbox.maxx - bbox.minx;
  const height = bbox.maxy - bbox.miny;
  const maxDim = Math.max(width, height);
  
  // EPS = max(width, height) * 1e-7, clamped to [1e-9, 1e-5]
  let eps = maxDim * 1e-7;
  eps = Math.max(eps, 1e-9);
  eps = Math.min(eps, 1e-5);
  
  return eps;
}

/**
 * Compute euclidean length of segment
 */
function computeSegmentLength(p1: Point, p2: Point): number {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute bounding box for a segment
 */
function computeSegmentBbox(p1: Point, p2: Point): { minx: number; miny: number; maxx: number; maxy: number } {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  return {
    minx: Math.min(x1, x2),
    miny: Math.min(y1, y2),
    maxx: Math.max(x1, x2),
    maxy: Math.max(y1, y2)
  };
}

/**
 * Extract all boundary segments from a polygon outer ring
 */
function extractSegmentsFromRing(ring: Ring, sid: string): Segment[] {
  const segments: Segment[] = [];
  
  // Iterate consecutive pairs (ring is closed, so last point connects to first)
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    
    // Skip zero-length segments
    const len = computeSegmentLength(p1, p2);
    if (len === 0) {
      continue;
    }
    
    const bbox = computeSegmentBbox(p1, p2);
    segments.push({ p1, p2, len, sid, bbox });
  }
  
  return segments;
}

/**
 * Extract all boundary segments from a polygon geometry
 */
function extractSegmentsFromGeometry(
  geom: GeoJSONFeature['geometry'],
  sid: string
): Segment[] {
  const segments: Segment[] = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    // Only process outer ring (first ring)
    if (polygon.length > 0) {
      const outerRing = polygon[0];
      segments.push(...extractSegmentsFromRing(outerRing, sid));
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as MultiPolygon;
    // Process outer ring of each polygon
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        const outerRing = polygon[0];
        segments.push(...extractSegmentsFromRing(outerRing, sid));
      }
    }
  }
  
  return segments;
}

/**
 * Compute cross product magnitude (for colinearity check)
 */
function crossProductMagnitude(p1: Point, p2: Point, p3: Point): number {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  const [x3, y3] = p3;
  
  // Vector from p1 to p2
  const v1x = x2 - x1;
  const v1y = y2 - y1;
  
  // Vector from p1 to p3
  const v2x = x3 - x1;
  const v2y = y3 - y1;
  
  // Cross product magnitude
  return Math.abs(v1x * v2y - v1y * v2x);
}

/**
 * Compute perpendicular distance from point to line segment
 */
function pointToSegmentDistance(p: Point, seg: Segment): number {
  const [px, py] = p;
  const [x1, y1] = seg.p1;
  const [x2, y2] = seg.p2;
  
  const dx = x2 - x1;
  const dy = y2 - y1;
  const segLenSq = dx * dx + dy * dy;
  
  if (segLenSq === 0) {
    // Segment is a point
    const dpx = px - x1;
    const dpy = py - y1;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  
  // Project point onto line segment
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
  // Check if endpoints of seg2 are colinear with seg1
  const cross1 = crossProductMagnitude(seg1.p1, seg1.p2, seg2.p1);
  const cross2 = crossProductMagnitude(seg1.p1, seg1.p2, seg2.p2);
  
  // Both endpoints must be colinear
  if (cross1 > tol || cross2 > tol) {
    return false;
  }
  
  // Also check perpendicular distance from seg2's endpoints to seg1's line
  const dist1 = pointToSegmentDistance(seg2.p1, seg1);
  const dist2 = pointToSegmentDistance(seg2.p2, seg1);
  
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
  // Project all endpoints onto seg1's line
  const t1_p1 = projectPointOntoLine(seg1.p1, seg1);
  const t1_p2 = projectPointOntoLine(seg1.p2, seg1);
  const t2_p1 = projectPointOntoLine(seg2.p1, seg1);
  const t2_p2 = projectPointOntoLine(seg2.p2, seg1);
  
  // Normalize so seg1 spans [0, 1]
  const seg1Min = Math.min(t1_p1, t1_p2);
  const seg1Max = Math.max(t1_p1, t1_p2);
  const seg1Span = seg1Max - seg1Min;
  
  if (seg1Span === 0) {
    return 0;
  }
  
  // Normalize seg2's projections
  const t2Min = Math.min(t2_p1, t2_p2);
  const t2Max = Math.max(t2_p1, t2_p2);
  const norm2Min = (t2Min - seg1Min) / seg1Span;
  const norm2Max = (t2Max - seg1Min) / seg1Span;
  
  // Compute overlap in normalized space [0, 1]
  const overlapMin = Math.max(0, norm2Min);
  const overlapMax = Math.min(1, norm2Max);
  const overlapNorm = Math.max(0, overlapMax - overlapMin);
  
  // Convert back to actual length
  return overlapNorm * seg1.len;
}

/**
 * Compute grid cell size deterministically from bounds
 */
function computeGridCellSize(bbox: { minx: number; miny: number; maxx: number; maxy: number }): number {
  const width = bbox.maxx - bbox.minx;
  const height = bbox.maxy - bbox.miny;
  const maxDim = Math.max(width, height);
  
  // Cell size = max(width, height) / 128, clamped to reasonable range
  let cellSize = maxDim / 128;
  cellSize = Math.max(cellSize, 0.1);
  cellSize = Math.min(cellSize, 100);
  
  return cellSize;
}

/**
 * Get grid cell indices for a bounding box
 */
function getGridCells(bbox: { minx: number; miny: number; maxx: number; maxy: number }, cellSize: number): Array<{ i: number; j: number }> {
  const minI = Math.floor(bbox.minx / cellSize);
  const maxI = Math.floor(bbox.maxx / cellSize);
  const minJ = Math.floor(bbox.miny / cellSize);
  const maxJ = Math.floor(bbox.maxy / cellSize);
  
  const cells: Array<{ i: number; j: number }> = [];
  for (let i = minI; i <= maxI; i++) {
    for (let j = minJ; j <= maxJ; j++) {
      cells.push({ i, j });
    }
  }
  
  return cells;
}

async function main(): Promise<void> {
  const sourcePath = resolve('data/derived/settlements_substrate.geojson');
  const outputPath = resolve('data/derived/settlement_graph_v2.json');
  const auditJsonPath = resolve('data/derived/settlement_graph_v2.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_graph_v2.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });
  
  // Load source GeoJSON
  process.stdout.write(`Loading ${sourcePath}...\n`);
  const sourceContent = readFileSync(sourcePath, 'utf8');
  const sourceGeoJSON = JSON.parse(sourceContent) as GeoJSONFC;
  
  if (sourceGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${sourceGeoJSON.type}`);
  }
  
  const features = sourceGeoJSON.features;
  process.stdout.write(`Loaded ${features.length} features\n`);
  
  // Compute global bbox and EPS
  process.stdout.write(`Computing global bounding box...\n`);
  const bbox = computeGlobalBbox(features);
  if (!bbox) {
    throw new Error('Could not compute global bounding box');
  }
  
  const eps = computeEPS(bbox);
  const cellSize = computeGridCellSize(bbox);
  process.stdout.write(`EPS (quantization grid): ${eps}\n`);
  process.stdout.write(`Grid cell size: ${cellSize}\n`);
  process.stdout.write(`Global bbox: [${bbox.minx}, ${bbox.miny}, ${bbox.maxx}, ${bbox.maxy}]\n`);
  
  // Extract segments and build spatial index
  process.stdout.write(`Extracting boundary segments...\n`);
  const allSegments: Segment[] = [];
  const allValidSids = new Set<string>();
  let missingSidCount = 0;
  let nonPolygonCount = 0;
  
  for (const feature of features) {
    const sid = extractSid(feature.properties);
    if (sid === null) {
      missingSidCount++;
      continue;
    }
    
    if (!isPolygonGeometry(feature.geometry)) {
      nonPolygonCount++;
      continue;
    }
    
    // Track this as a valid settlement
    allValidSids.add(sid);
    
    const segments = extractSegmentsFromGeometry(feature.geometry, sid);
    allSegments.push(...segments);
  }
  
  process.stdout.write(`Extracted ${allSegments.length} segments from ${allValidSids.size} settlements\n`);
  process.stdout.write(`Missing SID features: ${missingSidCount}\n`);
  process.stdout.write(`Non-polygon features: ${nonPolygonCount}\n`);
  
  // Build spatial grid index
  process.stdout.write(`Building spatial grid index...\n`);
  const grid = new Map<string, Segment[]>();
  
  for (const seg of allSegments) {
    const cells = getGridCells(seg.bbox, cellSize);
    for (const cell of cells) {
      const cellKey = `${cell.i},${cell.j}`;
      if (!grid.has(cellKey)) {
        grid.set(cellKey, []);
      }
      grid.get(cellKey)!.push(seg);
    }
  }
  
  process.stdout.write(`Grid has ${grid.size} cells\n`);
  
  // Build adjacency graph from overlapping segments
  process.stdout.write(`Detecting overlapping colinear segments...\n`);
  const adjacencyMap = new Map<string, Map<string, number>>(); // sid -> { neighborSid -> shared_length }
  let segmentComparisons = 0;
  let skippedNumeric = 0;
  
  // Process each grid cell
  for (const [cellKey, cellSegments] of grid.entries()) {
    // Compare segments from different settlements
    for (let i = 0; i < cellSegments.length; i++) {
      for (let j = i + 1; j < cellSegments.length; j++) {
        const seg1 = cellSegments[i];
        const seg2 = cellSegments[j];
        
        // Skip if same settlement
        if (seg1.sid === seg2.sid) {
          continue;
        }
        
        segmentComparisons++;
        
        // Check if segments are colinear
        if (!areColinear(seg1, seg2, eps)) {
          continue;
        }
        
        // Compute overlap length
        let overlapLen: number;
        try {
          overlapLen = computeOverlapLength(seg1, seg2);
        } catch (err) {
          skippedNumeric++;
          continue;
        }
        
        // Only count if overlap length > 0
        if (overlapLen <= 0) {
          continue;
        }
        
        // Ensure sid ordering is deterministic (low < high)
        const sidA = seg1.sid < seg2.sid ? seg1.sid : seg2.sid;
        const sidB = seg1.sid < seg2.sid ? seg2.sid : seg1.sid;
        
        // Initialize maps if needed
        if (!adjacencyMap.has(sidA)) {
          adjacencyMap.set(sidA, new Map());
        }
        if (!adjacencyMap.has(sidB)) {
          adjacencyMap.set(sidB, new Map());
        }
        
        const mapA = adjacencyMap.get(sidA)!;
        const mapB = adjacencyMap.get(sidB)!;
        
        // Accumulate shared border length
        const currentA = mapA.get(sidB) || 0;
        const currentB = mapB.get(sidA) || 0;
        
        const newLength = currentA + overlapLen;
        mapA.set(sidB, newLength);
        mapB.set(sidA, newLength);
      }
    }
  }
  
  process.stdout.write(`Built adjacency for ${adjacencyMap.size} nodes with neighbors\n`);
  process.stdout.write(`Total valid settlements: ${allValidSids.size}\n`);
  process.stdout.write(`Segment comparisons performed: ${segmentComparisons}\n`);
  process.stdout.write(`Skipped due to numeric issues: ${skippedNumeric}\n`);
  
  // Build graph structure (sorted, deterministic)
  // Include ALL valid settlements, even if they have no neighbors (isolated)
  const allSids = Array.from(allValidSids).sort(); // Deterministic ordering
  
  const graph: Record<string, Array<{ sid: string; shared_border_length: number }>> = {};
  const edgeList: GraphEdge[] = [];
  const edgeSet = new Set<string>(); // For deduplication: "sid_low|sid_high"
  
  for (const sid of allSids) {
    const neighbors = adjacencyMap.get(sid);
    const neighborArray: Array<{ sid: string; shared_border_length: number }> = [];
    
    if (neighbors) {
      for (const [neighborSid, length] of neighbors.entries()) {
        neighborArray.push({ sid: neighborSid, shared_border_length: length });
      }
    }
    
    // Sort neighbors by sid (deterministic)
    neighborArray.sort((a, b) => a.sid.localeCompare(b.sid));
    
    graph[sid] = neighborArray;
    
    // Add to edge list (undirected, so only add once per pair)
    for (const neighbor of neighborArray) {
      const sidLow = sid < neighbor.sid ? sid : neighbor.sid;
      const sidHigh = sid < neighbor.sid ? neighbor.sid : sid;
      const edgeKey = `${sidLow}|${sidHigh}`;
      
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edgeList.push({
          a: sidLow,
          b: sidHigh,
          shared_border_length: neighbor.shared_border_length
        });
      }
    }
  }
  
  // Sort edge list (deterministic)
  edgeList.sort((e1, e2) => {
    const aCompare = e1.a.localeCompare(e2.a);
    if (aCompare !== 0) {
      return aCompare;
    }
    return e1.b.localeCompare(e2.b);
  });
  
  // Build output graph
  const outputGraph: SettlementGraph = {
    schema_version: 1,
    source: 'data/derived/settlements_substrate.geojson',
    nodes: allSids.length,
    edges: edgeList.length,
    graph,
    edge_list: edgeList
  };
  
  // Compute audit statistics
  const degrees = allSids.map(sid => graph[sid].length);
  degrees.sort((a, b) => a - b);
  
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
  
  const isolated: string[] = [];
  for (const sid of allSids) {
    if (graph[sid].length === 0) {
      isolated.push(sid);
    }
  }
  isolated.sort(); // Deterministic ordering
  
  const topDegree: Array<{ sid: string; degree: number }> = allSids
    .map(sid => ({ sid, degree: graph[sid].length }))
    .sort((a, b) => {
      if (b.degree !== a.degree) {
        return b.degree - a.degree;
      }
      return a.sid.localeCompare(b.sid);
    })
    .slice(0, 20); // Top 20
  
  const topSharedBorderEdges: Array<{ a: string; b: string; length: number }> = edgeList
    .map(e => ({ a: e.a, b: e.b, length: e.shared_border_length }))
    .sort((e1, e2) => {
      if (e2.length !== e1.length) {
        return e2.length - e1.length;
      }
      const aCompare = e1.a.localeCompare(e2.a);
      if (aCompare !== 0) {
        return aCompare;
      }
      return e1.b.localeCompare(e2.b);
    })
    .slice(0, 50); // Top 50
  
  const auditReport: AuditReport = {
    counts: {
      nodes: allSids.length,
      edges: edgeList.length,
      isolated_count: isolated.length
    },
    degree_stats: {
      min: degrees.length > 0 ? degrees[0] : 0,
      p50: median(degrees),
      p90: p90(degrees),
      max: degrees.length > 0 ? degrees[degrees.length - 1] : 0
    },
    top_degree: topDegree,
    top_shared_border_edges: topSharedBorderEdges,
    isolated: isolated,
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      segment_comparisons_performed: segmentComparisons,
      skipped_due_to_numeric_issues: skippedNumeric
    }
  };
  
  // Write output graph
  writeFileSync(outputPath, JSON.stringify(outputGraph, null, 2), 'utf8');
  process.stdout.write(`Wrote graph to ${outputPath}\n`);
  process.stdout.write(`  Nodes: ${outputGraph.nodes}\n`);
  process.stdout.write(`  Edges: ${outputGraph.edges}\n`);
  
  // Write audit JSON
  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditJsonPath}\n`);
  
  // Write audit TXT
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENT ADJACENCY GRAPH AUDIT (v2: Overlap Detection)');
  txtLines.push('==========================================================');
  txtLines.push('');
  txtLines.push('COUNTS:');
  txtLines.push(`  Nodes: ${auditReport.counts.nodes}`);
  txtLines.push(`  Edges: ${auditReport.counts.edges}`);
  txtLines.push(`  Isolated settlements: ${auditReport.counts.isolated_count}`);
  txtLines.push('');
  txtLines.push('DEGREE STATISTICS:');
  txtLines.push(`  Min: ${auditReport.degree_stats.min}`);
  txtLines.push(`  Median (p50): ${auditReport.degree_stats.p50}`);
  txtLines.push(`  p90: ${auditReport.degree_stats.p90}`);
  txtLines.push(`  Max: ${auditReport.degree_stats.max}`);
  txtLines.push('');
  txtLines.push('TOP DEGREE SETTLEMENTS (top 20):');
  for (const item of auditReport.top_degree) {
    txtLines.push(`  ${item.sid}: degree ${item.degree}`);
  }
  txtLines.push('');
  txtLines.push('TOP SHARED BORDER EDGES (top 50 by length):');
  for (const edge of auditReport.top_shared_border_edges) {
    txtLines.push(`  ${edge.a} <-> ${edge.b}: ${edge.length.toFixed(6)}`);
  }
  txtLines.push('');
  if (auditReport.isolated.length > 0) {
    txtLines.push(`ISOLATED SETTLEMENTS (${auditReport.isolated.length}):`);
    // Show first 50, then count if more
    const showCount = Math.min(50, auditReport.isolated.length);
    for (let i = 0; i < showCount; i++) {
      txtLines.push(`  ${auditReport.isolated[i]}`);
    }
    if (auditReport.isolated.length > showCount) {
      txtLines.push(`  ... and ${auditReport.isolated.length - showCount} more`);
    }
    txtLines.push('');
  }
  txtLines.push('ANOMALIES:');
  txtLines.push(`  Missing SID features: ${auditReport.anomalies.missing_sid_features_count}`);
  txtLines.push(`  Non-polygon features: ${auditReport.anomalies.non_polygon_features_count}`);
  txtLines.push(`  Segment comparisons performed: ${auditReport.anomalies.segment_comparisons_performed}`);
  txtLines.push(`  Skipped due to numeric issues: ${auditReport.anomalies.skipped_due_to_numeric_issues}`);
  txtLines.push('');
  txtLines.push('NOTE:');
  txtLines.push('  Adjacency is defined as shared boundary segments only (contiguity).');
  txtLines.push('  Point-touch does not create edges. No terrain inference performed.');
  txtLines.push('  v2 uses overlap detection to find shared borders even when boundaries');
  txtLines.push('  are split differently across polygons (robust to different vertex splits).');
  txtLines.push('  Coordinate quantization (EPS) used only for robust segment matching.');
  txtLines.push('  No geometry modification or invention performed.');
  
  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Nodes: ${auditReport.counts.nodes}\n`);
  process.stdout.write(`  Edges: ${auditReport.counts.edges}\n`);
  process.stdout.write(`  Isolated: ${auditReport.counts.isolated_count}\n`);
  process.stdout.write(`  Degree: min=${auditReport.degree_stats.min}, median=${auditReport.degree_stats.p50}, p90=${auditReport.degree_stats.p90}, max=${auditReport.degree_stats.max}\n`);
  process.stdout.write(`  Segment comparisons: ${auditReport.anomalies.segment_comparisons_performed}\n`);
  process.stdout.write(`  Skipped numeric: ${auditReport.anomalies.skipped_due_to_numeric_issues}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
