/**
 * Rebuild Settlements GeoJSON from SVG-based Municipality JS Files
 * 
 * EXPERIMENTAL SCRIPT - NOT CANONICAL
 * 
 * This script rebuilds a settlements GeoJSON from the SVG-based municipality JS files
 * under data/source/settlements. This is an experimental/alternate substrate for
 * inspection and comparison with Phase 0 canonical substrate.
 * 
 * IMPORTANT: This does NOT modify or replace Phase 0 canonical files.
 * Outputs are written to separate paths (svg_substrate/).
 * 
 * Usage:
 *   npm run map:rebuild:svg_substrate
 *   or: tsx scripts/map/rebuild_settlements_geojson_from_svg_js.ts
 * 
 * Outputs:
 *   - data/derived/svg_substrate/settlements_svg_substrate.geojson
 *   - data/derived/svg_substrate/settlements_svg_substrate.audit.json
 *   - data/derived/svg_substrate/settlements_svg_substrate.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import parseSVG from 'svg-path-parser';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Rebuild an experimental settlements GeoJSON from SVG JS sources (data/source/settlements) and create an inspection viewer, without overwriting Phase 0 canonical substrate");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    settlement_name: string | null;
    municipality_id: string | null;
    source_file: string;
    source_shape_id: string;
    transform_applied: {
      viewBox?: { x: number; y: number; width: number; height: number };
      translate?: { x: number; y: number };
      scale?: { x: number; y: number };
      rotate?: number;
      identity: boolean;
    };
    notes?: string[];
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface CensusMunicipality {
  n: string; // name
  s: string[]; // settlement IDs
  p: number[]; // population [total, bosniak, croat, serb, other]
}

interface CensusData {
  metadata?: {
    settlement_count?: number;
    municipality_count?: number;
  };
  municipalities: Record<string, CensusMunicipality>;
}

interface SettlementCensusEntry {
  settlement_id: string;
  municipality_id: string;
  municipality_name: string;
  population: number[];
}

interface ParsedShape {
  path: string;
  munID?: string | number;
  name?: string;
  id?: string | number;
  shapeIndex: number;
}

interface ParsedMunicipalityFile {
  filePath: string;
  relativePath: string;
  municipalityId: string | null;
  viewBox: { x: number; y: number; width: number; height: number } | null;
  shapes: ParsedShape[];
  bounds: { minx: number; miny: number; maxx: number; maxy: number } | null;
}

interface AuditReport {
  total_files_parsed: number;
  total_shapes_extracted: number;
  total_features_emitted: number;
  matched_count: number;
  unmatched_count: number;
  ambiguous_count: number;
  per_file_stats: Array<{
    file: string;
    shapes: number;
    matched: number;
    unmatched: number;
    bounds: { minx: number; miny: number; maxx: number; maxy: number } | null;
    transforms_found: {
      viewBox: boolean;
      translate: boolean;
      scale: boolean;
      rotate: boolean;
    };
  }>;
  geometry_validity: {
    valid: number;
    invalid: number;
    reasons: Record<string, number>;
  };
  top_50_files_by_unmatched: Array<{
    file: string;
    unmatched: number;
  }>;
  top_200_unmatched: Array<{
    sid: string;
    source_file: string;
    source_shape_id: string;
    name_hint: string | null;
    mun_hint: string | null;
  }>;
}

/**
 * Normalize string for matching (trim, uppercase, remove diacritics, collapse whitespace)
 */
function normalizeString(str: string): string {
  return str
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/\s+/g, ' ');
}

/**
 * Flatten curve to line segments deterministically
 */
function flattenCurve(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  x3: number, y3: number,
  segments: number = 16
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
    const y = mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
    points.push([x, y]);
  }
  return points;
}

/**
 * Flatten quadratic curve to line segments deterministically
 */
function flattenQuadraticCurve(
  x0: number, y0: number,
  x1: number, y1: number,
  x2: number, y2: number,
  segments: number = 16
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * x1 + t * t * x2;
    const y = mt * mt * y0 + 2 * mt * t * y1 + t * t * y2;
    points.push([x, y]);
  }
  return points;
}

/**
 * Convert SVG path to GeoJSON polygon coordinates
 */
function svgPathToPolygon(svgPath: string): Polygon | null {
  if (!svgPath || !svgPath.trim()) return null;

  try {
    const commands = parseSVG(svgPath);
    parseSVG.makeAbsolute(commands);
    
    const coordinates: Point[] = [];
    let startX = 0;
    let startY = 0;
    let hasMove = false;
    let lastX = 0;
    let lastY = 0;

    for (const cmd of commands) {
      const code = cmd.code.toUpperCase();

      switch (code) {
        case 'M': {
          const x = cmd.x!;
          const y = cmd.y!;
          if (hasMove && coordinates.length > 0) {
            // Close previous path
            if (coordinates.length > 0 && 
                (coordinates[coordinates.length - 1][0] !== startX || 
                 coordinates[coordinates.length - 1][1] !== startY)) {
              coordinates.push([startX, startY]);
            }
          }
          startX = x;
          startY = y;
          lastX = x;
          lastY = y;
          hasMove = true;
          coordinates.push([x, y]);
          break;
        }
        case 'L': {
          const x = cmd.x!;
          const y = cmd.y!;
          lastX = x;
          lastY = y;
          coordinates.push([x, y]);
          break;
        }
        case 'H': {
          const x = cmd.x!;
          lastX = x;
          coordinates.push([x, lastY]);
          break;
        }
        case 'V': {
          const y = cmd.y!;
          lastY = y;
          coordinates.push([lastX, y]);
          break;
        }
        case 'Z': {
          // Close path
          if (coordinates.length > 0 && 
              (coordinates[coordinates.length - 1][0] !== startX || 
               coordinates[coordinates.length - 1][1] !== startY)) {
            coordinates.push([startX, startY]);
          }
          break;
        }
        case 'C': {
          // Cubic Bezier: flatten deterministically
          const x0 = lastX;
          const y0 = lastY;
          const x1 = cmd.x1!;
          const y1 = cmd.y1!;
          const x2 = cmd.x2!;
          const y2 = cmd.y2!;
          const x3 = cmd.x!;
          const y3 = cmd.y!;
          const curvePoints = flattenCurve(x0, y0, x1, y1, x2, y2, x3, y3, 16);
          // Skip first point (already added as lastX, lastY)
          for (let i = 1; i < curvePoints.length; i++) {
            coordinates.push(curvePoints[i]);
          }
          lastX = x3;
          lastY = y3;
          break;
        }
        case 'Q': {
          // Quadratic Bezier: flatten deterministically
          const x0 = lastX;
          const y0 = lastY;
          const x1 = cmd.x1!;
          const y1 = cmd.y1!;
          const x2 = cmd.x!;
          const y2 = cmd.y!;
          const curvePoints = flattenQuadraticCurve(x0, y0, x1, y1, x2, y2, 16);
          // Skip first point
          for (let i = 1; i < curvePoints.length; i++) {
            coordinates.push(curvePoints[i]);
          }
          lastX = x2;
          lastY = y2;
          break;
        }
        case 'S':
        case 'T':
        case 'A': {
          // Simplified: use end point
          const x = cmd.x!;
          const y = cmd.y!;
          lastX = x;
          lastY = y;
          coordinates.push([x, y]);
          break;
        }
      }
    }

    // Ensure path is closed
    if (coordinates.length > 0 && hasMove &&
        (coordinates[coordinates.length - 1][0] !== startX || 
         coordinates[coordinates.length - 1][1] !== startY)) {
      coordinates.push([startX, startY]);
    }

    if (coordinates.length < 4) return null; // Need at least 4 points for a valid polygon

    // Ensure consistent orientation (counter-clockwise for outer ring)
    const area = computeRingArea(coordinates);
    if (area > 0) {
      // Clockwise, reverse
      coordinates.reverse();
    }

    return [coordinates];
  } catch (err) {
    return null;
  }
}

/**
 * Compute signed area of a ring (positive = counter-clockwise)
 */
function computeRingArea(ring: Point[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    area += ring[i][0] * ring[j][1];
    area -= ring[j][0] * ring[i][1];
  }
  return area / 2;
}

/**
 * Validate polygon geometry
 */
function validatePolygon(polygon: Polygon): { valid: boolean; reason?: string } {
  if (!polygon || polygon.length === 0) {
    return { valid: false, reason: 'empty_polygon' };
  }
  
  const outerRing = polygon[0];
  if (!outerRing || outerRing.length < 4) {
    return { valid: false, reason: 'ring_too_short' };
  }
  
  // Check if closed
  const first = outerRing[0];
  const last = outerRing[outerRing.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { valid: false, reason: 'ring_not_closed' };
  }
  
  // Check all coordinates are finite
  for (const pt of outerRing) {
    if (!isFinite(pt[0]) || !isFinite(pt[1])) {
      return { valid: false, reason: 'non_finite_coords' };
    }
  }
  
  return { valid: true };
}

/**
 * Parse municipality JS file to extract SVG paths and metadata
 */
function parseMunicipalityFile(filePath: string, relativePath: string): ParsedMunicipalityFile {
  const content = readFileSync(filePath, 'utf8');
  
  // Extract municipality ID from filename (format: "Name_ID.js")
  const filenameMatch = filePath.match(/_(\d+)\.js$/);
  const municipalityId = filenameMatch ? filenameMatch[1] : null;
  
  // Extract viewBox: R.setViewBox(x, y, width, height, preserveAspectRatio)
  const viewBoxMatch = content.match(/R\.setViewBox\s*\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/);
  const viewBox = viewBoxMatch ? {
    x: parseFloat(viewBoxMatch[1]),
    y: parseFloat(viewBoxMatch[2]),
    width: parseFloat(viewBoxMatch[3]),
    height: parseFloat(viewBoxMatch[4])
  } : null;
  
  // Extract paths: mun.push(R.path("...").data("munID", ...))
  const shapes: ParsedShape[] = [];
  let shapeIndex = 0;
  
  // Pattern: mun.push(R.path("...").data("munID", number))
  const pathWithMunIDRegex = /R\.path\s*\(\s*"([^"]+)"\s*\)\s*\.data\s*\(\s*"munID"\s*,\s*(\d+)\s*\)/g;
  let match;
  
  while ((match = pathWithMunIDRegex.exec(content)) !== null) {
    const path = match[1];
    const munID = parseInt(match[2], 10);
    shapes.push({
      path,
      munID,
      shapeIndex: shapeIndex++
    });
  }
  
  // Also try pattern without munID: R.path("...")
  // This is a fallback for files that don't have data attributes
  if (shapes.length === 0) {
    const simplePathRegex = /R\.path\s*\(\s*"([^"]+)"\s*\)/g;
    let simpleMatch;
    while ((simpleMatch = simplePathRegex.exec(content)) !== null) {
      const path = simpleMatch[1];
      shapes.push({
        path,
        shapeIndex: shapeIndex++
      });
    }
  }
  
  // Compute bounds from all paths
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let hasBounds = false;
  
  for (const shape of shapes) {
    const polygon = svgPathToPolygon(shape.path);
    if (polygon && polygon[0]) {
      for (const pt of polygon[0]) {
        if (isFinite(pt[0]) && isFinite(pt[1])) {
          minx = Math.min(minx, pt[0]);
          miny = Math.min(miny, pt[1]);
          maxx = Math.max(maxx, pt[0]);
          maxy = Math.max(maxy, pt[1]);
          hasBounds = true;
        }
      }
    }
  }
  
  return {
    filePath,
    relativePath,
    municipalityId,
    viewBox,
    shapes,
    bounds: hasBounds ? { minx, miny, maxx, maxy } : null
  };
}

/**
 * Build flat settlement index from census data
 */
function buildSettlementIndex(census: CensusData): Map<string, SettlementCensusEntry> {
  const index = new Map<string, SettlementCensusEntry>();
  
  for (const [munId, mun] of Object.entries(census.municipalities)) {
    if (!mun.s || !Array.isArray(mun.s)) continue;
    
    for (const settlementId of mun.s) {
      index.set(settlementId, {
        settlement_id: settlementId,
        municipality_id: munId,
        municipality_name: mun.n || '',
        population: mun.p || []
      });
    }
  }
  
  return index;
}

/**
 * Match shape to census entry
 */
function matchShapeToCensus(
  shape: ParsedShape,
  municipalityId: string | null,
  settlementIndex: Map<string, SettlementCensusEntry>
): { matched: true; settlementId: string } | { matched: false; reason: string } {
  // Try by munID if present
  if (shape.munID) {
    const sid = String(shape.munID);
    if (settlementIndex.has(sid)) {
      return { matched: true, settlementId: sid };
    }
  }
  
  // Try by id if present
  if (shape.id) {
    const sid = String(shape.id);
    if (settlementIndex.has(sid)) {
      return { matched: true, settlementId: sid };
    }
  }
  
  // Try by name + municipality if both present
  if (shape.name && municipalityId) {
    // This would require name normalization and matching
    // For now, mark as unmatched
  }
  
  return { matched: false, reason: 'no_matching_id' };
}

async function main(): Promise<void> {
  const settlementsDir = resolve('data/source/settlements');
  const censusPath = resolve('data/source/bih_census_1991.json');
  const outputDir = resolve('data/derived/svg_substrate');
  const geojsonPath = resolve(outputDir, 'settlements_svg_substrate.geojson');
  const auditJsonPath = resolve(outputDir, 'settlements_svg_substrate.audit.json');
  const auditTxtPath = resolve(outputDir, 'settlements_svg_substrate.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });
  
  // Load census
  process.stdout.write(`Loading census from ${censusPath}...\n`);
  const censusContent = readFileSync(censusPath, 'utf8');
  const census = JSON.parse(censusContent) as CensusData;
  const settlementIndex = buildSettlementIndex(census);
  process.stdout.write(`Loaded ${settlementIndex.size} settlements from census\n`);
  
  // Discover municipality JS files
  process.stdout.write(`Discovering municipality JS files in ${settlementsDir}...\n`);
  const files: string[] = [];
  
  function discoverFiles(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        discoverFiles(fullPath);
      } else if (entry.endsWith('.js')) {
        files.push(fullPath);
      }
    }
  }
  
  discoverFiles(settlementsDir);
  files.sort(); // Deterministic ordering
  
  process.stdout.write(`Found ${files.length} JS files\n`);
  
  // Parse all files
  const parsedFiles: ParsedMunicipalityFile[] = [];
  for (const file of files) {
    const relativePath = relative(settlementsDir, file);
    const parsed = parseMunicipalityFile(file, relativePath);
    parsedFiles.push(parsed);
  }
  
  // Build features
  const features: GeoJSONFeature[] = [];
  const audit: AuditReport = {
    total_files_parsed: parsedFiles.length,
    total_shapes_extracted: 0,
    total_features_emitted: 0,
    matched_count: 0,
    unmatched_count: 0,
    ambiguous_count: 0,
    per_file_stats: [],
    geometry_validity: {
      valid: 0,
      invalid: 0,
      reasons: {}
    },
    top_50_files_by_unmatched: [],
    top_200_unmatched: []
  };
  
  const unmatchedList: Array<{
    sid: string;
    source_file: string;
    source_shape_id: string;
    name_hint: string | null;
    mun_hint: string | null;
  }> = [];
  
  for (const parsedFile of parsedFiles) {
    const fileStats = {
      file: parsedFile.relativePath,
      shapes: parsedFile.shapes.length,
      matched: 0,
      unmatched: 0,
      bounds: parsedFile.bounds,
      transforms_found: {
        viewBox: parsedFile.viewBox !== null,
        translate: false,
        scale: false,
        rotate: false
      }
    };
    
    audit.total_shapes_extracted += parsedFile.shapes.length;
    
    for (const shape of parsedFile.shapes) {
      const polygon = svgPathToPolygon(shape.path);
      if (!polygon) {
        audit.geometry_validity.invalid++;
        audit.geometry_validity.reasons['parse_failed'] = (audit.geometry_validity.reasons['parse_failed'] || 0) + 1;
        continue;
      }
      
      const validation = validatePolygon(polygon);
      if (!validation.valid) {
        audit.geometry_validity.invalid++;
        audit.geometry_validity.reasons[validation.reason || 'unknown'] = 
          (audit.geometry_validity.reasons[validation.reason || 'unknown'] || 0) + 1;
        continue;
      }
      
      audit.geometry_validity.valid++;
      
      // Match to census
      const match = matchShapeToCensus(shape, parsedFile.municipalityId, settlementIndex);
      
      let sid: string;
      let settlementName: string | null = null;
      let municipalityId: string | null = parsedFile.municipalityId;
      const notes: string[] = [];
      
      if (match.matched) {
        sid = `S${match.settlementId}`;
        const censusEntry = settlementIndex.get(match.settlementId);
        if (censusEntry) {
          settlementName = censusEntry.municipality_name; // Note: this is municipality name, not settlement name
          municipalityId = censusEntry.municipality_id;
        }
        audit.matched_count++;
        fileStats.matched++;
      } else {
        sid = `UNMATCHED::${parsedFile.municipalityId || 'unknown'}::${shape.shapeIndex}`;
        audit.unmatched_count++;
        fileStats.unmatched++;
        notes.push('unmatched_census');
        
        unmatchedList.push({
          sid,
          source_file: parsedFile.relativePath,
          source_shape_id: `shape_${shape.shapeIndex}`,
          name_hint: shape.name || null,
          mun_hint: parsedFile.municipalityId
        });
      }
      
      // Build transform info
      const transformApplied = {
        viewBox: parsedFile.viewBox || undefined,
        translate: undefined,
        scale: undefined,
        rotate: undefined,
        identity: parsedFile.viewBox === null
      };
      
      const feature: GeoJSONFeature = {
        type: 'Feature',
        properties: {
          sid,
          settlement_name: settlementName,
          municipality_id: municipalityId,
          source_file: parsedFile.relativePath,
          source_shape_id: `shape_${shape.shapeIndex}`,
          transform_applied: transformApplied,
          notes: notes.length > 0 ? notes : undefined
        },
        geometry: {
          type: 'Polygon',
          coordinates: polygon
        }
      };
      
      features.push(feature);
      audit.total_features_emitted++;
    }
    
    audit.per_file_stats.push(fileStats);
  }
  
  // Sort features deterministically by sid
  features.sort((a, b) => a.properties.sid.localeCompare(b.properties.sid));
  
  // Build GeoJSON
  const geoJSON: GeoJSONFC = {
    type: 'FeatureCollection',
    features
  };
  
  // Write GeoJSON
  writeFileSync(geojsonPath, JSON.stringify(geoJSON, null, 2), 'utf8');
  process.stdout.write(`Wrote ${features.length} features to ${geojsonPath}\n`);
  
  // Sort unmatched list and take top 200
  unmatchedList.sort((a, b) => a.sid.localeCompare(b.sid));
  audit.top_200_unmatched = unmatchedList.slice(0, 200);
  
  // Sort files by unmatched count
  const filesByUnmatched = [...audit.per_file_stats]
    .sort((a, b) => b.unmatched - a.unmatched)
    .slice(0, 50)
    .map(s => ({ file: s.file, unmatched: s.unmatched }));
  audit.top_50_files_by_unmatched = filesByUnmatched;
  
  // Write audit JSON
  writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2), 'utf8');
  process.stdout.write(`Wrote audit JSON to ${auditJsonPath}\n`);
  
  // Write audit TXT
  const auditTxt = [
    'SVG SUBSTRATE REBUILD AUDIT',
    '='.repeat(50),
    '',
    `Total files parsed: ${audit.total_files_parsed}`,
    `Total shapes extracted: ${audit.total_shapes_extracted}`,
    `Total features emitted: ${audit.total_features_emitted}`,
    '',
    'Matching:',
    `  Matched: ${audit.matched_count}`,
    `  Unmatched: ${audit.unmatched_count}`,
    `  Ambiguous: ${audit.ambiguous_count}`,
    '',
    'Geometry validity:',
    `  Valid: ${audit.geometry_validity.valid}`,
    `  Invalid: ${audit.geometry_validity.invalid}`,
    '  Reasons:',
    ...Object.entries(audit.geometry_validity.reasons).map(([reason, count]) => `    ${reason}: ${count}`),
    '',
    'Top 50 files by unmatched count:',
    ...audit.top_50_files_by_unmatched.map(s => `  ${s.file}: ${s.unmatched} unmatched`),
    '',
    'Top 200 unmatched entries:',
    ...audit.top_200_unmatched.map(e => `  ${e.sid} (${e.source_file}, ${e.source_shape_id})`),
  ].join('\n');
  
  writeFileSync(auditTxtPath, auditTxt, 'utf8');
  process.stdout.write(`Wrote audit TXT to ${auditTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Files parsed: ${audit.total_files_parsed}\n`);
  process.stdout.write(`  Shapes extracted: ${audit.total_shapes_extracted}\n`);
  process.stdout.write(`  Features emitted: ${audit.total_features_emitted}\n`);
  process.stdout.write(`  Matched: ${audit.matched_count}\n`);
  process.stdout.write(`  Unmatched: ${audit.unmatched_count}\n`);
  process.stdout.write(`  Valid geometry: ${audit.geometry_validity.valid}\n`);
  process.stdout.write(`  Invalid geometry: ${audit.geometry_validity.invalid}\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
