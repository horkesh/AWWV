#!/usr/bin/env node
/**
 * Derive Municipality Borders from Settlement Polygons
 * 
 * Extracts municipality outer borders by cancelling shared edges between settlement polygons
 * within the same municipality. Uses shared-edge cancellation (no boolean unions).
 * 
 * CRITICAL RULES:
 * - Deterministic: stable sorting, fixed rounding (6 decimals), no timestamps, no randomness
 * - No boolean union, no buffering, no hulls, no simplification, no smoothing
 * - No "repair"; only derive borders by cancelling shared edges inside each municipality
 * - Must support non-contiguous municipalities (MultiLineString with multiple parts)
 * 
 * Inputs:
 * - data/source/geography_settlements.geojson (settlement polygons)
 * 
 * Outputs:
 * - data/derived/municipality_borders_from_settlements.geojson
 * - data/derived/municipality_borders_from_settlements_report.json
 * - data/derived/municipality_borders_from_settlements_report.txt
 * 
 * Usage:
 *   npm run map:derive-muni-borders
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Derive municipality outer borders from settlement polygon fabric without boolean unions, by shared-edge cancellation and stitching");

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// GeoJSON type declarations
declare namespace GeoJSON {
  interface FeatureCollection {
    type: 'FeatureCollection';
    features: Feature[];
  }
  interface Feature {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry: Geometry;
  }
  type Geometry = Polygon | MultiPolygon | LineString | MultiLineString | Point;
  interface Polygon {
    type: 'Polygon';
    coordinates: number[][][];
  }
  interface MultiPolygon {
    type: 'MultiPolygon';
    coordinates: number[][][][];
  }
  interface LineString {
    type: 'LineString';
    coordinates: number[][];
  }
  interface MultiLineString {
    type: 'MultiLineString';
    coordinates: number[][][];
  }
  interface Point {
    type: 'Point';
    coordinates: number[];
  }
}

// ============================================================================
// Constants
// ============================================================================

const SETTLEMENT_INPUT_PATH = resolve('data/source/geography_settlements.geojson');
const OUTPUT_GEOJSON_PATH = resolve('data/derived/municipality_borders_from_settlements.geojson');
const OUTPUT_REPORT_JSON_PATH = resolve('data/derived/municipality_borders_from_settlements_report.json');
const OUTPUT_REPORT_TXT_PATH = resolve('data/derived/municipality_borders_from_settlements_report.txt');

const COORD_PRECISION = 6;

// ============================================================================
// Types
// ============================================================================

interface Edge {
  key: string;
  pointA: [number, number];
  pointB: [number, number];
  municipality_id: string;
  count: number; // occurrence count within this municipality
}

interface BoundarySegment {
  pointA: [number, number];
  pointB: [number, number];
  municipality_id: string;
}

interface MunicipalityStats {
  municipality_id: string;
  settlement_count: number;
  polygon_count: number;
  segments_total: number;
  boundary_segment_count: number;
  chain_count: number;
  warnings: string[];
}

interface Report {
  total_settlements: number;
  total_municipalities: number;
  municipality_ids: string[];
  per_municipality: MunicipalityStats[];
  top_20_by_boundary_segment_count: Array<{ municipality_id: string; boundary_segment_count: number }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Round coordinate to fixed precision
 */
function roundCoord(coord: number): number {
  return Math.round(coord * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION);
}

/**
 * Create canonical edge key from two points (ordered lexicographically)
 */
function createEdgeKey(pointA: [number, number], pointB: [number, number]): string {
  const a: [number, number] = [roundCoord(pointA[0]), roundCoord(pointA[1])];
  const b: [number, number] = [roundCoord(pointB[0]), roundCoord(pointB[1])];
  
  // Order lexicographically: a <= b
  const [first, second] = a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
    ? [a, b]
    : [b, a];
  
  return `${first[0]},${first[1]}|${second[0]},${second[1]}`;
}

/**
 * Extract edges from polygon ring (outer ring only)
 */
function extractEdgesFromRing(ring: number[][]): Array<{ pointA: [number, number]; pointB: [number, number] }> {
  const edges: Array<{ pointA: [number, number]; pointB: [number, number] }> = [];
  
  for (let i = 0; i < ring.length; i++) {
    const nextI = (i + 1) % ring.length;
    const pointA: [number, number] = [roundCoord(ring[i][0]), roundCoord(ring[i][1])];
    const pointB: [number, number] = [roundCoord(ring[nextI][0]), roundCoord(ring[nextI][1])];
    
    // Skip zero-length edges
    if (pointA[0] === pointB[0] && pointA[1] === pointB[1]) {
      continue;
    }
    
    edges.push({ pointA, pointB });
  }
  
  return edges;
}

/**
 * Stitch segments into polylines deterministically
 * - Start with endpoints where degree==1 (open chains) in lexicographic order
 * - Then handle remaining cycles (all degree==2) by picking smallest unused pointKey
 */
function stitchSegmentsIntoPaths(segments: BoundarySegment[]): number[][][] {
  if (segments.length === 0) {
    return [];
  }
  
  const paths: number[][][] = [];
  const used = new Set<number>();
  
  // Build endpoint adjacency map: pointKey -> list of neighboring pointKeys
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
  
  // Compute degree for each endpoint
  const endpointDegree = new Map<string, number>();
  for (const [key, connections] of endpointMap.entries()) {
    endpointDegree.set(key, connections.length);
  }
  
  // Process all segments
  while (used.size < segments.length) {
    // Find first unused segment, prioritizing degree-1 endpoints (open chains)
    let startIdx = -1;
    let startPoint: [number, number] | null = null;
    let isStartPoint = true;
    
    // First pass: look for degree-1 endpoints (open chains)
    for (let i = 0; i < segments.length; i++) {
      if (used.has(i)) continue;
      
      const seg = segments[i];
      const keyA = `${seg.pointA[0]},${seg.pointA[1]}`;
      const keyB = `${seg.pointB[0]},${seg.pointB[1]}`;
      const degA = endpointDegree.get(keyA) || 0;
      const degB = endpointDegree.get(keyB) || 0;
      
      if (degA === 1) {
        if (startIdx === -1 || keyA < `${startPoint![0]},${startPoint![1]}`) {
          startIdx = i;
          startPoint = seg.pointA;
          isStartPoint = true;
        }
      } else if (degB === 1) {
        if (startIdx === -1 || keyB < `${startPoint![0]},${startPoint![1]}`) {
          startIdx = i;
          startPoint = seg.pointB;
          isStartPoint = false;
        }
      }
    }
    
    // Second pass: if no degree-1 endpoints, pick smallest unused pointKey (cycle)
    if (startIdx === -1) {
      const unusedPointKeys: string[] = [];
      for (let i = 0; i < segments.length; i++) {
        if (used.has(i)) continue;
        const seg = segments[i];
        unusedPointKeys.push(`${seg.pointA[0]},${seg.pointA[1]}`);
        unusedPointKeys.push(`${seg.pointB[0]},${seg.pointB[1]}`);
      }
      unusedPointKeys.sort();
      
      if (unusedPointKeys.length > 0) {
        const smallestKey = unusedPointKeys[0];
        for (let i = 0; i < segments.length; i++) {
          if (used.has(i)) continue;
          const seg = segments[i];
          const keyA = `${seg.pointA[0]},${seg.pointA[1]}`;
          const keyB = `${seg.pointB[0]},${seg.pointB[1]}`;
          if (keyA === smallestKey || keyB === smallestKey) {
            startIdx = i;
            startPoint = keyA === smallestKey ? seg.pointA : seg.pointB;
            isStartPoint = keyA === smallestKey;
            break;
          }
        }
      }
    }
    
    if (startIdx === -1) break;
    
    const path: number[][] = [];
    let currentPoint: [number, number];
    
    // Start path
    const startSeg = segments[startIdx];
    if (isStartPoint) {
      path.push([startSeg.pointA[0], startSeg.pointA[1]]);
      path.push([startSeg.pointB[0], startSeg.pointB[1]]);
      currentPoint = startSeg.pointB;
    } else {
      path.push([startSeg.pointB[0], startSeg.pointB[1]]);
      path.push([startSeg.pointA[0], startSeg.pointA[1]]);
      currentPoint = startSeg.pointA;
    }
    used.add(startIdx);
    
    // Extend forward
    let extended = true;
    while (extended) {
      extended = false;
      const currentKey = `${currentPoint[0]},${currentPoint[1]}`;
      const candidates = endpointMap.get(currentKey) || [];
      
      // Pick next deterministically (lexicographically smallest neighbor using unused segment)
      let bestCandidate: { segmentIdx: number; nextPoint: [number, number] } | null = null;
      
      for (const candidate of candidates) {
        if (used.has(candidate.segmentIdx)) continue;
        
        const seg = segments[candidate.segmentIdx];
        const nextPoint = candidate.isStart ? seg.pointB : seg.pointA;
        const nextKey = `${nextPoint[0]},${nextPoint[1]}`;
        
        if (!bestCandidate || nextKey < `${bestCandidate.nextPoint[0]},${bestCandidate.nextPoint[1]}`) {
          bestCandidate = {
            segmentIdx: candidate.segmentIdx,
            nextPoint
          };
        }
      }
      
      if (bestCandidate) {
        path.push([bestCandidate.nextPoint[0], bestCandidate.nextPoint[1]]);
        currentPoint = bestCandidate.nextPoint;
        used.add(bestCandidate.segmentIdx);
        extended = true;
      }
    }
    
    // Extend backward (only if we started from a degree-1 endpoint)
    if (startPoint && endpointDegree.get(`${startPoint[0]},${startPoint[1]}`) === 1) {
      currentPoint = startPoint;
      extended = true;
      while (extended) {
        extended = false;
        const currentKey = `${currentPoint[0]},${currentPoint[1]}`;
        const candidates = endpointMap.get(currentKey) || [];
        
        let bestCandidate: { segmentIdx: number; prevPoint: [number, number] } | null = null;
        
        for (const candidate of candidates) {
          if (used.has(candidate.segmentIdx)) continue;
          
          const seg = segments[candidate.segmentIdx];
          const prevPoint = candidate.isStart ? seg.pointA : seg.pointB;
          const prevKey = `${prevPoint[0]},${prevPoint[1]}`;
          
          if (!bestCandidate || prevKey < `${bestCandidate.prevPoint[0]},${bestCandidate.prevPoint[1]}`) {
            bestCandidate = {
              segmentIdx: candidate.segmentIdx,
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
    }
    
    if (path.length >= 2) {
      paths.push(path);
    }
  }
  
  return paths;
}

// ============================================================================
// Main Processing
// ============================================================================

async function main(): Promise<void> {
  console.log('Loading settlement polygons from geography_settlements.geojson...');
  
  if (!existsSync(SETTLEMENT_INPUT_PATH)) {
    console.error(`Error: Settlement file not found at ${SETTLEMENT_INPUT_PATH}`);
    process.exitCode = 0;
    return;
  }
  
  const inputContent = await readFile(SETTLEMENT_INPUT_PATH, 'utf8');
  const inputGeoJSON = JSON.parse(inputContent) as GeoJSON.FeatureCollection;
  
  if (inputGeoJSON.type !== 'FeatureCollection') {
    console.error('Error: Input is not a FeatureCollection');
    process.exitCode = 0;
    return;
  }
  
  const inputFeatures = inputGeoJSON.features || [];
  console.log(`Found ${inputFeatures.length} features`);
  
  // Filter to Polygon and MultiPolygon geometries only
  const polygonFeatures = inputFeatures.filter(feature => {
    const geometry = feature.geometry;
    return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
  });
  
  console.log(`Found ${polygonFeatures.length} polygon features`);
  
  if (polygonFeatures.length === 0) {
    console.warn('WARNING: No polygon features found');
    await writeReport({ total_settlements: 0, total_municipalities: 0, municipality_ids: [], per_municipality: [], top_20_by_boundary_segment_count: [] }, ['No polygon features found']);
    process.exitCode = 0;
    return;
  }
  
  // Determine municipality ID field
  let muniIdField: string | null = null;
  for (const feature of polygonFeatures) {
    const props = feature.properties || {};
    if (props.municipality_id !== undefined) {
      muniIdField = 'municipality_id';
      break;
    } else if (props.mun_id !== undefined) {
      muniIdField = 'mun_id';
      break;
    }
  }
  
  if (!muniIdField) {
    console.warn('WARNING: No municipality ID field found (tried municipality_id, mun_id)');
    await writeReport({ total_settlements: polygonFeatures.length, total_municipalities: 0, municipality_ids: [], per_municipality: [], top_20_by_boundary_segment_count: [] }, ['No municipality ID field found']);
    process.exitCode = 0;
    return;
  }
  
  console.log(`Using municipality ID field: ${muniIdField}`);
  
  // Group settlements by municipality_id
  const polygonsByMuni = new Map<string, GeoJSON.Feature[]>();
  const settlementCounts = new Map<string, number>();
  
  for (const feature of polygonFeatures) {
    const props = feature.properties || {};
    const muniId = String(props[muniIdField!] || '').trim();
    
    if (!muniId) continue;
    
    if (!polygonsByMuni.has(muniId)) {
      polygonsByMuni.set(muniId, []);
      settlementCounts.set(muniId, 0);
    }
    
    polygonsByMuni.get(muniId)!.push(feature);
    settlementCounts.set(muniId, settlementCounts.get(muniId)! + 1);
  }
  
  const uniqueMuniIds = Array.from(polygonsByMuni.keys()).sort(); // Deterministic sort
  console.log(`Municipalities with polygons: ${uniqueMuniIds.length}`);
  
  // For each municipality: extract edges and count occurrences
  console.log('Extracting edges and counting occurrences per municipality...');
  const boundarySegmentsByMuni = new Map<string, BoundarySegment[]>();
  const polygonCounts = new Map<string, number>();
  
  for (const muniId of uniqueMuniIds) {
    const polygons = polygonsByMuni.get(muniId) || [];
    const edgeMap = new Map<string, { pointA: [number, number]; pointB: [number, number]; count: number }>();
    
    let polygonCount = 0;
    
    for (const polygon of polygons) {
      const geometry = polygon.geometry;
      const rings: number[][][] = [];
      
      if (geometry.type === 'Polygon') {
        rings.push(...geometry.coordinates);
      } else if (geometry.type === 'MultiPolygon') {
        for (const poly of geometry.coordinates) {
          rings.push(...poly);
        }
      }
      
      // Process outer rings only (first ring of each polygon)
      for (let ringIdx = 0; ringIdx < rings.length; ringIdx++) {
        const ring = rings[ringIdx];
        if (ring.length < 3) continue;
        
        // Only process outer ring (index 0 for each polygon)
        if (geometry.type === 'Polygon') {
          if (ringIdx > 0) continue; // Skip holes
        } else if (geometry.type === 'MultiPolygon') {
          // For MultiPolygon, first ring of each part is outer ring
          let partStartIdx = 0;
          for (const part of geometry.coordinates) {
            if (ringIdx === partStartIdx) {
              // This is an outer ring
              partStartIdx += part.length;
              break;
            }
            partStartIdx += part.length;
            if (ringIdx < partStartIdx) {
              // This is a hole, skip
              continue;
            }
          }
          if (ringIdx >= partStartIdx) continue; // Skip holes
        }
        
        polygonCount++;
        const edges = extractEdgesFromRing(ring);
        
        for (const edge of edges) {
          const key = createEdgeKey(edge.pointA, edge.pointB);
          
          if (!edgeMap.has(key)) {
            edgeMap.set(key, {
              pointA: edge.pointA,
              pointB: edge.pointB,
              count: 0
            });
          }
          
          edgeMap.get(key)!.count++;
        }
      }
    }
    
    polygonCounts.set(muniId, polygonCount);
    
    // Boundary segments are those with count === 1
    const boundarySegments: BoundarySegment[] = [];
    for (const [key, edge] of edgeMap.entries()) {
      if (edge.count === 1) {
        boundarySegments.push({
          pointA: edge.pointA,
          pointB: edge.pointB,
          municipality_id: muniId
        });
      }
    }
    
    boundarySegmentsByMuni.set(muniId, boundarySegments);
  }
  
  console.log('Stitching boundary segments into chains...');
  
  // Stitch segments into chains for each municipality
  const features: GeoJSON.Feature[] = [];
  const report: Report = {
    total_settlements: polygonFeatures.length,
    total_municipalities: uniqueMuniIds.length,
    municipality_ids: uniqueMuniIds,
    per_municipality: [],
    top_20_by_boundary_segment_count: []
  };
  
  for (const muniId of uniqueMuniIds) {
    const segments = boundarySegmentsByMuni.get(muniId) || [];
    const paths = stitchSegmentsIntoPaths(segments);
    
    const settlementCount = settlementCounts.get(muniId) || 0;
    const polygonCount = polygonCounts.get(muniId) || 0;
    
    const warnings: string[] = [];
    if (segments.length === 0) {
      warnings.push('no_boundary_segments');
    }
    
    // Check for junction degree > 2 (branching)
    const endpointCounts = new Map<string, number>();
    for (const seg of segments) {
      const keyA = `${seg.pointA[0]},${seg.pointA[1]}`;
      const keyB = `${seg.pointB[0]},${seg.pointB[1]}`;
      endpointCounts.set(keyA, (endpointCounts.get(keyA) || 0) + 1);
      endpointCounts.set(keyB, (endpointCounts.get(keyB) || 0) + 1);
    }
    
    let maxDegree = 0;
    for (const count of endpointCounts.values()) {
      maxDegree = Math.max(maxDegree, count);
    }
    
    if (maxDegree > 2) {
      warnings.push(`junction_degree_${maxDegree}`);
    }
    
    if (paths.length === 0) {
      warnings.push('no_chains_stitched');
    }
    
    // Create feature
    const geometry: GeoJSON.MultiLineString = {
      type: 'MultiLineString',
      coordinates: paths.length > 0 ? paths : [[[0, 0], [0, 0]]] // Fallback empty geometry
    };
    
    features.push({
      type: 'Feature',
      properties: {
        municipality_id: muniId,
        settlement_count: settlementCount,
        polygon_count: polygonCount,
        boundary_segment_count: segments.length,
        chain_count: paths.length,
        warnings: warnings.length > 0 ? warnings : undefined
      },
      geometry
    });
    
    report.per_municipality.push({
      municipality_id: muniId,
      settlement_count: settlementCount,
      polygon_count: polygonCount,
      segments_total: segments.length,
      boundary_segment_count: segments.length,
      chain_count: paths.length,
      warnings
    });
  }
  
  // Sort top 20 by boundary_segment_count
  report.top_20_by_boundary_segment_count = report.per_municipality
    .sort((a, b) => {
      if (b.boundary_segment_count !== a.boundary_segment_count) {
        return b.boundary_segment_count - a.boundary_segment_count;
      }
      return a.municipality_id.localeCompare(b.municipality_id);
    })
    .slice(0, 20)
    .map(m => ({ municipality_id: m.municipality_id, boundary_segment_count: m.boundary_segment_count }));
  
  // Write outputs
  console.log('Writing outputs...');
  await mkdir(resolve('data/derived'), { recursive: true });
  
  const geojson: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features
  };
  
  await writeFile(OUTPUT_GEOJSON_PATH, JSON.stringify(geojson, null, 2), 'utf8');
  await writeFile(OUTPUT_REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
  await writeReport(report, []);
  
  console.log('Done!');
  console.log(`  GeoJSON: ${OUTPUT_GEOJSON_PATH}`);
  console.log(`  Report JSON: ${OUTPUT_REPORT_JSON_PATH}`);
  console.log(`  Report TXT: ${OUTPUT_REPORT_TXT_PATH}`);
  console.log(`  Emitted ${features.length} municipality features`);
}

async function writeReport(report: Report, additionalWarnings: string[]): Promise<void> {
  const lines: string[] = [
    'Municipality Borders from Settlements Report',
    '===========================================',
    '',
    `Total settlements: ${report.total_settlements}`,
    `Total municipalities: ${report.total_municipalities}`,
    '',
  ];
  
  if (report.municipality_ids && report.municipality_ids.length > 0) {
    lines.push(`Municipality IDs (${report.municipality_ids.length}):`);
    report.municipality_ids.forEach(id => {
      lines.push(`  ${id}`);
    });
    lines.push('');
  }
  
  // Municipalities with warnings
  const municipalitiesWithWarnings = report.per_municipality.filter(m => m.warnings.length > 0);
  if (municipalitiesWithWarnings.length > 0) {
    lines.push(`Municipalities with warnings: ${municipalitiesWithWarnings.length}`);
    municipalitiesWithWarnings.forEach(m => {
      lines.push(`  ${m.municipality_id}: ${m.warnings.join(', ')}`);
    });
    lines.push('');
  }
  
  // Top 20 by boundary segment count
  if (report.top_20_by_boundary_segment_count && report.top_20_by_boundary_segment_count.length > 0) {
    lines.push('Top 20 by boundary segment count:');
    report.top_20_by_boundary_segment_count.forEach(item => {
      lines.push(`  ${item.municipality_id}: ${item.boundary_segment_count} segments`);
    });
    lines.push('');
  }
  
  // Per-municipality summary (first few)
  if (report.per_municipality.length > 0) {
    lines.push('Per-municipality summary (first 10):');
    report.per_municipality.slice(0, 10).forEach(m => {
      lines.push(`  ${m.municipality_id}: ${m.settlement_count} settlements, ${m.polygon_count} polygons, ${m.boundary_segment_count} boundary segments, ${m.chain_count} chains`);
      if (m.warnings.length > 0) {
        lines.push(`    Warnings: ${m.warnings.join(', ')}`);
      }
    });
    if (report.per_municipality.length > 10) {
      lines.push(`  ... and ${report.per_municipality.length - 10} more`);
    }
    lines.push('');
  }
  
  if (additionalWarnings.length > 0) {
    lines.push('Additional warnings:');
    additionalWarnings.forEach(w => {
      lines.push(`  ${w}`);
    });
    lines.push('');
  }
  
  await writeFile(OUTPUT_REPORT_TXT_PATH, lines.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exitCode = 1;
});
