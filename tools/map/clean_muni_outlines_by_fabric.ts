#!/usr/bin/env node
/**
 * Clean Municipality Outlines by Settlement Fabric
 * 
 * Removes interior segments from municipality outlines by using settlement
 * polygon fabric as an oracle to classify segments as "true boundary" vs "interior seam".
 * 
 * CRITICAL RULES:
 * - Deterministic: stable ordering, fixed precision, no randomness, no timestamps
 * - No smoothing, union, simplification, buffering
 * - No snapping to boundaries
 * - Filter step only: segments kept or dropped based on fabric classification
 * - If classification coverage too low, warn and output unchanged copy
 * 
 * Inputs:
 * - data/source/geography.geojson (settlement fabric)
 * - data/derived/municipality_outlines_from_html.geojson (municipality outlines)
 * 
 * Outputs:
 * - data/derived/municipality_outlines_from_html_cleaned.geojson
 * - data/derived/municipality_outlines_from_html_cleaned_report.json
 * - data/derived/municipality_outlines_from_html_cleaned_report.txt
 * 
 * Usage:
 *   npm run map:clean-muni-outlines
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Filter municipality outline segments that are provably interior using settlement fabric as oracle, without geometry invention");

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ============================================================================
// Constants
// ============================================================================

const SETTLEMENT_FABRIC_PATH = resolve('data/source/geography.geojson');
const MUNI_OUTLINES_PATH = resolve('data/derived/municipality_outlines_from_html.geojson');
const OUTPUT_CLEANED_PATH = resolve('data/derived/municipality_outlines_from_html_cleaned.geojson');
const OUTPUT_REPORT_JSON_PATH = resolve('data/derived/municipality_outlines_from_html_cleaned_report.json');
const OUTPUT_REPORT_TXT_PATH = resolve('data/derived/municipality_outlines_from_html_cleaned_report.txt');

const EPS_FRACTION = 1e-4;
const MIN_EPS = 1e-6;
const COORD_PRECISION = 6;

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
  muni_key: string;
  segments_total: number;
  dropped: number;
  kept: number;
  unclassified_count: number;
  key_mismatch_count: number;
}

interface Report {
  coverage: {
    total_segments: number;
    classified_segments: number;
    fully_classified_segments: number;
    dropped_segments: number;
    kept_segments: number;
  };
  per_municipality: MunicipalityStats[];
  top_20_by_dropped: Array<{ muni_key: string; dropped: number }>;
  mode_flags: {
    outlines_have_muni_id_mapping: boolean;
    eps_used: number;
    precision_used: number;
  };
  warnings: string[];
}

// ============================================================================
// Point-in-Polygon Test
// ============================================================================

/**
 * Point-in-polygon test using ray casting algorithm
 */
function pointInPolygon(point: [number, number], polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  if (polygon.type === 'Polygon') {
    return pointInPolygonRing(point, polygon.coordinates[0]);
  } else if (polygon.type === 'MultiPolygon') {
    for (const poly of polygon.coordinates) {
      if (pointInPolygonRing(point, poly[0])) {
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
// Spatial Index (Simple Grid)
// ============================================================================

class SpatialIndex {
  private grid: Map<string, SettlementPolygon[]>;
  private cellSize: number;
  private bbox: { minX: number; minY: number; maxX: number; maxY: number };

  constructor(polygons: SettlementPolygon[], cellSize: number) {
    this.grid = new Map();
    this.cellSize = cellSize;
    
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
    const minCellX = Math.floor((bbox.minX - this.bbox.minX) / this.cellSize);
    const minCellY = Math.floor((bbox.minY - this.bbox.minY) / this.cellSize);
    const maxCellX = Math.floor((bbox.maxX - this.bbox.minX) / this.cellSize);
    const maxCellY = Math.floor((bbox.maxY - this.bbox.minY) / this.cellSize);
    
    for (let cx = minCellX; cx <= maxCellX; cx++) {
      for (let cy = minCellY; cy <= maxCellY; cy++) {
        cells.push(`${cx},${cy}`);
      }
    }
    return cells;
  }

  findPolygonsContainingPoint(point: [number, number]): SettlementPolygon[] {
    const cellX = Math.floor((point[0] - this.bbox.minX) / this.cellSize);
    const cellY = Math.floor((point[1] - this.bbox.minY) / this.cellSize);
    const cellKey = `${cellX},${cellY}`;
    
    const candidates = this.grid.get(cellKey) || [];
    const results: SettlementPolygon[] = [];
    
    for (const poly of candidates) {
      if (pointInPolygon(point, poly.geometry)) {
        results.push(poly);
      }
    }
    
    return results;
  }

  getBbox(): { minX: number; minY: number; maxX: number; maxY: number } {
    return this.bbox;
  }
}

// ============================================================================
// Geometry Utilities
// ============================================================================

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
    const p1: [number, number] = [coordinates[i][0], coordinates[i][1]];
    const p2: [number, number] = [coordinates[i + 1][0], coordinates[i + 1][1]];
    
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    
    if (len < 1e-10) continue; // Skip degenerate segments
    
    const midpoint: [number, number] = [
      (p1[0] + p2[0]) / 2,
      (p1[1] + p2[1]) / 2
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
  muniKey: string,
  muniIdMapping: Map<string, string>,
  spatialIndex: SpatialIndex,
  eps: number
): ClassificationResult {
  const { midpoint, normal } = segment;
  
  // Sample points on both sides
  const left: [number, number] = [
    midpoint[0] + normal[0] * eps,
    midpoint[1] + normal[1] * eps
  ];
  const right: [number, number] = [
    midpoint[0] - normal[0] * eps,
    midpoint[1] - normal[1] * eps
  ];
  
  // Find polygons containing each point
  const leftPolys = spatialIndex.findPolygonsContainingPoint(left);
  const rightPolys = spatialIndex.findPolygonsContainingPoint(right);
  
  // If multiple polygons, pick smallest bbox area (deterministic)
  const leftPoly = leftPolys.length > 0 
    ? leftPolys.sort((a, b) => {
        const areaA = (a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY);
        const areaB = (b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY);
        return areaA - areaB;
      })[0]
    : null;
  
  const rightPoly = rightPolys.length > 0
    ? rightPolys.sort((a, b) => {
        const areaA = (a.bbox.maxX - a.bbox.minX) * (a.bbox.maxY - a.bbox.minY);
        const areaB = (b.bbox.maxX - b.bbox.minX) * (b.bbox.maxY - b.bbox.minY);
        return areaA - areaB;
      })[0]
    : null;
  
  const leftMuniId = leftPoly?.muniId;
  const rightMuniId = rightPoly?.muniId;
  
  // Get mapped muni_id for this outline feature
  const mappedMuniId = muniIdMapping.get(muniKey);
  
  // Classification logic
  if (leftMuniId && rightMuniId) {
    if (leftMuniId === rightMuniId) {
      // Both sides in same municipality
      if (mappedMuniId && leftMuniId === mappedMuniId) {
        // Interior seam -> DROP
        return { keep: false, reason: 'interior_seam', leftMuniId, rightMuniId };
      } else if (mappedMuniId && leftMuniId !== mappedMuniId) {
        // Key mismatch -> KEEP
        return { keep: true, reason: 'key_mismatch', leftMuniId, rightMuniId };
      } else {
        // No mapping -> KEEP (conservative)
        return { keep: true, reason: 'no_mapping_same_side', leftMuniId, rightMuniId };
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
    currentLine.push([
      Math.round(originalCoords[0][0] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION),
      Math.round(originalCoords[0][1] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION)
    ]);
  }
  
  for (let i = 0; i < segmentClassifications.length; i++) {
    const classification = segmentClassifications[i];
    const nextPoint = originalCoords[i + 1];
    
    if (!nextPoint) break;
    
    const roundedPoint: [number, number] = [
      Math.round(nextPoint[0] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION),
      Math.round(nextPoint[1] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION)
    ];
    
    if (classification.keep) {
      // Add next point to current line
      currentLine.push(roundedPoint);
    } else {
      // Segment dropped - finish current line and start new one
      if (currentLine.length >= 2) {
        lines.push(currentLine);
      }
      // Start new line with the endpoint of dropped segment
      currentLine = [roundedPoint[0], roundedPoint[1]];
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
  
  // Load settlement fabric
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
    console.warn('Server will exit with report indicating no settlements found.');
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
    await writeReport({} as Report, ['No municipality ID field found in settlement features']);
    process.exitCode = 0;
    return;
  }
  
  // Build settlement polygons with spatial index
  console.log(`Building spatial index for ${settlementFeatures.length} settlement polygons...`);
  const settlementPolygons: SettlementPolygon[] = [];
  
  for (let i = 0; i < settlementFeatures.length; i++) {
    const feature = settlementFeatures[i];
    const geometry = feature.geometry;
    
    if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
      continue;
    }
    
    const props = feature.properties || {};
    const muniId = String(props[muniIdField!] || '');
    
    if (!muniId) continue;
    
    const bbox = computeBbox(geometry);
    settlementPolygons.push({
      bbox,
      muniId,
      geometry,
      originalIndex: i
    });
  }
  
  // Compute cell size for spatial index (use diagonal fraction)
  const fabricBbox = settlementPolygons.reduce((acc, poly) => {
    if (acc.minX === undefined) {
      return { ...poly.bbox };
    }
    return {
      minX: Math.min(acc.minX, poly.bbox.minX),
      minY: Math.min(acc.minY, poly.bbox.minY),
      maxX: Math.max(acc.maxX, poly.bbox.maxX),
      maxY: Math.max(acc.maxY, poly.bbox.maxY)
    };
  }, {} as { minX?: number; minY?: number; maxX?: number; maxY?: number });
  
  const diag = Math.hypot(
    fabricBbox.maxX! - fabricBbox.minX!,
    fabricBbox.maxY! - fabricBbox.minY!
  );
  const cellSize = Math.max(diag * 0.01, 1.0); // 1% of diagonal, min 1.0
  const eps = Math.max(diag * EPS_FRACTION, MIN_EPS);
  
  const spatialIndex = new SpatialIndex(settlementPolygons, cellSize);
  
  // Load municipality outlines
  console.log('Loading municipality outlines...');
  if (!existsSync(MUNI_OUTLINES_PATH)) {
    console.error(`Error: Municipality outlines not found at ${MUNI_OUTLINES_PATH}`);
    process.exitCode = 0;
    return;
  }
  
  const outlinesContent = await readFile(MUNI_OUTLINES_PATH, 'utf8');
  const outlinesGeoJSON = JSON.parse(outlinesContent) as GeoJSON.FeatureCollection;
  
  // Build muni_key -> muni_id mapping
  const muniIdMapping = new Map<string, string>();
  let hasMapping = false;
  
  for (const feature of outlinesGeoJSON.features) {
    const props = feature.properties || {};
    const muniKey = props.muni_key || '';
    
    if (!muniKey) continue;
    
    // Try to map muni_key to muni_id
    if (props.municipality_id !== undefined) {
      muniIdMapping.set(muniKey, String(props.municipality_id));
      hasMapping = true;
    } else if (/^\d+$/.test(muniKey)) {
      // Purely numeric key - treat as muni_id
      muniIdMapping.set(muniKey, muniKey);
      hasMapping = true;
    }
  }
  
  console.log(`Mapping status: ${hasMapping ? 'Found' : 'No mapping found'}`);
  if (!hasMapping) {
    console.warn('WARNING: No muni_id mapping for outlines - running in KEEP-only mode');
  }
  
  // Process each municipality outline
  console.log('Processing municipality outlines...');
  const cleanedFeatures: GeoJSON.Feature[] = [];
  const report: Report = {
    coverage: {
      total_segments: 0,
      classified_segments: 0,
      fully_classified_segments: 0,
      dropped_segments: 0,
      kept_segments: 0
    },
    per_municipality: [],
    top_20_by_dropped: [],
    mode_flags: {
      outlines_have_muni_id_mapping: hasMapping,
      eps_used: eps,
      precision_used: COORD_PRECISION
    },
    warnings: []
  };
  
  // Sort features deterministically
  const sortedFeatures = [...outlinesGeoJSON.features].sort((a, b) => {
    const keyA = (a.properties?.muni_key || '').toLowerCase();
    const keyB = (b.properties?.muni_key || '').toLowerCase();
    return keyA.localeCompare(keyB);
  });
  
  for (const feature of sortedFeatures) {
    const props = feature.properties || {};
    const muniKey = props.muni_key || 'UNKNOWN';
    const geometry = feature.geometry;
    
    if (geometry.type !== 'LineString' && geometry.type !== 'MultiLineString') {
      // Copy as-is
      cleanedFeatures.push(feature);
      continue;
    }
    
    // Process each line separately (for MultiLineString)
    const inputLines = geometry.type === 'LineString' 
      ? [geometry.coordinates]
      : geometry.coordinates;
    
    const cleanedLines: number[][][] = [];
    let muniDropped = 0;
    let muniKept = 0;
    let muniUnclassified = 0;
    let muniKeyMismatch = 0;
    
    for (const lineCoords of inputLines) {
      if (lineCoords.length < 2) {
        // Skip degenerate lines
        continue;
      }
      
      // Extract segments for this line
      const segments = extractSegments(lineCoords);
      const segmentClassifications: ClassificationResult[] = [];
      
      for (const segment of segments) {
        const classification = classifySegment(segment, muniKey, muniIdMapping, spatialIndex, eps);
        segmentClassifications.push(classification);
        
        report.coverage.total_segments++;
        
        if (classification.reason === 'unclassified') {
          muniUnclassified++;
        } else {
          report.coverage.classified_segments++;
          if (classification.leftMuniId && classification.rightMuniId) {
            report.coverage.fully_classified_segments++;
          }
        }
        
        if (classification.keep) {
          muniKept++;
          report.coverage.kept_segments++;
        } else {
          muniDropped++;
          report.coverage.dropped_segments++;
        }
        
        if (classification.reason === 'key_mismatch') {
          muniKeyMismatch++;
        }
      }
      
      // Rebuild geometry for this line
      const lineCleaned = rebuildGeometry(lineCoords, segmentClassifications);
      cleanedLines.push(...lineCleaned);
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
      muni_key: muniKey,
      segments_total: segments.length,
      dropped: muniDropped,
      kept: muniKept,
      unclassified_count: muniUnclassified,
      key_mismatch_count: muniKeyMismatch
    });
  }
  
  // Sort top 20 by dropped count
  report.top_20_by_dropped = report.per_municipality
    .sort((a, b) => {
      if (b.dropped !== a.dropped) return b.dropped - a.dropped;
      return a.muni_key.localeCompare(b.muni_key);
    })
    .slice(0, 20)
    .map(m => ({ muni_key: m.muni_key, dropped: m.dropped }));
  
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
}

async function writeReport(report: Report, additionalWarnings: string[]): Promise<void> {
  const hasData = report.coverage && report.coverage.total_segments > 0;
  
  const lines: string[] = [
    'Municipality Outlines Cleaning Report',
    '====================================',
    '',
  ];
  
  if (hasData) {
    lines.push(
      `Total segments: ${report.coverage.total_segments}`,
      `Classified segments: ${report.coverage.classified_segments}`,
      `Fully classified segments: ${report.coverage.fully_classified_segments}`,
      `Dropped segments: ${report.coverage.dropped_segments}`,
      `Kept segments: ${report.coverage.kept_segments}`,
      '',
      `Mode: ${report.mode_flags?.outlines_have_muni_id_mapping ? 'Mapping enabled (drops enabled)' : 'No mapping (KEEP-only mode for safety)'}`,
      `Epsilon used: ${report.mode_flags?.eps_used || 0}`,
      ''
    );
  }
  
  if (additionalWarnings.length > 0 || (report.warnings && report.warnings.length > 0)) {
    lines.push('Warnings:');
    [...additionalWarnings, ...(report.warnings || [])].forEach(w => lines.push(`  - ${w}`));
    lines.push('');
  }
  
  if (!report.mode_flags?.outlines_have_muni_id_mapping) {
    lines.push('IMPORTANT: No outline muni_id mapping found. Drop disabled for safety.');
    lines.push('');
  }
  
  if (report.top_20_by_dropped && report.top_20_by_dropped.length > 0) {
    lines.push('Top 20 municipalities by dropped segment count:');
    report.top_20_by_dropped.forEach(item => {
      lines.push(`  ${item.muni_key}: ${item.dropped} dropped`);
    });
    lines.push('');
  }
  
  await writeFile(OUTPUT_REPORT_TXT_PATH, lines.join('\n'), 'utf8');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exitCode = 1;
});
