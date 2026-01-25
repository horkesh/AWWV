/**
 * Map Build Pipeline: Rebuild deterministic map substrate from source files
 * 
 * Sources:
 *   - data/source/master_settlements.xlsx (settlement census data)
 *   - data/source/settlements_pack.zip (SVG geometry data)
 * 
 * Outputs (data/derived/):
 *   - settlements_meta.csv
 *   - settlement_points.geojson
 *   - settlement_polygons.geojson
 *   - municipality_outline.geojson
 *   - geometry_report.json
 *   - build_fingerprint.txt
 * 
 * Usage:
 *   tsx tools/map/build_map.ts
 *   pnpm build:map
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import * as turf from '@turf/turf';
import booleanValid from '@turf/boolean-valid';
import concaveman from 'concaveman';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';
import { chooseSettlementRing, ringToCoords } from './geometry_pipeline';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: build settlements + municipality outlines from excel + pack");
loadLedger();
assertLedgerFresh("map rebuild: build settlements + municipality outlines from excel + pack");

// ============================================================================
// Types
// ============================================================================

interface SettlementMeta {
  sid: string;
  name: string;
  mid: string;
  municipality_name: string;
  lat: number | null;
  lon: number | null;
  source_row_id: string;
}

interface GeometryIndexEntry {
  svg_file: string;
  svg_path_count: number;
  svg_d_concat: string;
}

interface GeometryIndex {
  by_sid: Map<string, GeometryIndexEntry>;
  by_mid_name: Map<string, GeometryIndexEntry>;
}

interface ParsedSheet {
  municipality_id: string;
  municipality_name: string;
  settlements: Array<{
    settlement_name: string;
    settlement_id: string | null;
    total_population: number | null;
    lat: number | null;
    lon: number | null;
    [key: string]: unknown;
  }>;
  aggregate_row_count: number;
}

interface GeometryReport {
  input_hashes: {
    excel: string;
    zip: string;
  };
  counts: {
    settlements_total: number;
    aggregate_rows_filtered: number;
    points_created: number;
    polygons_kept: number;
    polygons_dropped: number;
    municipalities_derived: number;
  };
  polygon_drop_reasons: Record<string, number>;
  crs: string;
  bounds: {
    min_x: number;
    min_y: number;
    max_x: number;
    max_y: number;
  };
  municipality_coverage: {
    percent_points_contained: number;
    municipalities_with_all_contained: number;
    municipalities_with_some_outside: number;
  };
  offenders: {
    sids_dropped: string[];
    mids_failed_coverage: string[];
  };
  build_params: {
    coordinate_precision: number;
    concave_hull_concavity: number;
    concave_hull_length_threshold: number;
  };
  tool_version: string;
}

// ============================================================================
// Constants
// ============================================================================

const EXCEL_PATH = resolve('data/source/master_settlements.xlsx');
const ZIP_PATH = resolve('data/source/settlements_pack.zip');
const WORK_DIR = resolve('data/work');
const PACK_UNPACK_DIR = join(WORK_DIR, 'settlements_pack');
const DERIVED_DIR = resolve('data/derived');

const COORDINATE_PRECISION = 6;
const CONCAVE_HULL_CONCAVITY = 2.0;
const CONCAVE_HULL_LENGTH_THRESHOLD = 0;
const POINT_IN_POLYGON_TOLERANCE = 1e-6;

// ============================================================================
// Utilities
// ============================================================================

/**
 * Normalize name: trim, collapse whitespace, lowercase, remove diacritics
 */
function normalizeName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Check if a row is an aggregate row (contains "∑" symbol)
 */
function isAggregateRow(row: XLSX.CellObject[]): boolean {
  for (const cell of row) {
    if (cell && cell.v != null) {
      const cellStr = String(cell.v);
      if (cellStr.includes('∑')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get cell value as string, null if empty
 */
function getCellString(cell: XLSX.CellObject | undefined): string | null {
  if (!cell || cell.v == null) return null;
  return String(cell.v).trim() || null;
}

/**
 * Get cell value as number, null if not a number
 */
function getCellNumber(cell: XLSX.CellObject | undefined): number | null {
  if (!cell || cell.v == null) return null;
  const val = cell.v;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const num = parseFloat(val.trim());
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Round coordinate to fixed precision
 */
function roundCoord(value: number): number {
  return Math.round(value * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION);
}

/**
 * Canonicalize JSON (stable key ordering)
 */
function canonicalizeJSON(obj: unknown): string {
  return JSON.stringify(obj, Object.keys(obj as Record<string, unknown>).sort(), 2);
}

/**
 * Compute SHA256 hash of file
 */
async function hashFile(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Compute deterministic build fingerprint
 */
async function computeFingerprint(
  excelHash: string,
  zipHash: string,
  report: GeometryReport
): Promise<string> {
  const fingerprintData = {
    excel_hash: excelHash,
    zip_hash: zipHash,
    build_params: report.build_params,
    tool_version: report.tool_version,
    counts: report.counts
  };
  const json = canonicalizeJSON(fingerprintData);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

// ============================================================================
// Excel Parsing
// ============================================================================

async function parseExcelFile(xlsxPath: string): Promise<{
  sheets: Map<string, ParsedSheet>;
  aggregateRowsFiltered: number;
}> {
  const buffer = await readFile(xlsxPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  const sheets = new Map<string, ParsedSheet>();
  let aggregateRowsFiltered = 0;

  // Try to load municipality mapping from existing file
  let municipalityIdMap = new Map<string, string>();
  try {
    const munPath = resolve('data/source/master_municipalities.json');
    const existing = JSON.parse(await readFile(munPath, 'utf8')) as { municipalities?: Array<{ municipality_id: string; name: string }> };
    if (existing.municipalities) {
      for (const muni of existing.municipalities) {
        municipalityIdMap.set(normalizeName(muni.name), muni.municipality_id);
      }
    }
  } catch {
    // File doesn't exist or invalid, will derive IDs
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    
    // Find header row
    const namePatterns = ['settlement', 'name', 'naselje', 'naziv', 'ime'];
    const popPatterns = ['total', 'population', 'ukupno', 'stanovništvo', 'populacija', 'stanovnika'];
    
    let headerRow = -1;
    const headerMap = new Map<string, number>();
    
    for (let r = range.s.r; r <= Math.min(range.s.r + 20, range.e.r); r++) {
      let foundNameCol = false;
      let foundPopCol = false;
      const rowHeaderMap = new Map<string, number>();
      
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v != null) {
          const headerStr = String(cell.v).toLowerCase().trim();
          const normalized = headerStr.replace(/\s+/g, '_');
          rowHeaderMap.set(normalized, c);
          
          if (namePatterns.some(p => headerStr.includes(p))) {
            foundNameCol = true;
          }
          if (popPatterns.some(p => headerStr.includes(p))) {
            foundPopCol = true;
          }
        }
      }
      
      if (foundNameCol && foundPopCol) {
        headerRow = r;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })];
          if (cell && cell.v != null) {
            const headerStr = String(cell.v).toLowerCase().trim().replace(/\s+/g, '_');
            headerMap.set(headerStr, c);
          }
        }
        break;
      }
    }

    if (headerRow === -1) {
      console.warn(`Warning: Could not detect header row in sheet "${sheetName}", skipping`);
      continue;
    }

    // Find municipality name
    let municipalityName = sheetName;
    for (let r = range.s.r; r < headerRow; r++) {
      for (let c = range.s.c; c <= Math.min(range.s.c + 5, range.e.c); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v && typeof cell.v === 'string') {
          const val = cell.v.trim();
          if (val.startsWith('#') || /^\d+$/.test(val) || val.length < 3) continue;
          if (val.includes('Pretraži') || val.includes('Search') || val.includes(':')) continue;
          if (val.length > 2 && !val.includes('Popis') && !val.includes('**')) {
            municipalityName = val;
            break;
          }
        }
      }
      if (municipalityName !== sheetName) break;
    }

    // Derive municipality_id
    let municipalityId: string;
    const normalizedName = normalizeName(municipalityName);
    if (municipalityIdMap.has(normalizedName)) {
      municipalityId = municipalityIdMap.get(normalizedName)!;
    } else {
      const match = sheetName.match(/(\d+)/);
      if (match) {
        municipalityId = match[1];
      } else {
        // Use hash-based ID (deterministic)
        let hash = 0;
        for (let i = 0; i < sheetName.length; i++) {
          hash = ((hash << 5) - hash) + sheetName.charCodeAt(i);
          hash = hash & hash;
        }
        municipalityId = String(1000000 + (Math.abs(hash) % 900000));
      }
      municipalityIdMap.set(normalizedName, municipalityId);
    }

    // Parse data rows
    const settlements: ParsedSheet['settlements'] = [];
    let aggregateCount = 0;

    // Find column indices
    const settlementNameCol = Array.from(headerMap.entries()).find(([k]) => 
      namePatterns.some(p => k.includes(p))
    )?.[1] ?? 0;
    
    const settlementIdCol = Array.from(headerMap.entries()).find(([k]) => 
      (k.includes('id') || k.includes('šifra') || k.includes('sifra')) && !k.includes('mun')
    )?.[1];
    
    const latCol = Array.from(headerMap.entries()).find(([k]) => 
      k.includes('lat') || k.includes('latitude')
    )?.[1];
    
    const lonCol = Array.from(headerMap.entries()).find(([k]) => 
      k.includes('lon') || k.includes('lng') || k.includes('longitude')
    )?.[1];

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const rowCells: XLSX.CellObject[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        rowCells.push(sheet[XLSX.utils.encode_cell({ r, c })]);
      }

      // CRITICAL: Filter aggregate rows (∑ symbol)
      if (isAggregateRow(rowCells)) {
        aggregateCount++;
        aggregateRowsFiltered++;
        continue;
      }

      const settlementName = getCellString(rowCells[settlementNameCol]);
      if (!settlementName) continue;

      // Skip header-like rows
      const normalizedSettlementName = normalizeName(settlementName);
      const headerPatterns = [
        'naseljeno', 'mjesto', 'settlement', 'name', 'naziv', 'ime',
        'ukupno', 'total', 'population', 'populacija'
      ];
      if (headerPatterns.some(p => normalizedSettlementName === normalizeName(p))) {
        continue;
      }

      const settlement: ParsedSheet['settlements'][0] = {
        settlement_name: settlementName,
        settlement_id: settlementIdCol != null ? getCellString(rowCells[settlementIdCol]) : null,
        total_population: null, // Not needed for geometry build
        lat: latCol != null ? getCellNumber(rowCells[latCol]) : null,
        lon: lonCol != null ? getCellNumber(rowCells[lonCol]) : null
      };

      settlements.push(settlement);
    }

    sheets.set(sheetName, {
      municipality_id: municipalityId,
      municipality_name: municipalityName,
      settlements,
      aggregate_row_count: aggregateCount
    });
  }

  return { sheets, aggregateRowsFiltered };
}

// ============================================================================
// ZIP Parsing
// ============================================================================

async function parseSvgPack(zipPath: string): Promise<GeometryIndex> {
  const zipBuffer = await readFile(zipPath);
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  
  const index: GeometryIndex = {
    by_sid: new Map(),
    by_mid_name: new Map()
  };

  for (const entry of entries) {
    if (!entry.entryName.endsWith('.svg') && !entry.entryName.endsWith('.js')) continue;

    const content = entry.getData().toString('utf8');
    
    try {
      let paths: string[] = [];
      
      // Try SVG format first
      const svgPathRegex = /<path[^>]*\s+d\s*=\s*["']([^"']+)["'][^>]*>/gi;
      let match;
      while ((match = svgPathRegex.exec(content)) !== null) {
        if (match[1]) {
          paths.push(match[1]);
        }
      }
      
      // Try JS format (Raphael.js style)
      if (paths.length === 0) {
        const jsPathRegex = /\.path\s*\(\s*["']([^"']+)["']/gi;
        while ((match = jsPathRegex.exec(content)) !== null) {
          if (match[1]) {
            paths.push(match[1]);
          }
        }
      }
      
      const svgDConcat = paths.join(' | ');
      const svgPathCount = paths.length;

      if (svgPathCount === 0) continue;

      const filename = entry.entryName.replace(/\.(svg|js)$/i, '').replace(/^.*[\\/]/, '');
      
      // Try to extract SID from filename
      const sidMatch = filename.match(/^(\d+)$/);
      if (sidMatch) {
        index.by_sid.set(sidMatch[1], {
          svg_file: entry.entryName,
          svg_path_count: svgPathCount,
          svg_d_concat: svgDConcat
        });
      } else {
        // Try pattern: <mid>_<name>
        const midNameMatch = filename.match(/^(\d+)_(.+)$/);
        if (midNameMatch) {
          const mid = midNameMatch[1];
          const name = midNameMatch[2];
          const key = `${mid}:${normalizeName(name)}`;
          index.by_mid_name.set(key, {
            svg_file: entry.entryName,
            svg_path_count: svgPathCount,
            svg_d_concat: svgDConcat
          });
        } else {
          const key = normalizeName(filename);
          index.by_mid_name.set(key, {
            svg_file: entry.entryName,
            svg_path_count: svgPathCount,
            svg_d_concat: svgDConcat
          });
        }
      }
    } catch (err) {
      // Skip invalid files
      continue;
    }
  }

  return index;
}

// ============================================================================
// Main Build Function
// ============================================================================

async function main(): Promise<void> {
  console.log('Building map from source files...\n');

  // Ensure directories exist
  await mkdir(WORK_DIR, { recursive: true });
  await mkdir(DERIVED_DIR, { recursive: true });

  // Clear unpack directory
  try {
    await rm(PACK_UNPACK_DIR, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }

  // Compute input hashes
  console.log('Computing input hashes...');
  const excelHash = await hashFile(EXCEL_PATH);
  const zipHash = await hashFile(ZIP_PATH);
  console.log(`  Excel hash: ${excelHash.substring(0, 16)}...`);
  console.log(`  ZIP hash: ${zipHash.substring(0, 16)}...\n`);

  // Parse Excel
  console.log('Parsing Excel file...');
  const { sheets, aggregateRowsFiltered } = await parseExcelFile(EXCEL_PATH);
  console.log(`  Loaded ${sheets.size} municipality sheets`);
  console.log(`  Filtered ${aggregateRowsFiltered} aggregate rows (∑)\n`);

  // Parse ZIP
  console.log('Parsing SVG pack...');
  const geometryIndex = await parseSvgPack(ZIP_PATH);
  console.log(`  Indexed ${geometryIndex.by_sid.size} SVGs by SID`);
  console.log(`  Indexed ${geometryIndex.by_mid_name.size} SVGs by name\n`);

  // Collect all settlements
  const allSettlements: SettlementMeta[] = [];
  const allSettlementIds = new Set<string>();
  const settlementGeometry = new Map<string, { polygon: turf.Feature<turf.Polygon> | null; point: turf.Feature<turf.Point> | null }>();
  const municipalitySettlements = new Map<string, SettlementMeta[]>();
  const polygonDropReasons: Record<string, number> = {};

  for (const [sheetName, sheetData] of sheets.entries()) {
    const mid = sheetData.municipality_id;
    const municipalitySettlementsList: SettlementMeta[] = [];

    for (const settlement of sheetData.settlements) {
      // Generate or use settlement ID
      let sid: string;
      if (settlement.settlement_id && !allSettlementIds.has(settlement.settlement_id)) {
        sid = settlement.settlement_id;
      } else if (settlement.settlement_id) {
        // Duplicate ID - generate new one deterministically
        const normalizedName = normalizeName(settlement.settlement_name);
        let hash = 0;
        for (let i = 0; i < `${mid}:${normalizedName}`.length; i++) {
          hash = ((hash << 5) - hash) + `${mid}:${normalizedName}`.charCodeAt(i);
          hash = hash & hash;
        }
        sid = String(900000000 + (Math.abs(hash) % 90000000));
        while (allSettlementIds.has(sid)) {
          sid = String(parseInt(sid) + 1);
        }
      } else {
        // Generate deterministic ID
        const normalizedName = normalizeName(settlement.settlement_name);
        let hash = 0;
        for (let i = 0; i < `${mid}:${normalizedName}`.length; i++) {
          hash = ((hash << 5) - hash) + `${mid}:${normalizedName}`.charCodeAt(i);
          hash = hash & hash;
        }
        sid = String(900000000 + (Math.abs(hash) % 90000000));
        while (allSettlementIds.has(sid)) {
          sid = String(parseInt(sid) + 1);
        }
      }
      
      allSettlementIds.add(sid);

      // Find geometry
      let svgEntry: GeometryIndexEntry | undefined;
      svgEntry = geometryIndex.by_sid.get(sid);
      if (!svgEntry) {
        const normalizedName = normalizeName(settlement.settlement_name);
        const midNameKey = `${mid}:${normalizedName}`;
        svgEntry = geometryIndex.by_mid_name.get(midNameKey);
        if (!svgEntry) {
          svgEntry = geometryIndex.by_mid_name.get(normalizedName);
        }
      }

      const meta: SettlementMeta = {
        sid,
        name: settlement.settlement_name,
        mid,
        municipality_name: sheetData.municipality_name,
        lat: settlement.lat ? roundCoord(settlement.lat) : null,
        lon: settlement.lon ? roundCoord(settlement.lon) : null,
        source_row_id: `${sheetName}:${settlement.settlement_name}`
      };

      allSettlements.push(meta);
      municipalitySettlementsList.push(meta);

      // Process geometry
      let polygon: turf.Feature<turf.Polygon> | null = null;
      let point: turf.Feature<turf.Point> | null = null;

      if (svgEntry && svgEntry.svg_d_concat) {
        // Process SVG path to polygon
        const result = chooseSettlementRing(svgEntry.svg_d_concat);
        
        if (result.ring) {
          const coords = ringToCoords(result.ring);
          if (coords.length >= 3) {
            // Close ring
            const closedCoords = [...coords];
            if (closedCoords[0][0] !== closedCoords[closedCoords.length - 1][0] ||
                closedCoords[0][1] !== closedCoords[closedCoords.length - 1][1]) {
              closedCoords.push([closedCoords[0][0], closedCoords[0][1]]);
            }

            // Round coordinates
            const roundedCoords = closedCoords.map(([x, y]) => [roundCoord(x), roundCoord(y)]);

            try {
              const turfPoly = turf.polygon([roundedCoords]);
              if (booleanValid(turfPoly) || turf.area(turfPoly) > 0) {
                polygon = turfPoly;
              } else {
                polygonDropReasons['gis_invalid'] = (polygonDropReasons['gis_invalid'] || 0) + 1;
              }
            } catch {
              polygonDropReasons['conversion_error'] = (polygonDropReasons['conversion_error'] || 0) + 1;
            }
          } else {
            polygonDropReasons['too_few_points'] = (polygonDropReasons['too_few_points'] || 0) + 1;
          }
        } else {
          const reason = result.drop_reason || 'unknown';
          polygonDropReasons[reason] = (polygonDropReasons[reason] || 0) + 1;
        }
      }

      // Create point (from lat/lon or polygon centroid)
      if (meta.lat != null && meta.lon != null) {
        point = turf.point([roundCoord(meta.lon), roundCoord(meta.lat)]);
      } else if (polygon) {
        const centroid = turf.centroid(polygon);
        point = centroid;
        meta.lat = roundCoord(centroid.geometry.coordinates[1]);
        meta.lon = roundCoord(centroid.geometry.coordinates[0]);
      } else {
        // No geometry - skip point
      }

      settlementGeometry.set(sid, { polygon, point });
    }

    municipalitySettlements.set(mid, municipalitySettlementsList);
  }

  // Sort settlements by sid for determinism
  allSettlements.sort((a, b) => {
    const aNum = parseInt(a.sid, 10) || 0;
    const bNum = parseInt(b.sid, 10) || 0;
    return aNum - bNum;
  });

  console.log(`Processed ${allSettlements.length} settlements`);
  console.log(`  With polygons: ${Array.from(settlementGeometry.values()).filter(g => g.polygon).length}`);
  console.log(`  With points: ${Array.from(settlementGeometry.values()).filter(g => g.point).length}\n`);

  // CRITICAL CHECK: Assert no ∑ in outputs
  for (const settlement of allSettlements) {
    if (settlement.name.includes('∑') || settlement.sid.includes('∑') || settlement.mid.includes('∑')) {
      throw new Error(`INVARIANT VIOLATION: Aggregate row detected in settlement: ${settlement.sid} (${settlement.name})`);
    }
  }

  // Write settlements_meta.csv
  console.log('Writing settlements_meta.csv...');
  const csvLines = ['sid,name,mid,municipality_name,lat,lon,source_row_id'];
  for (const settlement of allSettlements) {
    const line = [
      settlement.sid,
      `"${settlement.name.replace(/"/g, '""')}"`,
      settlement.mid,
      `"${settlement.municipality_name.replace(/"/g, '""')}"`,
      settlement.lat ?? '',
      settlement.lon ?? '',
      `"${settlement.source_row_id.replace(/"/g, '""')}"`
    ].join(',');
    csvLines.push(line);
  }
  await writeFile(
    join(DERIVED_DIR, 'settlements_meta.csv'),
    csvLines.join('\n') + '\n',
    'utf8'
  );
  console.log(`  Wrote ${allSettlements.length} settlements\n`);

  // Write settlement_points.geojson
  console.log('Writing settlement_points.geojson...');
  const points: turf.Feature<turf.Point>[] = [];
  for (const settlement of allSettlements) {
    const geom = settlementGeometry.get(settlement.sid);
    if (geom?.point) {
      points.push(turf.point(geom.point.geometry.coordinates, {
        sid: settlement.sid,
        mid: settlement.mid
      }));
    }
  }
  points.sort((a, b) => {
    const aSid = a.properties?.sid || '';
    const bSid = b.properties?.sid || '';
    return aSid.localeCompare(bSid);
  });
  const pointsGeoJSON: turf.FeatureCollection<turf.Point> = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:EPSG::4326' }
    },
    features: points
  };
  await writeFile(
    join(DERIVED_DIR, 'settlement_points.geojson'),
    canonicalizeJSON(pointsGeoJSON),
    'utf8'
  );
  console.log(`  Wrote ${points.length} points\n`);

  // Write settlement_polygons.geojson
  console.log('Writing settlement_polygons.geojson...');
  const polygons: turf.Feature<turf.Polygon>[] = [];
  for (const settlement of allSettlements) {
    const geom = settlementGeometry.get(settlement.sid);
    if (geom?.polygon) {
      polygons.push(turf.polygon(geom.polygon.geometry.coordinates, {
        sid: settlement.sid,
        mid: settlement.mid
      }));
    }
  }
  polygons.sort((a, b) => {
    const aSid = a.properties?.sid || '';
    const bSid = b.properties?.sid || '';
    return aSid.localeCompare(bSid);
  });
  const polygonsGeoJSON: turf.FeatureCollection<turf.Polygon> = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:EPSG::4326' }
    },
    features: polygons
  };
  await writeFile(
    join(DERIVED_DIR, 'settlement_polygons.geojson'),
    canonicalizeJSON(polygonsGeoJSON),
    'utf8'
  );
  console.log(`  Wrote ${polygons.length} polygons\n`);

  // Build municipality outlines
  console.log('Building municipality outlines...');
  const municipalityOutlines: turf.Feature<turf.Polygon>[] = [];
  const municipalitiesWithSomeOutside: string[] = [];
  let municipalitiesWithAllContained = 0;

  for (const [mid, settlements] of municipalitySettlements.entries()) {
    const municipalityPolygons = settlements
      .map(s => settlementGeometry.get(s.sid)?.polygon)
      .filter((p): p is turf.Feature<turf.Polygon> => p !== null && p !== undefined);

    const municipalityPoints = settlements
      .map(s => settlementGeometry.get(s.sid)?.point)
      .filter((p): p is turf.Feature<turf.Point> => p !== null && p !== undefined);

    if (municipalityPolygons.length === 0 && municipalityPoints.length === 0) {
      continue; // Skip municipalities with no geometry
    }

    let outline: turf.Feature<turf.Polygon> | null = null;

    if (municipalityPolygons.length >= 1) {
      // Try union of polygons
      try {
        if (municipalityPolygons.length === 1) {
          outline = municipalityPolygons[0];
        } else {
          let unioned = municipalityPolygons[0];
          for (let i = 1; i < municipalityPolygons.length; i++) {
            unioned = turf.union(unioned, municipalityPolygons[i]) as turf.Feature<turf.Polygon | turf.MultiPolygon>;
          }
          if (unioned.geometry.type === 'Polygon') {
            outline = unioned as turf.Feature<turf.Polygon>;
          } else if (unioned.geometry.type === 'MultiPolygon') {
            // Extract largest polygon
            let largestArea = 0;
            let largestPoly: turf.Feature<turf.Polygon> | null = null;
            for (const polyCoords of unioned.geometry.coordinates) {
              const poly = turf.polygon(polyCoords);
              const area = turf.area(poly);
              if (area > largestArea) {
                largestArea = area;
                largestPoly = poly;
              }
            }
            if (largestPoly) {
              outline = largestPoly;
            }
          }
        }
      } catch {
        // Union failed, fall through to concave hull
      }
    }

    // Fallback to concave hull from points
    if (!outline && municipalityPoints.length >= 3) {
      const pointCoords = municipalityPoints.map(p => p.geometry.coordinates);
      try {
        const hullPoints = concaveman(pointCoords, CONCAVE_HULL_CONCAVITY, CONCAVE_HULL_LENGTH_THRESHOLD);
        if (hullPoints.length >= 3) {
          // Close ring
          if (hullPoints[0][0] !== hullPoints[hullPoints.length - 1][0] ||
              hullPoints[0][1] !== hullPoints[hullPoints.length - 1][1]) {
            hullPoints.push([hullPoints[0][0], hullPoints[0][1]]);
          }
          outline = turf.polygon([hullPoints]);
        }
      } catch {
        // Concave hull failed
      }
    }

    if (outline) {
      outline.properties = { mid };
      municipalityOutlines.push(outline);

      // Check point containment
      let allContained = true;
      for (const point of municipalityPoints) {
        if (!turf.booleanPointInPolygon(point, outline)) {
          allContained = false;
          break;
        }
      }
      if (allContained) {
        municipalitiesWithAllContained++;
      } else {
        municipalitiesWithSomeOutside.push(mid);
      }
    }
  }

  municipalityOutlines.sort((a, b) => {
    const aMid = a.properties?.mid || '';
    const bMid = b.properties?.mid || '';
    return aMid.localeCompare(bMid);
  });

  console.log(`  Built ${municipalityOutlines.length} municipality outlines\n`);

  // Write municipality_outline.geojson
  console.log('Writing municipality_outline.geojson...');
  const outlinesGeoJSON: turf.FeatureCollection<turf.Polygon> = {
    type: 'FeatureCollection',
    crs: {
      type: 'name',
      properties: { name: 'urn:ogc:def:crs:EPSG::4326' }
    },
    features: municipalityOutlines
  };
  await writeFile(
    join(DERIVED_DIR, 'municipality_outline.geojson'),
    canonicalizeJSON(outlinesGeoJSON),
    'utf8'
  );
  console.log(`  Wrote ${municipalityOutlines.length} outlines\n`);

  // Calculate bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (points.length > 0) {
    for (const point of points) {
      const [lon, lat] = point.geometry.coordinates;
      minX = Math.min(minX, lon);
      minY = Math.min(minY, lat);
      maxX = Math.max(maxX, lon);
      maxY = Math.max(maxY, lat);
    }
  }

  // Build geometry report
  const totalPoints = points.length;
  const totalPolygons = polygons.length;
  const totalDropped = allSettlements.length - totalPolygons;
  const totalMunicipalities = municipalitySettlements.size;
  const totalPointsContained = municipalityOutlines.reduce((sum, outline) => {
    const mid = outline.properties?.mid;
    if (!mid) return sum;
    const muniPoints = municipalitySettlements.get(mid)
      ?.map(s => settlementGeometry.get(s.sid)?.point)
      .filter((p): p is turf.Feature<turf.Point> => p !== null && p !== undefined) || [];
    return sum + muniPoints.filter(p => turf.booleanPointInPolygon(p, outline)).length;
  }, 0);

  const report: GeometryReport = {
    input_hashes: {
      excel: excelHash,
      zip: zipHash
    },
    counts: {
      settlements_total: allSettlements.length,
      aggregate_rows_filtered: aggregateRowsFiltered,
      points_created: totalPoints,
      polygons_kept: totalPolygons,
      polygons_dropped: totalDropped,
      municipalities_derived: municipalityOutlines.length
    },
    polygon_drop_reasons: polygonDropReasons,
    crs: 'EPSG:4326',
    bounds: {
      min_x: isFinite(minX) ? roundCoord(minX) : 0,
      min_y: isFinite(minY) ? roundCoord(minY) : 0,
      max_x: isFinite(maxX) ? roundCoord(maxX) : 0,
      max_y: isFinite(maxY) ? roundCoord(maxY) : 0
    },
    municipality_coverage: {
      percent_points_contained: totalPoints > 0 ? (totalPointsContained / totalPoints) * 100 : 0,
      municipalities_with_all_contained: municipalitiesWithAllContained,
      municipalities_with_some_outside: municipalitiesWithSomeOutside.length
    },
    offenders: {
      sids_dropped: allSettlements
        .filter(s => !settlementGeometry.get(s.sid)?.polygon)
        .slice(0, 20)
        .map(s => s.sid),
      mids_failed_coverage: municipalitiesWithSomeOutside.slice(0, 20)
    },
    build_params: {
      coordinate_precision: COORDINATE_PRECISION,
      concave_hull_concavity: CONCAVE_HULL_CONCAVITY,
      concave_hull_length_threshold: CONCAVE_HULL_LENGTH_THRESHOLD
    },
    tool_version: '1.0.0'
  };

  // Write geometry_report.json
  console.log('Writing geometry_report.json...');
  await writeFile(
    join(DERIVED_DIR, 'geometry_report.json'),
    canonicalizeJSON(report),
    'utf8'
  );
  console.log('  Report written\n');

  // Compute and write fingerprint
  console.log('Computing build fingerprint...');
  const fingerprint = await computeFingerprint(excelHash, zipHash, report);
  await writeFile(
    join(DERIVED_DIR, 'build_fingerprint.txt'),
    fingerprint + '\n',
    'utf8'
  );
  console.log(`  Fingerprint: ${fingerprint.substring(0, 16)}...\n`);

  console.log('Build complete!');
  console.log(`  Settlements: ${allSettlements.length}`);
  console.log(`  Points: ${totalPoints}`);
  console.log(`  Polygons: ${totalPolygons}`);
  console.log(`  Municipality outlines: ${municipalityOutlines.length}`);
  console.log(`  Aggregate rows filtered: ${aggregateRowsFiltered}`);
}

main().catch((err) => {
  console.error('Build failed:', err);
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
});
