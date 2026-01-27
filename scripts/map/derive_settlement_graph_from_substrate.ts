/**
 * Derive Settlement Adjacency Graph from Settlement Substrate
 * 
 * CANONICAL SCRIPT FOR PHASE 1 SETTLEMENT ADJACENCY GRAPH
 * 
 * This script derives a deterministic, undirected adjacency graph where edges
 * exist ONLY when two settlement polygons share a boundary segment (shared border
 * length > 0). No terrain inference, no point-touch adjacency, no geometry invention.
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no unions, hulls, buffering, smoothing, repair, simplification.
 * Coordinate quantization is used ONLY for robust segment key matching, derived
 * deterministically from the dataset bounds and applied uniformly (does not modify
 * or write geometry).
 * 
 * Usage:
 *   npm run map:derive:graph
 *   or: tsx scripts/map/derive_settlement_graph_from_substrate.ts
 * 
 * Outputs:
 *   - data/derived/settlement_graph.json (canonical Phase 1 adjacency graph)
 *   - data/derived/settlement_graph.audit.json
 *   - data/derived/settlement_graph.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1: derive deterministic settlement adjacency graph from frozen settlement substrate without any geometry invention");

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

interface SegmentInfo {
  len: number;
  owners: Set<string>;
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
  isolated: string[];
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    segment_multishare_count: number;
    max_shared_border_length_edge: {
      a: string;
      b: string;
      length: number;
    } | null;
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
 * Quantize coordinate to grid
 */
function quantize(coord: number, eps: number): number {
  return Math.round(coord / eps) * eps;
}

/**
 * Canonicalize segment endpoints (lexicographic ordering)
 */
function canonicalizeSegment(p1: Point, p2: Point): [Point, Point] {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  
  // Lexicographic comparison: x first, then y
  if (x1 < x2 || (x1 === x2 && y1 < y2)) {
    return [p1, p2];
  }
  if (x2 < x1 || (x2 === x1 && y2 < y1)) {
    return [p2, p1];
  }
  // Points are equal (shouldn't happen for valid segments, but handle gracefully)
  return [p1, p2];
}

/**
 * Create segment key string from quantized endpoints
 */
function createSegmentKey(p1: Point, p2: Point, eps: number): string {
  const [q1, q2] = canonicalizeSegment(p1, p2);
  const [x1, y1] = q1;
  const [x2, y2] = q2;
  
  // Quantize
  const qx1 = quantize(x1, eps);
  const qy1 = quantize(y1, eps);
  const qx2 = quantize(x2, eps);
  const qy2 = quantize(y2, eps);
  
  // Format with enough precision to preserve EPS grid
  // Use fixed decimal formatting with sufficient precision
  const precision = Math.max(9, Math.ceil(-Math.log10(eps)) + 2);
  return `${qx1.toFixed(precision)},${qy1.toFixed(precision)}|${qx2.toFixed(precision)},${qy2.toFixed(precision)}`;
}

/**
 * Compute euclidean length of segment from quantized endpoints
 */
function computeSegmentLength(p1: Point, p2: Point, eps: number): number {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  
  const qx1 = quantize(x1, eps);
  const qy1 = quantize(y1, eps);
  const qx2 = quantize(x2, eps);
  const qy2 = quantize(y2, eps);
  
  const dx = qx2 - qx1;
  const dy = qy2 - qy1;
  
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Extract all boundary segments from a polygon outer ring
 */
function extractSegmentsFromRing(ring: Ring, eps: number): Array<{ key: string; len: number; p1: Point; p2: Point }> {
  const segments: Array<{ key: string; len: number; p1: Point; p2: Point }> = [];
  
  // Iterate consecutive pairs (ring is closed, so last point connects to first)
  for (let i = 0; i < ring.length; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % ring.length];
    
    // Skip zero-length segments
    const len = computeSegmentLength(p1, p2, eps);
    if (len === 0) {
      continue;
    }
    
    const key = createSegmentKey(p1, p2, eps);
    segments.push({ key, len, p1, p2 });
  }
  
  return segments;
}

/**
 * Extract all boundary segments from a polygon geometry
 */
function extractSegmentsFromGeometry(
  geom: GeoJSONFeature['geometry'],
  eps: number
): Array<{ key: string; len: number; p1: Point; p2: Point }> {
  const segments: Array<{ key: string; len: number; p1: Point; p2: Point }> = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    // Only process outer ring (first ring)
    if (polygon.length > 0) {
      const outerRing = polygon[0];
      segments.push(...extractSegmentsFromRing(outerRing, eps));
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as MultiPolygon;
    // Process outer ring of each polygon
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        const outerRing = polygon[0];
        segments.push(...extractSegmentsFromRing(outerRing, eps));
      }
    }
  }
  
  return segments;
}

async function main(): Promise<void> {
  const sourcePath = resolve('data/derived/settlements_substrate.geojson');
  const outputPath = resolve('data/derived/settlement_graph.json');
  const auditJsonPath = resolve('data/derived/settlement_graph.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_graph.audit.txt');
  
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
  process.stdout.write(`EPS (quantization grid): ${eps}\n`);
  process.stdout.write(`Global bbox: [${bbox.minx}, ${bbox.miny}, ${bbox.maxx}, ${bbox.maxy}]\n`);
  
  // Extract segments and build segment -> owners map
  // Also collect all valid settlement SIDs (for isolated node tracking)
  process.stdout.write(`Extracting boundary segments...\n`);
  const segmentMap = new Map<string, SegmentInfo>();
  const allValidSids = new Set<string>(); // All settlements with valid SID and polygon geometry
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
    
    const segments = extractSegmentsFromGeometry(feature.geometry, eps);
    
    for (const seg of segments) {
      if (!segmentMap.has(seg.key)) {
        segmentMap.set(seg.key, { len: seg.len, owners: new Set() });
      }
      const info = segmentMap.get(seg.key)!;
      // Use the length from the first occurrence (should be same for all, but deterministic)
      info.owners.add(sid);
    }
  }
  
  process.stdout.write(`Extracted ${segmentMap.size} unique segments\n`);
  process.stdout.write(`Missing SID features: ${missingSidCount}\n`);
  process.stdout.write(`Non-polygon features: ${nonPolygonCount}\n`);
  
  // Build adjacency graph from shared segments
  process.stdout.write(`Building adjacency graph...\n`);
  const adjacencyMap = new Map<string, Map<string, number>>(); // sid -> { neighborSid -> shared_length }
  let segmentMultishareCount = 0;
  let maxSharedBorderLength = 0;
  let maxSharedBorderEdge: { a: string; b: string; length: number } | null = null;
  
  for (const [segmentKey, info] of segmentMap.entries()) {
    if (info.owners.size >= 2) {
      // Multiple owners: create edges for all pairs
      const ownersArray = Array.from(info.owners).sort(); // Deterministic ordering
      
      if (info.owners.size > 2) {
        segmentMultishareCount++;
      }
      
      for (let i = 0; i < ownersArray.length; i++) {
        for (let j = i + 1; j < ownersArray.length; j++) {
          const sidA = ownersArray[i];
          const sidB = ownersArray[j];
          
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
          
          const newLength = currentA + info.len;
          mapA.set(sidB, newLength);
          mapB.set(sidA, newLength);
          
          // Track max shared border length
          if (newLength > maxSharedBorderLength) {
            maxSharedBorderLength = newLength;
            maxSharedBorderEdge = { a: sidA, b: sidB, length: newLength };
          }
        }
      }
    }
  }
  
  process.stdout.write(`Built adjacency for ${adjacencyMap.size} nodes with neighbors\n`);
  process.stdout.write(`Total valid settlements: ${allValidSids.size}\n`);
  process.stdout.write(`Segments shared by >2 settlements: ${segmentMultishareCount}\n`);
  
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
    isolated: isolated,
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      segment_multishare_count: segmentMultishareCount,
      max_shared_border_length_edge: maxSharedBorderEdge
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
  txtLines.push('SETTLEMENT ADJACENCY GRAPH AUDIT');
  txtLines.push('=================================');
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
  txtLines.push(`  Segments shared by >2 settlements: ${auditReport.anomalies.segment_multishare_count}`);
  if (auditReport.anomalies.max_shared_border_length_edge) {
    const edge = auditReport.anomalies.max_shared_border_length_edge;
    txtLines.push(`  Max shared border length: ${edge.length.toFixed(6)} (${edge.a} <-> ${edge.b})`);
  }
  txtLines.push('');
  txtLines.push('NOTE:');
  txtLines.push('  Adjacency is defined as shared boundary segments only (contiguity).');
  txtLines.push('  Point-touch does not create edges. No terrain inference performed.');
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
  process.stdout.write(`  Segments shared by >2: ${auditReport.anomalies.segment_multishare_count}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
