/**
 * Derive Municipality Outlines from Settlement Polygon Fabric
 * 
 * Creates municipality outlines by unioning polygons (poly_id micro-areas) from the
 * settlement polygon fabric. This is a derived/reconstructed layer for reference/visualization.
 * 
 * CRITICAL RULES:
 * - Do NOT assume polygon↔settlement 1:1 mapping
 * - Do NOT invent municipalities
 * - Municipality identity must come from explicit municipality reference field in polygon fabric
 * - Determinism is mandatory (stable ordering, no timestamps, no randomness)
 * 
 * Inputs:
 * - data/derived/polygon_fabric.geojson (or polygon_fabric_with_mid.geojson if available)
 * - data/derived/settlements_meta.csv (for expected municipality set)
 * 
 * Outputs:
 * - data/derived/municipality_outlines_from_settlement_fabric.geojson
 * - data/derived/municipality_outlines_derivation_report.json
 * - data/derived/municipality_outlines_missing.csv
 * - data/derived/muni_from_fabric_viewer.html
 * 
 * Usage:
 *   npm run map:derive:muni-from-fabric
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';
import * as polygonClipping from 'polyclip-ts';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("Reduce polygon-clipping union failures via conservative deterministic normalization ladder");
polygonClipping.setPrecision(1e-6);
loadLedger();
assertLedgerFresh("Derive municipality outlines from settlement polygon fabric deterministically (no settlement↔polygon 1:1 assumption)");

// ============================================================================
// Constants
// ============================================================================

const POLYGONS_FABRIC_PATH = resolve('data/derived/polygon_fabric.geojson');
const POLYGONS_WITH_MID_PATH = resolve('data/derived/polygon_fabric_with_mid.geojson');
const SETTLEMENTS_META_PATH = resolve('data/derived/settlements_meta.csv');
const OUTPUT_GEOJSON_PATH = resolve('data/derived/municipality_outlines_from_settlement_fabric.geojson');
const OUTPUT_REPORT_PATH = resolve('data/derived/municipality_outlines_derivation_report.json');
const OUTPUT_MISSING_CSV_PATH = resolve('data/derived/municipality_outlines_missing.csv');
const OUTPUT_UNION_STATUS_CSV_PATH = resolve('data/derived/municipality_union_status.csv');
const OUTPUT_VIEWER_PATH = resolve('data/derived/muni_from_fabric_viewer.html');
const UNION_BATCH_SIZE = 100;
const COORDINATE_PRECISION = 3;

// ============================================================================
// Types
// ============================================================================

interface UnionResult {
  success: boolean;
  result: turf.Feature<turf.Polygon | turf.MultiPolygon> | null;
  failureReason: string | null;
  failureDetail: string | null;
}

interface MunicipalityUnionStatus {
  mun_id: string;
  poly_count: number;
  union_attempted: boolean;
  union_result: 'success' | 'failed' | 'fallback_collection';
  failure_reason: string | null;
  failure_detail: string | null;
  normalization_level_attempted: number | null;
  normalization_level_succeeded: number | null;
  union_error_message: string | null;
}

interface DerivationReport {
  inputs: {
    polygon_fabric: string;
    polygon_to_muni_map: string | null;
    id_scheme: 'mid' | 'mun_code';
  };
  totals: {
    polygons_loaded: number;
    polygons_with_muni: number;
    municipalities_expected: number;
    municipalities_with_polygons: number;
    municipalities_emitted: number;
    municipalities_missing: number;
  };
  missing_municipalities: string[];
  geometry_stats: {
    unions_attempted: number;
    unions_succeeded: number;
    unions_failed: number;
    fallbacks_used: number;
    unions_succeeded_by_level: { [level: string]: number };
  };
  normalization_params: {
    eps1: number;
    area_eps: number;
    clamp: [number, number];
  };
  union_failures_by_reason: { [reason: string]: number };
  failures: Array<{
    mun_id: string;
    reason: string;
    detail: string | null;
  }>;
  per_municipality_union_status_path: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize coordinates to fixed precision
 */
function normalizeCoordinates(geom: turf.Feature<turf.Polygon | turf.MultiPolygon>): turf.Feature<turf.Polygon | turf.MultiPolygon> {
  if (geom.geometry.type === 'Polygon') {
    const coords = geom.geometry.coordinates;
    const normalized: number[][][] = coords.map(ring =>
      ring.map(([x, y]) => [
        Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
        Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
      ])
    );
    return turf.polygon(normalized, geom.properties);
  } else if (geom.geometry.type === 'MultiPolygon') {
    const coords = geom.geometry.coordinates;
    const normalized: number[][][][] = coords.map(polygon =>
      polygon.map(ring =>
        ring.map(([x, y]) => [
          Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
          Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
        ])
      )
    );
    return turf.multiPolygon(normalized, geom.properties);
  }
  return geom;
}

/**
 * Close ring if needed (ensure first and last points match)
 */
function closeRing(ring: number[][]): number[][] {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...ring, [first[0], first[1]]];
  }
  return ring;
}

/**
 * Remove duplicate consecutive points
 */
function removeDuplicatePoints(ring: number[][]): number[][] {
  if (ring.length < 2) return ring;
  const result: number[][] = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const prev = result[result.length - 1];
    const curr = ring[i];
    if (prev[0] !== curr[0] || prev[1] !== curr[1]) {
      result.push(curr);
    }
  }
  return result;
}

/**
 * Quantize coordinates to a fixed grid step
 */
function quantizeCoordinates(ring: number[][], eps: number): number[][] {
  return ring.map(([x, y]) => [
    Math.round(x / eps) * eps,
    Math.round(y / eps) * eps
  ]);
}

/**
 * Compute triangle area (signed, for collinearity check)
 */
function triangleArea(a: number[], b: number[], c: number[]): number {
  return Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
}

/**
 * Remove nearly-collinear points from a ring
 */
function removeCollinearPoints(ring: number[][], areaEps: number): number[][] {
  if (ring.length < 3) return ring;
  const result: number[][] = [ring[0]];
  for (let i = 1; i < ring.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = ring[i];
    const next = ring[i + 1];
    const area = triangleArea(prev, curr, next);
    if (area > areaEps) {
      result.push(curr);
    }
  }
  // Always keep last point
  if (ring.length > 1) {
    result.push(ring[ring.length - 1]);
  }
  return result;
}

/**
 * Count distinct points in a ring (after removing duplicates)
 */
function countDistinctPoints(ring: number[][]): number {
  const distinct = new Set<string>();
  for (const [x, y] of ring) {
    distinct.add(`${x},${y}`);
  }
  return distinct.size;
}

/**
 * Normalize geometry at a specific level
 * Level 0: ring closure + remove duplicate consecutive points
 * Level 1: Level 0 + quantize coordinates to grid step EPS1
 * Level 2: Level 1 + remove nearly-collinear points + drop rings with < 4 distinct points
 */
function normalizeGeometry(
  feature: turf.Feature<turf.Polygon>,
  level: number,
  eps1: number,
  areaEps: number
): turf.Feature<turf.Polygon> | null {
  const coords = feature.geometry.coordinates;
  const normalized: number[][][] = [];
  
  for (const ring of coords) {
    let normalizedRing = removeDuplicatePoints(ring);
    normalizedRing = closeRing(normalizedRing);
    
    if (level >= 1) {
      normalizedRing = quantizeCoordinates(normalizedRing, eps1);
      // Remove duplicates again after quantization
      normalizedRing = removeDuplicatePoints(normalizedRing);
      normalizedRing = closeRing(normalizedRing);
    }
    
    if (level >= 2) {
      normalizedRing = removeCollinearPoints(normalizedRing, areaEps);
      // Remove duplicates again after collinear removal
      normalizedRing = removeDuplicatePoints(normalizedRing);
      normalizedRing = closeRing(normalizedRing);
      
      // Drop rings with < 4 distinct points
      if (countDistinctPoints(normalizedRing) < 4) {
        continue; // Skip this ring
      }
    }
    
    // Ensure ring has at least 3 points after all operations
    if (normalizedRing.length >= 3) {
      normalized.push(normalizedRing);
    }
  }
  
  // Must have at least one valid ring
  if (normalized.length === 0) {
    return null;
  }
  
  return turf.polygon(normalized, feature.properties);
}

/**
 * Normalize polygon geometry (ring closure, duplicate removal)
 */
function normalizePolygonGeometry(feature: turf.Feature<turf.Polygon>): turf.Feature<turf.Polygon> {
  const coords = feature.geometry.coordinates;
  const normalized: number[][][] = coords.map(ring => {
    let normalizedRing = removeDuplicatePoints(ring);
    normalizedRing = closeRing(normalizedRing);
    return normalizedRing;
  });
  return turf.polygon(normalized, feature.properties);
}

/**
 * Convert GeoJSON Polygon coordinates to polyclip-ts format (Poly).
 * Applies minimal ring normalization: remove duplicate consecutive points, ensure closure.
 */
function polygonToPolyclipFormat(feature: turf.Feature<turf.Polygon>): number[][][] {
  const coords = feature.geometry.coordinates;
  return coords.map(ring => {
    let r = removeDuplicatePoints(ring);
    r = closeRing(r);
    return r;
  });
}

/**
 * Convert polyclip-ts MultiPoly result to GeoJSON Feature.
 * MultiPoly is Poly[]; empty [] → null.
 */
function multiPolyToGeoJSON(multiPoly: number[][][][]): turf.Feature<turf.Polygon | turf.MultiPolygon> | null {
  if (!multiPoly || multiPoly.length === 0) return null;
  const rounded = multiPoly.map(poly =>
    poly.map(ring =>
      ring.map(([x, y]) => [
        Math.round(x * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION),
        Math.round(y * Math.pow(10, COORDINATE_PRECISION)) / Math.pow(10, COORDINATE_PRECISION)
      ] as [number, number])
    )
  );
  if (rounded.length === 1) {
    return turf.polygon(rounded[0], {});
  }
  return turf.multiPolygon(rounded, {});
}

/**
 * Compute bbox from polygon fabric
 */
function computeBboxFromFabric(fc: turf.FeatureCollection<turf.Polygon>): { width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  for (const feature of fc.features) {
    const bbox = turf.bbox(feature);
    minX = Math.min(minX, bbox[0]);
    minY = Math.min(minY, bbox[1]);
    maxX = Math.max(maxX, bbox[2]);
    maxY = Math.max(maxY, bbox[3]);
  }
  
  return {
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Deterministic union of polygons using polyclip-ts (boolean polygon union).
 * Applies normalization at the specified level before union.
 * No buffer fix; fallback to polygon collection when union fails.
 */
function unionPolygonsDeterministic(
  polygons: turf.Feature<turf.Polygon>[],
  normalizationLevel: number,
  eps1: number,
  areaEps: number
): UnionResult {
  if (polygons.length === 0) {
    return {
      success: false,
      result: null,
      failureReason: 'no_polygons',
      failureDetail: 'Empty polygon array'
    };
  }

  if (polygons.length === 1) {
    const normalized = normalizeGeometry(polygons[0], normalizationLevel, eps1, areaEps);
    if (!normalized) {
      return {
        success: false,
        result: null,
        failureReason: 'normalization_failed',
        failureDetail: 'Single polygon became invalid after normalization'
      };
    }
    return {
      success: true,
      result: normalizeCoordinates(normalized),
      failureReason: null,
      failureDetail: null
    };
  }

  for (let i = 0; i < polygons.length; i++) {
    const poly = polygons[i];
    if (!poly.geometry || poly.geometry.type !== 'Polygon') {
      return {
        success: false,
        result: null,
        failureReason: 'invalid_polygon_input',
        failureDetail: `Polygon at index ${i} has invalid geometry type: ${poly.geometry?.type || 'null'}`
      };
    }
    if (!poly.geometry.coordinates || poly.geometry.coordinates.length === 0) {
      return {
        success: false,
        result: null,
        failureReason: 'invalid_polygon_input',
        failureDetail: `Polygon at index ${i} has empty coordinates`
      };
    }
  }

  const sorted = [...polygons].sort((a, b) => {
    const idA = String(a.properties?.poly_id ?? '');
    const idB = String(b.properties?.poly_id ?? '');
    return idA.localeCompare(idB);
  });

  // Apply normalization at the specified level
  const normalized: turf.Feature<turf.Polygon>[] = [];
  for (const p of sorted) {
    const norm = normalizeGeometry(p, normalizationLevel, eps1, areaEps);
    if (norm) {
      normalized.push(norm);
    }
  }
  
  if (normalized.length === 0) {
    return {
      success: false,
      result: null,
      failureReason: 'normalization_failed',
      failureDetail: 'All polygons became invalid after normalization'
    };
  }
  
  const polyclipPolys = normalized.map(p => polygonToPolyclipFormat(p));

  try {
    const acc = polygonClipping.union(polyclipPolys[0], ...polyclipPolys.slice(1));
    if (!acc || acc.length === 0) {
      return {
        success: false,
        result: null,
        failureReason: 'union_empty_result',
        failureDetail: 'polyclip-ts union returned empty'
      };
    }
    const multiPoly = acc as number[][][][];
    const feature = multiPolyToGeoJSON(multiPoly);
    if (!feature) {
      return {
        success: false,
        result: null,
        failureReason: 'union_empty_result',
        failureDetail: 'Converted result empty'
      };
    }
    return {
      success: true,
      result: normalizeCoordinates(feature),
      failureReason: null,
      failureDetail: null
    };
  } catch (err) {
    return {
      success: false,
      result: null,
      failureReason: 'union_exception',
      failureDetail: `${err instanceof Error ? err.message : String(err)}`.substring(0, 200)
    };
  }
}

/**
 * Load expected municipalities from settlements_meta.csv
 */
async function loadExpectedMunicipalities(): Promise<Set<string>> {
  try {
    const content = await readFile(SETTLEMENTS_META_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('sid,'));
    const municipalities = new Set<string>();
    
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 3) {
        const mid = parts[2]?.trim();
        if (mid && mid !== '') {
          municipalities.add(mid);
        }
      }
    }
    
    return municipalities;
  } catch (err) {
    console.warn(`Warning: Could not load expected municipalities from ${SETTLEMENTS_META_PATH}: ${err instanceof Error ? err.message : String(err)}`);
    return new Set();
  }
}

/**
 * Get municipality name from settlements_meta.csv
 */
async function loadMunicipalityNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const content = await readFile(SETTLEMENTS_META_PATH, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() && !line.startsWith('sid,'));
    
    for (const line of lines) {
      const parts = line.split(',');
      if (parts.length >= 4) {
        const mid = parts[2]?.trim();
        const name = parts[3]?.trim();
        if (mid && mid !== '' && name && name !== '') {
          if (!names.has(mid)) {
            names.set(mid, name);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`Warning: Could not load municipality names: ${err instanceof Error ? err.message : String(err)}`);
  }
  return names;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Deriving municipality outlines from settlement polygon fabric...\n');
  
  try {
    // Load polygon fabric (prefer with_mid if available)
    let polygonFC: turf.FeatureCollection<turf.Polygon> | null = null;
    let polygonToMuniMap: string | null = null;
    let useMid = false;
    
    try {
      await access(POLYGONS_WITH_MID_PATH, constants.F_OK);
      const content = await readFile(POLYGONS_WITH_MID_PATH, 'utf8');
      polygonFC = JSON.parse(content);
      const polygonsWithMid = polygonFC.features.filter(f => f.properties?.mid != null && f.properties.mid !== '').length;
      if (polygonsWithMid > 0) {
        useMid = true;
        polygonToMuniMap = POLYGONS_WITH_MID_PATH;
        console.log(`Loaded ${polygonFC.features.length} polygons from ${POLYGONS_WITH_MID_PATH} (${polygonsWithMid} have mid)`);
      } else {
        throw new Error('No polygons with mid found');
      }
    } catch {
      // Fallback to polygon_fabric.geojson
      try {
        const content = await readFile(POLYGONS_FABRIC_PATH, 'utf8');
        polygonFC = JSON.parse(content);
        polygonToMuniMap = POLYGONS_FABRIC_PATH;
        console.log(`Loaded ${polygonFC.features.length} polygons from ${POLYGONS_FABRIC_PATH}`);
      } catch (err) {
        throw new Error(`Failed to load polygon fabric: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    
    // Determine ID scheme
    const idScheme: 'mid' | 'mun_code' = useMid ? 'mid' : 'mun_code';
    
    // Load expected municipalities
    let expectedMunicipalities: Set<string>;
    if (useMid) {
      expectedMunicipalities = await loadExpectedMunicipalities();
    } else {
      // No external list: expected = unique mun_ids observed in polygons_with_muni (set after grouping)
      expectedMunicipalities = new Set();
    }
    const municipalityNames = await loadMunicipalityNames();
    
    console.log(`ID scheme: ${idScheme}`);
    
    // Group polygons by municipality
    const polygonsByMuni = new Map<string, turf.Feature<turf.Polygon>[]>();
    let polygonsWithMuni = 0;
    
    for (const feature of polygonFC.features) {
      let muniId: string | null = null;
      
      if (useMid) {
        const mid = feature.properties?.mid;
        if (mid != null && mid !== '' && typeof mid === 'string') {
          muniId = String(mid).trim();
        }
      } else {
        const munCode = feature.properties?.mun_code;
        if (munCode != null && munCode !== '' && typeof munCode === 'string') {
          muniId = String(munCode).trim();
        }
      }
      
      if (muniId) {
        if (!polygonsByMuni.has(muniId)) {
          polygonsByMuni.set(muniId, []);
        }
        polygonsByMuni.get(muniId)!.push(feature);
        polygonsWithMuni++;
      }
    }
    
    console.log(`Polygons with municipality: ${polygonsWithMuni} / ${polygonFC.features.length}`);
    console.log(`Municipalities with polygons: ${polygonsByMuni.size}`);

    if (!useMid) {
      for (const id of polygonsByMuni.keys()) expectedMunicipalities.add(id);
      console.log(`Expected municipalities (from fabric): ${expectedMunicipalities.size}`);
    } else {
      console.log(`Expected municipalities (from settlements_meta): ${expectedMunicipalities.size}`);
    }
    
    // Compute bbox and normalization parameters
    const bbox = computeBboxFromFabric(polygonFC);
    const maxDim = Math.max(bbox.width, bbox.height);
    const eps1Raw = maxDim * 1e-7;
    const eps1 = Math.max(1e-6, Math.min(1e-3, eps1Raw));
    const areaEps = eps1 * eps1;
    console.log(`\nNormalization parameters:`);
    console.log(`  Bbox: width=${bbox.width.toFixed(3)}, height=${bbox.height.toFixed(3)}`);
    console.log(`  EPS1: ${eps1} (clamped from ${eps1Raw})`);
    console.log(`  AREA_EPS: ${areaEps}`);

    // Confirm and log mistake if previous run had broken union path (read existing report before overwriting)
    try {
      const existing = await readFile(OUTPUT_REPORT_PATH, 'utf8');
      const prev = JSON.parse(existing) as DerivationReport;
      const u = prev.geometry_stats;
      const t = prev.totals;
      const reasons = Object.keys(prev.union_failures_by_reason || {});
      const allUnionException = reasons.length === 1 && reasons[0] === 'union_exception';
      if (
        t.municipalities_emitted > 0 &&
        u.unions_succeeded === 0 &&
        u.fallbacks_used === t.municipalities_emitted &&
        allUnionException
      ) {
        appendMistake(
          {
            title: 'Muni-from-fabric union path was broken, forcing fallback for all municipalities',
            mistake: "All unions failed due to a broken union/buffer-fix path (e.g., 'Must have at least 2 geometries'), causing outputs to be MultiPolygon collections that render like the settlement fabric.",
            correctRule: 'Use a proper deterministic polygon union implementation; only fallback when union genuinely fails for a specific municipality; report expected/emitted/missing consistently.'
          },
          '2026-01-25'
        );
      }
    } catch {
      // No existing report or parse error; skip mistake confirmation
    }
    
    // Derive outlines
    const outlines: turf.Feature<turf.Polygon | turf.MultiPolygon>[] = [];
    const unionStatuses: MunicipalityUnionStatus[] = [];
    const unionFailuresByReason: { [reason: string]: number } = {};
    
    const report: DerivationReport = {
      inputs: {
        polygon_fabric: polygonToMuniMap || POLYGONS_FABRIC_PATH,
        polygon_to_muni_map: polygonToMuniMap,
        id_scheme: idScheme
      },
      totals: {
        polygons_loaded: polygonFC.features.length,
        polygons_with_muni: polygonsWithMuni,
        municipalities_expected: expectedMunicipalities.size,
        municipalities_with_polygons: polygonsByMuni.size,
        municipalities_emitted: 0,
        municipalities_missing: 0
      },
      missing_municipalities: [],
      geometry_stats: {
        unions_attempted: 0,
        unions_succeeded: 0,
        unions_failed: 0,
        fallbacks_used: 0,
        unions_succeeded_by_level: { '0': 0, '1': 0, '2': 0 }
      },
      normalization_params: {
        eps1: eps1,
        area_eps: areaEps,
        clamp: [1e-6, 1e-3]
      },
      union_failures_by_reason: {},
      failures: [],
      per_municipality_union_status_path: 'data/derived/municipality_union_status.csv'
    };
    
    // Process each municipality
    const sortedMuniIds = Array.from(polygonsByMuni.keys()).sort();
    let featureIndex = 0;
    
    for (const muniId of sortedMuniIds) {
      const polygons = polygonsByMuni.get(muniId) || [];
      report.geometry_stats.unions_attempted++;
      
      // Try union at each normalization level (0, 1, 2)
      let outline: turf.Feature<turf.Polygon | turf.MultiPolygon> | null = null;
      let method = 'polygon_union';
      let unionStatus: MunicipalityUnionStatus;
      let succeededLevel: number | null = null;
      let lastError: string | null = null;
      
      for (let level = 0; level <= 2; level++) {
        const unionResult = unionPolygonsDeterministic(polygons, level, eps1, areaEps);
        
        if (unionResult.success && unionResult.result) {
          outline = unionResult.result;
          succeededLevel = level;
          report.geometry_stats.unions_succeeded++;
          report.geometry_stats.unions_succeeded_by_level[String(level)]++;
          break;
        } else {
          // Record error for this level
          lastError = unionResult.failureDetail || unionResult.failureReason || 'Unknown error';
        }
      }
      
      if (outline && succeededLevel !== null) {
        // Success at some level
        unionStatus = {
          mun_id: muniId,
          poly_count: polygons.length,
          union_attempted: true,
          union_result: 'success',
          failure_reason: null,
          failure_detail: null,
          normalization_level_attempted: 2,
          normalization_level_succeeded: succeededLevel,
          union_error_message: null
        };
      } else {
        // Failed at all levels - use fallback collection
        const normalized = polygons.map(p => normalizePolygonGeometry(p));
        const normalizedPolys = normalized.map(p => p.geometry.coordinates);
        outline = turf.multiPolygon(normalizedPolys, {});
        method = 'polygon_collection_fallback';
        report.geometry_stats.unions_failed++;
        report.geometry_stats.fallbacks_used++;
        
        const failureReason = 'union_exception';
        const failureDetail = lastError ? lastError.substring(0, 120) : `Union failed at all normalization levels (${polygons.length} polygons)`;
        
        unionStatus = {
          mun_id: muniId,
          poly_count: polygons.length,
          union_attempted: true,
          union_result: 'fallback_collection',
          failure_reason: failureReason,
          failure_detail: failureDetail,
          normalization_level_attempted: 2,
          normalization_level_succeeded: null,
          union_error_message: failureDetail.substring(0, 120)
        };
        
        // Count failure reason
        if (!unionFailuresByReason[failureReason]) {
          unionFailuresByReason[failureReason] = 0;
        }
        unionFailuresByReason[failureReason]++;
        
        report.failures.push({
          mun_id: muniId,
          reason: failureReason,
          detail: failureDetail
        });
      }
      
      unionStatuses.push(unionStatus);
      
      // Get municipality name
      const name = municipalityNames.get(muniId) || null;
      
      // Set properties
      outline!.properties = {
        mun_id: muniId,
        name: name,
        source: 'derived_from_settlement_polygon_fabric',
        method: method,
        poly_count: polygons.length,
        normalization_level: unionStatus.normalization_level_succeeded,
        feature_index: featureIndex++
      };
      
      outlines.push(outline!);
    }
    
    report.totals.municipalities_emitted = outlines.length;
    report.union_failures_by_reason = unionFailuresByReason;
    
    const emittedSet = new Set(sortedMuniIds);
    const missing = Array.from(expectedMunicipalities).filter(mid => !emittedSet.has(mid)).sort();
    report.totals.municipalities_missing = missing.length;
    report.missing_municipalities = missing;
    
    if (useMid && report.totals.municipalities_emitted === report.totals.municipalities_expected && report.totals.municipalities_missing !== 0) {
      console.warn(`Warning: Internal consistency check failed - emitted=${report.totals.municipalities_emitted}, expected=${report.totals.municipalities_expected}, missing=${report.totals.municipalities_missing}`);
    }
    if (report.totals.polygons_with_muni === report.totals.polygons_loaded && polygonsByMuni.size !== report.totals.municipalities_emitted) {
      console.warn(`Warning: Internal consistency check failed - all polygons have muni but municipality count mismatch`);
    }
    
    // Write GeoJSON
    const outputFC: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon> = {
      type: 'FeatureCollection',
      crs: {
        type: 'name',
        properties: {
          name: 'LOCAL_PIXELS_V2'
        }
      },
      features: outlines
    };
    
    await writeFile(OUTPUT_GEOJSON_PATH, JSON.stringify(outputFC, null, 2), 'utf8');
    console.log(`\n✓ Wrote ${outlines.length} municipality outlines to ${OUTPUT_GEOJSON_PATH}`);
    
    // Write report
    await writeFile(OUTPUT_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`✓ Wrote derivation report to ${OUTPUT_REPORT_PATH}`);
    
    // Write missing CSV
    if (missing.length > 0) {
      const csvLines = ['mun_id,name'];
      for (const mid of missing) {
        const name = municipalityNames.get(mid) || '';
        csvLines.push(`${mid},${name}`);
      }
      await writeFile(OUTPUT_MISSING_CSV_PATH, csvLines.join('\n') + '\n', 'utf8');
      console.log(`✓ Wrote ${missing.length} missing municipalities to ${OUTPUT_MISSING_CSV_PATH}`);
    } else {
      await writeFile(OUTPUT_MISSING_CSV_PATH, 'mun_id,name\n', 'utf8');
      console.log(`✓ Wrote empty missing CSV (no missing municipalities)`);
    }
    
    // Write union status CSV
    const unionStatusCsvLines = ['mun_id,poly_count,union_attempted,union_result,failure_reason,failure_detail,normalization_level_attempted,normalization_level_succeeded,union_error_message'];
    for (const status of unionStatuses) {
      const detail = status.failure_detail ? `"${status.failure_detail.replace(/"/g, '""')}"` : '';
      const errorMsg = status.union_error_message ? `"${status.union_error_message.replace(/"/g, '""')}"` : '';
      unionStatusCsvLines.push(
        `${status.mun_id},${status.poly_count},${status.union_attempted},${status.union_result},${status.failure_reason || ''},${detail},${status.normalization_level_attempted ?? ''},${status.normalization_level_succeeded ?? ''},${errorMsg}`
      );
    }
    await writeFile(OUTPUT_UNION_STATUS_CSV_PATH, unionStatusCsvLines.join('\n') + '\n', 'utf8');
    console.log(`✓ Wrote union status CSV to ${OUTPUT_UNION_STATUS_CSV_PATH}`);
    
    // Generate viewer
    await generateViewer(outputFC, report);
    console.log(`✓ Generated viewer at ${OUTPUT_VIEWER_PATH}`);
    
    // Summary
    console.log(`\nSummary:`);
    console.log(`  Polygons loaded: ${report.totals.polygons_loaded}`);
    console.log(`  Polygons with municipality: ${report.totals.polygons_with_muni}`);
    console.log(`  Municipalities expected: ${report.totals.municipalities_expected}`);
    console.log(`  Municipalities emitted: ${report.totals.municipalities_emitted}`);
    console.log(`  Municipalities missing: ${report.totals.municipalities_missing}`);
    console.log(`  Unions succeeded: ${report.geometry_stats.unions_succeeded}`);
    console.log(`  Unions failed: ${report.geometry_stats.unions_failed}`);
    console.log(`  Fallbacks used: ${report.geometry_stats.fallbacks_used}`);
    console.log(`  Unions succeeded by level:`);
    for (const [level, count] of Object.entries(report.geometry_stats.unions_succeeded_by_level).sort()) {
      console.log(`    Level ${level}: ${count}`);
    }
    if (Object.keys(unionFailuresByReason).length > 0) {
      console.log(`  Union failures by reason:`);
      for (const [reason, count] of Object.entries(unionFailuresByReason).sort()) {
        console.log(`    ${reason}: ${count}`);
      }
    }
    
    // Check if we need to log the bug fix
    if (useMid && report.totals.municipalities_emitted === report.totals.municipalities_expected && report.totals.municipalities_missing === 0) {
      // Bug was fixed - this is expected behavior now
    } else if (useMid && report.totals.municipalities_missing === report.totals.municipalities_expected && report.totals.municipalities_emitted > 0) {
      // This indicates the old bug - log it
      appendMistake({
        title: 'Municipality outline derivation reported all municipalities missing',
        mistake: 'Report logic produced missing list equal to expected even when municipalities were emitted; misleading diagnostics due to ID scheme mismatch (comparing mid from settlements_meta.csv with mun_code from polygons)',
        correctRule: 'Missing list must be expected_minus_emitted (same ID scheme), and counts must be internally consistent. When using mun_code scheme, cannot compare to expected municipalities from settlements_meta.csv (which uses mid).'
      }, '2026-01-25');
    }
    
  } catch (err) {
    console.error('Error deriving municipality outlines:', err);
    process.exit(1);
  }
}

/**
 * Generate HTML viewer
 */
async function generateViewer(
  geojson: turf.FeatureCollection<turf.Polygon | turf.MultiPolygon>,
  report: DerivationReport
): Promise<void> {
  const geojsonData = JSON.stringify(geojson);
  const reportData = JSON.stringify(report);
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Municipality Outlines from Settlement Fabric</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    
    #canvas-container {
      flex: 1;
      position: relative;
      background: #1a1a1a;
    }
    
    #map-canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    
    #sidebar {
      width: 300px;
      background: #2d2d2d;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    #sidebar-header {
      padding: 16px;
      background: #1a1a1a;
      border-bottom: 1px solid #444;
    }
    
    #sidebar-header h1 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    
    #sidebar-header p {
      font-size: 12px;
      color: #aaa;
    }
    
    #sidebar-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
    }
    
    .section {
      margin-bottom: 24px;
    }
    
    .section h2 {
      font-size: 14px;
      text-transform: uppercase;
      color: #888;
      margin-bottom: 12px;
    }
    
    .stat {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #333;
    }
    
    .stat-label {
      color: #aaa;
    }
    
    .stat-value {
      font-weight: 600;
    }
    
    .toggle {
      display: flex;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .toggle input {
      margin-right: 8px;
    }
    
    .toggle label {
      cursor: pointer;
    }
    
    #info-panel {
      background: #1a1a1a;
      padding: 12px;
      border-radius: 4px;
      margin-top: 16px;
      display: none;
    }
    
    #info-panel.visible {
      display: block;
    }
    
    #info-panel h3 {
      font-size: 14px;
      margin-bottom: 8px;
    }
    
    #info-panel p {
      font-size: 12px;
      margin: 4px 0;
      color: #ccc;
    }
    
    .warning {
      color: #ff6b6b;
    }
    
    .success {
      color: #51cf66;
    }
  </style>
</head>
<body>
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>Municipality Outlines</h1>
      <p>Derived from Settlement Polygon Fabric</p>
    </div>
    <div id="sidebar-content">
      <div class="section">
        <h2>Statistics</h2>
        <div class="stat">
          <span class="stat-label">Municipalities</span>
          <span class="stat-value">${report.totals.municipalities_emitted}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Expected</span>
          <span class="stat-value">${report.totals.municipalities_expected}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Missing</span>
          <span class="stat-value ${report.totals.municipalities_missing > 0 ? 'warning' : 'success'}">${report.totals.municipalities_missing}</span>
        </div>
        <div class="stat">
          <span class="stat-label">With polygons</span>
          <span class="stat-value">${report.totals.municipalities_with_polygons ?? report.totals.municipalities_emitted}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Unions Succeeded</span>
          <span class="stat-value success">${report.geometry_stats.unions_succeeded}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Unions Failed</span>
          <span class="stat-value ${report.geometry_stats.unions_failed > 0 ? 'warning' : ''}">${report.geometry_stats.unions_failed}</span>
        </div>
        <div class="stat">
          <span class="stat-label">Fallbacks Used</span>
          <span class="stat-value ${report.geometry_stats.fallbacks_used > 0 ? 'warning' : ''}">${report.geometry_stats.fallbacks_used}</span>
        </div>
      </div>
      
      <div class="section">
        <h2>Layers</h2>
        <div class="toggle">
          <input type="checkbox" id="toggle-outlines" checked>
          <label for="toggle-outlines">Municipality Outlines</label>
        </div>
      </div>
      
      <div id="info-panel">
        <h3>Municipality Info</h3>
        <p id="info-mun-id"></p>
        <p id="info-name"></p>
        <p id="info-poly-count"></p>
        <p id="info-method"></p>
        <p id="info-normalization-level"></p>
      </div>
    </div>
  </div>
  
  <div id="canvas-container">
    <canvas id="map-canvas"></canvas>
  </div>
  
  <script>
    const geojsonData = ${geojsonData};
    const reportData = ${reportData};
    
    const canvas = document.getElementById('map-canvas');
    const ctx = canvas.getContext('2d');
    const toggleOutlines = document.getElementById('toggle-outlines');
    const infoPanel = document.getElementById('info-panel');
    
    let bounds = null;
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;
    let showOutlines = true;
    
    // Calculate bounds
    function calculateBounds() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      
      for (const feature of geojsonData.features) {
        const coords = feature.geometry.type === 'Polygon' 
          ? feature.geometry.coordinates[0]
          : feature.geometry.coordinates.flat().flat();
        
        for (const [x, y] of coords) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      
      return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
    }
    
    // Initialize
    function init() {
      bounds = calculateBounds();
      resizeCanvas();
      fitToBounds();
      render();
    }
    
    function resizeCanvas() {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
      render();
    }
    
    function fitToBounds() {
      const padding = 50;
      const scaleX = (canvas.width - padding * 2) / bounds.width;
      const scaleY = (canvas.height - padding * 2) / bounds.height;
      scale = Math.min(scaleX, scaleY);
      offsetX = (canvas.width - bounds.width * scale) / 2 - bounds.minX * scale;
      offsetY = (canvas.height - bounds.height * scale) / 2 - bounds.minY * scale;
    }
    
    function worldToScreen(x, y) {
      return {
        x: x * scale + offsetX,
        y: y * scale + offsetY
      };
    }
    
    function render() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      if (showOutlines) {
        for (const feature of geojsonData.features) {
          const props = feature.properties || {};
          const isFallback = props.method === 'polygon_collection_fallback';
          
          ctx.strokeStyle = isFallback ? '#ff6b6b' : '#51cf66';
          ctx.lineWidth = isFallback ? 4 : 2;
          ctx.setLineDash(isFallback ? [8, 4] : []);
          ctx.fillStyle = isFallback ? 'rgba(255, 107, 107, 0.1)' : 'rgba(81, 207, 102, 0.1)';
          
          if (feature.geometry.type === 'Polygon') {
            drawPolygon(feature.geometry.coordinates[0]);
          } else if (feature.geometry.type === 'MultiPolygon') {
            for (const poly of feature.geometry.coordinates) {
              drawPolygon(poly[0]);
            }
          }
        }
      }
    }
    
    function drawPolygon(ring) {
      ctx.beginPath();
      const start = worldToScreen(ring[0][0], ring[0][1]);
      ctx.moveTo(start.x, start.y);
      
      for (let i = 1; i < ring.length; i++) {
        const pt = worldToScreen(ring[i][0], ring[i][1]);
        ctx.lineTo(pt.x, pt.y);
      }
      
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    
    function pointInPolygon(point, polygon) {
      const [x, y] = point;
      let inside = false;
      const ring = polygon[0];
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }
    
    function findFeatureAt(x, y) {
      const worldX = (x - offsetX) / scale;
      const worldY = (y - offsetY) / scale;
      const point = [worldX, worldY];
      
      for (const feature of geojsonData.features) {
        if (feature.geometry.type === 'Polygon') {
          if (pointInPolygon(point, feature.geometry.coordinates)) {
            return feature;
          }
        } else if (feature.geometry.type === 'MultiPolygon') {
          for (const poly of feature.geometry.coordinates) {
            if (pointInPolygon(point, poly)) {
              return feature;
            }
          }
        }
      }
      return null;
    }
    
    // Event handlers
    toggleOutlines.addEventListener('change', (e) => {
      showOutlines = e.target.checked;
      render();
    });
    
    canvas.addEventListener('mousedown', (e) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    
    canvas.addEventListener('mousemove', (e) => {
      if (isDragging) {
        offsetX += e.clientX - lastX;
        offsetY += e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;
        render();
      } else {
        const feature = findFeatureAt(e.offsetX, e.offsetY);
        if (feature) {
          const props = feature.properties || {};
          document.getElementById('info-mun-id').textContent = 'Municipality ID: ' + (props.mun_id || 'N/A');
          document.getElementById('info-name').textContent = 'Name: ' + (props.name || 'N/A');
          document.getElementById('info-poly-count').textContent = 'Polygons: ' + (props.poly_count || 0);
          document.getElementById('info-method').textContent = 'Method: ' + (props.method || 'N/A');
          const normLevel = props.normalization_level !== null && props.normalization_level !== undefined 
            ? 'Level ' + props.normalization_level 
            : 'N/A (fallback)';
          document.getElementById('info-normalization-level').textContent = 'Normalization Level: ' + normLevel;
          infoPanel.classList.add('visible');
        } else {
          infoPanel.classList.remove('visible');
        }
      }
    });
    
    canvas.addEventListener('mouseup', () => {
      isDragging = false;
    });
    
    canvas.addEventListener('click', (e) => {
      const feature = findFeatureAt(e.offsetX, e.offsetY);
      if (feature) {
        const props = feature.properties || {};
        console.log('Clicked municipality:', props);
      }
    });
    
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      const mouseX = e.offsetX;
      const mouseY = e.offsetY;
      const worldX = (mouseX - offsetX) / scale;
      const worldY = (mouseY - offsetY) / scale;
      
      scale *= delta;
      offsetX = mouseX - worldX * scale;
      offsetY = mouseY - worldY * scale;
      render();
    });
    
    window.addEventListener('resize', () => {
      resizeCanvas();
    });
    
    init();
  </script>
</body>
</html>`;
  
  await writeFile(OUTPUT_VIEWER_PATH, html, 'utf8');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
