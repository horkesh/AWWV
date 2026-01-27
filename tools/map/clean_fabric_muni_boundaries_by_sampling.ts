#!/usr/bin/env node
/**
 * Clean Fabric-Derived Municipality Boundaries by Sampling
 * 
 * Second cleaning pass: removes interior segments from fabric-derived boundaries
 * by sampling against settlement polygons (municipality id oracle).
 * Works even when shared-edge cancellation fails due to coordinate mismatches.
 * 
 * CRITICAL RULES:
 * - Deterministic: stable sorting, fixed precision, no timestamps
 * - No union, hulls, simplification, smoothing, snapping
 * - Do NOT repair geometries; only drop segments provably interior
 * - If classification coverage insufficient, keep geometry unchanged and report
 * 
 * Inputs:
 * - data/source/geography.geojson (settlement polygons with municipality id)
 * - data/derived/municipality_boundaries_from_fabric.geojson (fabric-derived boundaries)
 * 
 * Outputs:
 * - data/derived/municipality_boundaries_from_fabric_cleaned.geojson
 * - data/derived/municipality_boundaries_from_fabric_cleaned_report.json
 * - data/derived/municipality_boundaries_from_fabric_cleaned_report.txt
 * 
 * Usage:
 *   npm run map:clean-muni-fabric
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Clean fabric-derived municipality boundary lines by sampling against settlement polygons to drop provably interior segments, deterministically");

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ============================================================================
// Constants
// ============================================================================

const SETTLEMENT_FABRIC_PATH = resolve('data/source/geography.geojson');
const BOUNDARIES_PATH = resolve('data/derived/municipality_boundaries_from_fabric.geojson');
const OUTPUT_CLEANED_PATH = resolve('data/derived/municipality_boundaries_from_fabric_cleaned.geojson');
const OUTPUT_REPORT_JSON_PATH = resolve('data/derived/municipality_boundaries_from_fabric_cleaned_report.json');
const OUTPUT_REPORT_TXT_PATH = resolve('data/derived/municipality_boundaries_from_fabric_cleaned_report.txt');

const COORD_PRECISION = 6;
const GRID_SIZE = 128;
const EPS_FRACTION = 1e-4;
const MIN_EPS = 1e-6;
const MAX_EPS_FRACTION = 1e-2;
const MIN_COVERAGE_RATIO = 0.1; // 10%

// ============================================================================
// Types
// ============================================================================

interface SettlementPolygon {
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  muniId: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  originalIndex: number;
}

interface Segment {
  p1: [number, number];
  p2: [number, number];
  midpoint: [number, number];
  normal: [number, number];
  index: number;
}

interface ClassificationResult {
  keep: boolean;
  reason: string;
  leftMuniId?: string;
  rightMuniId?: string;
}

interface MunicipalityStats {
  municipality_id: string;
  segments_total: number;
  segments_dropped: number;
  segments_kept: number;
  fully_classified_segments: number;
  unclassified_segments: number;
  coverage_ratio: number;
  notes: string[];
}

interface Report {
  global: {
    municipalities_total: number;
    municipalities_with_any_drops: number;
    total_segments: number;
    total_dropped_segments: number;
    total_unclassified_segments: number;
    eps_used: number;
    grid_size: number;
  };
  per_municipality: MunicipalityStats[];
  top_20_by_dropped: Array<{ municipality_id: string; segments_dropped: number }>;
}

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
// Point-in-Polygon Test
// ============================================================================

/**
 * Point-in-polygon test using ray casting algorithm
 */
function pointInPolygon(point: [number, number], polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  if (polygon.type === 'Polygon') {
    return pointInPolygonRing(point, polygon.coordinates[0]) &&
           !polygon.coordinates.slice(1).some(hole => pointInPolygonRing(point, hole));
  } else if (polygon.type === 'MultiPolygon') {
    for (const poly of polygon.coordinates) {
      if (pointInPolygonRing(point, poly[0]) &&
          !poly.slice(1).some(hole => pointInPolygonRing(point, hole))) {
        return true;
      }
    }
  }
  return false;
}

function pointInPolygonRing(point: [number, number], ring: number[][]): boolean {
  const [x, y] = point;
  let inside = false;
  
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) {
      inside = !inside;
    }
  }
  
  return inside;
}

// ============================================================================
// Spatial Index (Bbox Bucket Grid)
// ============================================================================

class BboxBucketIndex {
  private grid: Map<string, SettlementPolygon[]>;
  private cellSizeX: number;
  private cellSizeY: number;
  private bbox: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(polygons: SettlementPolygon[], gridSize: number) {
    this.grid = new Map();
    
    // Compute global bbox
    let first = true;
    let minX = 0, minY = 0, maxX = 0, maxY = 0;
    for (const poly of polygons) {
      if (first) {
        minX = poly.bbox.minX;
        minY = poly.bbox.minY;
        maxX = poly.bbox.maxX;
        maxY = poly.bbox.maxY;
        first = false;
      } else {
        minX = Math.min(minX, poly.bbox.minX);
        minY = Math.min(minY, poly.bbox.minY);
        maxX = Math.max(maxX, poly.bbox.maxX);
        maxY = Math.max(maxY, poly.bbox.maxY);
      }
    }
    this.bbox = { minX, minY, maxX, maxY };
    
    // Compute cell sizes
    this.cellSizeX = (maxX - minX) / gridSize;
    this.cellSizeY = (maxY - minY) / gridSize;
    
    // Build grid
    for (const poly of polygons) {
      const cells = this.getCellsForBbox(poly.bbox);
      for (const cell of cells) {
        if (!this.grid.has(cell)) {
          this.grid.set(cell, []);
        }
        this.grid.get(cell)!.push(poly);
      }
    }
  }

  private getCellsForBbox(bbox: { minX: number; minY: number; maxX: number; maxY: number }): string[] {
    const cells: string[] = [];
    const minCellX = Math.floor((bbox.minX - this.bbox.minX) / this.cellSizeX);
    const minCellY = Math.floor((bbox.minY - this.bbox.minY) / this.cellSizeY);
    const maxCellX = Math.floor((bbox.maxX - this.bbox.minX) / this.cellSizeX);
    const maxCellY = Math.floor((bbox.maxY - this.bbox.minY) / this.cellSizeY);
    
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        cells.push(`${cx},${cy}`);
      }
    }
    return cells;
  }

  findPolygonContainingPoint(point: [number, number]): SettlementPolygon | null {
    const cellX = Math.floor((point[0] - this.bbox.minX) / this.cellSizeX);
    const cellY = Math.floor((point[1] - this.bbox.minY) / this.cellSizeY);
    const cellKey = `${cellX},${cellY}`;
    
    const candidates = this.grid.get(cellKey) || [];
    const containing: SettlementPolygon[] = [];
    
    for (const poly of candidates) {
      if (pointInPolygon(point, poly.geometry)) {
        containing.push(poly);
      }
    }
    
    if (containing.length === 0) {
      return null;
    }
    
    // If multiple, pick smallest bbox area (deterministic)
    if (containing.length === 1) {
      return containing[0];
    }
    
    containing.sort((a, b) => {
      const areaA = (a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY);
      const areaB = (b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY);
      return areaA - areaB;
    });
    
    return containing[0];
  }

  getBbox(): { minX: number; minY: number; maxX: number; maxY: number } {
    return this.bbox;
  }
}

// ============================================================================
// Geometry Utilities
// ============================================================================

function roundCoord(coord: number): number {
  return Math.round(coord * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION);
}

function computeBbox(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): { minX: number; minY: number; maxX: number; maxY: number } {
  let first = true;
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  
  const coords = geometry.type === 'Polygon' 
    ? geometry.coordinates[0]
    : geometry.coordinates.flatMap(p => p[0]);
  
  for (const coord of coords) {
    const [x, y] = coord;
    if (first) {
      minX = maxX = x;
      minY = maxY = y;
      first = false;
    } else {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  
  return { minX, minY, maxX, maxY };
}

function extractSegments(coordinates: number[][]): Segment[] {
  const segments: Segment[] = [];
  
  for (let i = 0; i < coordinates.length - 1; i++) {
    const p1: [number, number] = [roundCoord(coordinates[i][0]), roundCoord(coordinates[i][1])];
    const p2: [number, number] = [roundCoord(coordinates[i + 1][0]), roundCoord(coordinates[i + 1][1])];
    
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 1e-10) continue; // Skip degenerate segments
    
    const midpoint: [number, number] = [
      roundCoord((p1[0] + p2[0]) / 2),
      roundCoord((p1[1] + p2[1]) / 2)
    ];
    
    // Normal (perpendicular, normalized)
    const normal: [number, number] = [-dy / len, dx / len];
    
    segments.push({
      p1,
      p2,
      midpoint,
      normal,
      index: i
    });
  }
  
  return segments;
}

// ============================================================================
// Classification
// ============================================================================

function classifySegment(
  segment: Segment,
  currentMuniId: string,
  spatialIndex: BboxBucketIndex,
  eps: number
): ClassificationResult {
  const { midpoint, normal } = segment;
  
  // Sample points on both sides
  const left: [number, number] = [
    roundCoord(midpoint[0] + normal[0] * eps),
    roundCoord(midpoint[1] + normal[1] * eps)
  ];
  const right: [number, number] = [
    roundCoord(midpoint[0] - normal[0] * eps),
    roundCoord(midpoint[1] - normal[1] * eps)
  ];
  
  // Query polygons containing each point
  const leftPoly = spatialIndex.findPolygonContainingPoint(left);
  const rightPoly = spatialIndex.findPolygonContainingPoint(right);
  
  const leftMuniId = leftPoly?.muniId;
  const rightMuniId = rightPoly?.muniId;
  
  // Classification logic
  if (leftMuniId && rightMuniId) {
    if (leftMuniId === rightMuniId) {
      // Both sides in same municipality
      if (leftMuniId === currentMuniId) {
        // Interior seam -> DROP
        return { keep: false, reason: 'interior_seam', leftMuniId, rightMuniId };
      } else {
        // Same other municipality -> KEEP but record
        return { keep: true, reason: 'side_same_other_muni', leftMuniId, rightMuniId };
      }
    } else {
      // Different municipalities -> boundary -> KEEP
      return { keep: true, reason: 'true_boundary', leftMuniId, rightMuniId };
    }
  } else if (leftMuniId || rightMuniId) {
    // One side inside, other outside -> boundary -> KEEP
    return { keep: true, reason: 'outside_on_one_side', leftMuniId, rightMuniId };
  } else {
    // Neither side classified -> KEEP but unclassified
    return { keep: true, reason: 'unclassified' };
  }
}

// ============================================================================
// Geometry Rebuilding
// ============================================================================

function rebuildGeometry(
  originalCoords: number[][],
  segmentClassifications: ClassificationResult[]
): number[][][] {
  const lines: number[][] = [];
  let currentLine: number[] = [];
  
  // Always include first point
  if (originalCoords.length > 0) {
    currentLine.push([originalCoords[0][0], originalCoords[0][1]]);
  }
  
  for (let i = 0; i < segmentClassifications.length; i++) {
    const classification = segmentClassifications[i];
    const nextPoint = originalCoords[i + 1];
    
    if (!nextPoint) break;
    
    if (classification.keep) {
      // Add next point to current line
      currentLine.push([nextPoint[0], nextPoint[1]]);
    } else {
      // Segment dropped - finish current line and start new one
      if (currentLine.length >= 2) {
        lines.push(currentLine);
      }
      // Start new line with the endpoint of dropped segment
      currentLine = [[nextPoint[0], nextPoint[1]]];
    }
  }
  
  // Add final line if it has points
  if (currentLine.length >= 2) {
    lines.push(currentLine);
  }
  
  return lines.length > 0 ? lines : [];
}

// ============================================================================
// Main Processing
// ============================================================================

async function main(): Promise<void> {
  console.log('Loading settlement fabric...');
  
  if (!existsSync(SETTLEMENT_FABRIC_PATH)) {
    console.error(`Error: Settlement fabric not found at ${SETTLEMENT_FABRIC_PATH}`);
    process.exitCode = 0;
    return;
  }
  
  const fabricContent = await readFile(SETTLEMENT_FABRIC_PATH, 'utf8');
  const fabricGeoJSON = JSON.parse(fabricContent) as GeoJSON.FeatureCollection;
  
  // Filter to settlement features
  const settlementFeatures = fabricGeoJSON.features.filter(feature => {
    const props = feature.properties || {};
    return props.feature_type === 'settlement' ||
           props.layer === 'settlement' ||
           (props.kind && String(props.kind).toLowerCase() === 'settlement');
  });
  
  if (settlementFeatures.length === 0) {
    console.warn('WARNING: No settlement features found in fabric');
    await writeReport({} as Report, ['No settlement features found']);
    process.exitCode = 0;
    return;
  }
  
  // Determine municipality ID field
  let muniIdField: string | null = null;
  for (const feature of settlementFeatures) {
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
    await writeReport({} as Report, ['No municipality ID field found']);
    process.exitCode = 0;
    return;
  }
  
  // Build settlement polygons with spatial index
  console.log(`Building spatial index for ${settlementFeatures.length} settlement polygons...`);
  const settlementPolygons: SettlementPolygon[] = [];
  
  // Sort deterministically before building index
  const sortedFeatures = [...settlementFeatures].sort((a, b) => {
    const propsA = a.properties || {};
    const propsB = b.properties || {};
    const muniIdA = String(propsA[muniIdField!] || '');
    const muniIdB = String(propsB[muniIdField!] || '');
    const sidA = String(propsA.settlement_id || propsA.sid || '');
    const sidB = String(propsB.settlement_id || propsB.sid || '');
    const idxA = settlementFeatures.indexOf(a);
    const idxB = settlementFeatures.indexOf(b);
    
    if (muniIdA !== muniIdB) return muniIdA.localeCompare(muniIdB);
    if (sidA !== sidB) return sidA.localeCompare(sidB);
    return idxA - idxB;
  });
  
  for (let i = 0; i < sortedFeatures.length; i++) {
    const feature = sortedFeatures[i];
    const geometry = feature.geometry;
    
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      continue;
    }
    
    const props = feature.properties || {};
    const muniId = String(props[muniIdField!] || '').trim();
    
    if (!muniId) continue;
    
    const bbox = computeBbox(geometry);
    settlementPolygons.push({
      bbox,
      muniId,
      geometry,
      originalIndex: i
    });
  }
  
  // Build spatial index
  const spatialIndex = new BboxBucketIndex(settlementPolygons, GRID_SIZE);
  const fabricBbox = spatialIndex.getBbox();
  const diag = Math.hypot(
    fabricBbox.maxX - fabricBbox.minX,
    fabricBbox.maxY - fabricBbox.minY
  );
  const eps = Math.max(MIN_EPS, Math.min(diag * MAX_EPS_FRACTION, diag * EPS_FRACTION));
  
  console.log(`Spatial index built: ${settlementPolygons.length} polygons, grid ${GRID_SIZE}x${GRID_SIZE}`);
  console.log(`Epsilon: ${eps} (diagonal: ${diag.toFixed(3)})`);
  
  // Load boundaries
  console.log('Loading municipality boundaries...');
  if (!existsSync(BOUNDARIES_PATH)) {
    console.error(`Error: Municipality boundaries not found at ${BOUNDARIES_PATH}`);
    process.exitCode = 0;
    return;
  }
  
  const boundariesContent = await readFile(BOUNDARIES_PATH, 'utf8');
  const boundariesGeoJSON = JSON.parse(boundariesContent) as GeoJSON.FeatureCollection;
  
  // Process each municipality boundary
  console.log('Processing municipality boundaries...');
  const cleanedFeatures: GeoJSON.Feature[] = [];
  const report: Report = {
    global: {
      municipalities_total: 0,
      municipalities_with_any_drops: 0,
      total_segments: 0,
      total_dropped_segments: 0,
      total_unclassified_segments: 0,
      eps_used: eps,
      grid_size: GRID_SIZE
    },
    per_municipality: [],
    top_20_by_dropped: []
  };
  
  // Sort features deterministically
  const sortedBoundaryFeatures = [...boundariesGeoJSON.features].sort((a, b) => {
    const idA = (a.properties?.municipality_id || '').toLowerCase();
    const idB = (b.properties?.municipality_id || '').toLowerCase();
    return idA.localeCompare(idB);
  });
  
  for (const feature of sortedBoundaryFeatures) {
    const props = feature.properties || {};
    const muniId = String(props.municipality_id || '').trim();
    
    if (!muniId) {
      // Copy as-is if no municipality_id
      cleanedFeatures.push(feature);
      continue;
    }
    
    const geometry = feature.geometry;
    if (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString') {
      cleanedFeatures.push(feature);
      continue;
    }
    
    // Extract all coordinates
    const inputLines = geometry.type === 'LineString' 
      ? [geometry.coordinates]
      : geometry.coordinates;
    
    const cleanedLines: number[][][] = [];
    let muniDropped = 0;
    let muniKept = 0;
    let muniUnclassified = 0;
    let muniFullyClassified = 0;
    let muniSideSameOtherMuni = 0;
    const notes: string[] = [];
    
    // First pass: classify all segments
    const allSegments: Array<{ lineCoords: number[][]; segments: Segment[]; classifications: ClassificationResult[] }> = [];
    
    for (const lineCoords of inputLines) {
      if (lineCoords.length < 2) continue;
      
      const segments = extractSegments(lineCoords);
      const segmentClassifications: ClassificationResult[] = [];
      
      for (const segment of segments) {
        const classification = classifySegment(segment, muniId, spatialIndex, eps);
        segmentClassifications.push(classification);
        
        report.global.total_segments++;
        
        if (classification.reason === 'unclassified') {
          muniUnclassified++;
          report.global.total_unclassified_segments++;
        } else {
          if (classification.leftMuniId && classification.rightMuniId) {
            muniFullyClassified++;
          }
        }
        
        if (classification.keep) {
          muniKept++;
        } else {
          muniDropped++;
          report.global.total_dropped_segments++;
        }
        
        if (classification.reason === 'side_same_other_muni') {
          muniSideSameOtherMuni++;
        }
      }
      
      allSegments.push({ lineCoords, segments, classifications: segmentClassifications });
    }
    
    // Check coverage ratio for entire municipality
    const totalSegments = muniDropped + muniKept;
    const coverageRatio = totalSegments > 0 
      ? muniFullyClassified / totalSegments 
      : 0;
    
    // If coverage too low, don't drop anything
    const useCoverageProtection = coverageRatio < MIN_COVERAGE_RATIO;
    const originalDropped = muniDropped;
    if (useCoverageProtection) {
      notes.push('insufficient_classification_coverage');
      // Adjust global count: subtract what we would have dropped
      report.global.total_dropped_segments -= originalDropped;
      muniDropped = 0; // Reset dropped count for this municipality
    }
    
    // Second pass: rebuild geometry
    for (const { lineCoords, classifications } of allSegments) {
      if (useCoverageProtection) {
        // Rebuild without drops
        const allKept = classifications.map(() => ({ keep: true, reason: 'coverage_protection' }));
        const lineCleaned = rebuildGeometry(lineCoords, allKept);
        cleanedLines.push(...lineCleaned);
      } else {
        // Rebuild with drops
        const lineCleaned = rebuildGeometry(lineCoords, classifications);
        cleanedLines.push(...lineCleaned);
      }
    }
    
    // Only count as having drops if coverage protection wasn't used
    if (muniDropped > 0 && !useCoverageProtection) {
      report.global.municipalities_with_any_drops++;
    }
    
    if (muniSideSameOtherMuni > 0) {
      notes.push(`side_same_other_muni_count_${muniSideSameOtherMuni}`);
    }
    
    // Create cleaned feature
    const cleanedGeometry: GeoJSON.MultiLineString = {
      type: 'MultiLineString',
      coordinates: cleanedLines.length > 0 ? cleanedLines : [[inputLines[0][0], inputLines[0][0]]] // Fallback
    };
    
    cleanedFeatures.push({
      type: 'Feature',
      properties: { ...props },
      geometry: cleanedGeometry
    });
    
    report.per_municipality.push({
      municipality_id: muniId,
      segments_total: muniDropped + muniKept,
      segments_dropped: muniDropped,
      segments_kept: muniKept,
      fully_classified_segments: muniFullyClassified,
      unclassified_segments: muniUnclassified,
      coverage_ratio: (muniDropped + muniKept) > 0 
        ? muniFullyClassified / (muniDropped + muniKept) 
        : 0,
      notes
    });
  }
  
  report.global.municipalities_total = sortedBoundaryFeatures.length;
  
  // Sort top 20 by dropped count
  report.top_20_by_dropped = report.per_municipality
    .sort((a, b) => {
      if (b.segments_dropped !== a.segments_dropped) {
        return b.segments_dropped - a.segments_dropped;
      }
      return a.municipality_id.localeCompare(b.municipality_id);
    })
    .slice(0, 20)
    .map(m => ({ municipality_id: m.municipality_id, segments_dropped: m.segments_dropped }));
  
  // Write outputs
  console.log('Writing outputs...');
  await mkdir(resolve('data/derived'), { recursive: true });
  
  const cleanedGeoJSON: GeoJSON.FeatureCollection = {
    type: 'FeatureCollection',
    features: cleanedFeatures
  };
  
  await writeFile(OUTPUT_CLEANED_PATH, JSON.stringify(cleanedGeoJSON, null, 2), 'utf8');
  await writeFile(OUTPUT_REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
  await writeReport(report, []);
  
  console.log('Done!');
  console.log(`  Cleaned GeoJSON: ${OUTPUT_CLEANED_PATH}`);
  console.log(`  Report JSON: ${OUTPUT_REPORT_JSON_PATH}`);
  console.log(`  Report TXT: ${OUTPUT_REPORT_TXT_PATH}`);
  console.log(`  Total segments: ${report.global.total_segments}, dropped: ${report.global.total_dropped_segments}`);
}

async function writeReport(report: Report, additionalWarnings: string[]): Promise<void> {
  const lines: string[] = [
    'Fabric-Derived Municipality Boundaries Cleaning Report',
    '=====================================================',
    '',
    `Municipalities total: ${report.global?.municipalities_total || 0}`,
    `Municipalities with any drops: ${report.global?.municipalities_with_any_drops || 0}`,
    `Total segments: ${report.global?.total_segments || 0}`,
    `Total dropped segments: ${report.global?.total_dropped_segments || 0}`,
    `Total unclassified segments: ${report.global?.total_unclassified_segments || 0}`,
    `Epsilon used: ${report.global?.eps_used || 0}`,
    `Grid size: ${report.global?.grid_size || 0}`,
    '',
  ];
  
  if (report.top_20_by_dropped && report.top_20_by_dropped.length > 0) {
    lines.push('Top 20 municipalities by dropped segment count:');
    report.top_20_by_dropped.forEach(item => {
      lines.push(`  ${item.municipality_id}: ${item.segments_dropped} dropped`);
    });
    lines.push('');
  }
  
  // Find municipalities with side_same_other_muni issues
  const problemSpots = report.per_municipality?.filter(m => 
    m.notes.some(note => note.includes('side_same_other_muni'))
  ) || [];
  
  if (problemSpots.length > 0) {
    lines.push('Problem spots (side_same_other_muni detected):');
    problemSpots.forEach(m => {
      const countNote = m.notes.find(n => n.includes('side_same_other_muni_count'));
      lines.push(`  ${m.municipality_id}: ${countNote || 'side_same_other_muni detected'}`);
    });
    lines.push('');
  }
  
  // Find municipalities with insufficient coverage
  const insufficientCoverage = report.per_municipality?.filter(m => 
    m.notes.includes('insufficient_classification_coverage')
  ) || [];
  
  if (insufficientCoverage.length > 0) {
    lines.push(`Municipalities with insufficient classification coverage (${insufficientCoverage.length}):`);
    insufficientCoverage.forEach(m => {
      lines.push(`  ${m.municipality_id}: coverage ratio ${m.coverage_ratio.toFixed(3)} (geometry unchanged)`);
    });
    lines.push('');
  }
  
  await writeFile(OUTPUT_REPORT_TXT_PATH, lines.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exitCode = 1;
});
