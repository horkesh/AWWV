/**
 * Extract Municipality Borders from drzava.js
 *
 * Parses drzava.js to extract municipality borders directly from authored shapes.
 * Bypasses union operations by using pre-authored municipality paths.
 *
 * Input:
 *   - data/source/drzava.js
 *
 * Output:
 *   - data/derived/municipality_borders_from_drzava.geojson
 *   - data/derived/municipality_borders_extraction_report.json
 *   - data/derived/municipality_borders_extraction_failures.csv
 *   - data/derived/municipality_borders_from_drzava_viewer.html
 *   - data/derived/municipality_audit/municipality_geometry_failures_diagnostic.json
 *   - data/derived/municipality_audit/municipality_geometry_failures_diagnostic.csv
 *
 * Usage:
 *   tsx tools/map/extract_municipality_borders_from_drzava.ts
 *   npm run map:extract:muni:drzava
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import parseSVG from 'svg-path-parser';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Diagnose why some municipality geometries fail parsing without repairing or inferring shapes");
loadLedger();
assertLedgerFresh("Diagnose why some municipality geometries fail parsing without repairing or inferring shapes");

// ============================================================================
// Types
// ============================================================================

type AdminLayer = 'municipality' | 'canton' | 'entity' | 'other';

interface MunicipalityExtract {
  munID: number;
  path_d: string;
}

interface FailedEntity {
  munid_5: number;
  name: string;
  reason: string;
  layer: 'municipality';
}

interface SampleNonMunicipality {
  inferred_layer: string;
  id: string | null;
  name: string | null;
  reason: string;
}

interface AdminLayerBreakdown {
  municipality: number;
  canton: number;
  entity: number;
  other: number;
}

interface ExtractionReport {
  total_found_munIDs: number;
  total_converted: number;
  dropped_count: number;
  dropped_reasons: Record<string, number>;
  duplicate_munID_count: number;
  failed_entities: FailedEntity[];
  admin_layer_breakdown: AdminLayerBreakdown;
  sample_non_municipality: SampleNonMunicipality[];
  bounds: {
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  } | null;
  municipality_failures: number;
  municipality_failures_by_reason: Record<string, number>;
  municipality_failed_ids: string[];
}

/** Diagnostic entry for a municipality geometry conversion failure (diagnostics only, no repair). */
interface GeometryFailureDiagnostic {
  munid_5: string;
  name: string;
  raw_geometry_kind: 'svg_path' | 'coords_array' | 'unknown';
  failure_stage: 'duplicate' | 'parse_path' | 'to_rings' | 'polygon_validate';
  failure_reason: string;
  detail: string;
  basic_stats: {
    raw_point_count?: number | null;
    ring_count_detected?: number | null;
    has_nan?: boolean | null;
    bbox?: [number, number, number, number] | null;
  };
}

// ============================================================================
// Constants
// ============================================================================

const INPUT_PATH = resolve('data/source/drzava.js');
const OUTPUT_PATH = resolve('data/derived/municipality_borders_from_drzava.geojson');
const LEGACY_BORDERS_PATH = resolve('data/derived/municipality_borders.geojson');
const REPORT_PATH = resolve('data/derived/municipality_borders_extraction_report.json');
const FAILURES_CSV_PATH = resolve('data/derived/municipality_borders_extraction_failures.csv');
const VIEWER_HTML_PATH = resolve('data/derived/municipality_borders_from_drzava_viewer.html');
const DERIVED_DIR = resolve('data/derived');
const AUDIT_DIR = resolve('data/derived/municipality_audit');
const DIAGNOSTIC_JSON_PATH = resolve('data/derived/municipality_audit/municipality_geometry_failures_diagnostic.json');
const DIAGNOSTIC_CSV_PATH = resolve('data/derived/municipality_audit/municipality_geometry_failures_diagnostic.csv');

const DETAIL_MAX_LEN = 200;

const CURVE_TOLERANCE = 0.25; // Fixed tolerance for curve flattening (pixels)
const COORDINATE_PRECISION = 3; // Decimal places for coordinates
const MIN_AREA = 1e-6; // Minimum area to keep a polygon
const EXPECTED_FEATURE_COUNT = 142;
const MIN_FEATURE_COUNT = 130;

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Round coordinate to fixed precision
 */
function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

/**
 * Truncate detail string to max length (deterministic).
 */
function truncateDetail(s: string, maxLen: number = DETAIL_MAX_LEN): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen);
}

type SvgPathResult =
  | { rings: number[][][]; diagnostic?: undefined }
  | { rings: null; diagnostic: { failure_stage: 'parse_path' | 'to_rings'; detail: string; raw_point_count?: number; ring_count_detected: number } };

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
  
  function subdivide(t0: number, t1: number, depth: number): void {
    if (depth > 10) return; // Safety limit
    
    const tm = (t0 + t1) / 2;
    
    const p0 = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, t0);
    const pm = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, tm);
    const p1 = bezierPoint(x0, y0, x1, y1, x2, y2, x3, y3, t1);
    
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
 * Flatten an arc to line segments (simplified - sample at fixed intervals)
 */
function flattenArc(
  x0: number, y0: number,
  rx: number, ry: number,
  xAxisRotation: number,
  largeArcFlag: number,
  sweepFlag: number,
  x: number, y: number,
  stepCount: number = 24
): Array<[number, number]> {
  // Simplified arc flattening - sample at fixed intervals
  // For proper arc handling, would need to convert to cubic bezier or use proper arc math
  // This is a basic approximation
  const points: Array<[number, number]> = [];
  points.push([x0, y0]);
  
  // Simple linear interpolation as fallback (not accurate but deterministic)
  for (let i = 1; i <= stepCount; i++) {
    const t = i / stepCount;
    points.push([
      roundCoord(x0 + (x - x0) * t),
      roundCoord(y0 + (y - y0) * t)
    ]);
  }
  
  return points;
}

/**
 * Convert SVG path to polygon coordinates.
 * Returns rings or null with diagnostic on failure (parse_path / to_rings).
 */
function svgPathToRings(svgPath: string): SvgPathResult {
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
    let rawPointCount = 0;

    for (const cmd of commands) {
      const code = cmd.code.toUpperCase();

      switch (code) {
        case 'M': {
          if (hasMove && currentRing.length > 0) {
            if (currentRing.length > 0 &&
                (currentRing[currentRing.length - 1][0] !== startX ||
                 currentRing[currentRing.length - 1][1] !== startY)) {
              currentRing.push([roundCoord(startX), roundCoord(startY)]);
              rawPointCount++;
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
          rawPointCount++;
          break;
        }
        case 'L': {
          currentX = cmd.x ?? currentX;
          currentY = cmd.y ?? currentY;
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          rawPointCount++;
          break;
        }
        case 'H': {
          currentX = cmd.x ?? currentX;
          if ('y0' in cmd && cmd.y0 != null) {
            currentY = cmd.y0;
          }
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          rawPointCount++;
          break;
        }
        case 'V': {
          currentY = cmd.y ?? currentY;
          if ('x0' in cmd && cmd.x0 != null) {
            currentX = cmd.x0;
          }
          currentRing.push([roundCoord(currentX), roundCoord(currentY)]);
          rawPointCount++;
          break;
        }
        case 'C': {
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
            rawPointCount++;
          }
          currentX = x3;
          currentY = y3;
          break;
        }
        case 'S': {
          const x0 = currentX;
          const y0 = currentY;
          const x2 = cmd.x2 ?? x0;
          const y2 = cmd.y2 ?? y0;
          const x3 = cmd.x ?? x0;
          const y3 = cmd.y ?? y0;
          const x1 = x0;
          const y1 = y0;

          const curvePoints = flattenCubicBezier(x0, y0, x1, y1, x2, y2, x3, y3, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
            rawPointCount++;
          }
          currentX = x3;
          currentY = y3;
          break;
        }
        case 'Q': {
          const x0 = currentX;
          const y0 = currentY;
          const x1 = cmd.x1 ?? x0;
          const y1 = cmd.y1 ?? y0;
          const x2 = cmd.x ?? x0;
          const y2 = cmd.y ?? y0;

          const curvePoints = flattenQuadraticBezier(x0, y0, x1, y1, x2, y2, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
            rawPointCount++;
          }
          currentX = x2;
          currentY = y2;
          break;
        }
        case 'T': {
          const x0 = currentX;
          const y0 = currentY;
          const x2 = cmd.x ?? x0;
          const y2 = cmd.y ?? y0;
          const x1 = x0;
          const y1 = y0;

          const curvePoints = flattenQuadraticBezier(x0, y0, x1, y1, x2, y2, CURVE_TOLERANCE);
          for (let i = 1; i < curvePoints.length; i++) {
            currentRing.push([roundCoord(curvePoints[i][0]), roundCoord(curvePoints[i][1])]);
            rawPointCount++;
          }
          currentX = x2;
          currentY = y2;
          break;
        }
        case 'A': {
          const x0 = currentX;
          const y0 = currentY;
          const rx = cmd.rx ?? 0;
          const ry = cmd.ry ?? 0;
          const xAxisRotation = cmd.xAxisRotation ?? 0;
          const largeArcFlag = cmd.largeArcFlag ?? 0;
          const sweepFlag = cmd.sweepFlag ?? 0;
          const x = cmd.x ?? x0;
          const y = cmd.y ?? y0;

          const arcPoints = flattenArc(x0, y0, rx, ry, xAxisRotation, largeArcFlag, sweepFlag, x, y, 24);
          for (let i = 1; i < arcPoints.length; i++) {
            currentRing.push(arcPoints[i]);
            rawPointCount++;
          }
          currentX = x;
          currentY = y;
          break;
        }
        case 'Z': {
          if (currentRing.length > 0 &&
              (currentRing[currentRing.length - 1][0] !== startX ||
               currentRing[currentRing.length - 1][1] !== startY)) {
            currentRing.push([roundCoord(startX), roundCoord(startY)]);
            rawPointCount++;
          }
          currentX = startX;
          currentY = startY;
          break;
        }
      }
    }

    if (hasMove && currentRing.length > 0) {
      if (currentRing.length > 0 &&
          (currentRing[currentRing.length - 1][0] !== startX ||
           currentRing[currentRing.length - 1][1] !== startY)) {
        currentRing.push([roundCoord(startX), roundCoord(startY)]);
        rawPointCount++;
      }
      if (currentRing.length >= 3) {
        rings.push(currentRing);
      }
    }

    if (rings.length === 0) {
      return {
        rings: null,
        diagnostic: {
          failure_stage: 'to_rings',
          detail: 'parser ok but 0 rings or all rings < 3 points',
          raw_point_count: rawPointCount > 0 ? rawPointCount : undefined,
          ring_count_detected: 0
        }
      };
    }
    return { rings };
  } catch (err) {
    return {
      rings: null,
      diagnostic: {
        failure_stage: 'parse_path',
        detail: truncateDetail(err instanceof Error ? err.message : String(err)),
        ring_count_detected: 0
      }
    };
  }
}

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Classify an admin unit by explicit name prefixes from drzava.js.
 * Uses only explicit flags; no inference. Unknown → "other".
 */
function classifyAdminUnit(obj: { name: string }): AdminLayer {
  const n = obj.name.trim();
  if (n.startsWith('Kanton:')) return 'canton';
  if (n.startsWith('Entitet:')) return 'entity';
  if (n.startsWith('Regija:') || n.startsWith('Distrikt:') || n.startsWith('Država:')) return 'other';
  return 'municipality';
}

/**
 * Extract munID -> name map from drzava.js comment lines: //	10014	Banovići
 */
function extractNamesFromComments(content: string): Map<number, string> {
  const map = new Map<number, string>();
  const re = /\/\/\s*(\d+)\s+([^\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const id = parseInt(m[1], 10);
    const name = m[2].trim();
    if (!map.has(id)) map.set(id, name);
  }
  return map;
}

/**
 * Extract munID and path_d pairs from drzava.js
 */
function extractMunicipalityPairs(content: string): MunicipalityExtract[] {
  const pairs: MunicipalityExtract[] = [];
  
  // Pattern: .data("munID", <digits>) ... R.path("<svg path string>")
  // Also support single quotes: .data('munID', <digits>)
  // The path may come before or after the data call, but typically after
  // Pattern: R.path("...") ... .data("munID", 12345) or .data("munID", 12345) ... R.path("...")
  
  // More flexible pattern: find munID data call, then find nearest R.path call
  const munIDPattern = /\.data\(["']munID["'],\s*(\d+)\)/g;
  const pathPattern = /R\.path\(["']([^"']+)["']\)/g;
  
  // First, collect all munID positions and path positions
  const munIDMatches: Array<{ id: number; index: number }> = [];
  const pathMatches: Array<{ path: string; index: number }> = [];
  
  let match;
  while ((match = munIDPattern.exec(content)) !== null) {
    munIDMatches.push({ id: parseInt(match[1], 10), index: match.index });
  }
  
  while ((match = pathPattern.exec(content)) !== null) {
    pathMatches.push({ path: match[1], index: match.index });
  }
  
  // Match each munID with the nearest path (before or after, but prefer after)
  for (const munIDMatch of munIDMatches) {
    // Find the closest path, preferring paths after the munID
    let bestPath: { path: string; index: number } | null = null;
    let bestDistance = Infinity;
    
    for (const pathMatch of pathMatches) {
      const distance = Math.abs(pathMatch.index - munIDMatch.index);
      // Prefer paths after munID, but accept before if much closer
      if (pathMatch.index > munIDMatch.index || distance < bestDistance * 0.5) {
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPath = pathMatch;
        }
      }
    }
    
    if (bestPath) {
      pairs.push({
        munID: munIDMatch.id,
        path_d: bestPath.path
      });
    }
  }
  
  return pairs;
}

const SAMPLE_NON_MUNICIPALITY_MAX = 20;

/**
 * Classify each raw extraction, build breakdown and sample, filter to municipality only.
 * Stable iteration: source encounter order.
 */
function processRawAndFilter(
  pairs: MunicipalityExtract[],
  nameMap: Map<number, string>
): {
  municipalityExtracts: MunicipalityExtract[];
  breakdown: AdminLayerBreakdown;
  sample: SampleNonMunicipality[];
} {
  const breakdown: AdminLayerBreakdown = { municipality: 0, canton: 0, entity: 0, other: 0 };
  const sample: SampleNonMunicipality[] = [];
  const municipalityExtracts: MunicipalityExtract[] = [];

  for (const p of pairs) {
    const name = nameMap.get(p.munID) ?? '(unknown)';
    const layer = classifyAdminUnit({ name });
    let reason = '';
    if (layer === 'canton') reason = 'name_starts_with_Kanton:';
    else if (layer === 'entity') reason = 'name_starts_with_Entitet:';
    else if (layer === 'other') {
      if (name.startsWith('Regija:')) reason = 'name_starts_with_Regija:';
      else if (name.startsWith('Distrikt:')) reason = 'name_starts_with_Distrikt:';
      else if (name.startsWith('Država:')) reason = 'name_starts_with_Država:';
      else reason = 'other';
    }

    breakdown[layer] += 1;

    if (layer !== 'municipality') {
      if (sample.length < SAMPLE_NON_MUNICIPALITY_MAX) {
        sample.push({
          inferred_layer: layer,
          id: String(p.munID),
          name,
          reason
        });
      }
    } else {
      municipalityExtracts.push({ munID: p.munID, path_d: p.path_d });
    }
  }

  return { municipalityExtracts, breakdown, sample };
}

function padMunId5(n: number): string {
  return String(n).padStart(5, '0');
}

function basicStatsFromRingsAndFeature(
  rings: number[][][],
  feature: turf.Feature<turf.Polygon | turf.MultiPolygon>
): GeometryFailureDiagnostic['basic_stats'] {
  let rawPointCount = 0;
  let hasNan = false;
  for (const ring of rings) {
    for (const c of ring) {
      rawPointCount++;
      if (c.length >= 2 && (Number.isNaN(c[0]) || Number.isNaN(c[1]))) hasNan = true;
    }
  }
  const bbox = turf.bbox(feature);
  const ringCount = rings.length;
  const finite =
    isFinite(bbox[0]) && isFinite(bbox[1]) && isFinite(bbox[2]) && isFinite(bbox[3]);
  return {
    raw_point_count: rawPointCount,
    ring_count_detected: ringCount,
    has_nan: hasNan,
    bbox: finite
      ? ([roundCoord(bbox[0]), roundCoord(bbox[1]), roundCoord(bbox[2]), roundCoord(bbox[3])] as [number, number, number, number])
      : null
  };
}

/**
 * Convert extracted pairs to GeoJSON features (municipality-only).
 * Collects geometry-failure diagnostics (no repair, no inference).
 */
function convertToFeatures(
  extracts: MunicipalityExtract[],
  nameMap: Map<number, string>,
  reportExtras: {
    breakdown: AdminLayerBreakdown;
    sample: SampleNonMunicipality[];
    totalRawMunIDs: number;
  }
): {
  features: turf.Feature<turf.Polygon | turf.MultiPolygon>[];
  report: ExtractionReport;
  diagnostics: GeometryFailureDiagnostic[];
} {
  const features: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
  const droppedReasons: Record<string, number> = {};
  const seenMunIDs = new Set<number>();
  let duplicateCount = 0;
  const failed_entities: FailedEntity[] = [];
  const diagnostics: GeometryFailureDiagnostic[] = [];

  function fail(munid_5: number, reason: string): void {
    const name = nameMap.get(munid_5) ?? '(unknown)';
    failed_entities.push({ munid_5, name, reason, layer: 'municipality' });
  }

  function addDiagnostic(d: GeometryFailureDiagnostic): void {
    diagnostics.push(d);
  }

  for (const extract of extracts) {
    const name = nameMap.get(extract.munID) ?? '(unknown)';
    const munid_5_str = padMunId5(extract.munID);

    if (seenMunIDs.has(extract.munID)) {
      duplicateCount++;
      fail(extract.munID, 'duplicate_munid_5');
      addDiagnostic({
        munid_5: munid_5_str,
        name,
        raw_geometry_kind: 'unknown',
        failure_stage: 'duplicate',
        failure_reason: 'duplicate_munid_5',
        detail: 'duplicate munID in source',
        basic_stats: {}
      });
      continue;
    }
    seenMunIDs.add(extract.munID);

    const pathResult = svgPathToRings(extract.path_d);
    if (!pathResult.rings || pathResult.rings.length === 0) {
      droppedReasons['no_rings'] = (droppedReasons['no_rings'] || 0) + 1;
      fail(extract.munID, 'no_rings');
      const d = pathResult.diagnostic!;
      addDiagnostic({
        munid_5: munid_5_str,
        name,
        raw_geometry_kind: 'svg_path',
        failure_stage: d.failure_stage,
        failure_reason: 'no_rings',
        detail: truncateDetail(d.detail),
        basic_stats: {
          raw_point_count: d.raw_point_count ?? null,
          ring_count_detected: d.ring_count_detected,
          has_nan: null,
          bbox: null
        }
      });
      continue;
    }

    const rings = pathResult.rings;
    let geometry: turf.Polygon | turf.MultiPolygon;
    if (rings.length === 1) {
      geometry = turf.polygon(rings).geometry;
    } else {
      geometry = turf.multiPolygon(rings).geometry;
    }

    const feature = turf.feature(geometry, {
      munid_5: munid_5_str,
      mid: extract.munID,
      name: nameMap.get(extract.munID) ?? null,
      source: 'drzava.js',
      kind: 'municipality_border'
    });

    const bbox = turf.bbox(feature);
    if (!isFinite(bbox[0]) || !isFinite(bbox[1]) || !isFinite(bbox[2]) || !isFinite(bbox[3])) {
      droppedReasons['non_finite'] = (droppedReasons['non_finite'] || 0) + 1;
      fail(extract.munID, 'non_finite');
      addDiagnostic({
        munid_5: munid_5_str,
        name,
        raw_geometry_kind: 'svg_path',
        failure_stage: 'polygon_validate',
        failure_reason: 'non_finite',
        detail: truncateDetail(`bbox contains non-finite value(s)`),
        basic_stats: basicStatsFromRingsAndFeature(rings, feature)
      });
      continue;
    }

    const area = turf.area(feature);
    if (area < MIN_AREA) {
      droppedReasons['zero_area'] = (droppedReasons['zero_area'] || 0) + 1;
      fail(extract.munID, 'zero_area');
      addDiagnostic({
        munid_5: munid_5_str,
        name,
        raw_geometry_kind: 'svg_path',
        failure_stage: 'polygon_validate',
        failure_reason: 'zero_area',
        detail: truncateDetail(`area below minimum threshold (${area})`),
        basic_stats: basicStatsFromRingsAndFeature(rings, feature)
      });
      continue;
    }

    features.push(feature);
  }

  // Sort by munid_5 ascending (stable order)
  features.sort((a, b) => {
    const a5 = (a.properties?.munid_5 as string) ?? '';
    const b5 = (b.properties?.munid_5 as string) ?? '';
    return a5.localeCompare(b5);
  });

  // Add feature_index (array order as emitted)
  for (let i = 0; i < features.length; i++) {
    (features[i].properties as Record<string, unknown>).feature_index = i;
  }

  let bounds: ExtractionReport['bounds'] = null;
  if (features.length > 0) {
    const allBbox = turf.bbox(turf.featureCollection(features));
    bounds = {
      minx: roundCoord(allBbox[0]),
      miny: roundCoord(allBbox[1]),
      maxx: roundCoord(allBbox[2]),
      maxy: roundCoord(allBbox[3])
    };
  }

  // Sort failed_entities and diagnostics by munid_5 for determinism
  failed_entities.sort((a, b) => a.munid_5 - b.munid_5);
  diagnostics.sort((a, b) => a.munid_5.localeCompare(b.munid_5));

  const municipality_failures_by_reason: Record<string, number> = {};
  for (const e of failed_entities) {
    municipality_failures_by_reason[e.reason] = (municipality_failures_by_reason[e.reason] ?? 0) + 1;
  }
  const municipality_failed_ids = [...new Set(failed_entities.map((e) => padMunId5(e.munid_5)))].sort((a, b) => a.localeCompare(b));

  const report: ExtractionReport = {
    total_found_munIDs: reportExtras.totalRawMunIDs,
    total_converted: features.length,
    dropped_count: extracts.length - features.length - duplicateCount,
    dropped_reasons: droppedReasons,
    duplicate_munID_count: duplicateCount,
    failed_entities,
    admin_layer_breakdown: reportExtras.breakdown,
    sample_non_municipality: reportExtras.sample,
    bounds,
    municipality_failures: failed_entities.length,
    municipality_failures_by_reason,
    municipality_failed_ids
  };

  return { features, report, diagnostics };
}

/**
 * Escape CSV field (quote if contains comma, quote, or newline)
 */
function escapeCsvField(s: string): string {
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Generate deterministic static HTML viewer (no timestamps, stable order).
 * Loads GeoJSON and report via relative paths.
 */
function generateViewerHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Borders (drzava.js) – Visual Check</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; height: 100vh; overflow: hidden; background: #1a1a1a; }
    #canvas-wrap { flex: 1; position: relative; cursor: grab; }
    #canvas-wrap.dragging { cursor: grabbing; }
    canvas { display: block; width: 100%; height: 100%; }
    #legend {
      position: absolute; top: 10px; left: 10px;
      background: rgba(0,0,0,0.8); color: #e0e0e0; padding: 10px 14px; border-radius: 6px;
      font-size: 12px; z-index: 100;
    }
    #legend dt { font-weight: 600; margin-top: 6px; }
    #legend dt:first-child { margin-top: 0; }
    #legend dd { margin-left: 12px; color: #aaa; }
    #tooltip {
      position: absolute; background: rgba(0,0,0,0.9); color: #fff; padding: 8px 12px;
      border-radius: 4px; font-size: 12px; pointer-events: none; z-index: 1000; display: none;
    }
    #tooltip.visible { display: block; }
    #sidebar {
      width: 320px; background: #2d2d2d; color: #e0e0e0; display: flex; flex-direction: column;
      border-left: 1px solid #444; overflow-y: auto;
    }
    #sidebar h2 { font-size: 14px; padding: 12px 16px; border-bottom: 1px solid #444; }
    #search { width: 100%; padding: 8px 12px; margin: 12px 16px; margin-top: 0; background: #3d3d3d; border: 1px solid #555; border-radius: 4px; color: #e0e0e0; font-size: 13px; }
    #inspector { padding: 16px; font-size: 12px; }
    #inspector pre { background: #1e1e1e; padding: 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
    #failures-panel { border-top: 1px solid #444; }
    #failures-toggle { width: 100%; padding: 10px 16px; background: #252525; border: none; color: #e0e0e0; text-align: left; font-size: 13px; cursor: pointer; }
    #failures-toggle:hover { background: #333; }
    #failures-list { padding: 12px 16px; max-height: 220px; overflow-y: auto; font-size: 12px; }
    #failures-list ul { list-style: none; }
    #failures-list li { padding: 4px 0; border-bottom: 1px solid #333; }
    #failures-list li:last-child { border-bottom: none; }
    .fail-munid { font-weight: 600; }
    .fail-name { color: #aaa; }
    .fail-reason { color: #888; font-size: 11px; }
    #fit-btn { position: absolute; top: 10px; right: 10px; padding: 6px 12px; background: #3d3d3d; border: 1px solid #555; border-radius: 4px; color: #e0e0e0; cursor: pointer; font-size: 12px; z-index: 100; }
  </style>
</head>
<body>
  <div id="canvas-wrap">
    <canvas id="c"></canvas>
    <div id="tooltip"></div>
    <div id="legend">
      <dl>
        <dt>Features</dt><dd id="legend-features">—</dd>
        <dt>Failures</dt><dd id="legend-failures">—</dd>
        <dt>Admin layers</dt><dd id="legend-breakdown">—</dd>
      </dl>
    </div>
    <button id="fit-btn">Fit</button>
  </div>
  <div id="sidebar">
    <h2>Municipality borders (drzava.js)</h2>
    <input type="text" id="search" placeholder="Search munid_5 or name…" />
    <div id="inspector"><p>Click a municipality or search to inspect.</p></div>
    <div id="failures-panel">
      <button id="failures-toggle">Failed entities (report)</button>
      <div id="failures-list" style="display:none;"></div>
    </div>
  </div>
  <script>
(function () {
  const GEOJSON_PATH = "./municipality_borders_from_drzava.geojson";
  const REPORT_PATH = "./municipality_borders_extraction_report.json";

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const wrap = document.getElementById("canvas-wrap");
  const tooltip = document.getElementById("tooltip");
  const legendFeatures = document.getElementById("legend-features");
  const legendFailures = document.getElementById("legend-failures");
  const legendBreakdown = document.getElementById("legend-breakdown");
  const inspector = document.getElementById("inspector");
  const searchInput = document.getElementById("search");
  const failuresToggle = document.getElementById("failures-toggle");
  const failuresList = document.getElementById("failures-list");
  const fitBtn = document.getElementById("fit-btn");

  let geojson = null;
  let report = null;
  let scale = 1, offX = 0, offY = 0;
  let bounds = [0, 0, 1, 1];
  let dragging = false, dragStartX = 0, dragStartY = 0;
  let selectedIdx = -1;
  let searchQuery = "";

  function tx(x) { return x * scale + offX; }
  function ty(y) { return y * scale + offY; }
  function invX(px) { return (px - offX) / scale; }
  function invY(py) { return (py - offY) / scale; }

  function computeBounds(fc) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const f of fc.features) {
      const g = f.geometry;
      const rings = g.type === "Polygon" ? g.coordinates : g.coordinates.flat(1);
      for (const ring of rings) {
        for (const c of ring) {
          const x = c[0], y = c[1];
          if (x < minx) minx = x; if (y < miny) miny = y;
          if (x > maxx) maxx = x; if (y > maxy) maxy = y;
        }
      }
    }
    return [minx, miny, maxx, maxy];
  }

  function fitToView() {
    const pad = 24;
    const w = canvas.width, h = canvas.height;
    const bw = bounds[2] - bounds[0], bh = bounds[3] - bounds[1];
    const sx = (w - pad * 2) / bw, sy = (h - pad * 2) / bh;
    scale = Math.min(sx, sy);
    offX = (w - bw * scale) / 2 - bounds[0] * scale;
    offY = (h - bh * scale) / 2 - bounds[1] * scale;
    render();
  }

  function ringsFor(f) {
    const g = f.geometry;
    if (g.type === "Polygon") return g.coordinates;
    const out = [];
    for (const poly of g.coordinates) { for (const r of poly) out.push(r); }
    return out;
  }

  function matchesSearch(f, q) {
    if (!q) return false;
    const qu = q.toLowerCase();
    const mid = String(f.properties?.munid_5 ?? f.properties?.mid ?? "");
    const name = String(f.properties?.name ?? "").toLowerCase();
    return mid.includes(qu) || name.includes(qu);
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!geojson) return;
    const features = geojson.features;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const highlight = selectedIdx === i || matchesSearch(f, searchQuery);
      const lw = highlight ? 3 : 1;
      ctx.strokeStyle = highlight ? "#6af" : "#666";
      ctx.lineWidth = lw;
      for (const ring of ringsFor(f)) {
        if (ring.length < 2) continue;
        ctx.beginPath();
        ctx.moveTo(tx(ring[0][0]), ty(ring[0][1]));
        for (let j = 1; j < ring.length; j++) ctx.lineTo(tx(ring[j][0]), ty(ring[j][1]));
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  function hitTest(wx, wy) {
    if (!geojson) return -1;
    for (let i = 0; i < geojson.features.length; i++) {
      const f = geojson.features[i];
      const rings = ringsFor(f);
      if (rings.length && pointInRing(wx, wy, rings[0])) return i;
    }
    return -1;
  }

  function showTooltip(text, clientX, clientY) {
    tooltip.textContent = text;
    tooltip.classList.add("visible");
    tooltip.style.left = clientX + "px";
    tooltip.style.top = (clientY + 16) + "px";
  }

  function hideTooltip() { tooltip.classList.remove("visible"); }

  function updateInspector(idx) {
    if (idx < 0 || !geojson) {
      inspector.innerHTML = "<p>Click a municipality or search to inspect.</p>";
      return;
    }
    const f = geojson.features[idx];
    const m = f.properties?.munid_5 ?? f.properties?.mid ?? "(unknown)";
    const n = f.properties?.name ?? "(unknown)";
    inspector.innerHTML = "<pre>munid_5: " + m + "\\nname: " + n + "</pre>";
  }

  function resize() {
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    fitToView();
  }

  wrap.addEventListener("mousedown", function (e) {
    dragging = true;
    dragStartX = e.clientX - offX;
    dragStartY = e.clientY - offY;
    wrap.classList.add("dragging");
  });
  wrap.addEventListener("mousemove", function (e) {
    const rect = canvas.getBoundingClientRect();
    const wx = invX(e.clientX - rect.left), wy = invY(e.clientY - rect.top);
    if (dragging) {
      offX = e.clientX - dragStartX;
      offY = e.clientY - dragStartY;
      render();
    } else {
      const idx = hitTest(wx, wy);
      if (idx >= 0) {
        const f = geojson.features[idx];
        const m = f.properties?.munid_5 ?? f.properties?.mid ?? "(unknown)";
        const n = f.properties?.name ?? "(unknown)";
        showTooltip("munid_5: " + m + " \u2013 " + n, e.clientX, e.clientY);
      } else hideTooltip();
    }
  });
  wrap.addEventListener("mouseup", function () {
    dragging = false;
    wrap.classList.remove("dragging");
  });
  wrap.addEventListener("mouseleave", function () {
    dragging = false;
    wrap.classList.remove("dragging");
    hideTooltip();
  });
  wrap.addEventListener("click", function (e) {
    if (dragging) return;
    const rect = canvas.getBoundingClientRect();
    const wx = invX(e.clientX - rect.left), wy = invY(e.clientY - rect.top);
    const idx = hitTest(wx, wy);
    selectedIdx = idx;
    updateInspector(idx);
    render();
  });
  canvas.addEventListener("wheel", function (e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const nscale = scale * factor;
    if (nscale < 0.01 || nscale > 100) return;
    const wx = invX(mx), wy = invY(my);
    scale = nscale;
    offX = mx - wx * scale;
    offY = my - wy * scale;
    render();
  }, { passive: false });

  searchInput.addEventListener("input", function () {
    searchQuery = searchInput.value.trim();
    render();
  });
  searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      const q = searchQuery;
      if (!geojson || !q) return;
      const features = geojson.features;
      for (let i = 0; i < features.length; i++) {
        if (matchesSearch(features[i], q)) { selectedIdx = i; updateInspector(i); render(); break; }
      }
    }
  });

  failuresToggle.addEventListener("click", function () {
    const list = failuresList;
    const isHidden = list.style.display === "none";
    list.style.display = isHidden ? "block" : "none";
  });

  fitBtn.addEventListener("click", fitToView);
  window.addEventListener("resize", resize);
  resize();

  Promise.all([
    fetch(GEOJSON_PATH).then(function (r) { return r.json(); }),
    fetch(REPORT_PATH).then(function (r) { return r.json(); })
  ]).then(function (out) {
    geojson = out[0];
    report = out[1];
    bounds = computeBounds(geojson);
    legendFeatures.textContent = String(geojson.features.length);
    const failCount = (report && Array.isArray(report.failed_entities)) ? report.failed_entities.length : 0;
    legendFailures.textContent = String(failCount);
    var b = report && report.admin_layer_breakdown;
    if (b) {
      legendBreakdown.textContent = "muni " + b.municipality + " \u00b7 canton " + b.canton + " \u00b7 entity " + b.entity + " \u00b7 other " + b.other;
    } else {
      legendBreakdown.textContent = "\u2014";
    }
    if (report && Array.isArray(report.failed_entities)) {
      function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;"); }
      const ul = document.createElement("ul");
      for (const e of report.failed_entities) {
        const li = document.createElement("li");
        li.innerHTML = "<span class=\\"fail-munid\\">" + esc(e.munid_5) + "</span> <span class=\\"fail-name\\">" + esc(e.name || "(unknown)") + "</span><br><span class=\\"fail-reason\\">" + esc(e.reason || "") + "</span>";
        ul.appendChild(li);
      }
      failuresList.appendChild(ul);
    }
    resize();
  }).catch(function (err) {
    legendFeatures.textContent = "load error";
    legendFailures.textContent = "\u2014";
    if (legendBreakdown) legendBreakdown.textContent = "\u2014";
    inspector.innerHTML = "<p>Could not load GeoJSON or report. Open from data/derived/ or use a local server.</p>";
    console.error(err);
  });
})();
  </script>
</body>
</html>`;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Extracting municipality borders from drzava.js...\n');

  const content = await readFile(INPUT_PATH, 'utf8');
  const nameMap = extractNamesFromComments(content);

  console.log('Extracting munID and path pairs...');
  const pairs = extractMunicipalityPairs(content);
  console.log(`Found ${pairs.length} raw munID+path pairs`);

  const { municipalityExtracts, breakdown, sample } = processRawAndFilter(pairs, nameMap);
  console.log(`Admin layer breakdown: municipality=${breakdown.municipality} canton=${breakdown.canton} entity=${breakdown.entity} other=${breakdown.other}`);
  console.log(`Filtering to municipality-only: ${municipalityExtracts.length} items\n`);

  console.log('Converting SVG paths to GeoJSON (municipalities only)...');
  const reportExtras = {
    breakdown,
    sample,
    totalRawMunIDs: pairs.length
  };
  const { features, report, diagnostics } = convertToFeatures(municipalityExtracts, nameMap, reportExtras);

  if (features.length < MIN_FEATURE_COUNT) {
    console.warn(`WARNING: Only ${features.length} features converted (expected >= ${MIN_FEATURE_COUNT})`);
  }
  if (features.length !== EXPECTED_FEATURE_COUNT) {
    console.warn(`WARNING: Feature count is ${features.length} (expected ${EXPECTED_FEATURE_COUNT})`);
  }

  const fc: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
    type: 'FeatureCollection',
    features
  };

  const geojsonStr = JSON.stringify(fc, null, 2);
  await writeFile(OUTPUT_PATH, geojsonStr, 'utf8');
  console.log(`\n✓ Wrote ${features.length} features to ${OUTPUT_PATH}`);
  await writeFile(LEGACY_BORDERS_PATH, geojsonStr, 'utf8');
  console.log(`✓ Wrote legacy ${LEGACY_BORDERS_PATH} (same content)`);

  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`✓ Wrote report to ${REPORT_PATH}`);

  const csvLines = ['munid_5,name,reason,layer'];
  for (const e of report.failed_entities) {
    csvLines.push(
      [e.munid_5, escapeCsvField(e.name), escapeCsvField(e.reason), escapeCsvField(e.layer)].join(',')
    );
  }
  await writeFile(FAILURES_CSV_PATH, csvLines.join('\n') + '\n', 'utf8');
  console.log(`✓ Wrote failures CSV to ${FAILURES_CSV_PATH}`);

  await mkdir(AUDIT_DIR, { recursive: true });
  await writeFile(DIAGNOSTIC_JSON_PATH, JSON.stringify(diagnostics, null, 2), 'utf8');
  console.log(`✓ Wrote geometry failure diagnostic to ${DIAGNOSTIC_JSON_PATH}`);

  const diagCsvHeader = 'munid_5,name,raw_geometry_kind,failure_stage,failure_reason,detail,raw_point_count,ring_count_detected,has_nan,bbox';
  const diagCsvRows = diagnostics.map((d) => {
    const rpc = d.basic_stats.raw_point_count;
    const rcd = d.basic_stats.ring_count_detected;
    const hn = d.basic_stats.has_nan;
    const bb = d.basic_stats.bbox;
    const rpcStr = rpc != null ? String(rpc) : '';
    const rcdStr = rcd != null ? String(rcd) : '';
    const hnStr = hn === true ? 'true' : hn === false ? 'false' : '';
    const bboxStr = bb ? bb.join(',') : '';
    return [
      escapeCsvField(d.munid_5),
      escapeCsvField(d.name),
      escapeCsvField(d.raw_geometry_kind),
      escapeCsvField(d.failure_stage),
      escapeCsvField(d.failure_reason),
      escapeCsvField(d.detail),
      escapeCsvField(rpcStr),
      escapeCsvField(rcdStr),
      escapeCsvField(hnStr),
      escapeCsvField(bboxStr)
    ].join(',');
  });
  await writeFile(DIAGNOSTIC_CSV_PATH, [diagCsvHeader, ...diagCsvRows].join('\n') + '\n', 'utf8');
  console.log(`✓ Wrote geometry failure diagnostic CSV to ${DIAGNOSTIC_CSV_PATH}`);

  const viewerHtml = generateViewerHTML();
  await writeFile(VIEWER_HTML_PATH, viewerHtml, 'utf8');
  console.log(`✓ Wrote viewer to ${VIEWER_HTML_PATH}`);

  console.log('\nExtraction Summary:');
  console.log(`  Total found: ${report.total_found_munIDs}`);
  console.log(`  Converted: ${report.total_converted}`);
  console.log(`  Dropped: ${report.dropped_count}`);
  console.log(`  Duplicates: ${report.duplicate_munID_count}`);
  console.log(`  Failed entities: ${report.failed_entities.length}`);
  if (Object.keys(report.dropped_reasons).length > 0) {
    console.log('\n  Drop reasons:');
    for (const [reason, count] of Object.entries(report.dropped_reasons)) {
      console.log(`    ${reason}: ${count}`);
    }
  }
  if (report.bounds) {
    console.log(`\n  Bounds: [${report.bounds.minx}, ${report.bounds.miny}, ${report.bounds.maxx}, ${report.bounds.maxy}]`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
