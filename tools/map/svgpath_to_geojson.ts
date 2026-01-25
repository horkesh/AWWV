/**
 * SVG Path to GeoJSON: Convert SVG paths to GeoJSON polygons
 * 
 * Reads polygon_fabric.json and converts each SVG path into polygon features.
 * Polygons are territorial micro-areas, identified by poly_id, not settlements.
 * 
 * Outputs:
 *   - data/derived/polygon_fabric.geojson (LOCAL_PIXELS_V2)
 * 
 * Usage:
 *   tsx tools/map/svgpath_to_geojson.ts
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import parseSVG from 'svg-path-parser';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");
loadLedger();
assertLedgerFresh("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");

// ============================================================================
// Types
// ============================================================================

interface PolygonFabricFeature {
  poly_id: string;
  mun_code: string;
  name_html?: string;
  d: string;
}

interface ConversionResult {
  polygon: turf.Feature<turf.Polygon> | null;
  dropReason: string | null;
}

// ============================================================================
// Constants
// ============================================================================

const INPUT_PATH = resolve('data/derived/polygon_fabric.json');
const POLYGONS_OUTPUT_PATH = resolve('data/derived/polygon_fabric.geojson');
const DERIVED_DIR = resolve('data/derived');

const CURVE_TOLERANCE = 0.25; // Fixed tolerance for curve flattening (pixels)
const COORDINATE_PRECISION = 3; // Decimal places for coordinates
const MIN_AREA = 1e-6; // Minimum area to keep a polygon

// ============================================================================
// Conversion Functions
// ============================================================================

/**
 * Round coordinate to fixed precision
 */
function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

/**
 * Flatten a cubic bezier curve to line segments
 */
function flattenCubicBezier(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  tolerance: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  
  // Use recursive subdivision to flatten curve
  function subdivide(t0: number, t1: number, depth: number): void {
    if (depth > 10) return; // Safety limit
    
    const tm = (t0 + t1) / 2;
    
    // Calculate points at t0, tm, t1
    const p0 = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, t0);
    const pm = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, tm);
    const p1 = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, t1);
    
    // Check if line from p0 to p1 is close enough to pm
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const dist = Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / Math.sqrt(dx * dx + dy * dy);
    
    if (dist < tolerance) {
      points.push(p1);
    } else {
      subdivide(t0, tm, depth + 1);
      subdivide(tm, t1, depth + 1);
    }
  }
  
  points.push([x0, y0]);
  subdivide(0, 1, 0);
  
  return points;
}

/**
 * Calculate point on cubic bezier curve at parameter t
 */
function bezierPoint(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  t: number
): [number, number] {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  
  return [
    mt3 * x0 + 3 * mt2 * t * x1 + 3 * mt * t2 * x2 + t3 * x3,
    mt3 * y0 + 3 * mt2 * t * y1 + 3 * mt * t2 * y2 + t3 * y3
  ];
}

/**
 * Flatten a quadratic bezier curve to line segments
 */
function flattenQuadraticBezier(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  tolerance: number
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  
  function subdivide(t0: number, t1: number, depth: number): void {
    if (depth > 10) return;
    
    const tm = (t0 + t1) / 2;
    const p0 = quadPoint(x0, y0, x1, y1, x2, y2, t0);
    const pm = quadPoint(x0, y0, x1, y1, x2, y2, tm);
    const p1 = quadPoint(x0, y0, x1, y1, x2, y2, t1);
    
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const dist = Math.abs((pm[0] - p0[0]) * dy - (pm[1] - p0[1]) * dx) / Math.sqrt(dx * dx + dy * dy);
    
    if (dist < tolerance) {
      points.push(p1);
    } else {
      subdivide(t0, tm, depth + 1);
      subdivide(tm, t1, depth + 1);
    }
  }
  
  points.push([x0, y0]);
  subdivide(0, 1, 0);
  
  return points;
}

/**
 * Calculate point on quadratic bezier curve at parameter t
 */
function quadPoint(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  t: number
): [number, number] {
  const mt = 1 - t;
  return [
    mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
    mt * mt * y0 + 2 * mt * t * y1 + t * t * y2
  ];
}

/**
 * Convert SVG path to polygon coordinates
 */
function svgPathToRings(svgPath: string): number[][][] | null {
  try {
    const commands = parseSVG(svgPath);
    parseSVG.makeAbsolute(commands);
    
    const rings: number[][][] = [];
    let currentRing: number[][] = [];
    let currentX = 0;
    let currentY = 0;
    let startX = 0;
    let startY = 0;
    let hasMove = false;
    
    for (const cmd of commands) {
      const code = cmd.code.toUpperCase();
      
      switch (code) {
        case 'M': {
          // Start new ring
          if (hasMove && currentRing.length > 0) {
            // Close previous ring if needed
            if (currentRing.length > 0 && 
                (currentRing[currentRing.length - 1][0] !== startX || 
                 currentRing[currentRing.length - 1][1] !== startY)) {
              currentRing.push([roundCoord(startX), roundCoord(startY)]);
            }
            if (currentRing.length >= 3) {
              rings.push(currentRing);
            }
          }
          currentRing = [];
          currentX = cmd.x ?? 0;
          currentY = cmd.y ?? 0;
          startX = currentX;
          startY = currentY;
          hasMove = true;
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          break;
        }
        case 'L': {
          currentX = cmd.x ?? currentX;
          currentY = cmd.y ?? currentY;
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          break;
        }
        case 'H': {
          currentX = cmd.x ?? currentX;
          // After makeAbsolute, y0 should be available
          if ('y0' in cmd && cmd.y0 != null) {
            currentY = cmd.y0;
          }
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          break;
        }
        case 'V': {
          currentY = cmd.y ?? currentY;
          // After makeAbsolute, x0 should be available
          if ('x0' in cmd && cmd.x0 != null) {
            currentX = cmd.x0;
          }
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          break;
        }
        case 'C': {
          // Cubic bezier
          const x0 = currentX;
          const y0 = currentY;
          const x1 = cmd.x1 ?? x0;
          const y1 = cmd.y1 ?? y0;
          const x2 = cmd.x2 ?? x0;
          const y2 = cmd.y2 ?? y0;
          const x3 = cmd.x ?? x0;
          const y3 = cmd.y ?? y0;
          
          const curvePoints = flattenCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
          }
          currentX = x3;
          currentY = y3;
          break;
        }
        case 'S': {
          // Smooth cubic bezier (use previous control point)
          // For simplicity, treat as regular cubic with mirrored control point
          const x0 = currentX;
          const y0 = currentY;
          const x2 = cmd.x2 ?? x0;
          const y2 = cmd.y2 ?? y0;
          const x3 = cmd.x ?? x0;
          const y3 = cmd.y ?? y0;
          // Mirror previous control point (simplified - use current position)
          const x1 = x0;
          const y1 = y0;
          
          const curvePoints = flattenCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
          }
          currentX = x3;
          currentY = y3;
          break;
        }
        case 'Q': {
          // Quadratic bezier
          const x0 = currentX;
          const y0 = currentY;
          const x1 = cmd.x1 ?? x0;
          const y1 = cmd.y1 ?? y0;
          const x2 = cmd.x ?? x0;
          const y2 = cmd.y ?? y0;
          
          const curvePoints = flattenQuadraticBezier(x0, y0, x1, y1, x2, y2, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
          }
          currentX = x2;
          currentY = y2;
          break;
        }
        case 'T': {
          // Smooth quadratic bezier
          const x0 = currentX;
          const y0 = currentY;
          const x2 = cmd.x ?? x0;
          const y2 = cmd.y ?? y0;
          // Mirror previous control point (simplified)
          const x1 = x0;
          const y1 = y0;
          
          const curvePoints = flattenQuadraticBezier(x0, y0, x1, y1, x2, y2, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
          }
          currentX = x2;
          currentY = y2;
          break;
        }
        case 'Z': {
          // Close path
          if (currentRing.length > 0 && 
              (currentRing[currentRing.length - 1][0] !== startX || 
               currentRing[currentRing.length - 1][1] !== startY)) {
            currentRing.push([roundCoord(startX), roundCoord(startY)]);
          }
          currentX = startX;
          currentY = startY;
          break;
        }
        case 'A': {
          // Arc - not supported, drop
          return null;
        }
      }
    }
    
    // Close last ring if needed
    if (hasMove && currentRing.length > 0) {
      if (currentRing.length > 0 && 
          (currentRing[currentRing.length - 1][0] !== startX || 
           currentRing[currentRing.length - 1][1] !== startY)) {
        currentRing.push([roundCoord(startX), roundCoord(startY)]);
      }
      if (currentRing.length >= 3) {
        rings.push(currentRing);
      }
    }
    
    if (rings.length === 0) {
      return null;
    }
    
    // Remove duplicate consecutive points and normalize
    const cleanedRings = rings.map(ring => {
      const cleaned: number[][] = [];
      for (let i = 0; i < ring.length; i++) {
        const point = ring[i];
        if (i === 0 || point[0] !== cleaned[cleaned.length - 1][0] || point[1] !== cleaned[cleaned.length - 1][1]) {
          cleaned.push(point);
        }
      }
      // Ensure closed
      if (cleaned.length > 0 && 
          (cleaned[0][0] !== cleaned[cleaned.length - 1][0] || 
           cleaned[0][1] !== cleaned[cleaned.length - 1][1])) {
        cleaned.push([cleaned[0][0], cleaned[0][1]]);
      }
      return cleaned.length >= 3 ? cleaned : null;
    }).filter((ring): ring is number[][] => ring !== null);
    
    if (cleanedRings.length === 0) {
      return null;
    }
    
    return cleanedRings;
  } catch (err) {
    return null;
  }
}

/**
 * Normalize winding order (ensure counter-clockwise for exterior rings)
 */
function normalizeWinding(ring: number[][]): number[][] {
  // Calculate signed area using shoelace formula
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1];
    area -= ring[i + 1][0] * ring[i][1];
  }
  
  // If clockwise (negative area), reverse
  if (area < 0) {
    return [...ring].reverse();
  }
  
  return ring;
}

/**
 * Calculate polygon area
 */
function calculateArea(ring: number[][]): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i][0] * ring[i + 1][1];
    area -= ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(area) / 2;
}

/**
 * Convert SVG path to GeoJSON polygon
 */
function convertSVGPath(feature: PolygonFabricFeature): ConversionResult {
  const rings = svgPathToRings(feature.d);
  
  if (!rings || rings.length === 0) {
    return {
      polygon: null,
      dropReason: 'no_valid_rings'
    };
  }
  
  // Normalize winding and filter tiny rings
  const validRings = rings
    .map(ring => normalizeWinding(ring))
    .filter(ring => {
      const area = calculateArea(ring);
      return area >= MIN_AREA;
    });
  
  if (validRings.length === 0) {
    return {
      polygon: null,
      dropReason: 'all_rings_too_small'
    };
  }
  
  // Create polygon (first ring is exterior, rest are holes)
  // Properties: poly_id and mun_code only (no sid)
  const polygon: turf.Feature<turf.Polygon> = turf.polygon(
    validRings,
    {
      poly_id: feature.poly_id,
      mun_code: feature.mun_code
    }
  );
  
  return {
    polygon,
    dropReason: null
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Converting SVG paths to GeoJSON...\n');
  console.log(`Input: ${INPUT_PATH}`);
  
  try {
    const inputContent = await readFile(INPUT_PATH, 'utf8');
    const features: PolygonFabricFeature[] = JSON.parse(inputContent);
    
    console.log(`Processing ${features.length} features...`);
    
    const polygons: turf.Feature<turf.Polygon>[] = [];
    const dropReasons: Record<string, number> = {};
    let kept = 0;
    let dropped = 0;
    
    for (const feature of features) {
      const result = convertSVGPath(feature);
      
      if (result.polygon) {
        polygons.push(result.polygon);
        kept++;
      } else {
        dropped++;
        const reason = result.dropReason || 'unknown';
        dropReasons[reason] = (dropReasons[reason] || 0) + 1;
      }
    }
    
    // Create GeoJSON FeatureCollection
    const polygonFC: turf.FeatureCollection<turf.Polygon> = {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: 'LOCAL_PIXELS_V2'
        }
      },
      features: polygons
    };
    
    // Write output
    await writeFile(POLYGONS_OUTPUT_PATH, JSON.stringify(polygonFC, null, 2), 'utf8');
    
    console.log(`\nResults:`);
    console.log(`  Kept: ${kept}`);
    console.log(`  Dropped: ${dropped}`);
    if (Object.keys(dropReasons).length > 0) {
      console.log(`  Drop reasons:`);
      for (const [reason, count] of Object.entries(dropReasons)) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    console.log(`\nOutput:`);
    console.log(`  Polygons: ${POLYGONS_OUTPUT_PATH}`);
    console.log('✓ Conversion complete');
  } catch (err) {
    console.error('Error converting SVG paths:', err);
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) {
        console.error(err.stack);
      }
    }
    process.exit(1);
  }
}

main();
