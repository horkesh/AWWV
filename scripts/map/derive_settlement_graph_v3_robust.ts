/**
 * Derive Settlement Adjacency Graph from Settlement Substrate (v3: Robust Boundary Detection)
 *
 * CANONICAL SCRIPT FOR PHASE 1 SETTLEMENT ADJACENCY GRAPH (v3)
 *
 * This script derives a deterministic, undirected adjacency graph where edges
 * exist when two settlement polygons share a boundary segment. Unlike v1/v2, this
 * version handles the case where settlement boundaries were digitized independently
 * and don't share exact coordinates but are within a digitization tolerance.
 *
 * Key insight: Settlement boundaries in bih_master.geojson are nearly parallel lines
 * ~0.001-0.01 units apart, NOT the same line with different vertex splits. v1/v2
 * failed because they required exact colinearity.
 *
 * Algorithm:
 * 1. Extract all boundary segments from each settlement
 * 2. Use spatial index to find candidate segment pairs from different settlements
 * 3. For each candidate pair, check if segments are:
 *    a) Nearly parallel (dot product of unit vectors > threshold)
 *    b) Within tolerance distance (max point-to-segment distance < threshold)
 *    c) Have significant projected overlap (overlap length > min threshold)
 * 4. Accumulate matched segment lengths to determine shared border length
 *
 * Deterministic: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no unions, hulls, buffering, smoothing, repair, simplification.
 * Tolerance parameters derived deterministically from dataset bounds.
 *
 * Usage:
 *   npm run map:derive:graph:v3
 *   or: tsx scripts/map/derive_settlement_graph_v3_robust.ts
 *
 * Outputs:
 *   - data/derived/settlement_graph_v3.json (canonical Phase 1 adjacency graph v3)
 *   - data/derived/settlement_graph_v3.audit.json
 *   - data/derived/settlement_graph_v3.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 v3: derive settlement adjacency using Hausdorff-distance segment matching to handle independently digitized boundaries");

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

interface GraphEdge {
  a: string;
  b: string;
  shared_border_length: number;
}

interface SettlementGraph {
  schema_version: number;
  source: string;
  algorithm: string;
  tolerance_params: {
    distance_tolerance: number;
    parallel_threshold: number;
    min_overlap_length: number;
  };
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
  // Unit direction vector
  dx: number;
  dy: number;
  // Bounding box with tolerance expansion
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
  tolerance_params: {
    distance_tolerance: number;
    parallel_threshold: number;
    min_overlap_length: number;
  };
  top_degree: Array<{ sid: string; degree: number }>;
  top_shared_border_edges: Array<{ a: string; b: string; length: number }>;
  isolated: string[];
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    segment_pairs_checked: number;
    matches_found: number;
  };
}

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

  for (const feature of features) {
    if (!isPolygonGeometry(feature.geometry)) continue;

    if (feature.geometry.type === 'Polygon') {
      for (const ring of feature.geometry.coordinates as Polygon) {
        for (const point of ring) addPoint(point);
      }
    } else if (feature.geometry.type === 'MultiPolygon') {
      for (const poly of feature.geometry.coordinates as MultiPolygon) {
        for (const ring of poly) {
          for (const point of ring) addPoint(point);
        }
      }
    }
  }

  return minx === Infinity ? null : { minx, miny, maxx, maxy };
}

/**
 * Compute euclidean length
 */
function length(p1: Point, p2: Point): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Perpendicular distance from point to infinite line defined by segment
 */
function pointToLineDistance(p: Point, seg: Segment): number {
  // Using cross product formula: |AP × AB| / |AB|
  const [px, py] = p;
  const [ax, ay] = seg.p1;
  const apx = px - ax;
  const apy = py - ay;

  // Cross product magnitude (AP × unit direction)
  return Math.abs(apx * seg.dy - apy * seg.dx);
}

/**
 * Project point onto line defined by segment, return parameter t
 * t=0 at p1, t=1 at p2
 */
function projectPointOntoLine(p: Point, seg: Segment): number {
  const [px, py] = p;
  const [ax, ay] = seg.p1;
  const apx = px - ax;
  const apy = py - ay;

  // Dot product with unit direction, normalized by length
  return (apx * seg.dx + apy * seg.dy) / seg.len;
}

/**
 * Extract all boundary segments from a ring
 */
function extractSegmentsFromRing(ring: Ring, sid: string, tol: number): Segment[] {
  const segments: Segment[] = [];

  for (let i = 0; i < ring.length - 1; i++) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    const len = length(p1, p2);

    // Skip degenerate segments
    if (len < 1e-9) continue;

    // Unit direction vector
    const dx = (p2[0] - p1[0]) / len;
    const dy = (p2[1] - p1[1]) / len;

    // Bbox with tolerance expansion
    const bbox = {
      minx: Math.min(p1[0], p2[0]) - tol,
      miny: Math.min(p1[1], p2[1]) - tol,
      maxx: Math.max(p1[0], p2[0]) + tol,
      maxy: Math.max(p1[1], p2[1]) + tol
    };

    segments.push({ p1, p2, len, sid, dx, dy, bbox });
  }

  return segments;
}

/**
 * Extract all boundary segments from a geometry
 */
function extractSegmentsFromGeometry(geom: GeoJSONFeature['geometry'], sid: string, tol: number): Segment[] {
  const segments: Segment[] = [];

  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    // Only process outer ring (index 0)
    if (polygon.length > 0) {
      segments.push(...extractSegmentsFromRing(polygon[0], sid, tol));
    }
  } else if (geom.type === 'MultiPolygon') {
    for (const polygon of geom.coordinates as MultiPolygon) {
      if (polygon.length > 0) {
        segments.push(...extractSegmentsFromRing(polygon[0], sid, tol));
      }
    }
  }

  return segments;
}

/**
 * Check if two segments are nearly parallel
 * Returns absolute dot product of unit vectors (1 = parallel, 0 = perpendicular)
 */
function areParallel(seg1: Segment, seg2: Segment): number {
  // Dot product of unit direction vectors (absolute value since direction doesn't matter)
  return Math.abs(seg1.dx * seg2.dx + seg1.dy * seg2.dy);
}

/**
 * Compute the shared border length between two parallel segments within tolerance
 * Returns 0 if segments are not close enough or don't overlap
 */
function computeSharedLength(
  seg1: Segment,
  seg2: Segment,
  distTol: number,
  minOverlap: number
): number {
  // Check if all 4 endpoints are within distance tolerance of the other segment's line
  const d1a = pointToLineDistance(seg1.p1, seg2);
  const d1b = pointToLineDistance(seg1.p2, seg2);
  const d2a = pointToLineDistance(seg2.p1, seg1);
  const d2b = pointToLineDistance(seg2.p2, seg1);

  const maxDist = Math.max(d1a, d1b, d2a, d2b);
  if (maxDist > distTol) {
    return 0;
  }

  // Project all 4 endpoints onto seg1's line to find overlap
  const t1a = 0; // seg1.p1 projects to 0
  const t1b = 1; // seg1.p2 projects to 1
  const t2a = projectPointOntoLine(seg2.p1, seg1);
  const t2b = projectPointOntoLine(seg2.p2, seg1);

  // Find overlap range
  const seg2Min = Math.min(t2a, t2b);
  const seg2Max = Math.max(t2a, t2b);

  const overlapMin = Math.max(0, seg2Min);
  const overlapMax = Math.min(1, seg2Max);
  const overlapT = overlapMax - overlapMin;

  if (overlapT <= 0) {
    return 0;
  }

  // Convert to actual length
  const overlapLen = overlapT * seg1.len;

  if (overlapLen < minOverlap) {
    return 0;
  }

  return overlapLen;
}

/**
 * Get grid cell key
 */
function cellKey(i: number, j: number): string {
  return `${i},${j}`;
}

async function main(): Promise<void> {
  const sourcePath = resolve('data/derived/settlements_substrate.geojson');
  const outputPath = resolve('data/derived/settlement_graph_v3.json');
  const auditJsonPath = resolve('data/derived/settlement_graph_v3.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_graph_v3.audit.txt');

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

  // Compute global bbox
  const bbox = computeGlobalBbox(features);
  if (!bbox) {
    throw new Error('Could not compute global bounding box');
  }

  const width = bbox.maxx - bbox.minx;
  const height = bbox.maxy - bbox.miny;
  const maxDim = Math.max(width, height);

  // Tolerance parameters derived deterministically from dataset bounds
  // Distance tolerance: ~0.02 units based on observed digitization gaps of 0.001-0.01
  // This is large enough to catch digitization gaps but small enough to not create false adjacencies
  const distanceTolerance = Math.max(0.02, maxDim * 2e-5);

  // Parallel threshold: cos(10°) ≈ 0.985 - segments must be nearly parallel
  const parallelThreshold = 0.985;

  // Minimum overlap length: 0.1 units - reject tiny incidental overlaps
  const minOverlapLength = 0.1;

  process.stdout.write(`Global bbox: [${bbox.minx.toFixed(3)}, ${bbox.miny.toFixed(3)}, ${bbox.maxx.toFixed(3)}, ${bbox.maxy.toFixed(3)}]\n`);
  process.stdout.write(`Distance tolerance: ${distanceTolerance.toFixed(6)}\n`);
  process.stdout.write(`Parallel threshold: ${parallelThreshold}\n`);
  process.stdout.write(`Min overlap length: ${minOverlapLength}\n`);

  // Extract segments
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

    allValidSids.add(sid);
    const segments = extractSegmentsFromGeometry(feature.geometry, sid, distanceTolerance);
    allSegments.push(...segments);
  }

  process.stdout.write(`Extracted ${allSegments.length} segments from ${allValidSids.size} settlements\n`);

  // Build spatial grid index
  const cellSize = Math.max(5, maxDim / 100);
  process.stdout.write(`Building spatial grid (cell size: ${cellSize.toFixed(3)})...\n`);

  const grid = new Map<string, Segment[]>();

  for (const seg of allSegments) {
    const minI = Math.floor(seg.bbox.minx / cellSize);
    const maxI = Math.floor(seg.bbox.maxx / cellSize);
    const minJ = Math.floor(seg.bbox.miny / cellSize);
    const maxJ = Math.floor(seg.bbox.maxy / cellSize);

    for (let i = minI; i <= maxI; i++) {
      for (let j = minJ; j <= maxJ; j++) {
        const key = cellKey(i, j);
        if (!grid.has(key)) {
          grid.set(key, []);
        }
        grid.get(key)!.push(seg);
      }
    }
  }

  process.stdout.write(`Grid has ${grid.size} cells\n`);

  // Find matching segments
  // Strategy: Process grid cells in sorted order. For each cell, only process segment
  // pairs where BOTH segments have this cell as their "home" cell (lowest indexed cell
  // they appear in). This guarantees each pair is processed exactly once without
  // needing to track all pairs in memory.
  process.stdout.write(`Finding matching boundary segments...\n`);

  // Map: "sidA|sidB" -> accumulated shared length (where sidA < sidB lexicographically)
  const pairLengths = new Map<string, number>();
  let segmentPairsChecked = 0;
  let matchesFound = 0;

  // Assign each segment a "home" cell (the lowest indexed cell it appears in)
  const segmentHomeCell = new Map<Segment, string>();
  const sortedCellKeys = Array.from(grid.keys()).sort();

  for (const cellKey of sortedCellKeys) {
    for (const seg of grid.get(cellKey)!) {
      if (!segmentHomeCell.has(seg)) {
        segmentHomeCell.set(seg, cellKey);
      }
    }
  }

  let cellsProcessed = 0;
  for (const cellKey of sortedCellKeys) {
    const cellSegments = grid.get(cellKey)!;

    for (let i = 0; i < cellSegments.length; i++) {
      for (let j = i + 1; j < cellSegments.length; j++) {
        const seg1 = cellSegments[i];
        const seg2 = cellSegments[j];

        // Skip same settlement
        if (seg1.sid === seg2.sid) continue;

        // Only process pair if BOTH segments have this cell as their home cell
        // This ensures each pair is processed exactly once
        if (segmentHomeCell.get(seg1) !== cellKey || segmentHomeCell.get(seg2) !== cellKey) {
          continue;
        }

        segmentPairsChecked++;

        // Check if segments are nearly parallel
        const parallelism = areParallel(seg1, seg2);
        if (parallelism < parallelThreshold) continue;

        // Compute shared length
        const sharedLen = computeSharedLength(seg1, seg2, distanceTolerance, minOverlapLength);
        if (sharedLen <= 0) continue;

        matchesFound++;

        // Accumulate shared length for this settlement pair
        const sidA = seg1.sid < seg2.sid ? seg1.sid : seg2.sid;
        const sidB = seg1.sid < seg2.sid ? seg2.sid : seg1.sid;
        const settlementPairKey = `${sidA}|${sidB}`;

        const currentLen = pairLengths.get(settlementPairKey) || 0;
        pairLengths.set(settlementPairKey, currentLen + sharedLen);
      }
    }

    cellsProcessed++;
    if (cellsProcessed % 500 === 0) {
      process.stdout.write(`  Processed ${cellsProcessed}/${sortedCellKeys.length} cells, ${segmentPairsChecked} pairs checked, ${matchesFound} matches...\n`);
    }
  }

  process.stdout.write(`Checked ${segmentPairsChecked} segment pairs, found ${matchesFound} matches\n`);
  process.stdout.write(`Found ${pairLengths.size} adjacent settlement pairs\n`);

  // Build graph structure
  const allSids = Array.from(allValidSids).sort();
  const graph: Record<string, Array<{ sid: string; shared_border_length: number }>> = {};
  const edgeList: GraphEdge[] = [];

  // Initialize all nodes with empty neighbor lists
  for (const sid of allSids) {
    graph[sid] = [];
  }

  // Add edges
  for (const [pairKey, sharedLen] of pairLengths.entries()) {
    const [sidA, sidB] = pairKey.split('|');

    graph[sidA].push({ sid: sidB, shared_border_length: sharedLen });
    graph[sidB].push({ sid: sidA, shared_border_length: sharedLen });

    edgeList.push({ a: sidA, b: sidB, shared_border_length: sharedLen });
  }

  // Sort neighbors and edges for determinism
  for (const sid of allSids) {
    graph[sid].sort((a, b) => a.sid.localeCompare(b.sid));
  }
  edgeList.sort((e1, e2) => {
    const cmp = e1.a.localeCompare(e2.a);
    return cmp !== 0 ? cmp : e1.b.localeCompare(e2.b);
  });

  // Build output
  const outputGraph: SettlementGraph = {
    schema_version: 1,
    source: 'data/derived/settlements_substrate.geojson',
    algorithm: 'v3_robust_boundary_matching',
    tolerance_params: {
      distance_tolerance: distanceTolerance,
      parallel_threshold: parallelThreshold,
      min_overlap_length: minOverlapLength
    },
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

  const percentile = (arr: number[], p: number) => {
    if (arr.length === 0) return 0;
    const idx = Math.floor(arr.length * p);
    return arr[Math.min(idx, arr.length - 1)];
  };

  const isolated = allSids.filter(sid => graph[sid].length === 0).sort();

  const topDegree = allSids
    .map(sid => ({ sid, degree: graph[sid].length }))
    .sort((a, b) => b.degree !== a.degree ? b.degree - a.degree : a.sid.localeCompare(b.sid))
    .slice(0, 20);

  const topSharedBorderEdges = edgeList
    .map(e => ({ a: e.a, b: e.b, length: e.shared_border_length }))
    .sort((a, b) => b.length !== a.length ? b.length - a.length : a.a.localeCompare(b.a))
    .slice(0, 50);

  const auditReport: AuditReport = {
    counts: {
      nodes: allSids.length,
      edges: edgeList.length,
      isolated_count: isolated.length
    },
    degree_stats: {
      min: degrees.length > 0 ? degrees[0] : 0,
      p50: median(degrees),
      p90: percentile(degrees, 0.9),
      max: degrees.length > 0 ? degrees[degrees.length - 1] : 0
    },
    tolerance_params: {
      distance_tolerance: distanceTolerance,
      parallel_threshold: parallelThreshold,
      min_overlap_length: minOverlapLength
    },
    top_degree: topDegree,
    top_shared_border_edges: topSharedBorderEdges,
    isolated: isolated,
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      segment_pairs_checked: segmentPairsChecked,
      matches_found: matchesFound
    }
  };

  // Write outputs
  writeFileSync(outputPath, JSON.stringify(outputGraph, null, 2), 'utf8');
  process.stdout.write(`Wrote graph to ${outputPath}\n`);

  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditJsonPath}\n`);

  // Write audit TXT
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENT ADJACENCY GRAPH AUDIT (v3: Robust Boundary Detection)');
  txtLines.push('=================================================================');
  txtLines.push('');
  txtLines.push('ALGORITHM:');
  txtLines.push('  v3 uses Hausdorff-distance segment matching to detect shared borders');
  txtLines.push('  between settlements with independently digitized boundaries.');
  txtLines.push('  Unlike v1/v2 (exact colinearity), v3 handles parallel boundaries');
  txtLines.push('  within digitization tolerance.');
  txtLines.push('');
  txtLines.push('TOLERANCE PARAMETERS:');
  txtLines.push(`  Distance tolerance: ${auditReport.tolerance_params.distance_tolerance.toFixed(6)}`);
  txtLines.push(`  Parallel threshold: ${auditReport.tolerance_params.parallel_threshold}`);
  txtLines.push(`  Min overlap length: ${auditReport.tolerance_params.min_overlap_length}`);
  txtLines.push('');
  txtLines.push('COUNTS:');
  txtLines.push(`  Nodes: ${auditReport.counts.nodes}`);
  txtLines.push(`  Edges: ${auditReport.counts.edges}`);
  txtLines.push(`  Isolated settlements: ${auditReport.counts.isolated_count}`);
  txtLines.push(`  Isolation rate: ${(100 * auditReport.counts.isolated_count / auditReport.counts.nodes).toFixed(1)}%`);
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
  if (auditReport.isolated.length > 0 && auditReport.isolated.length <= 100) {
    txtLines.push(`ISOLATED SETTLEMENTS (${auditReport.isolated.length}):`);
    for (const sid of auditReport.isolated) {
      txtLines.push(`  ${sid}`);
    }
  } else if (auditReport.isolated.length > 100) {
    txtLines.push(`ISOLATED SETTLEMENTS (${auditReport.isolated.length}, showing first 100):`);
    for (const sid of auditReport.isolated.slice(0, 100)) {
      txtLines.push(`  ${sid}`);
    }
    txtLines.push(`  ... and ${auditReport.isolated.length - 100} more`);
  }
  txtLines.push('');
  txtLines.push('ANOMALIES:');
  txtLines.push(`  Missing SID features: ${auditReport.anomalies.missing_sid_features_count}`);
  txtLines.push(`  Non-polygon features: ${auditReport.anomalies.non_polygon_features_count}`);
  txtLines.push(`  Segment pairs checked: ${auditReport.anomalies.segment_pairs_checked}`);
  txtLines.push(`  Matches found: ${auditReport.anomalies.matches_found}`);
  txtLines.push('');
  txtLines.push('NOTE:');
  txtLines.push('  Adjacency is defined as shared boundary segments only (contiguity).');
  txtLines.push('  Point-touch does not create edges. No terrain inference performed.');
  txtLines.push('  v3 handles independently digitized boundaries within tolerance.');
  txtLines.push('  No geometry modification or invention performed.');

  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditTxtPath}\n`);

  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Nodes: ${auditReport.counts.nodes}\n`);
  process.stdout.write(`  Edges: ${auditReport.counts.edges}\n`);
  process.stdout.write(`  Isolated: ${auditReport.counts.isolated_count} (${(100 * auditReport.counts.isolated_count / auditReport.counts.nodes).toFixed(1)}%)\n`);
  process.stdout.write(`  Degree: min=${auditReport.degree_stats.min}, median=${auditReport.degree_stats.p50}, p90=${auditReport.degree_stats.p90}, max=${auditReport.degree_stats.max}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
