/**
 * Diagnose Settlement Contiguity Near-Miss
 * 
 * VALIDATION-ONLY DIAGNOSTIC FOR PHASE 1 ADJACENCY GRAPH
 * 
 * This script explains why the strict shared-segment adjacency graph is sparse
 * by measuring "near-miss" boundary proximity between settlements. This is a
 * validation-only diagnostic that does NOT modify any canonical Phase 0 or Phase 1
 * outputs.
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no buffers, unions, hulls, smoothing, repair. Only computes distances.
 * 
 * Usage:
 *   npm run map:diagnose:nearmiss
 *   or: tsx scripts/map/diagnose_settlement_contiguity_nearmiss.ts
 * 
 * Outputs:
 *   - data/derived/settlement_graph.nearmiss.audit.json
 *   - data/derived/settlement_graph.nearmiss.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 diagnostics: measure near-miss settlement contiguity and explain sparse adjacency without changing canon outputs");

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
}

interface NearMissPair {
  a: string;
  b: string;
  boundaryDist: number;
  bboxDist: number;
}

interface AuditReport {
  schema_version: number;
  source: string;
  strict_graph: string;
  nodes: number;
  strict_edges: number;
  strict_isolated: number;
  candidate_pairs_evaluated: number;
  eps: number;
  threshold_sweep_eps_scaled: Array<{ t: number; near_pairs: number; near_unique_nodes: number }>;
  threshold_sweep_fixed: Array<{ t: number; near_pairs: number; near_unique_nodes: number }>;
  distance_stats: { min: number; p50: number; p90: number; max: number };
  top_near_pairs: Array<{ a: string; b: string; boundaryDist: number; bboxDist: number }>;
  anomalies: {
    missing_sid_features_count: number;
    non_polygon_features_count: number;
    skipped_over_max_check_dist: number;
  };
}

// Parameters
const MAX_VERTS_PER_SETTLEMENT = 256;
const MAX_CHECK_DIST = 1e-3;
const GRID_DIVISOR = 64;

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
 * Extract boundary sample from polygon geometry (outer rings only, downsampled)
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
  
  // Deterministic downsampling if needed
  if (allPoints.length <= MAX_VERTS_PER_SETTLEMENT) {
    return allPoints;
  }
  
  // Take every k-th vertex, starting at index 0
  const k = Math.ceil(allPoints.length / MAX_VERTS_PER_SETTLEMENT);
  const sampled: Point[] = [];
  for (let i = 0; i < allPoints.length; i += k) {
    sampled.push(allPoints[i]);
  }
  
  return sampled;
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
    // Segment is a point
    const dpx = px - sx;
    const dpy = py - sy;
    return Math.sqrt(dpx * dpx + dpy * dpy);
  }
  
  // Project point onto segment
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
    // Also check last segment (closed ring)
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
    // Also check last segment (closed ring)
    if (sampleA.length > 1) {
      const dist = pointToSegmentDistance(pB, sampleA[sampleA.length - 1], sampleA[0]);
      minDist = Math.min(minDist, dist);
    }
  }
  
  return minDist === Infinity ? 0 : minDist;
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const graphPath = resolve('data/derived/settlement_graph.json');
  const outputJsonPath = resolve('data/derived/settlement_graph.nearmiss.audit.json');
  const outputTxtPath = resolve('data/derived/settlement_graph.nearmiss.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputJsonPath), { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrateGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrateGeoJSON.type}`);
  }
  
  // Load strict graph
  process.stdout.write(`Loading ${graphPath}...\n`);
  const graphContent = readFileSync(graphPath, 'utf8');
  const strictGraph = JSON.parse(graphContent) as SettlementGraph;
  
  // Build strict adjacency set for fast lookup
  const strictAdjacent = new Set<string>();
  for (const edge of strictGraph.edge_list) {
    const key = edge.a < edge.b ? `${edge.a}|${edge.b}` : `${edge.b}|${edge.a}`;
    strictAdjacent.add(key);
  }
  
  // Extract settlement data
  process.stdout.write(`Extracting settlement data...\n`);
  const settlements = new Map<string, SettlementData>();
  let missingSidCount = 0;
  let nonPolygonCount = 0;
  
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
    if (boundarySample.length === 0) {
      continue;
    }
    
    settlements.set(sid, {
      sid,
      bbox,
      boundarySample
    });
  }
  
  process.stdout.write(`Loaded ${settlements.size} settlements\n`);
  
  // Compute global bbox and EPS
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  for (const settlement of settlements.values()) {
    globalMinx = Math.min(globalMinx, settlement.bbox.minx);
    globalMiny = Math.min(globalMiny, settlement.bbox.miny);
    globalMaxx = Math.max(globalMaxx, settlement.bbox.maxx);
    globalMaxy = Math.max(globalMaxy, settlement.bbox.maxy);
  }
  
  const globalBbox = { minx: globalMinx, miny: globalMiny, maxx: globalMaxx, maxy: globalMaxy };
  const eps = computeEPS(globalBbox);
  const width = globalBbox.maxx - globalBbox.minx;
  const height = globalBbox.maxy - globalBbox.miny;
  const cellSize = Math.max(0.5, Math.min(50, Math.max(width, height) / GRID_DIVISOR));
  
  process.stdout.write(`Global bbox: [${globalBbox.minx}, ${globalBbox.miny}, ${globalBbox.maxx}, ${globalBbox.maxy}]\n`);
  process.stdout.write(`EPS: ${eps}\n`);
  process.stdout.write(`Cell size: ${cellSize}\n`);
  
  // Build spatial grid index
  process.stdout.write(`Building spatial grid index...\n`);
  const grid = new Map<string, string[]>(); // cellKey -> [sid...]
  
  for (const [sid, settlement] of settlements.entries()) {
    const bbox = settlement.bbox;
    const minCellX = Math.floor((bbox.minx - globalBbox.minx) / cellSize);
    const maxCellX = Math.floor((bbox.maxx - globalBbox.minx) / cellSize);
    const minCellY = Math.floor((bbox.miny - globalBbox.miny) / cellSize);
    const maxCellY = Math.floor((bbox.maxy - globalBbox.miny) / cellSize);
    
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        const cellKey = `${cx},${cy}`;
        if (!grid.has(cellKey)) {
          grid.set(cellKey, []);
        }
        grid.get(cellKey)!.push(sid);
      }
    }
  }
  
  // Generate candidate pairs
  process.stdout.write(`Generating candidate pairs...\n`);
  const candidatePairs = new Set<string>(); // "sid_low|sid_high"
  
  for (const [cellKey, sids] of grid.entries()) {
    // Sort for deterministic iteration
    const sortedSids = [...sids].sort();
    for (let i = 0; i < sortedSids.length; i++) {
      for (let j = i + 1; j < sortedSids.length; j++) {
        const sidA = sortedSids[i];
        const sidB = sortedSids[j];
        const pairKey = sidA < sidB ? `${sidA}|${sidB}` : `${sidB}|${sidA}`;
        candidatePairs.add(pairKey);
      }
    }
  }
  
  process.stdout.write(`Generated ${candidatePairs.size} candidate pairs\n`);
  
  // Compute near-miss distances
  process.stdout.write(`Computing near-miss distances...\n`);
  const nearMissPairs: NearMissPair[] = [];
  let skippedOverMaxDist = 0;
  let evaluatedCount = 0;
  
  for (const pairKey of Array.from(candidatePairs).sort()) {
    const [sidA, sidB] = pairKey.split('|');
    
    // Skip if already strict-adjacent
    if (strictAdjacent.has(pairKey)) {
      continue;
    }
    
    const settlementA = settlements.get(sidA);
    const settlementB = settlements.get(sidB);
    if (!settlementA || !settlementB) {
      continue;
    }
    
    // Compute bbox distance first
    const bboxDist = computeBboxDistance(settlementA.bbox, settlementB.bbox);
    
    if (bboxDist > MAX_CHECK_DIST) {
      skippedOverMaxDist++;
      continue;
    }
    
    evaluatedCount++;
    
    // Compute boundary distance
    const boundaryDist = computeBoundaryDistance(settlementA.boundarySample, settlementB.boundarySample);
    
    nearMissPairs.push({
      a: sidA,
      b: sidB,
      boundaryDist,
      bboxDist
    });
  }
  
  process.stdout.write(`Evaluated ${evaluatedCount} pairs (skipped ${skippedOverMaxDist} over max check dist)\n`);
  
  // Sort near-miss pairs deterministically
  nearMissPairs.sort((p1, p2) => {
    if (p1.boundaryDist !== p2.boundaryDist) {
      return p1.boundaryDist - p2.boundaryDist;
    }
    if (p1.a !== p2.a) {
      return p1.a.localeCompare(p2.a);
    }
    return p1.b.localeCompare(p2.b);
  });
  
  // Compute distance statistics
  const distances = nearMissPairs.map(p => p.boundaryDist).sort((a, b) => a - b);
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
  
  const distanceStats = {
    min: distances.length > 0 ? distances[0] : 0,
    p50: median(distances),
    p90: p90(distances),
    max: distances.length > 0 ? distances[distances.length - 1] : 0
  };
  
  // Threshold sweeps
  const thresholdsEpsScaled = [0, eps, 2 * eps, 5 * eps, 10 * eps, 25 * eps, 50 * eps];
  const thresholdsFixed = [1e-6, 5e-6, 1e-5, 5e-5, 1e-4];
  
  const sweepEpsScaled: Array<{ t: number; near_pairs: number; near_unique_nodes: number }> = [];
  const sweepFixed: Array<{ t: number; near_pairs: number; near_unique_nodes: number }> = [];
  
  for (const threshold of thresholdsEpsScaled) {
    const nearSet = new Set<string>();
    for (const pair of nearMissPairs) {
      if (pair.boundaryDist <= threshold) {
        nearSet.add(pair.a);
        nearSet.add(pair.b);
      }
    }
    sweepEpsScaled.push({
      t: threshold,
      near_pairs: nearMissPairs.filter(p => p.boundaryDist <= threshold).length,
      near_unique_nodes: nearSet.size
    });
  }
  
  for (const threshold of thresholdsFixed) {
    const nearSet = new Set<string>();
    for (const pair of nearMissPairs) {
      if (pair.boundaryDist <= threshold) {
        nearSet.add(pair.a);
        nearSet.add(pair.b);
      }
    }
    sweepFixed.push({
      t: threshold,
      near_pairs: nearMissPairs.filter(p => p.boundaryDist <= threshold).length,
      near_unique_nodes: nearSet.size
    });
  }
  
  // Count strict isolated
  const strictIsolated = Array.from(settlements.keys()).filter(sid => {
    const neighbors = strictGraph.graph[sid] || [];
    return neighbors.length === 0;
  }).length;
  
  // Build audit report
  const auditReport: AuditReport = {
    schema_version: 1,
    source: 'data/derived/settlements_substrate.geojson',
    strict_graph: 'data/derived/settlement_graph.json',
    nodes: settlements.size,
    strict_edges: strictGraph.edges,
    strict_isolated: strictIsolated,
    candidate_pairs_evaluated: evaluatedCount,
    eps,
    threshold_sweep_eps_scaled: sweepEpsScaled,
    threshold_sweep_fixed: sweepFixed,
    distance_stats: distanceStats,
    top_near_pairs: nearMissPairs.slice(0, 50),
    anomalies: {
      missing_sid_features_count: missingSidCount,
      non_polygon_features_count: nonPolygonCount,
      skipped_over_max_check_dist: skippedOverMaxDist
    }
  };
  
  // Write JSON audit
  writeFileSync(outputJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit JSON to ${outputJsonPath}\n`);
  
  // Write TXT audit
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENT CONTIGUITY NEAR-MISS DIAGNOSTIC');
  txtLines.push('===========================================');
  txtLines.push('');
  txtLines.push('STRICT GRAPH RECAP:');
  txtLines.push(`  Nodes: ${auditReport.nodes}`);
  txtLines.push(`  Strict edges: ${auditReport.strict_edges}`);
  txtLines.push(`  Strict isolated: ${auditReport.strict_isolated}`);
  txtLines.push('');
  txtLines.push('CANDIDATE GENERATION:');
  txtLines.push(`  Grid cell size: ${cellSize.toFixed(6)}`);
  txtLines.push(`  Candidate pairs generated: ${candidatePairs.size}`);
  txtLines.push(`  Pairs evaluated: ${auditReport.candidate_pairs_evaluated}`);
  txtLines.push(`  Pairs skipped (bboxDist > ${MAX_CHECK_DIST}): ${auditReport.anomalies.skipped_over_max_check_dist}`);
  txtLines.push('');
  txtLines.push('EPS AND THRESHOLDS:');
  txtLines.push(`  EPS (from dataset bounds): ${eps}`);
  txtLines.push('');
  txtLines.push('THRESHOLD SWEEP (EPS-scaled):');
  for (const entry of auditReport.threshold_sweep_eps_scaled) {
    txtLines.push(`  T=${entry.t.toExponential(3)}: ${entry.near_pairs} near pairs, ${entry.near_unique_nodes} unique nodes`);
  }
  txtLines.push('');
  txtLines.push('THRESHOLD SWEEP (Fixed units):');
  for (const entry of auditReport.threshold_sweep_fixed) {
    txtLines.push(`  T=${entry.t.toExponential(3)}: ${entry.near_pairs} near pairs, ${entry.near_unique_nodes} unique nodes`);
  }
  txtLines.push('');
  txtLines.push('DISTANCE STATISTICS:');
  txtLines.push(`  Min: ${auditReport.distance_stats.min.toExponential(6)}`);
  txtLines.push(`  Median (p50): ${auditReport.distance_stats.p50.toExponential(6)}`);
  txtLines.push(`  p90: ${auditReport.distance_stats.p90.toExponential(6)}`);
  txtLines.push(`  Max: ${auditReport.distance_stats.max.toExponential(6)}`);
  txtLines.push('');
  txtLines.push('TOP NEAREST PAIRS (top 20):');
  for (let i = 0; i < Math.min(20, auditReport.top_near_pairs.length); i++) {
    const pair = auditReport.top_near_pairs[i];
    txtLines.push(`  ${pair.a} <-> ${pair.b}: boundaryDist=${pair.boundaryDist.toExponential(6)}, bboxDist=${pair.bboxDist.toExponential(6)}`);
  }
  txtLines.push('');
  txtLines.push('ANOMALIES:');
  txtLines.push(`  Missing SID features: ${auditReport.anomalies.missing_sid_features_count}`);
  txtLines.push(`  Non-polygon features: ${auditReport.anomalies.non_polygon_features_count}`);
  txtLines.push(`  Skipped over max check dist: ${auditReport.anomalies.skipped_over_max_check_dist}`);
  txtLines.push('');
  txtLines.push('NOTE:');
  txtLines.push('  This diagnostic measures boundary-to-boundary distances to explain why');
  txtLines.push('  strict shared-segment adjacency is sparse. It does NOT modify any');
  txtLines.push('  canonical Phase 0 or Phase 1 outputs. If near_pairs grows rapidly as');
  txtLines.push('  threshold increases, sparse adjacency may be due to near-miss numeric');
  txtLines.push('  mismatch. If near_pairs remains low even at 1e-4, settlements are');
  txtLines.push('  truly disjoint (not a tiling).');
  
  writeFileSync(outputTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit TXT to ${outputTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Strict edges: ${auditReport.strict_edges}\n`);
  process.stdout.write(`  Strict isolated: ${auditReport.strict_isolated}\n`);
  process.stdout.write(`  Candidate pairs evaluated: ${auditReport.candidate_pairs_evaluated}\n`);
  process.stdout.write(`  Min boundary distance: ${auditReport.distance_stats.min.toExponential(6)}\n`);
  process.stdout.write(`  Median boundary distance: ${auditReport.distance_stats.p50.toExponential(6)}\n`);
  process.stdout.write(`  Near pairs at 1e-4: ${auditReport.threshold_sweep_fixed[auditReport.threshold_sweep_fixed.length - 1].near_pairs}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
