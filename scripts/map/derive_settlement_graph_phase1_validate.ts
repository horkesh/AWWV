/**
 * Phase 1 Validation: Derive Strict Shared-Border Settlement Adjacency Graph
 * 
 * CANONICAL VALIDATION SCRIPT FOR PHASE 1 SETTLEMENT ADJACENCY
 * 
 * This script validates whether the SVG-derived canonical settlement substrate
 * forms a true shared-border fabric by deriving a strict settlement adjacency
 * graph using shared-border-only logic.
 * 
 * VALIDATION ONLY: Do NOT compensate for bad geometry. Do NOT invent adjacency.
 * Do NOT apply tolerance-based distance inference.
 * 
 * Adjacency definition (canonical, Phase 1):
 * - Two settlements are adjacent IFF they share a boundary segment of positive length.
 * - Point-touch adjacency is explicitly excluded.
 * 
 * Deterministic: stable ordering, no randomness, no timestamps.
 * No geometry invention: no buffering, snapping, tolerance-based distance checks,
 * Hausdorff/proximity/epsilon fixes.
 * 
 * Usage:
 *   npm run map:derive:graph
 *   or: tsx scripts/map/derive_settlement_graph_phase1_validate.ts
 * 
 * Outputs:
 *   - data/derived/settlement_graph.json (canonical Phase 1 adjacency graph)
 *   - data/derived/settlement_graph.audit.json
 *   - data/derived/settlement_graph.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, warnIfUnrecorded } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 1 validation: derive strict shared-border settlement adjacency from SVG-derived canonical substrate");

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
  shared_len: number;
}

interface SettlementGraph {
  schema_version: number;
  source: string;
  nodes: number;
  edges: number;
  edge_list: GraphEdge[];
  graph: Record<string, Array<{ sid: string; shared_len: number }>>;
}

interface Segment {
  p1: Point;
  p2: Point;
  sid: string;
  len: number;
}

interface AuditReport {
  nodes: number;
  edges: number;
  isolated_count: number;
  isolated_percentage: number;
  isolated: string[];
  degree_stats: {
    min: number;
    p50: number;
    p90: number;
    max: number;
  };
  component_count: number;
  largest_component_size: number;
  shared_len_stats: {
    min: number;
    p50: number;
    p90: number;
    max: number;
  };
  top_50_edges_by_shared_len: Array<{ a: string; b: string; shared_len: number }>;
  anomalies: {
    segments_shared_by_more_than_two: {
      count: number;
      list: Array<{ segment: string; sids: string[] }>;
    };
    degree_gt_30_count: number;
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
 * Compute Euclidean distance between two points
 */
function distance(p1: Point, p2: Point): number {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute cross product of vectors (p2-p1) and (p3-p1)
 * Returns 0 if colinear (within floating precision)
 */
function crossProduct(p1: Point, p2: Point, p3: Point): number {
  const v1x = p2[0] - p1[0];
  const v1y = p2[1] - p1[1];
  const v2x = p3[0] - p1[0];
  const v2y = p3[1] - p1[1];
  return v1x * v2y - v1y * v2x;
}

/**
 * Check if three points are colinear (within floating precision)
 */
function areColinear(p1: Point, p2: Point, p3: Point): boolean {
  const cross = crossProduct(p1, p2, p3);
  // Use relative tolerance based on segment lengths to handle floating point precision
  const len1 = distance(p1, p2);
  const len2 = distance(p1, p3);
  const maxLen = Math.max(len1, len2);
  // Tolerance: cross product magnitude relative to segment length
  // This is still exact arithmetic, just accounting for floating point representation
  const tolerance = maxLen * Number.EPSILON * 100; // 100x machine epsilon scaled by length
  return Math.abs(cross) <= tolerance;
}

/**
 * Check if point p lies on segment (s1, s2)
 */
function pointOnSegment(p: Point, s1: Point, s2: Point): boolean {
  if (!areColinear(s1, s2, p)) {
    return false;
  }
  // Check if p is between s1 and s2
  const d1 = distance(s1, p);
  const d2 = distance(p, s2);
  const d12 = distance(s1, s2);
  // Allow small floating point error
  return Math.abs(d1 + d2 - d12) < d12 * Number.EPSILON * 100;
}

/**
 * Compute overlap length between two colinear segments
 * Returns 0 if no overlap, positive length if overlap exists
 */
function computeOverlapLength(s1: Point, s2: Point, t1: Point, t2: Point): number {
  // First check if segments are colinear
  if (!areColinear(s1, s2, t1) || !areColinear(s1, s2, t2)) {
    return 0;
  }
  
  // Project onto dominant axis (x or y)
  const dx1 = s2[0] - s1[0];
  const dy1 = s2[1] - s1[1];
  const useX = Math.abs(dx1) >= Math.abs(dy1);
  
  let sMin: number, sMax: number, tMin: number, tMax: number;
  
  if (useX) {
    // Project onto x-axis
    sMin = Math.min(s1[0], s2[0]);
    sMax = Math.max(s1[0], s2[0]);
    tMin = Math.min(t1[0], t2[0]);
    tMax = Math.max(t1[0], t2[0]);
  } else {
    // Project onto y-axis
    sMin = Math.min(s1[1], s2[1]);
    sMax = Math.max(s1[1], s2[1]);
    tMin = Math.min(t1[1], t2[1]);
    tMax = Math.max(t1[1], t2[1]);
  }
  
  // Compute overlap interval
  const overlapMin = Math.max(sMin, tMin);
  const overlapMax = Math.min(sMax, tMax);
  
  if (overlapMin >= overlapMax) {
    return 0; // No overlap
  }
  
  // Convert overlap interval length back to segment length
  const overlapInterval = overlapMax - overlapMin;
  const segmentLength = useX ? distance(s1, s2) : distance(s1, s2);
  const axisLength = useX ? Math.abs(dx1) : Math.abs(dy1);
  
  // Scale overlap interval to actual segment length
  if (axisLength === 0) {
    return 0; // Degenerate segment
  }
  
  return (overlapInterval / axisLength) * segmentLength;
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
    const len = distance(p1, p2);
    if (len === 0) {
      continue;
    }
    
    segments.push({ p1, p2, sid, len });
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
    // Only process outer ring (first ring), ignore holes
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
 * Find shared borders between all settlement pairs
 */
function findSharedBorders(segments: Segment[]): Map<string, Map<string, number>> {
  // Map: sid1 -> sid2 -> shared_length
  const sharedBorders = new Map<string, Map<string, number>>();
  
  // For each segment, check against all other segments
  for (let i = 0; i < segments.length; i++) {
    const seg1 = segments[i];
    
    for (let j = i + 1; j < segments.length; j++) {
      const seg2 = segments[j];
      
      // Skip if same settlement
      if (seg1.sid === seg2.sid) {
        continue;
      }
      
      // Check for overlap between seg1 and seg2
      const overlap1 = computeOverlapLength(seg1.p1, seg1.p2, seg2.p1, seg2.p2);
      const overlap2 = computeOverlapLength(seg2.p1, seg2.p2, seg1.p1, seg1.p2);
      const overlap = Math.max(overlap1, overlap2);
      
      if (overlap > 0) {
        // Ensure sid1 < sid2 for stable ordering
        const sid1 = seg1.sid < seg2.sid ? seg1.sid : seg2.sid;
        const sid2 = seg1.sid < seg2.sid ? seg2.sid : seg1.sid;
        
        if (!sharedBorders.has(sid1)) {
          sharedBorders.set(sid1, new Map());
        }
        const innerMap = sharedBorders.get(sid1)!;
        const currentLen = innerMap.get(sid2) || 0;
        innerMap.set(sid2, currentLen + overlap);
      }
    }
  }
  
  return sharedBorders;
}

/**
 * Build graph from shared borders
 */
function buildGraph(
  allSids: Set<string>,
  sharedBorders: Map<string, Map<string, number>>
): SettlementGraph {
  const edgeList: GraphEdge[] = [];
  const graph: Record<string, Array<{ sid: string; shared_len: number }>> = {};
  
  // Initialize all nodes
  for (const sid of allSids) {
    graph[sid] = [];
  }
  
  // Add edges from shared borders
  for (const [sid1, innerMap] of sharedBorders.entries()) {
    for (const [sid2, sharedLen] of innerMap.entries()) {
      // Ensure sid1 < sid2
      const a = sid1 < sid2 ? sid1 : sid2;
      const b = sid1 < sid2 ? sid2 : sid1;
      
      edgeList.push({ a, b, shared_len: sharedLen });
      
      graph[a].push({ sid: b, shared_len: sharedLen });
      graph[b].push({ sid: a, shared_len: sharedLen });
    }
  }
  
  // Sort edge list deterministically
  edgeList.sort((e1, e2) => {
    if (e1.a !== e2.a) {
      return e1.a < e2.a ? -1 : 1;
    }
    return e1.b < e2.b ? -1 : 1;
  });
  
  // Sort neighbor lists deterministically
  for (const sid of Object.keys(graph)) {
    graph[sid].sort((n1, n2) => {
      if (n1.sid !== n2.sid) {
        return n1.sid < n2.sid ? -1 : 1;
      }
      return 0;
    });
  }
  
  return {
    schema_version: 1,
    source: 'SVG canonical settlements_substrate.geojson',
    nodes: allSids.size,
    edges: edgeList.length,
    edge_list: edgeList,
    graph: graph
  };
}

/**
 * Compute connected components using DFS
 */
function computeComponents(graph: Record<string, Array<{ sid: string; shared_len: number }>>): string[][] {
  const visited = new Set<string>();
  const components: string[][] = [];
  
  function dfs(sid: string, component: string[]): void {
    if (visited.has(sid)) {
      return;
    }
    visited.add(sid);
    component.push(sid);
    
    const neighbors = graph[sid] || [];
    for (const neighbor of neighbors) {
      dfs(neighbor.sid, component);
    }
  }
  
  for (const sid of Object.keys(graph)) {
    if (!visited.has(sid)) {
      const component: string[] = [];
      dfs(sid, component);
      component.sort(); // Deterministic ordering
      components.push(component);
    }
  }
  
  // Sort components by size (largest first), then by first sid
  components.sort((c1, c2) => {
    if (c1.length !== c2.length) {
      return c2.length - c1.length;
    }
    return c1[0] < c2[0] ? -1 : 1;
  });
  
  return components;
}

/**
 * Compute percentile from sorted array
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[index];
}

/**
 * Generate audit report
 */
function generateAuditReport(
  graph: SettlementGraph,
  allSids: Set<string>,
  segments: Segment[]
): AuditReport {
  // Compute degrees
  const degrees: number[] = [];
  const isolated: string[] = [];
  let degreeGt30Count = 0;
  
  for (const sid of allSids) {
    const degree = graph.graph[sid]?.length || 0;
    degrees.push(degree);
    if (degree === 0) {
      isolated.push(sid);
    }
    if (degree > 30) {
      degreeGt30Count++;
    }
  }
  
  degrees.sort((a, b) => a - b);
  
  // Compute shared length stats
  const sharedLengths = graph.edge_list.map(e => e.shared_len);
  sharedLengths.sort((a, b) => a - b);
  
  // Compute components
  const components = computeComponents(graph.graph);
  
  // Find segments shared by more than two settlements
  const segmentOwners = new Map<string, Set<string>>();
  for (const seg of segments) {
    const key = `${seg.p1[0]},${seg.p1[1]}|${seg.p2[0]},${seg.p2[1]}`;
    if (!segmentOwners.has(key)) {
      segmentOwners.set(key, new Set());
    }
    segmentOwners.get(key)!.add(seg.sid);
  }
  
  const multiShareSegments: Array<{ segment: string; sids: string[] }> = [];
  for (const [key, sids] of segmentOwners.entries()) {
    if (sids.size > 2) {
      const sidArray = Array.from(sids).sort();
      multiShareSegments.push({ segment: key, sids: sidArray });
    }
  }
  multiShareSegments.sort((a, b) => {
    if (a.sids.length !== b.sids.length) {
      return b.sids.length - a.sids.length;
    }
    return a.segment < b.segment ? -1 : 1;
  });
  
  // Top 50 edges by shared length
  const topEdges = [...graph.edge_list]
    .sort((e1, e2) => e2.shared_len - e1.shared_len)
    .slice(0, 50);
  
  isolated.sort(); // Deterministic ordering
  
  return {
    nodes: graph.nodes,
    edges: graph.edges,
    isolated_count: isolated.length,
    isolated_percentage: graph.nodes > 0 ? (isolated.length / graph.nodes) * 100 : 0,
    isolated: isolated,
    degree_stats: {
      min: degrees.length > 0 ? degrees[0] : 0,
      p50: percentile(degrees, 50),
      p90: percentile(degrees, 90),
      max: degrees.length > 0 ? degrees[degrees.length - 1] : 0
    },
    component_count: components.length,
    largest_component_size: components.length > 0 ? components[0].length : 0,
    shared_len_stats: {
      min: sharedLengths.length > 0 ? sharedLengths[0] : 0,
      p50: percentile(sharedLengths, 50),
      p90: percentile(sharedLengths, 90),
      max: sharedLengths.length > 0 ? sharedLengths[sharedLengths.length - 1] : 0
    },
    top_50_edges_by_shared_len: topEdges,
    anomalies: {
      segments_shared_by_more_than_two: {
        count: multiShareSegments.length,
        list: multiShareSegments.slice(0, 50) // Limit to top 50
      },
      degree_gt_30_count: degreeGt30Count
    }
  };
}

/**
 * Generate human-readable audit text
 */
function generateAuditText(report: AuditReport, graph: SettlementGraph): string {
  const lines: string[] = [];
  
  lines.push('SETTLEMENT ADJACENCY GRAPH - PHASE 1 VALIDATION');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push(`Source: ${graph.source}`);
  lines.push(`Schema Version: ${graph.schema_version}`);
  lines.push('');
  lines.push('SUMMARY');
  lines.push('-'.repeat(60));
  lines.push(`Total Nodes (Settlements): ${report.nodes}`);
  lines.push(`Total Edges (Adjacencies): ${report.edges}`);
  lines.push(`Isolated Settlements: ${report.isolated_count} (${report.isolated_percentage.toFixed(2)}%)`);
  lines.push(`Connected Components: ${report.component_count}`);
  lines.push(`Largest Component Size: ${report.largest_component_size}`);
  lines.push('');
  
  lines.push('DEGREE STATISTICS');
  lines.push('-'.repeat(60));
  lines.push(`Min: ${report.degree_stats.min}`);
  lines.push(`Median (p50): ${report.degree_stats.p50}`);
  lines.push(`90th Percentile (p90): ${report.degree_stats.p90}`);
  lines.push(`Max: ${report.degree_stats.max}`);
  lines.push('');
  
  lines.push('SHARED BORDER LENGTH STATISTICS');
  lines.push('-'.repeat(60));
  lines.push(`Min: ${report.shared_len_stats.min.toFixed(6)}`);
  lines.push(`Median (p50): ${report.shared_len_stats.p50.toFixed(6)}`);
  lines.push(`90th Percentile (p90): ${report.shared_len_stats.p90.toFixed(6)}`);
  lines.push(`Max: ${report.shared_len_stats.max.toFixed(6)}`);
  lines.push('');
  
  if (report.anomalies.degree_gt_30_count > 0) {
    lines.push(`ANOMALY: ${report.anomalies.degree_gt_30_count} settlements with degree > 30`);
    lines.push('');
  }
  
  if (report.anomalies.segments_shared_by_more_than_two.count > 0) {
    lines.push(`ANOMALY: ${report.anomalies.segments_shared_by_more_than_two.count} segments shared by more than 2 settlements`);
    if (report.anomalies.segments_shared_by_more_than_two.list.length > 0) {
      lines.push('Top examples:');
      for (const item of report.anomalies.segments_shared_by_more_than_two.list.slice(0, 10)) {
        lines.push(`  Segment: ${item.segment}`);
        lines.push(`  Shared by: ${item.sids.join(', ')}`);
      }
    }
    lines.push('');
  }
  
  if (report.top_50_edges_by_shared_len.length > 0) {
    lines.push('TOP 10 EDGES BY SHARED BORDER LENGTH');
    lines.push('-'.repeat(60));
    for (const edge of report.top_50_edges_by_shared_len.slice(0, 10)) {
      lines.push(`${edge.a} <-> ${edge.b}: ${edge.shared_len.toFixed(6)}`);
    }
    lines.push('');
  }
  
  if (report.isolated.length > 0 && report.isolated.length <= 100) {
    lines.push('ISOLATED SETTLEMENTS');
    lines.push('-'.repeat(60));
    for (const sid of report.isolated) {
      lines.push(`  ${sid}`);
    }
    lines.push('');
  } else if (report.isolated.length > 100) {
    lines.push(`ISOLATED SETTLEMENTS (showing first 100 of ${report.isolated.length})`);
    lines.push('-'.repeat(60));
    for (const sid of report.isolated.slice(0, 100)) {
      lines.push(`  ${sid}`);
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Main execution
 */
function main(): void {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const graphPath = resolve('data/derived/settlement_graph.json');
  const auditJsonPath = resolve('data/derived/settlement_graph.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_graph.audit.txt');
  
  console.log(`Loading substrate from: ${substratePath}`);
  const geojsonContent = readFileSync(substratePath, 'utf8');
  const geojson: GeoJSONFC = JSON.parse(geojsonContent);
  
  console.log(`Loaded ${geojson.features.length} features`);
  
  // Extract all segments
  const allSids = new Set<string>();
  const segments: Segment[] = [];
  
  for (const feature of geojson.features) {
    const sid = extractSid(feature.properties);
    if (!sid) {
      console.warn(`Warning: Feature missing sid, skipping`);
      continue;
    }
    
    if (!isPolygonGeometry(feature.geometry)) {
      console.warn(`Warning: Feature ${sid} is not Polygon/MultiPolygon, skipping`);
      continue;
    }
    
    allSids.add(sid);
    const featureSegments = extractSegmentsFromGeometry(feature.geometry, sid);
    segments.push(...featureSegments);
  }
  
  console.log(`Extracted ${segments.length} boundary segments from ${allSids.size} settlements`);
  
  // Find shared borders
  console.log('Finding shared borders...');
  const sharedBorders = findSharedBorders(segments);
  
  // Build graph
  console.log('Building graph...');
  const graph = buildGraph(allSids, sharedBorders);
  
  // Generate audit report
  console.log('Generating audit report...');
  const auditReport = generateAuditReport(graph, allSids, segments);
  
  // Check for high isolation or fragmentation
  const highIsolation = auditReport.isolated_percentage > 20;
  const highFragmentation = auditReport.component_count > 1 && (auditReport.largest_component_size / auditReport.nodes) < 0.8;
  
  if (highIsolation || highFragmentation) {
    warnIfUnrecorded(
      true,
      {
        date: '2026-01-27',
        title: 'MAP: SVG-derived canonical settlements do not form a dense shared-border fabric',
        description: `Strict shared-border adjacency on the SVG-derived canonical substrate yields high isolation (${auditReport.isolated_percentage.toFixed(2)}%) or fragmentation (${auditReport.component_count} components, largest ${auditReport.largest_component_size}/${auditReport.nodes}), indicating the source geometry itself is not a true partition.`,
        correct_behavior: 'Treat this as a data truth. Do not compensate with tolerance unless explicitly elevated to canon via FORAWWV.md.'
      },
      'Phase 1 adjacency validation'
    );
  }
  
  // Generate audit text
  const auditText = generateAuditText(auditReport, graph);
  
  // Ensure output directory exists
  mkdirSync(dirname(graphPath), { recursive: true });
  
  // Write outputs
  console.log(`Writing graph to: ${graphPath}`);
  writeFileSync(graphPath, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  
  console.log(`Writing audit JSON to: ${auditJsonPath}`);
  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2) + '\n', 'utf8');
  
  console.log(`Writing audit text to: ${auditTxtPath}`);
  writeFileSync(auditTxtPath, auditText, 'utf8');
  
  console.log('');
  console.log('VALIDATION COMPLETE');
  console.log(`Nodes: ${graph.nodes}, Edges: ${graph.edges}`);
  console.log(`Isolated: ${auditReport.isolated_count} (${auditReport.isolated_percentage.toFixed(2)}%)`);
  console.log(`Components: ${auditReport.component_count}, Largest: ${auditReport.largest_component_size}`);
}

// Run main if this is the main module
main();
