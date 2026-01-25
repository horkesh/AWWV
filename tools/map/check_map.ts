/**
 * Map Validation CLI: Structural checks without rendering (Path A)
 * 
 * Validates:
 *   - ∑ rule applied (no aggregate rows in settlements)
 *   - settlements_meta integrity: unique sid, every sid has mid
 *   - polygon_fabric integrity: unique poly_id, valid geometry
 *   - municipality outlines integrity: every mid in settlements_meta has outline (if crosswalk exists)
 *   - Settlement points integrity: every point sid exists in meta
 * 
 * Usage:
 *   tsx tools/map/check_map.ts
 *   pnpm map:check
 */

import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as turf from '@turf/turf';
import booleanValid from '@turf/boolean-valid';
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

interface SettlementMeta {
  sid: string;
  name: string;
  mid: string;
  municipality_name: string;
  lat: number | null;
  lon: number | null;
  source_row_id: string;
}

interface GeometryReport {
  counts: {
    settlements_total: number;
    aggregate_rows_filtered: number;
    points_created: number;
    polygons_kept: number;
    polygons_dropped: number;
    municipalities_derived: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

const DERIVED_DIR = resolve('data/derived');
const POINT_IN_POLYGON_TOLERANCE = 1e-6;
const JOIN_HEALTH_THRESHOLD = 0.85; // Minimum match ratio to avoid warning

// ============================================================================
// Validation Functions
// ============================================================================

async function loadSettlementsMeta(): Promise<Map<string, SettlementMeta>> {
  const csvPath = join(DERIVED_DIR, 'settlements_meta.csv');
  const content = await readFile(csvPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }

  const header = lines[0].split(',');
  const sidIdx = header.indexOf('sid');
  const nameIdx = header.indexOf('name');
  const midIdx = header.indexOf('mid');
  const municipalityNameIdx = header.indexOf('municipality_name');
  const latIdx = header.indexOf('lat');
  const lonIdx = header.indexOf('lon');
  const sourceRowIdIdx = header.indexOf('source_row_id');

  if (sidIdx === -1 || nameIdx === -1 || midIdx === -1) {
    throw new Error('settlements_meta.csv missing required columns: sid, name, mid');
  }

  const metaMap = new Map<string, SettlementMeta>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Simple CSV parsing (handle quoted fields)
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);

    if (fields.length <= Math.max(sidIdx, nameIdx, midIdx)) continue;

    const sid = fields[sidIdx]?.trim();
    if (!sid) continue;

    const name = fields[nameIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
    const mid = fields[midIdx]?.trim() || '';
    const municipalityName = fields[municipalityNameIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';
    const latStr = fields[latIdx]?.trim() || '';
    const lonStr = fields[lonIdx]?.trim() || '';
    const sourceRowId = fields[sourceRowIdIdx]?.replace(/^"|"$/g, '').replace(/""/g, '"') || '';

    const lat = latStr ? parseFloat(latStr) : null;
    const lon = lonStr ? parseFloat(lonStr) : null;

    metaMap.set(sid, {
      sid,
      name,
      mid,
      municipality_name: municipalityName,
      lat,
      lon,
      source_row_id: sourceRowId
    });
  }

  return metaMap;
}

async function loadSettlementPoints(): Promise<Map<string, turf.Feature<turf.Point>>> {
  const geojsonPath = join(DERIVED_DIR, 'settlement_points_from_excel.geojson');
  const content = await readFile(geojsonPath, 'utf8');
  const fc: turf.FeatureCollection<turf.Point> = JSON.parse(content);

  const pointMap = new Map<string, turf.Feature<turf.Point>>();
  for (const feature of fc.features) {
    const sid = feature.properties?.sid;
    if (sid && typeof sid === 'string') {
      pointMap.set(sid, feature);
    }
  }
  return pointMap;
}

async function loadPolygonFabric(): Promise<Map<string, turf.Feature<turf.Polygon>>> {
  const geojsonPath = join(DERIVED_DIR, 'polygon_fabric.geojson');
  const content = await readFile(geojsonPath, 'utf8');
  const fc: turf.FeatureCollection<turf.Polygon> = JSON.parse(content);

  const polygonMap = new Map<string, turf.Feature<turf.Polygon>>();
  for (const feature of fc.features) {
    const polyId = feature.properties?.poly_id;
    if (polyId && typeof polyId === 'string') {
      polygonMap.set(polyId, feature);
    }
  }
  return polygonMap;
}

async function loadMunicipalityOutlines(): Promise<Map<string, turf.Feature<turf.Polygon>>> {
  const geojsonPath = join(DERIVED_DIR, 'municipality_outline.geojson');
  try {
    const content = await readFile(geojsonPath, 'utf8');
    const fc: turf.FeatureCollection<turf.Polygon> = JSON.parse(content);

    const outlineMap = new Map<string, turf.Feature<turf.Polygon>>();
    for (const feature of fc.features) {
      const mid = feature.properties?.mid;
      if (mid && typeof mid === 'string') {
        outlineMap.set(mid, feature);
      }
    }
    return outlineMap;
  } catch {
    // File might not exist or be empty in fallback mode
    return new Map();
  }
}

async function loadMunCodeOutlines(): Promise<Map<string, turf.Feature<turf.Polygon>>> {
  const geojsonPath = join(DERIVED_DIR, 'mun_code_outline.geojson');
  try {
    const content = await readFile(geojsonPath, 'utf8');
    const fc: turf.FeatureCollection<turf.Polygon> = JSON.parse(content);

    const outlineMap = new Map<string, turf.Feature<turf.Polygon>>();
    for (const feature of fc.features) {
      const munCode = feature.properties?.mun_code;
      if (munCode && typeof munCode === 'string') {
        outlineMap.set(munCode, feature);
      }
    }
    return outlineMap;
  } catch {
    return new Map();
  }
}

async function loadNationalOutline(): Promise<turf.Feature<turf.Polygon> | null> {
  const geojsonPath = join(DERIVED_DIR, 'national_outline.geojson');
  try {
    const content = await readFile(geojsonPath, 'utf8');
    const fc: turf.FeatureCollection<turf.Polygon> = JSON.parse(content);
    if (fc.features.length === 1) {
      return fc.features[0];
    }
    return null;
  } catch {
    return null;
  }
}

async function loadMunicipalityBorders(): Promise<Map<number, turf.Feature<turf.Polygon | turf.MultiPolygon>>> {
  const geojsonPath = join(DERIVED_DIR, 'municipality_borders.geojson');
  try {
    const content = await readFile(geojsonPath, 'utf8');
    const fc: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = JSON.parse(content);

    const borderMap = new Map<number, turf.Feature<turf.Polygon | turf.MultiPolygon>>();
    for (const feature of fc.features) {
      const mid = feature.properties?.mid;
      if (mid && typeof mid === 'number') {
        borderMap.set(mid, feature);
      }
    }
    return borderMap;
  } catch {
    return new Map();
  }
}

async function checkCrosswalkExists(): Promise<boolean> {
  try {
    const crosswalkPath = join(DERIVED_DIR, 'polygon_fabric_with_mid.geojson');
    await readFile(crosswalkPath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function loadGeometryReport(): Promise<GeometryReport | null> {
  try {
    const reportPath = join(DERIVED_DIR, 'geometry_report.json');
    const content = await readFile(reportPath, 'utf8');
    return JSON.parse(content) as GeometryReport;
  } catch {
    return null;
  }
}

// ============================================================================
// Validation Checks
// ============================================================================

interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
}

async function runChecks(): Promise<ValidationResult> {
  const result: ValidationResult = {
    passed: true,
    errors: [],
    warnings: []
  };

  console.log('Loading data files...\n');

  // Load all data
  const metaMap = await loadSettlementsMeta();
  const pointMap = await loadSettlementPoints();
  const polygonMap = await loadPolygonFabric();
  const outlineMap = await loadMunicipalityOutlines();
  const munCodeOutlineMap = await loadMunCodeOutlines();
  const nationalOutline = await loadNationalOutline();
  const municipalityBordersMap = await loadMunicipalityBorders();
  const report = await loadGeometryReport();
  const crosswalkExists = await checkCrosswalkExists();

  console.log(`Loaded:`);
  console.log(`  Settlements meta: ${metaMap.size}`);
  console.log(`  Settlement points: ${pointMap.size}`);
  console.log(`  Polygon fabric: ${polygonMap.size}`);
  console.log(`  Municipality outlines (mid): ${outlineMap.size}`);
  console.log(`  Municipality outlines (mun_code): ${munCodeOutlineMap.size}`);
  console.log(`  Municipality borders (drzava.js): ${municipalityBordersMap.size}`);
  console.log(`  National outline: ${nationalOutline ? 'Yes' : 'No'}`);
  console.log(`  Crosswalk exists: ${crosswalkExists}\n`);

  // Check 1: ∑ rule applied
  console.log('Check 1: ∑ filtering rule applied...');
  let hasAggregateSymbol = false;
  for (const meta of metaMap.values()) {
    if (meta.name.includes('∑') || meta.sid.includes('∑') || meta.mid.includes('∑')) {
      hasAggregateSymbol = true;
      result.passed = false;
      result.errors.push(`Aggregate row detected: sid=${meta.sid}, name=${meta.name}`);
    }
  }

  if (hasAggregateSymbol) {
    console.log('  FAIL: Aggregate rows (∑) detected in settlements');
  } else {
    console.log('  PASS: No aggregate rows (∑) in settlements');
  }

  if (report && report.counts.aggregate_rows_filtered > 0) {
    console.log(`  INFO: ${report.counts.aggregate_rows_filtered} aggregate rows were filtered during build`);
  }

  // Check 2: settlements_meta integrity
  console.log('\nCheck 2: settlements_meta integrity...');
  const sids = Array.from(metaMap.keys());
  const uniqueSids = new Set(sids);
  if (sids.length !== uniqueSids.size) {
    result.passed = false;
    result.errors.push(`Duplicate sids found: ${sids.length - uniqueSids.size} duplicates`);
    console.log('  FAIL: Duplicate sids detected');
  } else {
    console.log('  PASS: All sids are unique');
  }

  let sidsWithoutMid = 0;
  for (const meta of metaMap.values()) {
    if (!meta.mid || meta.mid.trim() === '') {
      sidsWithoutMid++;
      if (sidsWithoutMid <= 10) {
        result.errors.push(`Settlement ${meta.sid} missing mid`);
      }
    }
  }
  if (sidsWithoutMid > 0) {
    result.passed = false;
    console.log(`  FAIL: ${sidsWithoutMid} settlements missing mid`);
  } else {
    console.log('  PASS: Every sid has mid');
  }

  // Check 3: polygon_fabric integrity
  console.log('\nCheck 3: polygon_fabric integrity...');
  const polyIds = Array.from(polygonMap.keys());
  const uniquePolyIds = new Set(polyIds);
  if (polyIds.length !== uniquePolyIds.size) {
    result.passed = false;
    result.errors.push(`Duplicate poly_ids found: ${polyIds.length - uniquePolyIds.size} duplicates`);
    console.log('  FAIL: Duplicate poly_ids detected');
  } else {
    console.log('  PASS: All poly_ids are unique');
  }

  let invalidPolygons = 0;
  for (const [polyId, polygon] of polygonMap.entries()) {
    try {
      if (!booleanValid(polygon) && turf.area(polygon) <= 0) {
        invalidPolygons++;
        if (invalidPolygons <= 10) {
          result.warnings.push(`Polygon ${polyId} has invalid geometry`);
        }
      }
    } catch {
      invalidPolygons++;
      if (invalidPolygons <= 10) {
        result.warnings.push(`Polygon ${polyId} geometry check failed`);
      }
    }
  }
  if (invalidPolygons > 0) {
    console.log(`  WARNING: ${invalidPolygons} polygons have invalid geometry`);
  } else {
    console.log('  PASS: All polygons have valid geometry');
  }

  // Check 4: Settlement points integrity
  console.log('\nCheck 4: Settlement points integrity...');
  let pointsWithoutMeta = 0;
  for (const sid of pointMap.keys()) {
    if (!metaMap.has(sid)) {
      pointsWithoutMeta++;
      if (pointsWithoutMeta <= 10) {
        result.errors.push(`Point sid ${sid} not found in meta`);
      }
    }
  }
  if (pointsWithoutMeta > 0) {
    result.passed = false;
    console.log(`  FAIL: ${pointsWithoutMeta} point sids not in meta`);
  } else {
    console.log('  PASS: All point sids exist in meta');
  }

  // Check 5: Municipality outlines integrity
  console.log('\nCheck 5: Municipality outlines integrity...');
  if (crosswalkExists && outlineMap.size > 0) {
    // If crosswalk exists, every mid in settlements_meta should have an outline
    const midsInMeta = new Set(Array.from(metaMap.values()).map(m => m.mid));
    const midsWithoutOutline: string[] = [];
    for (const mid of midsInMeta) {
      if (!outlineMap.has(mid)) {
        midsWithoutOutline.push(mid);
      }
    }
    if (midsWithoutOutline.length > 0) {
      result.passed = false;
      result.errors.push(`${midsWithoutOutline.length} municipalities missing outlines: ${midsWithoutOutline.slice(0, 10).join(', ')}`);
      console.log(`  FAIL: ${midsWithoutOutline.length} municipalities missing outlines`);
    } else {
      console.log('  PASS: All municipalities have outlines');
    }
  } else if (!crosswalkExists) {
    // If no crosswalk, require mun_code_outline.geojson exists (may be partial, but must be valid GeoJSON)
    if (munCodeOutlineMap.size === 0) {
      result.passed = false;
      result.errors.push('No mun_code_crosswalk.csv found and mun_code_outline.geojson is missing or empty');
      console.log('  FAIL: mun_code_outline.geojson missing or empty (crosswalk missing)');
    } else {
      console.log(`  PASS: mun_code_outline.geojson exists with ${munCodeOutlineMap.size} features (fallback mode)`);
      
      // Check geometry_report.json for union failure stats
      if (report) {
        const munUnionFail = (report as any).mun_union_fail;
        const munHullUsed = (report as any).mun_hull_used;
        if (munUnionFail !== undefined && munUnionFail > 0) {
          result.warnings.push(`mun_code outlines: ${munUnionFail} groups used hull fallback (union failed)`);
          console.log(`  WARNING: ${munUnionFail} mun_code groups used hull fallback (union failed)`);
        }
        if (munHullUsed !== undefined && munHullUsed > 0) {
          console.log(`  INFO: ${munHullUsed} mun_code groups used hull fallback`);
        }
      }
    }
  } else {
    result.warnings.push('No municipality outlines found');
    console.log('  WARNING: No municipality outlines found');
  }
  
  // Check 5a: National outline integrity
  console.log('\nCheck 5a: National outline integrity...');
  if (!nationalOutline) {
    result.passed = false;
    result.errors.push('national_outline.geojson missing or does not have exactly 1 feature');
    console.log('  FAIL: national_outline.geojson missing or invalid');
  } else {
    const props = nationalOutline.properties || {};
    // Accept both union and hull fallback sources
    const validSources = ['polygon_fabric_union', 'national_hull_fallback'];
    if (props.id !== 'BIH' || !validSources.includes(props.source)) {
      result.warnings.push('National outline has unexpected properties');
      console.log('  WARNING: National outline properties may be unexpected');
    } else {
      console.log('  PASS: National outline exists and is valid');
      
      // Check if union failed
      if (props.union_failed === true || props.source === 'national_hull_fallback') {
        result.warnings.push('National outline used hull fallback (union failed)');
        console.log('  WARNING: National outline used hull fallback (union failed)');
      }
      
      // Check geometry_report.json for union failure stats
      if (report) {
        const natUnionFail = (report as any).nat_union_fail;
        const natHullUsed = (report as any).nat_hull_used;
        if (natUnionFail !== undefined && natUnionFail > 0) {
          result.warnings.push(`National outline: union failed, used hull fallback`);
          console.log(`  WARNING: National outline union failed, used hull fallback`);
        }
        if (natHullUsed !== undefined && natHullUsed > 0) {
          console.log(`  INFO: National outline used hull fallback`);
        }
      }
    }
  }

  // Check 6: Outlines contain municipality points (with tolerance)
  console.log('\nCheck 6: Outlines contain municipality points...');
  const municipalitiesWithPointsOutside: string[] = [];
  const midToPoints = new Map<string, turf.Feature<turf.Point>[]>();
  
  for (const [sid, point] of pointMap.entries()) {
    const meta = metaMap.get(sid);
    if (meta) {
      if (!midToPoints.has(meta.mid)) {
        midToPoints.set(meta.mid, []);
      }
      midToPoints.get(meta.mid)!.push(point);
    }
  }

  for (const [mid, outline] of outlineMap.entries()) {
    const points = midToPoints.get(mid) || [];
    let allContained = true;
    for (const point of points) {
      if (!turf.booleanPointInPolygon(point, outline)) {
        allContained = false;
        break;
      }
    }
    if (!allContained && points.length > 0) {
      municipalitiesWithPointsOutside.push(mid);
    }
  }

  if (municipalitiesWithPointsOutside.length > 0) {
    result.warnings.push(`${municipalitiesWithPointsOutside.length} municipalities have points outside outline`);
    console.log(`  WARNING: ${municipalitiesWithPointsOutside.length} municipalities have points outside outline`);
  } else {
    console.log('  PASS: All municipality points are contained in outlines');
  }

  // Check 7: Municipality borders integrity (from drzava.js)
  console.log('\nCheck 7: Municipality borders integrity (drzava.js)...');
  if (municipalityBordersMap.size > 0) {
    if (municipalityBordersMap.size < 130) {
      result.warnings.push(`Municipality borders has ${municipalityBordersMap.size} features (expected >= 130)`);
      console.log(`  WARNING: Municipality borders has ${municipalityBordersMap.size} features (expected >= 130)`);
    } else {
      console.log(`  PASS: Municipality borders has ${municipalityBordersMap.size} features`);
    }
    
    // Check that all features have numeric mid
    let featuresWithoutMid = 0;
    for (const [mid, feature] of municipalityBordersMap.entries()) {
      const propMid = feature.properties?.mid;
      if (typeof propMid !== 'number' || propMid !== mid) {
        featuresWithoutMid++;
      }
    }
    if (featuresWithoutMid > 0) {
      result.errors.push(`${featuresWithoutMid} municipality border features have invalid mid property`);
      console.log(`  FAIL: ${featuresWithoutMid} features have invalid mid property`);
    } else {
      console.log('  PASS: All municipality border features have valid mid property');
    }
  } else {
    result.warnings.push('Municipality borders file missing or empty (optional, but recommended)');
    console.log('  WARNING: Municipality borders file missing or empty');
  }

  return result;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Map Validation Check\n');
  console.log('='.repeat(80));
  console.log();

  try {
    const result = await runChecks();

    console.log();
    console.log('='.repeat(80));
    console.log();

    if (result.errors.length > 0) {
      console.log('ERRORS:');
      for (const error of result.errors.slice(0, 20)) {
        console.log(`  - ${error}`);
      }
      if (result.errors.length > 20) {
        console.log(`  ... and ${result.errors.length - 20} more errors`);
      }
      console.log();
    }

    if (result.warnings.length > 0) {
      console.log('WARNINGS:');
      for (const warning of result.warnings.slice(0, 20)) {
        console.log(`  - ${warning}`);
      }
      if (result.warnings.length > 20) {
        console.log(`  ... and ${result.warnings.length - 20} more warnings`);
      }
      console.log();
    }

    if (result.passed) {
      console.log('✓ All checks passed!');
      process.exit(0);
    } else {
      console.log('✗ Some checks failed. See errors above.');
      process.exit(1);
    }
  } catch (err) {
    console.error('Validation failed with error:', err);
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
