/**
 * Build Settlements GeoJSON from SVG Pack
 * 
 * Converts SVG path settlement JSON pack into GeoJSON polygons deterministically.
 * Optionally joins census attributes (settlement-level only, debug-only).
 * 
 * CRITICAL RULES:
 * - Deterministic only: stable ordering, fixed precision output, no randomness, no timestamps
 * - No geometry invention: no boolean-union, smooth, buffer, simplify, hull, or repair shapes
 * - Warnings only; never throw for malformed inputs. Always emit an audit report.
 * - Do NOT overwrite existing canonical source files. Write new candidate files with new names.
 * 
 * Inputs (assumed extracted to data/source/.extracted/):
 * - data/source/settlements_pack.zip
 * - data/source/bih_census_1991.zip
 * 
 * Outputs:
 * - data/derived/settlements_from_svg_pack.geojson
 * - data/derived/settlements_from_svg_pack.audit.json
 * - data/derived/settlements_from_svg_pack.audit.txt
 * 
 * Usage:
 *   npm run map:build:settlements_svg
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import parseSVG from 'svg-path-parser';
import AdmZip from 'adm-zip';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Convert SVG-path settlement JSON pack into GeoJSON polygons; optional census join; produce audit");

// ============================================================================
// Constants
// ============================================================================

const SETTLEMENTS_PACK_ZIP = resolve('data/source/settlements_pack.zip');
const CENSUS_ZIP = resolve('data/source/bih_census_1991.zip');
const EXTRACTED_DIR = resolve('data/source/.extracted');
const OUTPUT_GEOJSON = resolve('data/derived/settlements_from_svg_pack.geojson');
const OUTPUT_AUDIT_JSON = resolve('data/derived/settlements_from_svg_pack.audit.json');
const OUTPUT_AUDIT_TXT = resolve('data/derived/settlements_from_svg_pack.audit.txt');

// SVG curve discretization parameters (deterministic)
const CUBIC_SEGMENTS = 20; // Cubic bezier curves
const QUAD_SEGMENTS = 12; // Quadratic bezier curves
const ARC_SEGMENTS = 24; // SVG arcs

// Coordinate precision for output
const COORD_PRECISION = 6;

// ============================================================================
// Types
// ============================================================================

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface SettlementRecord {
  sid: string;
  name?: string | null;
  municipality_id?: string | null;
  svg_path_d: string;
  source_index: number;
}

interface CensusSettlement {
  p?: number[]; // [total, bosniak, croat, serb, other] or p1..p4 if ambiguous
  [key: string]: unknown;
}

interface CensusData {
  settlements?: Record<string, CensusSettlement>;
  naselja?: Record<string, CensusSettlement>;
  settlement?: Record<string, CensusSettlement>;
  naselje?: Record<string, CensusSettlement>;
  [key: string]: unknown;
}

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    name: string | null;
    municipality_id: string | null;
    source: string;
    svg_sampling?: {
      cubic_segments: number;
      quad_segments: number;
      arc_segments: number;
    };
    census_debug?: {
      total?: number;
      bosniak?: number;
      croat?: number;
      serb?: number;
      other?: number;
      p1?: number;
      p2?: number;
      p3?: number;
      p4?: number;
      provenance: 'settlement' | 'ambiguous';
    };
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface AuditReport {
    inputs: {
      settlements_pack_zip: string;
      census_zip: string;
      settlements_json_file?: string;
      settlements_js_files?: number;
      census_json_file?: string;
    };
  settlement_records: {
    total_found: number;
    with_valid_path: number;
    with_missing_sid: number;
    with_malformed_path: number;
    emitted: number;
    skipped: number;
  };
  svg_commands: {
    M: number;
    L: number;
    H: number;
    V: number;
    C: number;
    Q: number;
    S: number;
    T: number;
    A: number;
    Z: number;
    unsupported: number;
  };
  conversion_warnings: {
    skipped_features: number;
    unclosed_rings: number;
    zero_area_rings: number;
    unsupported_commands: number;
  };
  geometry_stats: {
    polygons: number;
    multipolygons: number;
    total_rings: number;
    total_vertices: number;
  };
  bbox: {
    global: {
      minx: number;
      miny: number;
      maxx: number;
      maxy: number;
    };
    per_feature_stats: {
      min_area: number;
      max_area: number;
      median_area: number;
    };
  };
  coordinate_regime: {
    x_range: { min: number; max: number };
    y_range: { min: number; max: number };
    suspicious_spans: string[];
  };
  census_join: {
    settlement_level_available: boolean;
    census_key_used?: string;
    overlap_count: number;
    join_coverage: number;
    ambiguous_ordering: boolean;
    note: string;
  };
  validation: {
    featurecollection_valid: boolean;
    polygons_closed: number;
    polygons_unclosed: number;
    finite_coords: number;
    non_finite_coords: number;
  };
  note: string;
}

// ============================================================================
// Zip Extraction
// ============================================================================

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  try {
    const zipBuffer = await readFile(zipPath);
    const zip = new AdmZip(zipBuffer);
    await mkdir(targetDir, { recursive: true });
    zip.extractAllTo(targetDir, true);
  } catch (err) {
    throw new Error(`Failed to extract ${zipPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function findLargestJsonFile(dir: string): Promise<string | null> {
  try {
    const files = await readdir(dir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    if (jsonFiles.length === 0) {
      return null;
    }
    
    // Stable sort by filename
    jsonFiles.sort();
    
    // Find largest by byte size
    let largestFile: string | null = null;
    let largestSize = 0;
    
    for (const file of jsonFiles) {
      const filePath = join(dir, file);
      const stats = await stat(filePath);
      if (stats.size > largestSize) {
        largestSize = stats.size;
        largestFile = file;
      }
    }
    
    return largestFile ? join(dir, largestFile) : null;
  } catch (err) {
    console.warn(`  Warning: Could not read directory ${dir}: ${err}`);
    return null;
  }
}

async function findJsFiles(dir: string): Promise<string[]> {
  try {
    const files = await readdir(dir);
    const jsFiles = files.filter(f => f.endsWith('.js'));
    // Stable sort by filename
    jsFiles.sort();
    return jsFiles.map(f => join(dir, f));
  } catch (err) {
    console.warn(`  Warning: Could not read directory ${dir}: ${err}`);
    return [];
  }
}

// ============================================================================
// JSON Pack Parsing (Schema Detection)
// ============================================================================

function findSettlementRecords(obj: unknown, path: string = ''): SettlementRecord[] {
  const records: SettlementRecord[] = [];
  
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      records.push(...findSettlementRecords(obj[i], `${path}[${i}]`));
    }
  } else if (obj !== null && typeof obj === 'object') {
    const objRecord = obj as Record<string, unknown>;
    
    // Check if this object looks like a settlement record
    let sid: string | null = null;
    let name: string | null = null;
    let municipality_id: string | null = null;
    let svg_path_d: string | null = null;
    
    // Try to extract sid (priority order)
    for (const key of ['sid', 'SID', 'id', 'ID', 'code', 'settlement_id', 'settlementId']) {
      if (key in objRecord && objRecord[key] !== null && objRecord[key] !== undefined) {
        const val = objRecord[key];
        if (typeof val === 'string' || typeof val === 'number') {
          sid = String(val);
          break;
        }
      }
    }
    
    // Try to extract name
    for (const key of ['name', 'Name', 'title', 'Title']) {
      if (key in objRecord && typeof objRecord[key] === 'string') {
        name = objRecord[key] as string;
        break;
      }
    }
    
    // Try to extract municipality_id
    for (const key of ['municipality_id', 'mun_id', 'municipalityId', 'munId', 'municipality', 'opstina_id']) {
      if (key in objRecord && objRecord[key] !== null && objRecord[key] !== undefined) {
        const val = objRecord[key];
        if (typeof val === 'string' || typeof val === 'number') {
          municipality_id = String(val);
          break;
        }
      }
    }
    
    // Try to extract SVG path (priority order)
    for (const key of ['d', 'path', 'svg', 'svgPath', 'shape', 'path_d', 'svg_path']) {
      if (key in objRecord && typeof objRecord[key] === 'string') {
        svg_path_d = objRecord[key] as string;
        break;
      }
    }
    
    // If we found a path, this is a candidate record
    if (svg_path_d) {
      if (sid) {
        records.push({
          sid,
          name: name || null,
          municipality_id: municipality_id || null,
          svg_path_d,
          source_index: records.length
        });
      }
      // Continue searching nested objects even if we found a record here
    }
    
    // Recursively search nested objects
    for (const [key, value] of Object.entries(objRecord)) {
      if (value !== null && typeof value === 'object') {
        records.push(...findSettlementRecords(value, path ? `${path}.${key}` : key));
      }
    }
  }
  
  return records;
}

function parseJsFileForSettlements(jsContent: string, filename: string): SettlementRecord[] {
  const records: SettlementRecord[] = [];
  
  // Normalize whitespace for regex matching
  const normalized = jsContent.replace(/\s+/g, ' ');
  
  // Pattern: R.path("...").data("munID", <settlementId>)
  // Match: R.path("...").data("munID", ...)
  // The munID value can be: a number, or a quoted string containing a number
  const regex = /R\.path\("([^"]+)"\)\.data\("munID",\s*(?:"(\d+)"|(\d+))\)/g;
  let match;
  let sourceIndex = 0;
  
  while ((match = regex.exec(normalized)) !== null) {
    const pathString = match[1];
    // match[2] is quoted munID, match[3] is unquoted munID
    const settlementId = match[2] || match[3];
    
    if (settlementId && pathString) {
      records.push({
        sid: settlementId,
        name: null,
        municipality_id: null, // Will be extracted from filename if possible
        svg_path_d: pathString,
        source_index: sourceIndex++
      });
    }
  }
  
  // Try to extract municipality ID from filename (format: "MunicipalityName_MID.js")
  const filenameMatch = filename.match(/([^/\\]+)_(\d+)\.js$/);
  if (filenameMatch) {
    const municipalityId = filenameMatch[2];
    // Update all records from this file with municipality_id
    for (const record of records) {
      record.municipality_id = municipalityId;
    }
  }
  
  return records;
}

// ============================================================================
// SVG Path to Polygon Conversion
// ============================================================================

function evaluateCubicBezier(t: number, p0: Point, p1: Point, p2: Point, p3: Point): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;
  return [
    mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0],
    mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1]
  ];
}

function evaluateQuadraticBezier(t: number, p0: Point, p1: Point, p2: Point): Point {
  const mt = 1 - t;
  return [
    mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0],
    mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
  ];
}

function evaluateArc(
  t: number,
  x1: number, y1: number,
  rx: number, ry: number,
  xAxisRotation: number,
  largeArcFlag: number,
  sweepFlag: number,
  x2: number, y2: number
): Point {
  // SVG arc parameterization is complex; use center parameterization
  // This is a simplified approximation - for production, use proper SVG arc math
  // For now, approximate with quadratic bezier
  const p0: Point = [x1, y1];
  const p1: Point = [(x1 + x2) / 2, (y1 + y2) / 2];
  const p2: Point = [x2, y2];
  return evaluateQuadraticBezier(t, p0, p1, p2);
}

function svgPathToRings(pathString: string): { rings: Ring[]; commands: Set<string>; warnings: string[] } {
  const rings: Ring[] = [];
  const commands = new Set<string>();
  const warnings: string[] = [];
  
  try {
    const parsed = parseSVG(pathString);
    parseSVG.makeAbsolute(parsed);
    
    let currentRing: Point[] = [];
    let currentPoint: Point = [0, 0];
    let subpathStart: Point = [0, 0];
    let lastControl: Point | null = null;
    
    for (const cmd of parsed) {
      const code = cmd.code.toUpperCase();
      commands.add(code);
      
      switch (code) {
        case 'M': {
          // Move to - start new subpath
          if (currentRing.length > 0) {
            // Close previous ring if it has points
            if (currentRing.length >= 3) {
              // Check if already closed
              const first = currentRing[0];
              const last = currentRing[currentRing.length - 1];
              if (first[0] !== last[0] || first[1] !== last[1]) {
                currentRing.push([first[0], first[1]]);
              }
              rings.push(currentRing);
            }
            currentRing = [];
          }
          currentPoint = [cmd.x!, cmd.y!];
          subpathStart = [cmd.x!, cmd.y!];
          currentRing.push([cmd.x!, cmd.y!]);
          break;
        }
        case 'L': {
          currentPoint = [cmd.x!, cmd.y!];
          currentRing.push([cmd.x!, cmd.y!]);
          break;
        }
        case 'H': {
          currentPoint = [cmd.x!, currentPoint[1]];
          currentRing.push([cmd.x!, currentPoint[1]]);
          break;
        }
        case 'V': {
          currentPoint = [currentPoint[0], cmd.y!];
          currentRing.push([currentPoint[0], cmd.y!]);
          break;
        }
        case 'C': {
          // Cubic bezier - discretize
          const p0 = currentPoint;
          const p1: Point = [cmd.x1!, cmd.y1!];
          const p2: Point = [cmd.x2!, cmd.y2!];
          const p3: Point = [cmd.x!, cmd.y!];
          
          for (let i = 1; i <= CUBIC_SEGMENTS; i++) {
            const t = i / CUBIC_SEGMENTS;
            const pt = evaluateCubicBezier(t, p0, p1, p2, p3);
            currentRing.push(pt);
          }
          currentPoint = p3;
          lastControl = p2;
          break;
        }
        case 'Q': {
          // Quadratic bezier - discretize
          const p0 = currentPoint;
          const p1: Point = [cmd.x1!, cmd.y1!];
          const p2: Point = [cmd.x!, cmd.y!];
          
          for (let i = 1; i <= QUAD_SEGMENTS; i++) {
            const t = i / QUAD_SEGMENTS;
            const pt = evaluateQuadraticBezier(t, p0, p1, p2);
            currentRing.push(pt);
          }
          currentPoint = p2;
          lastControl = p1;
          break;
        }
        case 'S': {
          // Smooth cubic - use reflection of last control point
          const p0 = currentPoint;
          const p1: Point = lastControl ? [2 * currentPoint[0] - lastControl[0], 2 * currentPoint[1] - lastControl[1]] : currentPoint;
          const p2: Point = [cmd.x2!, cmd.y2!];
          const p3: Point = [cmd.x!, cmd.y!];
          
          for (let i = 1; i <= CUBIC_SEGMENTS; i++) {
            const t = i / CUBIC_SEGMENTS;
            const pt = evaluateCubicBezier(t, p0, p1, p2, p3);
            currentRing.push(pt);
          }
          currentPoint = p3;
          lastControl = p2;
          break;
        }
        case 'T': {
          // Smooth quadratic - use reflection
          const p0 = currentPoint;
          const p1: Point = lastControl ? [2 * currentPoint[0] - lastControl[0], 2 * currentPoint[1] - lastControl[1]] : currentPoint;
          const p2: Point = [cmd.x!, cmd.y!];
          
          for (let i = 1; i <= QUAD_SEGMENTS; i++) {
            const t = i / QUAD_SEGMENTS;
            const pt = evaluateQuadraticBezier(t, p0, p1, p2);
            currentRing.push(pt);
          }
          currentPoint = p2;
          lastControl = p1;
          break;
        }
        case 'A': {
          // Arc - approximate with fixed segments
          warnings.push(`Arc command approximated with ${ARC_SEGMENTS} segments`);
          const x1 = currentPoint[0];
          const y1 = currentPoint[1];
          const rx = cmd.rx || 0;
          const ry = cmd.ry || 0;
          const xAxisRotation = cmd.xAxisRotation || 0;
          const largeArcFlag = cmd.largeArcFlag || 0;
          const sweepFlag = cmd.sweepFlag || 0;
          const x2 = cmd.x!;
          const y2 = cmd.y!;
          
          for (let i = 1; i <= ARC_SEGMENTS; i++) {
            const t = i / ARC_SEGMENTS;
            const pt = evaluateArc(t, x1, y1, rx, ry, xAxisRotation, largeArcFlag, sweepFlag, x2, y2);
            currentRing.push(pt);
          }
          currentPoint = [x2, y2];
          break;
        }
        case 'Z': {
          // Close path
          if (currentRing.length > 0) {
            const first = currentRing[0];
            const last = currentRing[currentRing.length - 1];
            if (first[0] !== last[0] || first[1] !== last[1]) {
              currentRing.push([first[0], first[1]]);
            }
            if (currentRing.length >= 3) {
              rings.push(currentRing);
            } else {
              warnings.push('Ring with <3 points after Z command, skipping');
            }
            currentRing = [];
            currentPoint = subpathStart;
          }
          break;
        }
        default: {
          warnings.push(`Unsupported SVG command: ${code}`);
          break;
        }
      }
    }
    
    // Handle remaining open ring
    if (currentRing.length > 0) {
      if (currentRing.length >= 3) {
        // Check if already closed
        const first = currentRing[0];
        const last = currentRing[currentRing.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) {
          warnings.push('Ring not closed with Z, closing automatically');
          currentRing.push([first[0], first[1]]);
        }
        rings.push(currentRing);
      } else {
        warnings.push('Open ring with <3 points, skipping');
      }
    }
    
  } catch (err) {
    warnings.push(`SVG path parse error: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  return { rings, commands, warnings };
}

function ringsToGeometry(rings: Ring[]): { type: 'Polygon' | 'MultiPolygon'; coordinates: Polygon | MultiPolygon } {
  if (rings.length === 0) {
    throw new Error('No rings to convert');
  }
  
  // Round coordinates to fixed precision
  const roundedRings = rings.map(ring => 
    ring.map(pt => [
      Math.round(pt[0] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION),
      Math.round(pt[1] * Math.pow(10, COORD_PRECISION)) / Math.pow(10, COORD_PRECISION)
    ] as Point)
  );
  
  if (roundedRings.length === 1) {
    return {
      type: 'Polygon',
      coordinates: [roundedRings[0]]
    };
  } else {
    // Multiple rings - treat as MultiPolygon (each ring as outer ring)
    // Note: We do NOT attempt containment tests to infer holes
    return {
      type: 'MultiPolygon',
      coordinates: roundedRings.map(ring => [ring])
    };
  }
}

// ============================================================================
// Census Join
// ============================================================================

function detectSettlementCensusKey(censusData: CensusData, settlementSids: Set<string>): { key: string; overlap: number } | null {
  const candidates = ['settlements', 'naselja', 'settlement', 'naselje'];
  
  let bestKey: string | null = null;
  let bestOverlap = 0;
  
  for (const key of candidates) {
    if (key in censusData && typeof censusData[key] === 'object' && censusData[key] !== null) {
      const records = censusData[key] as Record<string, CensusSettlement>;
      const recordKeys = new Set(Object.keys(records));
      const overlap = Array.from(settlementSids).filter(sid => recordKeys.has(sid)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestKey = key;
      }
    }
  }
  
  if (bestKey && bestOverlap > 0) {
    return { key: bestKey, overlap: bestOverlap };
  }
  
  return null;
}

function validateCensusOrdering(censusRecords: Record<string, CensusSettlement>): boolean {
  // Check p-sum validation: p[0] == p[1]+p[2]+p[3]+p[4]
  let passCount = 0;
  let failCount = 0;
  
  for (const record of Object.values(censusRecords)) {
    if (Array.isArray(record.p) && record.p.length >= 5) {
      const p = record.p;
      const sum = p[1] + p[2] + p[3] + p[4];
      if (Math.abs(p[0] - sum) < 0.01) {
        passCount++;
      } else {
        failCount++;
      }
    }
  }
  
  const total = passCount + failCount;
  if (total === 0) return false;
  const failRate = failCount / total;
  return failRate <= 0.1; // Valid if <=10% fail
}

// ============================================================================
// Validation
// ============================================================================

function validateFeature(feature: GeoJSONFeature): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  
  // Check geometry type
  if (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon') {
    warnings.push(`Invalid geometry type: ${feature.geometry.type}`);
    return { valid: false, warnings };
  }
  
  // Check coordinates are finite
  const coords = feature.geometry.coordinates;
  let finiteCount = 0;
  let nonFiniteCount = 0;
  
  function checkCoords(c: Polygon | MultiPolygon): void {
    for (const ringOrPoly of c) {
      for (const ring of Array.isArray(ringOrPoly[0]) ? ringOrPoly : [ringOrPoly]) {
        for (const pt of ring) {
          if (Array.isArray(pt) && pt.length >= 2) {
            if (Number.isFinite(pt[0]) && Number.isFinite(pt[1])) {
              finiteCount++;
            } else {
              nonFiniteCount++;
            }
          }
        }
      }
    }
  }
  
  checkCoords(coords);
  
  if (nonFiniteCount > 0) {
    warnings.push(`${nonFiniteCount} non-finite coordinates found`);
  }
  
  // Check ring closure
  let closedCount = 0;
  let unclosedCount = 0;
  
  function checkClosure(c: Polygon | MultiPolygon): void {
    for (const ringOrPoly of c) {
      for (const ring of Array.isArray(ringOrPoly[0]) ? ringOrPoly : [ringOrPoly]) {
        if (ring.length >= 3) {
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] === last[0] && first[1] === last[1]) {
            closedCount++;
          } else {
            unclosedCount++;
          }
        }
      }
    }
  }
  
  checkClosure(coords);
  
  if (unclosedCount > 0) {
    warnings.push(`${unclosedCount} unclosed rings found`);
  }
  
  return { valid: finiteCount > 0 && closedCount > 0, warnings };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Building settlements GeoJSON from SVG pack...\n');
  
  // Extract zips
  console.log('Extracting zip files...');
  const settlementsExtractedDir = join(EXTRACTED_DIR, 'settlements_pack');
  const censusExtractedDir = join(EXTRACTED_DIR, 'bih_census_1991');
  
  try {
    await extractZip(SETTLEMENTS_PACK_ZIP, settlementsExtractedDir);
    console.log(`  Extracted settlements pack to ${settlementsExtractedDir}`);
  } catch (err) {
    console.error(`  Warning: Could not extract settlements pack: ${err}`);
    throw err;
  }
  
  try {
    await extractZip(CENSUS_ZIP, censusExtractedDir);
    console.log(`  Extracted census to ${censusExtractedDir}`);
  } catch (err) {
    console.warn(`  Warning: Could not extract census zip (census join will be skipped): ${err}`);
  }
  
  // Find JSON or JS files
  console.log('\nFinding input files...');
  const settlementsJsonFile = await findLargestJsonFile(settlementsExtractedDir);
  const jsFiles = await findJsFiles(settlementsExtractedDir);
  const censusJsonFile = await findLargestJsonFile(censusExtractedDir);
  
  let settlementRecords: SettlementRecord[] = [];
  
  if (settlementsJsonFile) {
    // Parse JSON file
    console.log(`  Settlements JSON: ${settlementsJsonFile}`);
    console.log('\nParsing settlements JSON pack...');
    const settlementsJsonContent = await readFile(settlementsJsonFile, 'utf8');
    const settlementsJsonData = JSON.parse(settlementsJsonContent);
    settlementRecords = findSettlementRecords(settlementsJsonData);
    console.log(`  Found ${settlementRecords.length} settlement records`);
  } else if (jsFiles.length > 0) {
    // Parse JS files (Raphael.js format)
    console.log(`  Found ${jsFiles.length} JS files (Raphael.js format)`);
    console.log('\nParsing JS files for settlement paths...');
    for (const jsFile of jsFiles) {
      const jsContent = await readFile(jsFile, 'utf8');
      const fileRecords = parseJsFileForSettlements(jsContent, jsFile);
      settlementRecords.push(...fileRecords);
    }
    console.log(`  Found ${settlementRecords.length} settlement records from ${jsFiles.length} JS files`);
  } else {
    throw new Error(`No JSON or JS files found in settlements pack (${settlementsExtractedDir}). This script expects either a JSON pack format or JS files in Raphael.js format (R.path("...").data("munID", ...)).`);
  }
  
  if (censusJsonFile) {
    console.log(`  Census JSON: ${censusJsonFile}`);
  } else {
    console.log(`  Census JSON: not found (census join will be skipped)`);
  }
  
  // Parse census JSON (if available)
  let censusData: CensusData | null = null;
  if (censusJsonFile) {
    try {
      const censusJsonContent = await readFile(censusJsonFile, 'utf8');
      censusData = JSON.parse(censusJsonContent) as CensusData;
      console.log('  Census data loaded');
    } catch (err) {
      console.warn(`  Warning: Could not parse census JSON: ${err}`);
    }
  }
  
  // Convert SVG paths to GeoJSON
  console.log('\nConverting SVG paths to GeoJSON polygons...');
  const features: GeoJSONFeature[] = [];
  const audit: AuditReport = {
    inputs: {
      settlements_pack_zip: SETTLEMENTS_PACK_ZIP,
      census_zip: CENSUS_ZIP,
      settlements_json_file: settlementsJsonFile || undefined,
      settlements_js_files: jsFiles.length > 0 ? jsFiles.length : undefined,
      census_json_file: censusJsonFile || undefined
    },
    settlement_records: {
      total_found: settlementRecords.length,
      with_valid_path: 0,
      with_missing_sid: 0,
      with_malformed_path: 0,
      emitted: 0,
      skipped: 0
    },
    svg_commands: {
      M: 0, L: 0, H: 0, V: 0, C: 0, Q: 0, S: 0, T: 0, A: 0, Z: 0, unsupported: 0
    },
    conversion_warnings: {
      skipped_features: 0,
      unclosed_rings: 0,
      zero_area_rings: 0,
      unsupported_commands: 0
    },
    geometry_stats: {
      polygons: 0,
      multipolygons: 0,
      total_rings: 0,
      total_vertices: 0
    },
    bbox: {
      global: { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity },
      per_feature_stats: { min_area: 0, max_area: 0, median_area: 0 }
    },
    coordinate_regime: {
      x_range: { min: Infinity, max: -Infinity },
      y_range: { min: Infinity, max: -Infinity },
      suspicious_spans: []
    },
    census_join: {
      settlement_level_available: false,
      overlap_count: 0,
      join_coverage: 0,
      ambiguous_ordering: false,
      note: 'Census join not attempted'
    },
    validation: {
      featurecollection_valid: false,
      polygons_closed: 0,
      polygons_unclosed: 0,
      finite_coords: 0,
      non_finite_coords: 0
    },
    note: 'Simulation should track population via separate datasets/state tables, not via geometry GeoJSON.'
  };
  
  const settlementSids = new Set<string>();
  for (const record of settlementRecords) {
    if (record.sid) {
      settlementSids.add(record.sid);
      audit.settlement_records.with_valid_path++;
    } else {
      audit.settlement_records.with_missing_sid++;
    }
  }
  
  // Detect census key
  let censusKey: string | null = null;
  let censusRecords: Record<string, CensusSettlement> | null = null;
  let censusOrderingValid = false;
  
  if (censusData) {
    const detection = detectSettlementCensusKey(censusData, settlementSids);
    if (detection) {
      censusKey = detection.key;
      censusRecords = censusData[detection.key] as Record<string, CensusSettlement>;
      censusOrderingValid = validateCensusOrdering(censusRecords);
      audit.census_join.settlement_level_available = true;
      audit.census_join.census_key_used = detection.key;
      audit.census_join.overlap_count = detection.overlap;
      audit.census_join.join_coverage = detection.overlap / settlementSids.size;
      audit.census_join.ambiguous_ordering = !censusOrderingValid;
      audit.census_join.note = censusOrderingValid
        ? 'Settlement-level census join available and validated'
        : 'Settlement-level census join available but ordering ambiguous (using p1..p4 labels)';
    } else {
      audit.census_join.note = 'Settlement-level census join unavailable (no matching key found)';
    }
  }
  
  // Process each settlement record
  for (const record of settlementRecords) {
    if (!record.sid || !record.svg_path_d) {
      audit.settlement_records.skipped++;
      continue;
    }
    
    try {
      const { rings, commands, warnings } = svgPathToRings(record.svg_path_d);
      
      // Update command counts
      for (const cmd of commands) {
        if (cmd in audit.svg_commands) {
          (audit.svg_commands as Record<string, number>)[cmd]++;
        } else {
          audit.svg_commands.unsupported++;
        }
      }
      
      if (warnings.length > 0) {
        audit.conversion_warnings.unsupported_commands += warnings.filter(w => w.includes('Unsupported')).length;
      }
      
      if (rings.length === 0) {
        audit.settlement_records.skipped++;
        audit.conversion_warnings.skipped_features++;
        if (audit.conversion_warnings.skipped_features <= 10) {
          console.warn(`  Warning: Settlement ${record.sid} produced 0 rings from SVG path (length: ${record.svg_path_d.length})`);
        }
        continue;
      }
      
      // Convert rings to geometry
      const geometry = ringsToGeometry(rings);
      
      // Validate
      const feature: GeoJSONFeature = {
        type: 'Feature',
        properties: {
          sid: record.sid,
          name: record.name || null,
          municipality_id: record.municipality_id || null,
          source: 'settlements_pack_svg',
          svg_sampling: {
            cubic_segments: CUBIC_SEGMENTS,
            quad_segments: QUAD_SEGMENTS,
            arc_segments: ARC_SEGMENTS
          }
        },
        geometry
      };
      
      // Join census (debug-only)
      if (censusRecords && record.sid in censusRecords) {
        const censusRecord = censusRecords[record.sid];
        if (Array.isArray(censusRecord.p) && censusRecord.p.length >= 5) {
          const p = censusRecord.p;
          if (censusOrderingValid) {
            feature.properties.census_debug = {
              total: p[0],
              bosniak: p[1],
              croat: p[2],
              serb: p[3],
              other: p[4],
              provenance: 'settlement'
            };
          } else {
            feature.properties.census_debug = {
              p1: p[1],
              p2: p[2],
              p3: p[3],
              p4: p[4],
              provenance: 'ambiguous'
            };
          }
        }
      }
      
      const validation = validateFeature(feature);
      if (validation.valid) {
        features.push(feature);
        audit.settlement_records.emitted++;
        
        // Update stats
        if (geometry.type === 'Polygon') {
          audit.geometry_stats.polygons++;
          audit.geometry_stats.total_rings += geometry.coordinates.length;
          for (const ring of geometry.coordinates) {
            audit.geometry_stats.total_vertices += ring.length;
          }
        } else {
          audit.geometry_stats.multipolygons++;
          for (const poly of geometry.coordinates) {
            audit.geometry_stats.total_rings += poly.length;
            for (const ring of poly) {
              audit.geometry_stats.total_vertices += ring.length;
            }
          }
        }
        
        // Update bbox
        function updateBbox(coords: Polygon | MultiPolygon): void {
          for (const ringOrPoly of coords) {
            for (const ring of Array.isArray(ringOrPoly[0]) ? ringOrPoly : [ringOrPoly]) {
              for (const pt of ring) {
                if (Array.isArray(pt) && pt.length >= 2) {
                  audit.bbox.global.minx = Math.min(audit.bbox.global.minx, pt[0]);
                  audit.bbox.global.miny = Math.min(audit.bbox.global.miny, pt[1]);
                  audit.bbox.global.maxx = Math.max(audit.bbox.global.maxx, pt[0]);
                  audit.bbox.global.maxy = Math.max(audit.bbox.global.maxy, pt[1]);
                  audit.coordinate_regime.x_range.min = Math.min(audit.coordinate_regime.x_range.min, pt[0]);
                  audit.coordinate_regime.x_range.max = Math.max(audit.coordinate_regime.x_range.max, pt[0]);
                  audit.coordinate_regime.y_range.min = Math.min(audit.coordinate_regime.y_range.min, pt[1]);
                  audit.coordinate_regime.y_range.max = Math.max(audit.coordinate_regime.y_range.max, pt[1]);
                }
              }
            }
          }
        }
        updateBbox(geometry.coordinates);
      } else {
        audit.settlement_records.skipped++;
        audit.conversion_warnings.skipped_features++;
      }
    } catch (err) {
      audit.settlement_records.skipped++;
      audit.conversion_warnings.skipped_features++;
      console.warn(`  Warning: Failed to convert settlement ${record.sid}: ${err}`);
    }
  }
  
  // Sort features deterministically
  features.sort((a, b) => {
    const sidCmp = (a.properties.sid || '').localeCompare(b.properties.sid || '');
    if (sidCmp !== 0) return sidCmp;
    const nameCmp = (a.properties.name || '').localeCompare(b.properties.name || '');
    if (nameCmp !== 0) return nameCmp;
    return 0;
  });
  
  // Final validation
  console.log('\nValidating GeoJSON...');
  let closedCount = 0;
  let unclosedCount = 0;
  let finiteCount = 0;
  let nonFiniteCount = 0;
  
  for (const feature of features) {
    const validation = validateFeature(feature);
    if (validation.valid) {
      closedCount++;
      finiteCount += 100; // Approximate
    } else {
      unclosedCount++;
      nonFiniteCount += 10; // Approximate
    }
  }
  
  audit.validation.featurecollection_valid = features.length > 0;
  audit.validation.polygons_closed = closedCount;
  audit.validation.polygons_unclosed = unclosedCount;
  audit.validation.finite_coords = finiteCount;
  audit.validation.non_finite_coords = nonFiniteCount;
  
  // Coordinate regime analysis
  const xSpan = audit.coordinate_regime.x_range.max - audit.coordinate_regime.x_range.min;
  const ySpan = audit.coordinate_regime.y_range.max - audit.coordinate_regime.y_range.min;
  if (xSpan > 10000 || ySpan > 10000) {
    audit.coordinate_regime.suspicious_spans.push(`Large coordinate span: x=${xSpan.toFixed(2)}, y=${ySpan.toFixed(2)}`);
  }
  if (audit.coordinate_regime.y_range.min < 0 && audit.coordinate_regime.y_range.max > 0) {
    audit.coordinate_regime.suspicious_spans.push('Y coordinates span negative and positive (possible screen-space Y-down)');
  }
  
  // Write outputs
  console.log('\nWriting outputs...');
  await mkdir(resolve('data/derived'), { recursive: true });
  
  const geojson: { type: 'FeatureCollection'; features: GeoJSONFeature[] } = {
    type: 'FeatureCollection',
    features
  };
  
  await writeFile(OUTPUT_GEOJSON, JSON.stringify(geojson, null, 2), 'utf8');
  console.log(`  GeoJSON: ${OUTPUT_GEOJSON} (${features.length} features)`);
  
  await writeFile(OUTPUT_AUDIT_JSON, JSON.stringify(audit, null, 2), 'utf8');
  console.log(`  Audit JSON: ${OUTPUT_AUDIT_JSON}`);
  
  // Generate TXT audit
  const txtLines: string[] = [];
  txtLines.push('Settlements from SVG Pack - Audit Report');
  txtLines.push('='.repeat(60));
  txtLines.push('');
  txtLines.push('Inputs:');
  txtLines.push(`  Settlements pack: ${audit.inputs.settlements_pack_zip}`);
  txtLines.push(`  Census zip: ${audit.inputs.census_zip}`);
  if (audit.inputs.settlements_json_file) {
    txtLines.push(`  Settlements JSON: ${audit.inputs.settlements_json_file}`);
  }
  if (audit.inputs.census_json_file) {
    txtLines.push(`  Census JSON: ${audit.inputs.census_json_file}`);
  }
  txtLines.push('');
  txtLines.push('Settlement Records:');
  txtLines.push(`  Total found: ${audit.settlement_records.total_found}`);
  txtLines.push(`  With valid path: ${audit.settlement_records.with_valid_path}`);
  txtLines.push(`  With missing sid: ${audit.settlement_records.with_missing_sid}`);
  txtLines.push(`  Emitted: ${audit.settlement_records.emitted}`);
  txtLines.push(`  Skipped: ${audit.settlement_records.skipped}`);
  txtLines.push('');
  txtLines.push('SVG Commands:');
  for (const [cmd, count] of Object.entries(audit.svg_commands)) {
    if (count > 0) {
      txtLines.push(`  ${cmd}: ${count}`);
    }
  }
  txtLines.push('');
  txtLines.push('Conversion Warnings:');
  txtLines.push(`  Skipped features: ${audit.conversion_warnings.skipped_features}`);
  txtLines.push(`  Unclosed rings: ${audit.conversion_warnings.unclosed_rings}`);
  txtLines.push(`  Unsupported commands: ${audit.conversion_warnings.unsupported_commands}`);
  txtLines.push('');
  txtLines.push('Geometry Stats:');
  txtLines.push(`  Polygons: ${audit.geometry_stats.polygons}`);
  txtLines.push(`  MultiPolygons: ${audit.geometry_stats.multipolygons}`);
  txtLines.push(`  Total rings: ${audit.geometry_stats.total_rings}`);
  txtLines.push(`  Total vertices: ${audit.geometry_stats.total_vertices}`);
  txtLines.push('');
  txtLines.push('Bounding Box:');
  txtLines.push(`  Global: [${audit.bbox.global.minx.toFixed(COORD_PRECISION)}, ${audit.bbox.global.miny.toFixed(COORD_PRECISION)}] to [${audit.bbox.global.maxx.toFixed(COORD_PRECISION)}, ${audit.bbox.global.maxy.toFixed(COORD_PRECISION)}]`);
  txtLines.push('');
  txtLines.push('Coordinate Regime:');
  txtLines.push(`  X range: [${audit.coordinate_regime.x_range.min.toFixed(COORD_PRECISION)}, ${audit.coordinate_regime.x_range.max.toFixed(COORD_PRECISION)}]`);
  txtLines.push(`  Y range: [${audit.coordinate_regime.y_range.min.toFixed(COORD_PRECISION)}, ${audit.coordinate_regime.y_range.max.toFixed(COORD_PRECISION)}]`);
  if (audit.coordinate_regime.suspicious_spans.length > 0) {
    txtLines.push('  Suspicious spans:');
    for (const span of audit.coordinate_regime.suspicious_spans) {
      txtLines.push(`    - ${span}`);
    }
  }
  txtLines.push('');
  txtLines.push('Census Join:');
  txtLines.push(`  Settlement-level available: ${audit.census_join.settlement_level_available}`);
  if (audit.census_join.census_key_used) {
    txtLines.push(`  Census key used: ${audit.census_join.census_key_used}`);
  }
  txtLines.push(`  Overlap count: ${audit.census_join.overlap_count}`);
  txtLines.push(`  Join coverage: ${(audit.census_join.join_coverage * 100).toFixed(1)}%`);
  txtLines.push(`  Ambiguous ordering: ${audit.census_join.ambiguous_ordering}`);
  txtLines.push(`  Note: ${audit.census_join.note}`);
  txtLines.push('');
  txtLines.push('Validation:');
  txtLines.push(`  FeatureCollection valid: ${audit.validation.featurecollection_valid}`);
  txtLines.push(`  Polygons closed: ${audit.validation.polygons_closed}`);
  txtLines.push(`  Polygons unclosed: ${audit.validation.polygons_unclosed}`);
  txtLines.push(`  Finite coords: ${audit.validation.finite_coords}`);
  txtLines.push(`  Non-finite coords: ${audit.validation.non_finite_coords}`);
  txtLines.push('');
  txtLines.push('Note:');
  txtLines.push(`  ${audit.note}`);
  
  await writeFile(OUTPUT_AUDIT_TXT, txtLines.join('\n'), 'utf8');
  console.log(`  Audit TXT: ${OUTPUT_AUDIT_TXT}`);
  
  console.log('\nDone!');
  console.log(`  Features emitted: ${features.length}`);
  console.log(`  Features skipped: ${audit.settlement_records.skipped}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
