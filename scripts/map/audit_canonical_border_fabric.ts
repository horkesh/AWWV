/**
 * Border Fabric Forensic Audit: Canonical SVG-Derived Settlements Substrate
 * 
 * This script quantifies the border fabric of the canonical SVG-derived settlements
 * substrate by measuring:
 * - Total boundary length
 * - Shared border length (segments owned by exactly 2 settlements)
 * - Free boundary length (segments owned by exactly 1 settlement)
 * - Anomaly segments (owned by >2 settlements)
 * 
 * This audit is independent of the adjacency graph code path and provides a
 * forensic analysis of whether shared borders exist at scale in the substrate.
 * 
 * Deterministic: stable ordering, no randomness, no timestamps.
 * No geometry invention: quantization used ONLY for segment keying, not geometry modification.
 * 
 * Usage:
 *   npm run map:audit:borderfabric
 *   or: tsx scripts/map/audit_canonical_border_fabric.ts
 * 
 * Outputs:
 *   - data/derived/settlement_border_fabric.audit.json
 *   - data/derived/settlement_border_fabric.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, warnIfUnrecorded } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("SVG canonical substrate forensic: measure shared vs free boundary length via segment ownership index to determine whether shared borders exist at scale");

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

interface SegmentInfo {
  length: number;
  owners: Set<string>;
}

interface SettlementStats {
  sid: string;
  boundary_len: number;
  shared_len: number;
  free_len: number;
  shared_ratio: number;
  neighbor_count: number;
}

interface BorderFabricAudit {
  aggregate: {
    total_segments: number;
    total_boundary_len: number;
    shared_segment_count: number;
    shared_border_len: number;
    free_segment_count: number;
    free_border_len: number;
    anomaly_segment_count: number;
    anomaly_len: number;
    shared_ratio: number;
    free_ratio: number;
  };
  top_highest_shared_ratio: Array<{ sid: string; shared_ratio: number; boundary_len: number }>;
  top_lowest_shared_ratio: Array<{ sid: string; shared_ratio: number; boundary_len: number }>;
  top_highest_free_len: Array<{ sid: string; free_len: number; boundary_len: number }>;
  top_highest_neighbor_count: Array<{ sid: string; neighbor_count: number; boundary_len: number }>;
  per_settlement: Record<string, SettlementStats>;
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
  const precision = Math.max(9, Math.ceil(-Math.log10(eps)) + 2);
  return `${qx1.toFixed(precision)},${qy1.toFixed(precision)}|${qx2.toFixed(precision)},${qy2.toFixed(precision)}`;
}

/**
 * Compute Euclidean length of segment from quantized endpoints
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
function extractSegmentsFromRing(ring: Ring, sid: string, eps: number): Array<{ key: string; len: number }> {
  const segments: Array<{ key: string; len: number }> = [];
  
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
    segments.push({ key, len });
  }
  
  return segments;
}

/**
 * Extract all boundary segments from a polygon geometry
 */
function extractSegmentsFromGeometry(
  geom: GeoJSONFeature['geometry'],
  sid: string,
  eps: number
): Array<{ key: string; len: number }> {
  const segments: Array<{ key: string; len: number }> = [];
  
  if (geom.type === 'Polygon') {
    const polygon = geom.coordinates as Polygon;
    // Only process outer ring (first ring), ignore holes
    if (polygon.length > 0) {
      const outerRing = polygon[0];
      segments.push(...extractSegmentsFromRing(outerRing, sid, eps));
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = geom.coordinates as MultiPolygon;
    // Process outer ring of each polygon
    for (const polygon of multiPolygon) {
      if (polygon.length > 0) {
        const outerRing = polygon[0];
        segments.push(...extractSegmentsFromRing(outerRing, sid, eps));
      }
    }
  }
  
  return segments;
}

/**
 * Build segment ownership index
 */
function buildSegmentOwnershipIndex(
  features: GeoJSONFeature[],
  eps: number
): Map<string, SegmentInfo> {
  const index = new Map<string, SegmentInfo>();
  
  for (const feature of features) {
    const sid = extractSid(feature.properties);
    if (!sid) {
      continue;
    }
    
    if (!isPolygonGeometry(feature.geometry)) {
      continue;
    }
    
    const segments = extractSegmentsFromGeometry(feature.geometry, sid, eps);
    
    for (const seg of segments) {
      if (!index.has(seg.key)) {
        index.set(seg.key, {
          length: seg.len,
          owners: new Set()
        });
      }
      const info = index.get(seg.key)!;
      info.owners.add(sid);
      // Update length if this is the first time we see this segment
      // (all occurrences should have same length due to quantization)
      if (info.length === 0) {
        info.length = seg.len;
      }
    }
  }
  
  return index;
}

/**
 * Compute aggregate metrics
 */
function computeAggregateMetrics(index: Map<string, SegmentInfo>): BorderFabricAudit['aggregate'] {
  let totalSegments = 0;
  let totalBoundaryLen = 0;
  let sharedSegmentCount = 0;
  let sharedBorderLen = 0;
  let freeSegmentCount = 0;
  let freeBorderLen = 0;
  let anomalySegmentCount = 0;
  let anomalyLen = 0;
  
  for (const [key, info] of index.entries()) {
    totalSegments++;
    const ownerCount = info.owners.size;
    
    // Count length per owner (each settlement counts its boundary)
    totalBoundaryLen += info.length * ownerCount;
    
    if (ownerCount === 1) {
      freeSegmentCount++;
      freeBorderLen += info.length;
    } else if (ownerCount === 2) {
      sharedSegmentCount++;
      sharedBorderLen += info.length; // Count once for shared border
    } else {
      anomalySegmentCount++;
      anomalyLen += info.length;
    }
  }
  
  const totalBorderLen = sharedBorderLen + freeBorderLen;
  const sharedRatio = totalBorderLen > 0 ? sharedBorderLen / totalBorderLen : 0;
  const freeRatio = totalBorderLen > 0 ? freeBorderLen / totalBorderLen : 0;
  
  return {
    total_segments: totalSegments,
    total_boundary_len: totalBoundaryLen,
    shared_segment_count: sharedSegmentCount,
    shared_border_len: sharedBorderLen,
    free_segment_count: freeSegmentCount,
    free_border_len: freeBorderLen,
    anomaly_segment_count: anomalySegmentCount,
    anomaly_len: anomalyLen,
    shared_ratio: sharedRatio,
    free_ratio: freeRatio
  };
}

/**
 * Compute per-settlement statistics
 */
function computePerSettlementStats(
  features: GeoJSONFeature[],
  index: Map<string, SegmentInfo>,
  eps: number
): Record<string, SettlementStats> {
  const stats: Record<string, SettlementStats> = {};
  
  // Initialize all settlements
  for (const feature of features) {
    const sid = extractSid(feature.properties);
    if (!sid) {
      continue;
    }
    stats[sid] = {
      sid,
      boundary_len: 0,
      shared_len: 0,
      free_len: 0,
      shared_ratio: 0,
      neighbor_count: 0
    };
  }
  
  // Process each settlement's segments
  for (const feature of features) {
    const sid = extractSid(feature.properties);
    if (!sid || !isPolygonGeometry(feature.geometry)) {
      continue;
    }
    
    if (!stats[sid]) {
      stats[sid] = {
        sid,
        boundary_len: 0,
        shared_len: 0,
        free_len: 0,
        shared_ratio: 0,
        neighbor_count: 0
      };
    }
    
    const segments = extractSegmentsFromGeometry(feature.geometry, sid, eps);
    const neighbors = new Set<string>();
    
    for (const seg of segments) {
      const info = index.get(seg.key);
      if (!info) {
        continue;
      }
      
      const ownerCount = info.owners.size;
      stats[sid].boundary_len += seg.len;
      
      if (ownerCount === 1) {
        stats[sid].free_len += seg.len;
      } else if (ownerCount === 2) {
        stats[sid].shared_len += seg.len;
        // Track neighbors
        for (const owner of info.owners) {
          if (owner !== sid) {
            neighbors.add(owner);
          }
        }
      }
    }
    
    stats[sid].neighbor_count = neighbors.size;
    stats[sid].shared_ratio = stats[sid].boundary_len > 0
      ? stats[sid].shared_len / stats[sid].boundary_len
      : 0;
  }
  
  return stats;
}

/**
 * Generate top lists
 */
function generateTopLists(stats: Record<string, SettlementStats>): {
  top_highest_shared_ratio: Array<{ sid: string; shared_ratio: number; boundary_len: number }>;
  top_lowest_shared_ratio: Array<{ sid: string; shared_ratio: number; boundary_len: number }>;
  top_highest_free_len: Array<{ sid: string; free_len: number; boundary_len: number }>;
  top_highest_neighbor_count: Array<{ sid: string; neighbor_count: number; boundary_len: number }>;
} {
  const allStats = Object.values(stats);
  
  // Highest shared ratio
  const highestSharedRatio = [...allStats]
    .sort((a, b) => b.shared_ratio - a.shared_ratio)
    .slice(0, 50)
    .map(s => ({
      sid: s.sid,
      shared_ratio: s.shared_ratio,
      boundary_len: s.boundary_len
    }));
  
  // Lowest shared ratio (excluding tiny boundary_len < 1.0)
  const lowestSharedRatio = [...allStats]
    .filter(s => s.boundary_len >= 1.0)
    .sort((a, b) => a.shared_ratio - b.shared_ratio)
    .slice(0, 50)
    .map(s => ({
      sid: s.sid,
      shared_ratio: s.shared_ratio,
      boundary_len: s.boundary_len
    }));
  
  // Highest free length
  const highestFreeLen = [...allStats]
    .sort((a, b) => b.free_len - a.free_len)
    .slice(0, 50)
    .map(s => ({
      sid: s.sid,
      free_len: s.free_len,
      boundary_len: s.boundary_len
    }));
  
  // Highest neighbor count
  const highestNeighborCount = [...allStats]
    .sort((a, b) => b.neighbor_count - a.neighbor_count)
    .slice(0, 50)
    .map(s => ({
      sid: s.sid,
      neighbor_count: s.neighbor_count,
      boundary_len: s.boundary_len
    }));
  
  return {
    top_highest_shared_ratio: highestSharedRatio,
    top_lowest_shared_ratio: lowestSharedRatio,
    top_highest_free_len: highestFreeLen,
    top_highest_neighbor_count: highestNeighborCount
  };
}

/**
 * Generate human-readable audit text
 */
function generateAuditText(audit: BorderFabricAudit): string {
  const lines: string[] = [];
  
  lines.push('BORDER FABRIC FORENSIC AUDIT');
  lines.push('='.repeat(60));
  lines.push('Canonical SVG-Derived Settlements Substrate');
  lines.push('');
  
  lines.push('AGGREGATE METRICS');
  lines.push('-'.repeat(60));
  lines.push(`Total Segments: ${audit.aggregate.total_segments.toLocaleString()}`);
  lines.push(`Total Boundary Length: ${audit.aggregate.total_boundary_len.toFixed(2)}`);
  lines.push('');
  lines.push(`Shared Segments: ${audit.aggregate.shared_segment_count.toLocaleString()}`);
  lines.push(`Shared Border Length: ${audit.aggregate.shared_border_len.toFixed(2)}`);
  lines.push(`Shared Ratio: ${(audit.aggregate.shared_ratio * 100).toFixed(2)}%`);
  lines.push('');
  lines.push(`Free Segments: ${audit.aggregate.free_segment_count.toLocaleString()}`);
  lines.push(`Free Border Length: ${audit.aggregate.free_border_len.toFixed(2)}`);
  lines.push(`Free Ratio: ${(audit.aggregate.free_ratio * 100).toFixed(2)}%`);
  lines.push('');
  lines.push(`Anomaly Segments (>2 owners): ${audit.aggregate.anomaly_segment_count.toLocaleString()}`);
  lines.push(`Anomaly Length: ${audit.aggregate.anomaly_len.toFixed(2)}`);
  lines.push('');
  
  lines.push('TOP SETTLEMENTS - HIGHEST SHARED RATIO');
  lines.push('-'.repeat(60));
  for (const item of audit.top_highest_shared_ratio.slice(0, 20)) {
    lines.push(`${item.sid}: ${(item.shared_ratio * 100).toFixed(2)}% shared (boundary: ${item.boundary_len.toFixed(2)})`);
  }
  lines.push('');
  
  lines.push('TOP SETTLEMENTS - LOWEST SHARED RATIO');
  lines.push('-'.repeat(60));
  for (const item of audit.top_lowest_shared_ratio.slice(0, 20)) {
    lines.push(`${item.sid}: ${(item.shared_ratio * 100).toFixed(2)}% shared (boundary: ${item.boundary_len.toFixed(2)})`);
  }
  lines.push('');
  
  lines.push('TOP SETTLEMENTS - HIGHEST FREE BOUNDARY LENGTH');
  lines.push('-'.repeat(60));
  for (const item of audit.top_highest_free_len.slice(0, 20)) {
    lines.push(`${item.sid}: ${item.free_len.toFixed(2)} free (boundary: ${item.boundary_len.toFixed(2)})`);
  }
  lines.push('');
  
  lines.push('TOP SETTLEMENTS - HIGHEST NEIGHBOR COUNT');
  lines.push('-'.repeat(60));
  for (const item of audit.top_highest_neighbor_count.slice(0, 20)) {
    lines.push(`${item.sid}: ${item.neighbor_count} neighbors (boundary: ${item.boundary_len.toFixed(2)})`);
  }
  lines.push('');
  
  lines.push('INTERPRETATION');
  lines.push('-'.repeat(60));
  if (audit.aggregate.shared_ratio < 0.05) {
    lines.push('CONFIRMED: Shared border ratio < 5% indicates the SVG substrate');
    lines.push('does NOT form a shared-border partition at scale.');
    lines.push('Most boundaries are free (not shared between settlements).');
  } else {
    lines.push('Shared borders exist at scale in the substrate.');
  }
  
  return lines.join('\n');
}

/**
 * Main execution
 */
function main(): void {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const auditJsonPath = resolve('data/derived/settlement_border_fabric.audit.json');
  const auditTxtPath = resolve('data/derived/settlement_border_fabric.audit.txt');
  
  console.log(`Loading substrate from: ${substratePath}`);
  const geojsonContent = readFileSync(substratePath, 'utf8');
  const geojson: GeoJSONFC = JSON.parse(geojsonContent);
  
  console.log(`Loaded ${geojson.features.length} features`);
  
  // Compute global bounding box and EPS
  const bbox = computeGlobalBbox(geojson.features);
  if (!bbox) {
    throw new Error('Could not compute bounding box');
  }
  
  const eps = computeEPS(bbox);
  console.log(`Computed EPS: ${eps}`);
  
  // Build segment ownership index
  console.log('Building segment ownership index...');
  const index = buildSegmentOwnershipIndex(geojson.features, eps);
  console.log(`Indexed ${index.size} unique segments`);
  
  // Compute aggregate metrics
  console.log('Computing aggregate metrics...');
  const aggregate = computeAggregateMetrics(index);
  
  // Compute per-settlement statistics
  console.log('Computing per-settlement statistics...');
  const perSettlement = computePerSettlementStats(geojson.features, index, eps);
  
  // Generate top lists
  console.log('Generating top lists...');
  const topLists = generateTopLists(perSettlement);
  
  // Build audit report
  const audit: BorderFabricAudit = {
    aggregate,
    ...topLists,
    per_settlement: perSettlement
  };
  
  // Check interpretation and record if needed
  const lowSharedRatio = aggregate.shared_ratio < 0.05;
  const nearZeroShared = aggregate.shared_segment_count < 10;
  
  if (lowSharedRatio || nearZeroShared) {
    warnIfUnrecorded(
      true,
      {
        date: '2026-01-27',
        title: 'MAP: SVG canonical substrate lacks shared-border fabric at scale',
        description: `Border fabric audit confirms shared border ratio is ${(aggregate.shared_ratio * 100).toFixed(2)}% (${aggregate.shared_segment_count} shared segments). This indicates the SVG-derived substrate does NOT form a shared-border partition - most boundaries are free (not shared between settlements).`,
        correct_behavior: 'Treat this as a data truth. The substrate geometry itself is fragmented. Do not compensate with tolerance unless explicitly elevated to canon via FORAWWV.md.'
      },
      'Border fabric forensic audit'
    );
  }
  
  // Generate audit text
  const auditText = generateAuditText(audit);
  
  // Ensure output directory exists
  mkdirSync(dirname(auditJsonPath), { recursive: true });
  
  // Write outputs
  console.log(`Writing audit JSON to: ${auditJsonPath}`);
  writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2) + '\n', 'utf8');
  
  console.log(`Writing audit text to: ${auditTxtPath}`);
  writeFileSync(auditTxtPath, auditText, 'utf8');
  
  console.log('');
  console.log('AUDIT COMPLETE');
  console.log(`Total Segments: ${aggregate.total_segments.toLocaleString()}`);
  console.log(`Shared Border Ratio: ${(aggregate.shared_ratio * 100).toFixed(2)}%`);
  console.log(`Free Border Ratio: ${(aggregate.free_ratio * 100).toFixed(2)}%`);
  console.log(`Shared Segments: ${aggregate.shared_segment_count.toLocaleString()}`);
}

main();
