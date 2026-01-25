/**
 * MapKit regeneration: Rebuild settlements_polygons.geojson from source packs.
 * 
 * Deterministic pipeline that:
 * 1) Parses municipality JS files from ZIP
 * 2) Extracts SVG paths and settlement IDs
 * 3) Converts SVG paths to GeoJSON polygons (flattening Beziers)
 * 4) Joins attributes from master XLSX
 * 5) Outputs stable, reproducible GeoJSON
 * 
 * Usage:
 *   tsx scripts/map/regenerate_settlements_geojson.ts [--zip <path>] [--xlsx <path>] [--out <path>]
 * 
 * Defaults:
 *   zip: data/source/settlements_pack.zip
 *   xlsx: data/source/master_settlements.xlsx
 *   out: data/derived/settlements_polygons.regen.geojson
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import AdmZip from 'adm-zip';
import * as XLSX from 'xlsx';
import parseSVG from 'svg-path-parser';

// Types
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[]; // First ring is outer, rest are holes
type MultiPolygon = Polygon[];

interface SettlementPathRecord {
  munCode: string;
  settlementId: string;
  pathString: string;
  sourceJsFile: string;
}

interface XLSXRow {
  settlementId: string;
  settlementName?: string;
  [key: string]: unknown;
}

interface XLSXData {
  [munCode: string]: Map<string, XLSXRow>; // munCode -> settlementId -> row
}

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    mun_code: string;
    settlement_id: string;
    name?: string;
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface RegenSummary {
  total_features: number;
  per_municipality_counts: Record<string, number>;
  missing_xlsx_joins: {
    count: number;
    sample_sids: string[];
  };
  geometry_type_counts: {
    Polygon: number;
    MultiPolygon: number;
  };
  global_bounds: Bounds;
  cluster_diagnostic: {
    cluster_a_size: number;
    cluster_b_size: number;
    cluster_a_bounds: Bounds;
    cluster_b_bounds: Bounds;
    stray_cluster: 'A' | 'B' | null;
  };
  deduplication: {
    exact_duplicates_dropped: number;
    conflicts_resolved: number;
    top_conflicts: Array<{
      sid: string;
      kept_source: string;
      dropped_source: string;
      kept_score: number;
      dropped_score: number;
    }>;
  };
  municipality_summary_excluded: {
    total_skipped: number;
    skipped_by_file: Record<string, number>;
    sample_examples: Array<{
      filename: string;
      mun_code: string;
      mun_id: string;
    }>;
  };
  xlsx_allowlist_filtering: {
    total_skipped_not_in_allowlist: number;
    skipped_by_file: Record<string, number>;
    top_examples: Array<{
      filename: string;
      mun_code: string;
      mun_id: string;
    }>;
    missing_xlsx_sheet_count: number;
    missing_xlsx_sheet_mun_codes: string[];
    summary_ids_excluded_count: number;
  };
}

// Constants
const BEZIER_SUBDIVISIONS = 12; // Fixed N segments per cubic curve
const HOLE_AREA_THRESHOLD = 0.5; // Ring is hole if area < 0.5 * containing ring area
const GEOM_SIG_PRECISION = 3; // Decimal places for geometry signature quantization

// CLI args parsing
function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') args.zip = argv[++i] ?? '';
    else if (a === '--xlsx') args.xlsx = argv[++i] ?? '';
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a === '--help' || a === '-h') args.help = '1';
  }
  return {
    zip: args.zip || resolve('data/source/settlements_pack.zip'),
    xlsx: args.xlsx || resolve('data/source/master_settlements.xlsx'),
    out: args.out || resolve('data/derived/settlements_polygons.regen.geojson'),
    help: Boolean(args.help)
  };
}

// ============================================================================
// Deduplication helpers: Geometry signature and conflict resolution
// ============================================================================

/**
 * FNV-1a hash function (32-bit)
 */
function fnv1a32(str: string): number {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash = hash >>> 0; // Convert to unsigned 32-bit
  }
  return hash;
}

/**
 * Quantize a number to fixed precision for signature computation
 */
function quantize(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

/**
 * Compute deterministic geometry signature
 */
function computeGeometrySignature(feature: GeoJSONFeature): string {
  const geom = feature.geometry;
  const parts: string[] = [];
  
  // Type
  parts.push(geom.type);
  
  let totalRings = 0;
  let totalPoints = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pointHashes: number[] = [];
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    totalRings++;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      
      totalPoints++;
      const qx = quantize(x, GEOM_SIG_PRECISION);
      const qy = quantize(y, GEOM_SIG_PRECISION);
      
      minX = Math.min(minX, qx);
      minY = Math.min(minY, qy);
      maxX = Math.max(maxX, qx);
      maxY = Math.max(maxY, qy);
      
      // Hash quantized point
      const pointStr = `${qx},${qy}`;
      pointHashes.push(fnv1a32(pointStr));
    }
  };
  
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    if (Array.isArray(coords)) {
      for (const ring of coords) {
        processRing(ring);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    if (Array.isArray(coords)) {
      for (const polygon of coords) {
        if (Array.isArray(polygon)) {
          for (const ring of polygon) {
            processRing(ring);
          }
        }
      }
    }
  }
  
  // Bounds (quantized)
  const qMinX = quantize(minX, GEOM_SIG_PRECISION);
  const qMinY = quantize(minY, GEOM_SIG_PRECISION);
  const qMaxX = quantize(maxX, GEOM_SIG_PRECISION);
  const qMaxY = quantize(maxY, GEOM_SIG_PRECISION);
  
  // Rolling hash over point hashes
  let rollingHash = 0;
  for (const h of pointHashes) {
    rollingHash = ((rollingHash << 1) | (rollingHash >>> 31)) ^ h;
    rollingHash = rollingHash >>> 0;
  }
  
  // Build signature string
  parts.push(`rings:${totalRings}`);
  parts.push(`points:${totalPoints}`);
  parts.push(`bounds:${qMinX},${qMinY},${qMaxX},${qMaxY}`);
  parts.push(`hash:${rollingHash.toString(16)}`);
  
  return parts.join('|');
}

/**
 * Compute bounds area
 */
function boundsArea(bounds: Bounds): number {
  return (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
}

/**
 * Compute feature centroid
 */
function computeFeatureCentroid(feature: GeoJSONFeature): { cx: number; cy: number } | null {
  return computeCentroid(feature);
}

/**
 * Compute feature bounds
 */
function computeFeatureBounds(feature: GeoJSONFeature): Bounds | null {
  const geom = feature.geometry;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let hasPoints = false;
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      hasPoints = true;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  };
  
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    if (Array.isArray(coords)) {
      for (const ring of coords) {
        processRing(ring);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    if (Array.isArray(coords)) {
      for (const polygon of coords) {
        if (Array.isArray(polygon)) {
          for (const ring of polygon) {
            processRing(ring);
          }
        }
      }
    }
  }
  
  if (!hasPoints) return null;
  return { minX, minY, maxX, maxY };
}

/**
 * Count total points in a feature
 */
function countFeaturePoints(feature: GeoJSONFeature): number {
  const geom = feature.geometry;
  let count = 0;
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (Array.isArray(point) && point.length >= 2) {
        const [x, y] = point;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          count++;
        }
      }
    }
  };
  
  if (geom.type === 'Polygon') {
    const coords = geom.coordinates as Polygon;
    if (Array.isArray(coords)) {
      for (const ring of coords) {
        processRing(ring);
      }
    }
  } else if (geom.type === 'MultiPolygon') {
    const coords = geom.coordinates as MultiPolygon;
    if (Array.isArray(coords)) {
      for (const polygon of coords) {
        if (Array.isArray(polygon)) {
          for (const ring of polygon) {
            processRing(ring);
          }
        }
      }
    }
  }
  
  return count;
}

// ============================================================================
// 1) ZIP parsing: Extract municipality JS files
// ============================================================================

/**
 * Normalize digit string by removing leading zeros for comparison
 * Returns normalized numeric form as string, or original if not all digits
 */
function normDigits(s: string): string {
  const trimmed = s.trim();
  // Check if all digits
  if (!/^\d+$/.test(trimmed)) return s;
  // Convert to number and back to string to normalize (removes leading zeros)
  const num = Number(trimmed);
  if (!Number.isFinite(num) || num < 0) return s;
  return String(num);
}

function parseMunicipalityFilename(filename: string): { name: string; munCode: string } | null {
  // Pattern: <Name>_<munCode>.js
  const match = filename.match(/^(.+?)_(\d+)\.js$/i);
  if (!match) return null;
  return { name: match[1], munCode: match[2] };
}

function extractPathRecords(
  jsContent: string, 
  filename: string,
  allowedSettlementIdsByMunCode: Map<string, Set<string>>
): { 
  records: SettlementPathRecord[]; 
  skippedNotInAllowlist: Array<{ filename: string; munCode: string; munID: string }>;
} {
  const records: SettlementPathRecord[] = [];
  const skippedNotInAllowlist: Array<{ filename: string; munCode: string; munID: string }> = [];
  const munMatch = parseMunicipalityFilename(filename);
  if (!munMatch) return { records, skippedNotInAllowlist };

  const munCodeNorm = normDigits(munMatch.munCode);
  const allowlist = allowedSettlementIdsByMunCode.get(munCodeNorm);

  // Pattern: R.path("...").data("munID", <settlementId>)
  // May span multiple lines, normalize whitespace
  const normalized = jsContent.replace(/\s+/g, ' ');
  
  // Match: R.path("...").data("munID", ...)
  // Capture path string and settlement ID (handles both quoted and unquoted munID)
  // Pattern: .data("munID", <number>) or .data("munID", "<number>")
  // The munID value can be: a number, or a quoted string containing a number
  const regex = /R\.path\("([^"]+)"\)\.data\("munID",\s*(?:"(\d+)"|(\d+))\)/g;
  let match;
  
  while ((match = regex.exec(normalized)) !== null) {
    const pathString = match[1];
    // match[2] is quoted munID, match[3] is unquoted munID
    const settlementId = match[2] || match[3];
    const munIdNorm = normDigits(settlementId);
    
    // Filter: only keep records whose munID is in the XLSX allowlist
    if (allowlist) {
      if (!allowlist.has(munIdNorm)) {
        skippedNotInAllowlist.push({
          filename,
          munCode: munMatch.munCode,
          munID: settlementId
        });
        continue;
      }
    } else {
      // Missing allowlist - record but continue (will be reported)
      skippedNotInAllowlist.push({
        filename,
        munCode: munMatch.munCode,
        munID: settlementId
      });
      continue;
    }
    
    records.push({
      munCode: munMatch.munCode,
      settlementId,
      pathString,
      sourceJsFile: filename
    });
  }
  
  return { records, skippedNotInAllowlist };
}

async function parseZipFile(
  zipPath: string,
  allowedSettlementIdsByMunCode: Map<string, Set<string>>
): Promise<{
  records: SettlementPathRecord[];
  skippedNotInAllowlist: Array<{ filename: string; munCode: string; munID: string }>;
  skippedByFile: Record<string, number>;
  missingXlsxSheetForMunCode: Set<string>;
}> {
  const zipBuffer = await readFile(zipPath);
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  
  // Sort entries by filename (deterministic)
  entries.sort((a, b) => a.entryName.localeCompare(b.entryName));
  
  const allRecords: SettlementPathRecord[] = [];
  const skippedNotInAllowlist: Array<{ filename: string; munCode: string; munID: string }> = [];
  const skippedByFile: Record<string, number> = {};
  const missingXlsxSheetForMunCode = new Set<string>();
  
  for (const entry of entries) {
    if (!entry.entryName.endsWith('.js')) continue;
    
    const content = entry.getData().toString('utf8');
    const munMatch = parseMunicipalityFilename(entry.entryName);
    if (munMatch) {
      const munCodeNorm = normDigits(munMatch.munCode);
      if (!allowedSettlementIdsByMunCode.has(munCodeNorm)) {
        missingXlsxSheetForMunCode.add(munCodeNorm);
      }
    }
    
    const { records, skippedNotInAllowlist: skipped } = extractPathRecords(
      content, 
      entry.entryName,
      allowedSettlementIdsByMunCode
    );
    
    allRecords.push(...records);
    
    if (skipped.length > 0) {
      skippedByFile[entry.entryName] = skipped.length;
      skippedNotInAllowlist.push(...skipped);
    }
  }
  
  return { records: allRecords, skippedNotInAllowlist, skippedByFile, missingXlsxSheetForMunCode };
}

// ============================================================================
// 2) SVG path -> polygon conversion
// ============================================================================

function flattenBezier(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  n: number = BEZIER_SUBDIVISIONS
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mt = 1 - t;
    const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0];
    const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1];
    if (Number.isFinite(x) && Number.isFinite(y)) {
      points.push([x, y]);
    }
  }
  return points;
}

function parseSVGPathToRings(pathString: string): Ring[] {
  try {
    const commands = parseSVG(pathString);
    // Convert to absolute coordinates for easier processing
    parseSVG.makeAbsolute(commands);
    const rings: Ring[] = [];
    let currentRing: Point[] = [];
    let currentPoint: Point = [0, 0];
    let subpathStart: Point = [0, 0];
    
    for (const cmd of commands) {
      const code = cmd.code;
      
      if (code === 'M' || code === 'm') {
        // Move to (now absolute after makeAbsolute)
        if (currentRing.length > 0) {
          // Close previous ring if it has points
          if (currentRing.length >= 3) {
            // Ensure closed
            if (currentRing[0][0] !== currentRing[currentRing.length - 1][0] ||
                currentRing[0][1] !== currentRing[currentRing.length - 1][1]) {
              currentRing.push([currentRing[0][0], currentRing[0][1]]);
            }
            rings.push(currentRing);
          }
          currentRing = [];
        }
        const x = cmd.x;
        const y = cmd.y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          currentPoint = [x, y];
          subpathStart = [x, y];
          currentRing.push([x, y]);
        }
      } else if (code === 'L' || code === 'l') {
        // Line to (now absolute)
        const x = cmd.x;
        const y = cmd.y;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          currentPoint = [x, y];
          currentRing.push([x, y]);
        }
      } else if (code === 'H' || code === 'h') {
        // Horizontal line (now absolute)
        const x = cmd.x;
        if (Number.isFinite(x) && Number.isFinite(currentPoint[1])) {
          currentPoint = [x, currentPoint[1]];
          currentRing.push([x, currentPoint[1]]);
        }
      } else if (code === 'V' || code === 'v') {
        // Vertical line (now absolute)
        const y = cmd.y;
        if (Number.isFinite(currentPoint[0]) && Number.isFinite(y)) {
          currentPoint = [currentPoint[0], y];
          currentRing.push([currentPoint[0], y]);
        }
      } else if (code === 'C' || code === 'c') {
        // Cubic Bezier (now absolute)
        const x1 = cmd.x1;
        const y1 = cmd.y1;
        const x2 = cmd.x2;
        const y2 = cmd.y2;
        const x = cmd.x;
        const y = cmd.y;
        
        if (Number.isFinite(x1) && Number.isFinite(y1) &&
            Number.isFinite(x2) && Number.isFinite(y2) &&
            Number.isFinite(x) && Number.isFinite(y)) {
          const p0: Point = [currentPoint[0], currentPoint[1]];
          const p1: Point = [x1, y1];
          const p2: Point = [x2, y2];
          const p3: Point = [x, y];
          const bezierPoints = flattenBezier(p0, p1, p2, p3);
          // Skip first point (already in currentRing)
          for (let i = 1; i < bezierPoints.length; i++) {
            currentRing.push(bezierPoints[i]);
          }
          currentPoint = [x, y];
        }
      } else if (code === 'Z' || code === 'z') {
        // Close path
        if (currentRing.length >= 3) {
          // Ensure closed
          if (currentRing[0][0] !== currentRing[currentRing.length - 1][0] ||
              currentRing[0][1] !== currentRing[currentRing.length - 1][1]) {
            currentRing.push([currentRing[0][0], currentRing[0][1]]);
          }
          rings.push(currentRing);
        }
        currentRing = [];
        currentPoint = subpathStart;
      }
    }
    
    // Close last ring if open
    if (currentRing.length >= 3) {
      if (currentRing[0][0] !== currentRing[currentRing.length - 1][0] ||
          currentRing[0][1] !== currentRing[currentRing.length - 1][1]) {
        currentRing.push([currentRing[0][0], currentRing[0][1]]);
      }
      rings.push(currentRing);
    }
    
    // Filter out rings with < 3 points (after closure)
    return rings.filter(ring => ring.length >= 4); // 4 = 3 points + closure
  } catch (err) {
    // If parsing fails, return empty
    return [];
  }
}

function computeRingBounds(ring: Ring): Bounds | null {
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const [x, y] = point;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function computeRingArea(ring: Ring): number {
  // Shoelace formula
  if (!Array.isArray(ring) || ring.length < 3) return 0;
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const point1 = ring[i];
    const point2 = ring[i + 1];
    if (!Array.isArray(point1) || !Array.isArray(point2) || point1.length < 2 || point2.length < 2) continue;
    const [x1, y1] = point1;
    const [x2, y2] = point2;
    if (Number.isFinite(x1) && Number.isFinite(y1) && Number.isFinite(x2) && Number.isFinite(y2)) {
      area += x1 * y2;
      area -= x2 * y1;
    }
  }
  return Math.abs(area) / 2;
}

function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return outer.minX <= inner.minX && outer.minY <= inner.minY &&
         outer.maxX >= inner.maxX && outer.maxY >= inner.maxY;
}

function organizeRingsIntoPolygon(rings: Ring[]): Polygon | MultiPolygon {
  if (rings.length === 0) return [];
  if (rings.length === 1) return [rings[0]];
  
  // Compute bounds and areas for each ring
  const ringData = rings.map(ring => ({
    ring,
    bounds: computeRingBounds(ring),
    area: computeRingArea(ring)
  })).filter(rd => rd.bounds !== null) as Array<{
    ring: Ring;
    bounds: Bounds;
    area: number;
  }>;
  
  if (ringData.length === 0) return [];
  if (ringData.length === 1) return [ringData[0].ring];
  
  // Sort by area descending (largest first)
  ringData.sort((a, b) => b.area - a.area);
  
  // Group rings: assign smaller rings as holes of larger rings if contained
  const polygons: Polygon[] = [];
  const assigned = new Set<number>();
  
  for (let i = 0; i < ringData.length; i++) {
    if (assigned.has(i)) continue;
    
    const outer = ringData[i];
    const polygon: Polygon = [outer.ring];
    assigned.add(i);
    
    // Find holes for this outer ring
    for (let j = i + 1; j < ringData.length; j++) {
      if (assigned.has(j)) continue;
      const inner = ringData[j];
      
      // Check if inner is contained and significantly smaller
      if (boundsContains(outer.bounds, inner.bounds) &&
          inner.area < outer.area * HOLE_AREA_THRESHOLD) {
        polygon.push(inner.ring);
        assigned.add(j);
      }
    }
    
    polygons.push(polygon);
  }
  
  // If only one polygon, return as Polygon (Ring[]); otherwise MultiPolygon (Polygon[])
  if (polygons.length === 1) {
    return polygons[0]; // Return Polygon (Ring[])
  } else {
    return polygons; // Return MultiPolygon (Polygon[])
  }
}

function convertPathToGeometry(pathString: string): { type: 'Polygon' | 'MultiPolygon'; coordinates: Polygon | MultiPolygon } | null {
  const rings = parseSVGPathToRings(pathString);
  if (rings.length === 0) return null;
  
  const geometry = organizeRingsIntoPolygon(rings);
  if (Array.isArray(geometry) && geometry.length === 0) return null;
  
  // Check if it's a MultiPolygon vs Polygon
  // Polygon: Ring[] where Ring = Point[] and Point = [number, number]
  //   - geometry[0] is Ring (Point[])
  //   - geometry[0][0] is Point ([number, number])
  //   - geometry[0][0][0] is number
  // MultiPolygon: Polygon[] where Polygon = Ring[]
  //   - geometry[0] is Polygon (Ring[])
  //   - geometry[0][0] is Ring (Point[])
  //   - geometry[0][0][0] is Point ([number, number])
  //   - geometry[0][0][0][0] is number
  // So we check: if geometry[0][0][0] is a number, it's Polygon; if it's an array, it's MultiPolygon
  if (Array.isArray(geometry) && geometry.length > 0) {
    const first = geometry[0];
    if (Array.isArray(first) && first.length > 0) {
      const firstFirst = first[0];
      if (Array.isArray(firstFirst) && firstFirst.length > 0) {
        const firstFirstFirst = firstFirst[0];
        // If firstFirstFirst is a number, then firstFirst is a Point, so first is a Ring, so geometry is Polygon
        // If firstFirstFirst is an array, then firstFirst is a Ring, so first is a Polygon, so geometry is MultiPolygon
        if (typeof firstFirstFirst === 'number') {
          // Polygon: geometry is Ring[]
          return {
            type: 'Polygon',
            coordinates: geometry as Polygon
          };
        } else if (Array.isArray(firstFirstFirst) && firstFirstFirst.length >= 2 && typeof firstFirstFirst[0] === 'number') {
          // MultiPolygon: geometry is Polygon[]
          return {
            type: 'MultiPolygon',
            coordinates: geometry as MultiPolygon
          };
        }
      }
    }
  }
  
  // Fallback: assume Polygon (most common case)
  return {
    type: 'Polygon',
    coordinates: geometry as Polygon
  };
}

// ============================================================================
// 3) Excel parsing
// ============================================================================

function isSettlementId(value: unknown): boolean {
  if (typeof value === 'string') {
    return /^\d+$/.test(value.trim());
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0;
  }
  return false;
}

function parseSheet(sheet: XLSX.WorkSheet, sheetName: string): Map<string, XLSXRow> {
  const data = new Map<string, XLSXRow>();
  
  if (!sheet || !sheet['!ref']) return data;
  
  const range = XLSX.utils.decode_range(sheet['!ref']);
  let headerRow = -1;
  
  // Find header row: first row where cell(0) is settlement ID and cell(1) looks like name
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cell0 = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    const cell1 = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
    
    if (cell0 && isSettlementId(cell0.v)) {
      const val1 = cell1?.v;
      if (val1 && typeof val1 === 'string' && val1.trim().length > 0) {
        headerRow = r;
        break;
      }
    }
  }
  
  if (headerRow === -1) return data;
  
  // Read data rows
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const cell0 = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
    if (!cell0 || !isSettlementId(cell0.v)) {
      // Stop at first non-settlement-ID row
      break;
    }
    
    const settlementId = String(cell0.v).trim();
    const cell1 = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
    const settlementName = cell1?.v ? String(cell1.v).trim() : undefined;
    
    const row: XLSXRow = { settlementId };
    if (settlementName) row.settlementName = settlementName;
    
    // Extract other columns (population, etc.)
    // Assume common column names
    for (let c = 2; c <= range.e.c; c++) {
      const cell = sheet[XLSX.utils.encode_cell({ r, c })];
      const headerCell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })];
      if (cell && headerCell) {
        const key = String(headerCell.v || '').trim().toLowerCase().replace(/\s+/g, '_');
        if (key) {
          row[key] = cell.v;
        }
      }
    }
    
    data.set(settlementId, row);
  }
  
  return data;
}

function normalizeMunicipalityName(name: string): string[] {
  // Generate variations of municipality name to handle historical name changes
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const variations: string[] = [trimmed, normalized];
  
  // Remove common prefixes that changed after the war
  const prefixes = ['bosanska', 'srpska', 'hrvatska', 'bosansko', 'srpsko', 'hrvatsko'];
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix + ' ')) {
      const withoutPrefix = normalized.substring(prefix.length + 1).trim();
      if (withoutPrefix) {
        variations.push(withoutPrefix);
        variations.push(trimmed.replace(new RegExp(`^${prefix}\\s+`, 'i'), '').trim());
      }
    }
  }
  
  // Also try without common suffixes
  const suffixes = [' (grad)', ' grad'];
  for (const suffix of suffixes) {
    if (normalized.endsWith(suffix.toLowerCase())) {
      const withoutSuffix = normalized.substring(0, normalized.length - suffix.length).trim();
      if (withoutSuffix) {
        variations.push(withoutSuffix);
      }
    }
  }
  
  return [...new Set(variations)]; // Remove duplicates
}

async function loadMunicipalityNameMap(): Promise<Map<string, string>> {
  // Load municipalities.json to create code -> name mapping
  const munPath = resolve('data/municipalities.json');
  try {
    const munJson = JSON.parse(await readFile(munPath, 'utf8'));
    const mapping = new Map<string, string>();
    
    if (munJson && Array.isArray(munJson.municipalities)) {
      for (const mun of munJson.municipalities) {
        if (mun.id && mun.name) {
          mapping.set(String(mun.id), String(mun.name));
        }
      }
    }
    
    return mapping;
  } catch (err) {
    return new Map();
  }
}

async function loadMunicipalityMapping(): Promise<Map<string, string>> {
  // Load municipalities.json to create name -> code mapping
  const munPath = resolve('data/municipalities.json');
  try {
    const munJson = JSON.parse(await readFile(munPath, 'utf8'));
    const mapping = new Map<string, string>();
    
    if (munJson && Array.isArray(munJson.municipalities)) {
      for (const mun of munJson.municipalities) {
        if (mun.id && mun.name) {
          const munCode = String(mun.id);
          const nameVariations = normalizeMunicipalityName(String(mun.name));
          
          // Map all variations to the same code
          for (const variation of nameVariations) {
            if (variation) {
              mapping.set(variation, munCode);
            }
          }
        }
      }
    }
    
    return mapping;
  } catch (err) {
    process.stderr.write(`  Warning: Could not load municipalities.json: ${err instanceof Error ? err.message : String(err)}\n`);
    return new Map();
  }
}

async function parseXLSXFile(xlsxPath: string): Promise<{
  data: XLSXData;
  allowedSettlementIdsByMunCode: Map<string, Set<string>>;
  xlsxAllowCountByMunCode: Record<string, number>;
  xlsxSummaryExcludedByMunCode: Record<string, boolean>;
}> {
  const buffer = await readFile(xlsxPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  // Load municipality name -> code mapping
  const nameToCode = await loadMunicipalityMapping();
  
  const data: XLSXData = {};
  const unmappedSheets: string[] = [];
  const allowedSettlementIdsByMunCode = new Map<string, Set<string>>();
  const xlsxAllowCountByMunCode: Record<string, number> = {};
  const xlsxSummaryExcludedByMunCode: Record<string, boolean> = {};
  
  // Each sheet is a municipality
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    
    // Try multiple strategies to find municipality code:
    // 1. Direct lookup by sheet name (exact match)
    // 2. Normalized lookup (case-insensitive, trimmed)
    // 3. Extract number from sheet name
    // 4. Use sheet name as-is if it's all digits
    
    let munCode: string | null = null;
    
    // Strategy 1: Exact name match
    if (nameToCode.has(sheetName)) {
      munCode = nameToCode.get(sheetName)!;
    }
    // Strategy 2: Normalized name match
    else {
      const normalized = sheetName.trim().toLowerCase().replace(/\s+/g, ' ');
      if (nameToCode.has(normalized)) {
        munCode = nameToCode.get(normalized)!;
      }
    }
    
    // Strategy 3: Extract number from sheet name
    if (!munCode) {
      const match = sheetName.match(/(\d+)/);
      if (match) {
        munCode = match[1];
      }
    }
    
    // Strategy 4: If sheet name is all digits, use it directly
    if (!munCode && /^\d+$/.test(sheetName.trim())) {
      munCode = sheetName.trim();
    }
    
    // Strategy 5: Use sheet name as-is (fallback)
    if (!munCode) {
      munCode = sheetName.trim();
      unmappedSheets.push(sheetName);
    }
    
    const rows = parseSheet(sheet, sheetName);
    if (rows.size > 0) {
      // Store by all possible keys to maximize matching chances
      data[munCode] = rows;
      
      // Also store by normalized sheet name if different
      const normalized = sheetName.trim().toLowerCase().replace(/\s+/g, '_');
      if (normalized !== munCode && !data[normalized]) {
        data[normalized] = rows;
      }
      
      // Build allowlist for this municipality
      const munCodeNorm = normDigits(munCode);
      const allowlist = new Set<string>();
      
      for (const [settlementId] of rows.entries()) {
        const idNorm = normDigits(settlementId);
        allowlist.add(idNorm);
      }
      
      // Remove summary ID (munCode itself)
      const summaryExcluded = allowlist.has(munCodeNorm);
      if (summaryExcluded) {
        allowlist.delete(munCodeNorm);
        xlsxSummaryExcludedByMunCode[munCodeNorm] = true;
      } else {
        xlsxSummaryExcludedByMunCode[munCodeNorm] = false;
      }
      
      allowedSettlementIdsByMunCode.set(munCodeNorm, allowlist);
      xlsxAllowCountByMunCode[munCodeNorm] = allowlist.size;
    }
  }
  
  if (unmappedSheets.length > 0) {
    process.stdout.write(`  Warning: ${unmappedSheets.length} sheets could not be mapped to municipality codes (using sheet name as fallback)\n`);
    if (unmappedSheets.length <= 10) {
      process.stdout.write(`    Unmapped sheets: ${unmappedSheets.join(', ')}\n`);
    }
  }
  
  return { data, allowedSettlementIdsByMunCode, xlsxAllowCountByMunCode, xlsxSummaryExcludedByMunCode };
}

// ============================================================================
// 4) Join and generate GeoJSON
// ============================================================================

function computeGlobalBounds(features: GeoJSONFeature[]): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const f of features) {
    const coords = f.geometry.coordinates;
    
    const processRing = (ring: Ring) => {
      if (!Array.isArray(ring)) {
        process.stderr.write(`  Warning: Invalid ring structure for ${f.properties?.sid || 'unknown'}\n`);
        return;
      }
      for (const point of ring) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const [x, y] = point;
        if (Number.isFinite(x) && Number.isFinite(y)) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    };
    
    if (f.geometry.type === 'Polygon') {
      if (!Array.isArray(coords)) {
        process.stderr.write(`  Warning: Invalid Polygon coordinates for ${f.properties?.sid || 'unknown'}\n`);
        continue;
      }
      for (const ring of coords as Polygon) {
        processRing(ring);
      }
    } else if (f.geometry.type === 'MultiPolygon') {
      if (!Array.isArray(coords)) {
        process.stderr.write(`  Warning: Invalid MultiPolygon coordinates for ${f.properties?.sid || 'unknown'}\n`);
        continue;
      }
      for (const polygon of coords as MultiPolygon) {
        if (!Array.isArray(polygon)) continue;
        for (const ring of polygon) {
          processRing(ring);
        }
      }
    }
  }
  
  return { minX, minY, maxX, maxY };
}

function computeCentroid(feature: GeoJSONFeature): { cx: number; cy: number } | null {
  let sumX = 0, sumY = 0, count = 0;
  
  const processRing = (ring: Ring) => {
    if (!Array.isArray(ring)) return;
    for (const point of ring) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const [x, y] = point;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  };
  
  const coords = feature.geometry.coordinates;
  if (feature.geometry.type === 'Polygon') {
    // Only use outer ring (first ring)
    if (Array.isArray(coords) && coords.length > 0) {
      processRing(coords[0] as Ring);
    }
  } else if (feature.geometry.type === 'MultiPolygon') {
    // Only use outer ring of first polygon
    if (Array.isArray(coords) && coords.length > 0) {
      const firstPoly = coords[0] as Polygon;
      if (Array.isArray(firstPoly) && firstPoly.length > 0) {
        processRing(firstPoly[0] as Ring);
      }
    }
  }
  
  if (count === 0) return null;
  return { cx: sumX / count, cy: sumY / count };
}

function twoMeansClustering(features: GeoJSONFeature[]): RegenSummary['cluster_diagnostic'] {
  if (features.length < 2) {
    return {
      cluster_a_size: features.length,
      cluster_b_size: 0,
      cluster_a_bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      cluster_b_bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      stray_cluster: null
    };
  }
  
  const centroids = features.map(f => computeCentroid(f)).filter((c): c is { cx: number; cy: number } => c !== null);
  if (centroids.length < 2) {
    return {
      cluster_a_size: centroids.length,
      cluster_b_size: 0,
      cluster_a_bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      cluster_b_bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
      stray_cluster: null
    };
  }
  
  // Deterministic seed selection: farthest pair
  let seed1Idx = 0;
  let minSum = centroids[0].cx + centroids[0].cy;
  for (let i = 1; i < centroids.length; i++) {
    const sum = centroids[i].cx + centroids[i].cy;
    if (sum < minSum) {
      minSum = sum;
      seed1Idx = i;
    }
  }
  
  let seed2Idx = 0;
  let maxDistSq = 0;
  const seed1 = centroids[seed1Idx];
  for (let i = 0; i < centroids.length; i++) {
    if (i === seed1Idx) continue;
    const dx = centroids[i].cx - seed1.cx;
    const dy = centroids[i].cy - seed1.cy;
    const distSq = dx * dx + dy * dy;
    if (distSq > maxDistSq) {
      maxDistSq = distSq;
      seed2Idx = i;
    }
  }
  
  // Fixed 10 iterations
  let meanA = { x: seed1.cx, y: seed1.cy };
  let meanB = { x: centroids[seed2Idx].cx, y: centroids[seed2Idx].cy };
  let clusterA: number[] = [];
  let clusterB: number[] = [];
  
  for (let iter = 0; iter < 10; iter++) {
    clusterA = [];
    clusterB = [];
    
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      const dxA = c.cx - meanA.x;
      const dyA = c.cy - meanA.y;
      const distSqA = dxA * dxA + dyA * dyA;
      
      const dxB = c.cx - meanB.x;
      const dyB = c.cy - meanB.y;
      const distSqB = dxB * dxB + dyB * dyB;
      
      if (distSqA <= distSqB) {
        clusterA.push(i);
      } else {
        clusterB.push(i);
      }
    }
    
    // Update means
    let ax = 0, ay = 0, ac = 0, bx = 0, by = 0, bc = 0;
    for (let i = 0; i < centroids.length; i++) {
      const c = centroids[i];
      if (clusterA.includes(i)) {
        ax += c.cx;
        ay += c.cy;
        ac++;
      } else {
        bx += c.cx;
        by += c.cy;
        bc++;
      }
    }
    if (ac > 0) meanA = { x: ax / ac, y: ay / ac };
    if (bc > 0) meanB = { x: bx / bc, y: by / bc };
  }
  
  // Compute bounds for each cluster
  const computeClusterBounds = (indices: number[]): Bounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const idx of indices) {
      const c = centroids[idx];
      minX = Math.min(minX, c.cx);
      minY = Math.min(minY, c.cy);
      maxX = Math.max(maxX, c.cx);
      maxY = Math.max(maxY, c.cy);
    }
    return { minX, minY, maxX, maxY };
  };
  
  const boundsA = computeClusterBounds(clusterA);
  const boundsB = computeClusterBounds(clusterB);
  
  const countA = clusterA.length;
  const countB = clusterB.length;
  const strayCluster = countA < countB ? 'A' : countB < countA ? 'B' : null;
  
  return {
    cluster_a_size: countA,
    cluster_b_size: countB,
    cluster_a_bounds: boundsA,
    cluster_b_bounds: boundsB,
    stray_cluster: strayCluster
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  if (args.help) {
    process.stdout.write([
      'Usage:',
      '  tsx scripts/map/regenerate_settlements_geojson.ts [--zip <path>] [--xlsx <path>] [--out <path>]',
      '',
      'Defaults:',
      `  zip: ${args.zip}`,
      `  xlsx: ${args.xlsx}`,
      `  out: ${args.out}`,
      ''
    ].join('\n'));
    return;
  }
  
  process.stdout.write('MapKit regeneration: Rebuilding settlements_polygons.geojson\n');
  process.stdout.write(`  ZIP: ${args.zip}\n`);
  process.stdout.write(`  XLSX: ${args.xlsx}\n`);
  process.stdout.write(`  Output: ${args.out}\n\n`);
  
  // Check input files exist
  try {
    await access(args.zip);
  } catch {
    throw new Error(`ZIP file not found: ${args.zip}`);
  }
  try {
    await access(args.xlsx);
  } catch {
    throw new Error(`XLSX file not found: ${args.xlsx}`);
  }
  
  // Step 1: Parse XLSX first to build allowlists
  process.stdout.write('Step 1: Parsing XLSX file and building allowlists...\n');
  const { 
    data: xlsxData, 
    allowedSettlementIdsByMunCode, 
    xlsxAllowCountByMunCode,
    xlsxSummaryExcludedByMunCode
  } = await parseXLSXFile(args.xlsx);
  const totalXlsxRows = Object.values(xlsxData).reduce((sum, map) => sum + map.size, 0);
  const summaryExcludedCount = Object.values(xlsxSummaryExcludedByMunCode).filter(Boolean).length;
  process.stdout.write(`  Loaded ${totalXlsxRows} rows from ${Object.keys(xlsxData).length} municipality keys\n`);
  process.stdout.write(`  Built allowlists for ${allowedSettlementIdsByMunCode.size} municipalities\n`);
  process.stdout.write(`  Summary IDs excluded from ${summaryExcludedCount} municipality allowlists\n`);
  process.stdout.write(`  Available municipality codes in XLSX: ${Object.keys(xlsxData).slice(0, 20).join(', ')}${Object.keys(xlsxData).length > 20 ? '...' : ''}\n`);
  
  // Step 2: Parse ZIP with allowlist filtering
  process.stdout.write('Step 2: Parsing ZIP file with XLSX allowlist filtering...\n');
  const { 
    records: pathRecords, 
    skippedNotInAllowlist, 
    skippedByFile,
    missingXlsxSheetForMunCode
  } = await parseZipFile(args.zip, allowedSettlementIdsByMunCode);
  process.stdout.write(`  Extracted ${pathRecords.length} settlement path records\n`);
  process.stdout.write(`  Skipped ${skippedNotInAllowlist.length} records not in XLSX allowlist\n`);
  if (missingXlsxSheetForMunCode.size > 0) {
    process.stdout.write(`  Warning: ${missingXlsxSheetForMunCode.size} JS files have no matching XLSX sheet\n`);
    const sampleMissing = Array.from(missingXlsxSheetForMunCode).slice(0, 10);
    process.stdout.write(`    Sample missing munCodes: ${sampleMissing.join(', ')}\n`);
  }
  if (skippedNotInAllowlist.length > 0) {
    const topFiles = Object.entries(skippedByFile)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([file, count]) => `    ${file}: ${count}`);
    if (topFiles.length > 0) {
      process.stdout.write(`  Top files with skipped records:\n${topFiles.join('\n')}\n`);
    }
  }
  
  // Step 3: Convert paths to geometries and join attributes (Pass 1: collect all candidates)
  process.stdout.write('Step 3: Converting paths to polygons and joining attributes...\n');
  const candidateFeatures: Array<{ feature: GeoJSONFeature; record: SettlementPathRecord; xlsxRow?: XLSXRow }> = [];
  const missingJoins: string[] = [];
  const munCodeStats: Record<string, { total: number; matched: number }> = {};
  
  // Sort path records by canonical sid for deterministic output
  pathRecords.sort((a, b) => {
    const sidA = `${a.munCode}:${a.settlementId}`;
    const sidB = `${b.munCode}:${b.settlementId}`;
    return sidA.localeCompare(sidB);
  });
  
  for (const record of pathRecords) {
    const sid = `${record.munCode}:${record.settlementId}`;
    const geometry = convertPathToGeometry(record.pathString);
    
    if (!geometry) {
      process.stderr.write(`  Warning: Failed to convert path for ${sid}\n`);
      continue;
    }
    
    // Validate geometry structure
    if (!Array.isArray(geometry.coordinates)) {
      process.stderr.write(`  Warning: Invalid geometry coordinates for ${sid}\n`);
      continue;
    }
    
    // Initialize stats for this municipality
    if (!munCodeStats[record.munCode]) {
      munCodeStats[record.munCode] = { total: 0, matched: 0 };
    }
    munCodeStats[record.munCode].total++;
    
    // Join XLSX data - try multiple keys
    let munData = xlsxData[record.munCode];
    let xlsxRow = munData?.get(record.settlementId);
    
    // If not found, try alternative keys (normalized versions)
    if (!xlsxRow) {
      const normalized = record.munCode.toLowerCase().replace(/\s+/g, '_');
      munData = xlsxData[normalized];
      xlsxRow = munData?.get(record.settlementId);
    }
    
    // Last resort: search across all sheets for this settlement ID
    // (in case municipality code mismatch but settlement ID exists elsewhere)
    if (!xlsxRow) {
      for (const [key, dataMap] of Object.entries(xlsxData)) {
        const found = dataMap.get(record.settlementId);
        if (found) {
          xlsxRow = found;
          // Note: we found it but under a different municipality code
          // This is a data quality issue, but we'll use the data anyway
          break;
        }
      }
    }
    
    const properties: GeoJSONFeature['properties'] = {
      sid,
      mun_code: record.munCode,
      settlement_id: record.settlementId,
      source_js_file: record.sourceJsFile
    };
    
    if (xlsxRow) {
      munCodeStats[record.munCode].matched++;
      if (xlsxRow.settlementName) properties.name = xlsxRow.settlementName;
      // Copy other fields
      for (const [key, value] of Object.entries(xlsxRow)) {
        if (key !== 'settlementId' && key !== 'settlementName') {
          properties[key] = value;
        }
      }
      properties.source_sheet = record.munCode; // Sheet name is mun code
    } else {
      missingJoins.push(sid);
    }
    
    candidateFeatures.push({
      feature: {
        type: 'Feature',
        properties,
        geometry
      },
      record,
      xlsxRow
    });
  }
  
  process.stdout.write(`  Generated ${candidateFeatures.length} candidate features\n`);
  
  // Compute statistics for conflict resolution
  process.stdout.write('  Computing statistics for deduplication...\n');
  const allAreas: number[] = [];
  const allCentroids: Array<{ cx: number; cy: number }> = [];
  
  for (const { feature } of candidateFeatures) {
    const bounds = computeFeatureBounds(feature);
    if (bounds) {
      const area = boundsArea(bounds);
      if (area > 0 && Number.isFinite(area)) {
        allAreas.push(area);
      }
    }
    const centroid = computeFeatureCentroid(feature);
    if (centroid) {
      allCentroids.push(centroid);
    }
  }
  
  // Compute median area
  allAreas.sort((a, b) => a - b);
  const medianArea = allAreas.length > 0 
    ? (allAreas.length % 2 === 0 
        ? (allAreas[allAreas.length / 2 - 1] + allAreas[allAreas.length / 2]) / 2
        : allAreas[Math.floor(allAreas.length / 2)])
    : 1000; // Fallback
  
  // Compute provisional main bounds (from all centroids)
  let mainBounds: Bounds | null = null;
  if (allCentroids.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of allCentroids) {
      minX = Math.min(minX, c.cx);
      minY = Math.min(minY, c.cy);
      maxX = Math.max(maxX, c.cx);
      maxY = Math.max(maxY, c.cy);
    }
    // Expand by 10%
    const w = maxX - minX;
    const h = maxY - minY;
    mainBounds = {
      minX: minX - w * 0.1,
      minY: minY - h * 0.1,
      maxX: maxX + w * 0.1,
      maxY: maxY + h * 0.1
    };
  }
  
  process.stdout.write(`  Median area: ${medianArea.toFixed(2)}\n`);
  if (mainBounds) {
    process.stdout.write(`  Provisional main bounds: ${JSON.stringify(mainBounds)}\n`);
  }
  
  // Pass 2: Deduplicate with conflict resolution
  process.stdout.write('  Deduplicating features...\n');
  const seen = new Map<string, {
    feature: GeoJSONFeature;
    geomSig: string;
    score: number;
    source: { jsFile: string; record: SettlementPathRecord };
  }>();
  
  let dedupeExactCount = 0;
  let dedupeConflictCount = 0;
  const conflicts: Array<{
    sid: string;
    keptSource: string;
    droppedSource: string;
    keptSig: string;
    droppedSig: string;
    keptScore: number;
    droppedScore: number;
  }> = [];
  
  for (const { feature, record } of candidateFeatures) {
    const sid = feature.properties.sid;
    const geomSig = computeGeometrySignature(feature);
    const bounds = computeFeatureBounds(feature);
    const centroid = computeFeatureCentroid(feature);
    const pointCount = countFeaturePoints(feature);
    
    // Compute score
    let score = 0;
    
    // Area sanity check
    if (bounds) {
      const area = boundsArea(bounds);
      if (area >= medianArea / 100 && area <= medianArea * 100) {
        score += 1000;
      } else if (area > medianArea * 100) {
        score -= 500;
      } else if (area < medianArea / 100) {
        score -= 500;
      }
    }
    
    // Point count (detail)
    score += Math.min(pointCount, 500);
    
    // Main cluster proximity
    if (centroid && mainBounds) {
      if (centroid.cx >= mainBounds.minX && centroid.cx <= mainBounds.maxX &&
          centroid.cy >= mainBounds.minY && centroid.cy <= mainBounds.maxY) {
        score += 500;
      } else {
        score -= 500;
      }
    }
    
    if (!seen.has(sid)) {
      // First occurrence
      seen.set(sid, {
        feature,
        geomSig,
        score,
        source: { jsFile: record.sourceJsFile, record }
      });
    } else {
      // Duplicate SID
      const existing = seen.get(sid)!;
      
      if (geomSig === existing.geomSig) {
        // Exact duplicate
        dedupeExactCount++;
        // Keep first (already in seen)
      } else {
        // Conflict
        dedupeConflictCount++;
        
        // Determine winner
        let winner: typeof existing;
        let loser: { feature: GeoJSONFeature; geomSig: string; score: number; source: { jsFile: string; record: SettlementPathRecord } };
        
        if (score > existing.score) {
          winner = { feature, geomSig, score, source: { jsFile: record.sourceJsFile, record } };
          loser = existing;
        } else if (score < existing.score) {
          winner = existing;
          loser = { feature, geomSig, score, source: { jsFile: record.sourceJsFile, record } };
        } else {
          // Tie: use source_js_file lexicographic comparison
          const currentFile = record.sourceJsFile;
          const existingFile = existing.source.jsFile;
          if (currentFile < existingFile) {
            winner = { feature, geomSig, score, source: { jsFile: record.sourceJsFile, record } };
            loser = existing;
          } else if (currentFile > existingFile) {
            winner = existing;
            loser = { feature, geomSig, score, source: { jsFile: record.sourceJsFile, record } };
          } else {
            // Still tied: keep first (existing)
            winner = existing;
            loser = { feature, geomSig, score, source: { jsFile: record.sourceJsFile, record } };
          }
        }
        
        // Update seen with winner
        seen.set(sid, winner);
        
        // Record conflict
        conflicts.push({
          sid,
          keptSource: winner.source.jsFile,
          droppedSource: loser.source.jsFile,
          keptSig: winner.geomSig.substring(0, 100), // Truncate for readability
          droppedSig: loser.geomSig.substring(0, 100),
          keptScore: winner.score,
          droppedScore: loser.score
        });
      }
    }
  }
  
  process.stdout.write(`  Exact duplicates dropped: ${dedupeExactCount}\n`);
  process.stdout.write(`  Conflicts resolved: ${dedupeConflictCount}\n`);
  
  // Build final features array (sorted by sid)
  const features: GeoJSONFeature[] = Array.from(seen.values())
    .map(v => v.feature)
    .sort((a, b) => a.properties.sid.localeCompare(b.properties.sid));
  
  const perMunCounts: Record<string, number> = {};
  const geometryTypeCounts = { Polygon: 0, MultiPolygon: 0 };
  
  for (const f of features) {
    const munCode = f.properties.mun_code as string;
    perMunCounts[munCode] = (perMunCounts[munCode] || 0) + 1;
    geometryTypeCounts[f.geometry.type]++;
  }
  
  process.stdout.write(`  Generated ${features.length} features\n`);
  process.stdout.write(`  Missing XLSX joins: ${missingJoins.length} (${((missingJoins.length / features.length) * 100).toFixed(1)}%)\n`);
  
  // Report per-municipality join statistics
  const problemMuns = Object.entries(munCodeStats)
    .filter(([_, stats]) => stats.matched === 0 && stats.total > 0)
    .map(([code, _]) => code)
    .slice(0, 10);
  if (problemMuns.length > 0) {
    process.stdout.write(`  Municipalities with 0% join rate (sample): ${problemMuns.join(', ')}\n`);
  }
  
  // Show municipalities with missing joins (with names)
  if (missingJoins.length > 0) {
    // Group by municipality to see patterns
    const missingByMun: Record<string, number> = {};
    for (const sid of missingJoins) {
      const [munCode] = sid.split(':');
      missingByMun[munCode] = (missingByMun[munCode] || 0) + 1;
    }
    
    // Load municipality names for better reporting
    const munNameMap = await loadMunicipalityNameMap();
    const problemMuns = Object.entries(missingByMun)
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .map(([code, count]) => {
        const name = munNameMap.get(code) || 'Unknown';
        return { name, code, count };
      });
    
    process.stdout.write(`  Municipalities with missing joins (${problemMuns.length} total):\n`);
    for (const { name, code, count } of problemMuns) {
      process.stdout.write(`    - ${name} (${code}): ${count} missing settlement(s)\n`);
    }
    
    if (missingJoins.length <= 20) {
      process.stdout.write(`  Missing join SIDs: ${missingJoins.join(', ')}\n`);
    } else {
      process.stdout.write(`  Sample missing SIDs: ${missingJoins.slice(0, 10).join(', ')}...\n`);
    }
  }
  
  // Step 4: Compute summary
  process.stdout.write('Step 4: Computing summary statistics...\n');
  const globalBounds = computeGlobalBounds(features);
  const clusterDiagnostic = twoMeansClustering(features);
  
  // Create detailed missing joins report with municipality names
  const missingByMun: Record<string, number> = {};
  for (const sid of missingJoins) {
    const [munCode] = sid.split(':');
    missingByMun[munCode] = (missingByMun[munCode] || 0) + 1;
  }
  const munNameMap = await loadMunicipalityNameMap();
  const missingJoinsByMunicipality = Object.entries(missingByMun)
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => ({
      municipality_code: code,
      municipality_name: munNameMap.get(code) || 'Unknown',
      missing_count: count,
      sample_sids: missingJoins.filter(sid => sid.startsWith(`${code}:`)).slice(0, 5)
    }));
  
  // Sort conflicts by SID for deterministic output
  conflicts.sort((a, b) => a.sid.localeCompare(b.sid));
  
  // Sort skipped not-in-allowlist examples for deterministic output
  const sortedSkippedExamples = [...skippedNotInAllowlist]
    .sort((a, b) => {
      const fileCmp = a.filename.localeCompare(b.filename);
      if (fileCmp !== 0) return fileCmp;
      const munCmp = a.munCode.localeCompare(b.munCode);
      if (munCmp !== 0) return munCmp;
      return a.munID.localeCompare(b.munID);
    })
    .slice(0, 50);

  const summary: RegenSummary = {
    total_features: features.length,
    per_municipality_counts: perMunCounts,
    missing_xlsx_joins: {
      count: missingJoins.length,
      sample_sids: missingJoins.slice(0, 50).sort(),
      by_municipality: missingJoinsByMunicipality
    } as any, // Extend the type to include by_municipality
    geometry_type_counts: geometryTypeCounts,
    global_bounds: globalBounds,
    cluster_diagnostic: clusterDiagnostic,
    deduplication: {
      exact_duplicates_dropped: dedupeExactCount,
      conflicts_resolved: dedupeConflictCount,
      top_conflicts: conflicts.slice(0, 50).map(c => ({
        sid: c.sid,
        kept_source: c.keptSource,
        dropped_source: c.droppedSource,
        kept_score: c.keptScore,
        dropped_score: c.droppedScore
      }))
    },
    municipality_summary_excluded: {
      total_skipped: 0,
      skipped_by_file: {},
      sample_examples: []
    },
    xlsx_allowlist_filtering: {
      total_skipped_not_in_allowlist: skippedNotInAllowlist.length,
      skipped_by_file: skippedByFile,
      top_examples: sortedSkippedExamples.map(ex => ({
        filename: ex.filename,
        mun_code: ex.munCode,
        mun_id: ex.munID
      })),
      missing_xlsx_sheet_count: missingXlsxSheetForMunCode.size,
      missing_xlsx_sheet_mun_codes: Array.from(missingXlsxSheetForMunCode).sort(),
      summary_ids_excluded_count: summaryExcludedCount
    }
  };
  
  // Step 5: Write outputs
  process.stdout.write('Step 5: Writing outputs...\n');
  await mkdir(dirname(args.out), { recursive: true });
  
  const geojson = {
    type: 'FeatureCollection',
    features
  };
  
  await writeFile(args.out, JSON.stringify(geojson, null, 2), 'utf8');
  process.stdout.write(`  GeoJSON: ${args.out}\n`);
  
  const summaryPath = args.out.replace('.geojson', '_summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  process.stdout.write(`  Summary: ${summaryPath}\n`);
  
  // Write conflicts artifact
  const conflictsPath = args.out.replace('.geojson', '_conflicts.json');
  const conflictsArtifact = {
    total_conflicts: conflicts.length,
    conflicts: conflicts
  };
  await writeFile(conflictsPath, JSON.stringify(conflictsArtifact, null, 2), 'utf8');
  process.stdout.write(`  Conflicts: ${conflictsPath}\n`);
  
  // Step 6: Write report
  const reportPath = resolve('docs/mapkit_regen_report.md');
  await mkdir(dirname(reportPath), { recursive: true });
  
  const strayClusterPercent = summary.cluster_diagnostic.stray_cluster 
    ? (summary.cluster_diagnostic.stray_cluster === 'A' 
        ? (summary.cluster_diagnostic.cluster_a_size / summary.total_features * 100)
        : (summary.cluster_diagnostic.cluster_b_size / summary.total_features * 100))
    : 0;
  
  const reportLines = [
    '# MapKit Regeneration Report',
    '',
    '## Inputs',
    `- ZIP: \`${args.zip}\``,
    `- XLSX: \`${args.xlsx}\``,
    '',
    '## Outputs',
    `- GeoJSON: \`${args.out}\``,
    `- Summary: \`${summaryPath}\``,
    `- Conflicts: \`${conflictsPath}\``,
    '',
    '## Key Counts',
    `- Total features: ${summary.total_features}`,
    `- Municipalities: ${Object.keys(summary.per_municipality_counts).length}`,
    `- Missing XLSX joins: ${summary.missing_xlsx_joins.count}`,
    '',
    '## XLSX Allowlist Filtering',
    `- Total skipped (not in allowlist): ${summary.xlsx_allowlist_filtering.total_skipped_not_in_allowlist}`,
    `- Summary IDs excluded from allowlists: ${summary.xlsx_allowlist_filtering.summary_ids_excluded_count}`,
    `- Missing XLSX sheets: ${summary.xlsx_allowlist_filtering.missing_xlsx_sheet_count}`,
    summary.xlsx_allowlist_filtering.total_skipped_not_in_allowlist > 0 || summary.xlsx_allowlist_filtering.missing_xlsx_sheet_count > 0
      ? [
          '',
          '**Rationale:** The XLSX master file defines the authoritative list of settlements per municipality. Any JS path records whose `munID` is not in the XLSX allowlist (excluding the municipality summary row where `settlementId == munCode`) are excluded.',
          '',
          '### Top Files with Skipped Records:',
          ...Object.entries(summary.xlsx_allowlist_filtering.skipped_by_file)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([file, count]) => `- \`${file}\`: ${count} skipped`),
          '',
          '### Sample Examples:',
          ...summary.xlsx_allowlist_filtering.top_examples.slice(0, 20).map(ex =>
            `- \`${ex.filename}\`: munCode=${ex.mun_code}, munID=${ex.mun_id}`
          ),
          summary.xlsx_allowlist_filtering.missing_xlsx_sheet_count > 0
            ? [
                '',
                '### Missing XLSX Sheets:',
                `Municipality codes with JS files but no matching XLSX sheet: ${summary.xlsx_allowlist_filtering.missing_xlsx_sheet_mun_codes.slice(0, 20).join(', ')}${summary.xlsx_allowlist_filtering.missing_xlsx_sheet_mun_codes.length > 20 ? '...' : ''}`
              ].join('\n')
            : ''
        ].join('\n')
      : 'All JS path records matched XLSX allowlists.',
    '',
    '## Deduplication',
    `- Exact duplicates dropped: ${summary.deduplication.exact_duplicates_dropped}`,
    `- Conflicts resolved: ${summary.deduplication.conflicts_resolved}`,
    summary.deduplication.conflicts_resolved > 0
      ? [
          '',
          '### Top Conflicts (kept vs dropped):',
          ...summary.deduplication.top_conflicts.slice(0, 20).map(c => 
            `- **${c.sid}**: kept \`${c.kept_source}\` (score: ${c.keptScore}) vs dropped \`${c.dropped_source}\` (score: ${c.droppedScore})`
          ),
          '',
          `See \`${conflictsPath}\` for full conflict list.`
        ].join('\n')
      : 'No conflicts found.',
    '',
    '## Geometry Types',
    `- Polygon: ${summary.geometry_type_counts.Polygon}`,
    `- MultiPolygon: ${summary.geometry_type_counts.MultiPolygon}`,
    '',
    '## Global Bounds',
    `- minX: ${summary.global_bounds.minX.toFixed(6)}`,
    `- minY: ${summary.global_bounds.minY.toFixed(6)}`,
    `- maxX: ${summary.global_bounds.maxX.toFixed(6)}`,
    `- maxY: ${summary.global_bounds.maxY.toFixed(6)}`,
    '',
    '## Cluster Diagnostic',
    `- Cluster A size: ${summary.cluster_diagnostic.cluster_a_size}`,
    `- Cluster B size: ${summary.cluster_diagnostic.cluster_b_size}`,
    `- Stray cluster: ${summary.cluster_diagnostic.stray_cluster || 'none'} (${strayClusterPercent.toFixed(2)}%)`,
    `- Cluster A bounds: ${JSON.stringify(summary.cluster_diagnostic.cluster_a_bounds)}`,
    `- Cluster B bounds: ${JSON.stringify(summary.cluster_diagnostic.cluster_b_bounds)}`,
    strayClusterPercent > 0.5
      ? [
          '',
          '**Note:** Stray cluster persists after dedupe; likely genuine coordinate-regime split in source JS pack.',
          '',
          '## Coordinate Regime Diagnosis',
          '',
          'Run `npm run map:diagnose` to generate a detailed diagnosis of which source files are in MAIN vs STRAY coordinate regimes.',
          'The diagnosis will:',
          '- Identify which municipality JS files belong to which regime cluster',
          '- Compute transform hints (offset dx/dy, scale kx/ky) for STRAY sources',
          '- Output `data/derived/mapkit_regime_diagnosis.json` for use in normalization step',
          '',
          '**No transforms applied yet.** Next step is deterministic normalization using the diagnosis artifact.'
        ].join('\n')
      : '',
    '',
    '## Missing XLSX Joins',
    summary.missing_xlsx_joins.count > 0
      ? [
          `Found ${summary.missing_xlsx_joins.count} settlements without XLSX data.`,
          '',
          '### By Municipality:',
          ...(summary.missing_xlsx_joins as any).by_municipality?.map((m: any) => 
            `- **${m.municipality_name}** (${m.municipality_code}): ${m.missing_count} missing - Sample: ${m.sample_sids.join(', ')}`
          ) || [],
          '',
          `All missing SIDs: ${summary.missing_xlsx_joins.sample_sids.slice(0, 20).map(s => `- ${s}`).join('\n')}`
        ].join('\n')
      : 'All settlements have XLSX data.',
    '',
    '## Next Steps for Validation',
    '1. Run validation: `npm run map:regen:validate`',
    '2. Compare with original: `npm run map:validate`',
    '3. View in UI: Open `dev_ui/ui0_map.html?regen=1`',
    '4. Check for missing/misplaced settlements',
    ''
  ];
  
  await writeFile(reportPath, reportLines.join('\n'), 'utf8');
  process.stdout.write(`  Report: ${reportPath}\n`);
  
  process.stdout.write('\nRegeneration complete!\n');
}

main().catch((err) => {
  process.stderr.write(`regenerate_settlements_geojson failed: ${err instanceof Error ? err.message : String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + '\n');
  }
  process.exitCode = 1;
});
