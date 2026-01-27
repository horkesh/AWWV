/**
 * Derive Minimal Settlement Substrate from bih_master.geojson
 * 
 * CANONICAL SCRIPT FOR PHASE 0 SETTLEMENT SUBSTRATE
 * 
 * This script is canonical for Phase 0 settlement substrate. It creates a minimal
 * settlement-only GeoJSON containing ONLY what the map system needs:
 * - Geometry (Polygon/MultiPolygon, as-is, no modification)
 * - Stable IDs (sid from properties.id)
 * - Minimal join keys (name, municipality_id)
 * 
 * Deterministic only: stable ordering, fixed precision, no randomness, no timestamps.
 * No geometry invention: no unions, hulls, buffering, smoothing, repair, simplification.
 * 
 * Usage:
 *   npm run map:derive:substrate
 *   or: tsx scripts/map/derive_settlement_substrate_from_master.ts
 * 
 * Outputs:
 *   - data/derived/settlements_substrate.geojson (canonical Phase 0 substrate)
 *   - data/derived/settlements_substrate.audit.json
 *   - data/derived/settlements_substrate.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Phase 0 cleanup: remove obsolete settlement map artifacts and dead code");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  properties: Record<string, unknown>;
  geometry: {
    type: string;
    coordinates: unknown;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface OutputFeature {
  type: 'Feature';
  properties: {
    sid: string;
    name: string | null;
    municipality_id: string | null;
    source_index: number;
    source: string;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: Polygon | MultiPolygon;
  };
}

interface AuditReport {
  input: {
    total_features: number;
    geometry_type_counts: Record<string, number>;
    layer_type_counts?: Record<string, number>;
    feature_type_counts?: Record<string, number>;
    kind_counts?: Record<string, number>;
  };
  settlement_detection: {
    method: string;
    filter_applied: string;
    candidate_count: number;
    decision_path: string[];
  };
  output: {
    feature_count: number;
    missing_sid_count: number;
    missing_sid_sample_indices: number[];
    invalid_geometry_count: number;
    invalid_geometry_reasons: {
      non_polygon: number;
      non_finite_coords: number;
      ring_too_short: number;
      ring_not_closed: number;
    };
    invalid_geometry_samples: Array<{
      source_index: number;
      reason: string;
      detail?: string;
    }>;
  };
  sid_stats: {
    unique_count: number;
    duplicates_count: number;
    duplicate_samples: Array<{
      sid: string;
      count: number;
      source_indices: number[];
    }>;
  };
  municipality_id_stats: {
    present_count: number;
    missing_count: number;
    present_percentage: number;
  };
  bbox: {
    global: {
      minx: number;
      miny: number;
      maxx: number;
      maxy: number;
    };
    per_feature: {
      min_width: number;
      median_width: number;
      p90_width: number;
      max_width: number;
      min_height: number;
      median_height: number;
      p90_height: number;
      max_height: number;
    };
  };
  note: string;
}

// Settlement ID candidate keys (priority order)
const SID_CANDIDATE_KEYS = ['sid', 'SID', 'settlement_id', 'settlementId', 'naselje_id', 'naseljeId', 'id'];

// Settlement name candidate keys (priority order)
const NAME_CANDIDATE_KEYS = ['name', 'NAME', 'settlement_name', 'naselje', 'naselje_name'];

// Municipality ID candidate keys (priority order)
const MUNI_ID_CANDIDATE_KEYS = ['municipality_id', 'mun_id', 'opstina_id', 'mun_code'];

/**
 * Extract settlement ID from feature properties
 */
function extractSid(properties: Record<string, unknown>): string | null {
  for (const key of SID_CANDIDATE_KEYS) {
    const value = properties[key];
    if (value !== null && value !== undefined) {
      return String(value);
    }
  }
  return null;
}

/**
 * Extract settlement name from feature properties
 */
function extractName(properties: Record<string, unknown>): string | null {
  for (const key of NAME_CANDIDATE_KEYS) {
    const value = properties[key];
    if (value !== null && value !== undefined && typeof value === 'string') {
      return value;
    }
  }
  return null;
}

/**
 * Extract municipality ID from feature properties
 */
function extractMunicipalityId(properties: Record<string, unknown>): string | null {
  for (const key of MUNI_ID_CANDIDATE_KEYS) {
    const value = properties[key];
    if (value !== null && value !== undefined) {
      return String(value);
    }
  }
  return null;
}

/**
 * Check if geometry is Polygon or MultiPolygon
 */
function isPolygonGeometry(geom: GeoJSONFeature['geometry']): boolean {
  return geom.type === 'Polygon' || geom.type === 'MultiPolygon';
}

/**
 * Validate ring: must have >= 4 points and be closed (first == last)
 */
function validateRing(ring: Ring): { valid: boolean; reason?: string } {
  if (ring.length < 4) {
    return { valid: false, reason: 'ring_too_short' };
  }
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return { valid: false, reason: 'ring_not_closed' };
  }
  return { valid: true };
}

/**
 * Check if all coordinates are finite numbers
 */
function validateCoordinates(coords: unknown, geomType: string): { valid: boolean; reason?: string } {
  if (!Array.isArray(coords)) {
    return { valid: false, reason: 'non_finite_coords' };
  }
  
  function checkPoint(point: unknown): boolean {
    if (!Array.isArray(point) || point.length < 2) {
      return false;
    }
    const [x, y] = point;
    return typeof x === 'number' && typeof y === 'number' && 
           isFinite(x) && isFinite(y);
  }
  
  function checkRing(ring: unknown): boolean {
    if (!Array.isArray(ring)) {
      return false;
    }
    return ring.every(checkPoint);
  }
  
  function checkPolygon(poly: unknown): boolean {
    if (!Array.isArray(poly) || poly.length === 0) {
      return false;
    }
    return poly.every(checkRing);
  }
  
  if (geomType === 'Polygon') {
    // Polygon: [[[x,y], ...]]
    if (!Array.isArray(coords) || coords.length === 0) {
      return { valid: false, reason: 'non_finite_coords' };
    }
    return { valid: coords.every(checkRing) };
  } else if (geomType === 'MultiPolygon') {
    // MultiPolygon: [[[[x,y], ...]], ...]
    if (!Array.isArray(coords) || coords.length === 0) {
      return { valid: false, reason: 'non_finite_coords' };
    }
    return { valid: coords.every(checkPolygon) };
  }
  
  return { valid: false, reason: 'non_finite_coords' };
}

/**
 * Validate geometry (no repair, just check)
 */
function validateGeometry(geom: GeoJSONFeature['geometry']): { valid: boolean; reason?: string; detail?: string } {
  if (!isPolygonGeometry(geom)) {
    return { valid: false, reason: 'non_polygon', detail: `Type: ${geom.type}` };
  }
  
  const coords = geom.coordinates;
  const coordCheck = validateCoordinates(coords, geom.type);
  if (!coordCheck.valid) {
    return { valid: false, reason: coordCheck.reason || 'non_finite_coords' };
  }
  
  // Check rings
  if (geom.type === 'Polygon') {
    const polygon = coords as Polygon;
    if (polygon.length === 0) {
      return { valid: false, reason: 'ring_too_short', detail: 'Empty polygon' };
    }
    const outerRing = polygon[0];
    const ringCheck = validateRing(outerRing);
    if (!ringCheck.valid) {
      return { valid: false, reason: ringCheck.reason, detail: `Outer ring: ${ringCheck.reason}` };
    }
  } else if (geom.type === 'MultiPolygon') {
    const multiPolygon = coords as MultiPolygon;
    if (multiPolygon.length === 0) {
      return { valid: false, reason: 'ring_too_short', detail: 'Empty MultiPolygon' };
    }
    for (let i = 0; i < multiPolygon.length; i++) {
      const polygon = multiPolygon[i];
      if (polygon.length === 0) {
        return { valid: false, reason: 'ring_too_short', detail: `Polygon ${i}: empty` };
      }
      const outerRing = polygon[0];
      const ringCheck = validateRing(outerRing);
      if (!ringCheck.valid) {
        return { valid: false, reason: ringCheck.reason, detail: `Polygon ${i} outer ring: ${ringCheck.reason}` };
      }
    }
  }
  
  return { valid: true };
}

/**
 * Compute bbox for a feature
 */
function computeBbox(geom: GeoJSONFeature['geometry']): { minx: number; miny: number; maxx: number; maxy: number } | null {
  if (!isPolygonGeometry(geom)) {
    return null;
  }
  
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  
  function addPoint([x, y]: Point): void {
    if (isFinite(x) && isFinite(y)) {
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  }
  
  function processRing(ring: Ring): void {
    for (const point of ring) {
      addPoint(point);
    }
  }
  
  function processPolygon(poly: Polygon): void {
    for (const ring of poly) {
      processRing(ring);
    }
  }
  
  if (geom.type === 'Polygon') {
    processPolygon(geom.coordinates as Polygon);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates as MultiPolygon) {
      processPolygon(poly);
    }
  }
  
  if (minx === Infinity) {
    return null;
  }
  
  return { minx, miny, maxx, maxy };
}

/**
 * Detect settlement features using deterministic rules
 */
function detectSettlementFeatures(features: GeoJSONFeature[]): {
  candidates: Array<{ feature: GeoJSONFeature; index: number }>;
  method: string;
  filter: string;
  decisionPath: string[];
} {
  const decisionPath: string[] = [];
  
  // Collect all property keys and type indicators
  const layerValues = new Map<string, number>();
  const featureTypeValues = new Map<string, number>();
  const kindValues = new Map<string, number>();
  const geometryTypeCounts = new Map<string, number>();
  
  for (const feature of features) {
    const props = feature.properties;
    const geom = feature.geometry;
    
    // Count geometry types
    const geomType = geom.type;
    geometryTypeCounts.set(geomType, (geometryTypeCounts.get(geomType) || 0) + 1);
    
    // Count layer values
    if (props.layer && typeof props.layer === 'string') {
      layerValues.set(props.layer, (layerValues.get(props.layer) || 0) + 1);
    }
    
    // Count feature_type values
    if (props.feature_type && typeof props.feature_type === 'string') {
      featureTypeValues.set(props.feature_type, (featureTypeValues.get(props.feature_type) || 0) + 1);
    }
    
    // Count kind values
    if (props.kind && typeof props.kind === 'string') {
      kindValues.set(props.kind, (kindValues.get(props.kind) || 0) + 1);
    }
  }
  
  decisionPath.push(`Total features: ${features.length}`);
  decisionPath.push(`Geometry types: ${Array.from(geometryTypeCounts.entries()).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  
  // Strategy 1: Use explicit layer="settlement" filter
  const layerSettlementCandidates: Array<{ feature: GeoJSONFeature; index: number }> = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const props = feature.properties;
    if (props.layer === 'settlement' && isPolygonGeometry(feature.geometry)) {
      const sid = extractSid(props);
      if (sid !== null) {
        layerSettlementCandidates.push({ feature, index: i });
      }
    }
  }
  
  decisionPath.push(`Layer="settlement" filter: ${layerSettlementCandidates.length} candidates with Polygon/MultiPolygon + valid sid`);
  
  // Strategy 2: Use feature_type="settlement" filter
  const featureTypeSettlementCandidates: Array<{ feature: GeoJSONFeature; index: number }> = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const props = feature.properties;
    if (props.feature_type === 'settlement' && isPolygonGeometry(feature.geometry)) {
      const sid = extractSid(props);
      if (sid !== null) {
        featureTypeSettlementCandidates.push({ feature, index: i });
      }
    }
  }
  
  decisionPath.push(`feature_type="settlement" filter: ${featureTypeSettlementCandidates.length} candidates with Polygon/MultiPolygon + valid sid`);
  
  // Strategy 3: Use kind="settlement" (case-insensitive) filter
  const kindSettlementCandidates: Array<{ feature: GeoJSONFeature; index: number }> = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const props = feature.properties;
    if (props.kind && typeof props.kind === 'string' && props.kind.toLowerCase() === 'settlement' && isPolygonGeometry(feature.geometry)) {
      const sid = extractSid(props);
      if (sid !== null) {
        kindSettlementCandidates.push({ feature, index: i });
      }
    }
  }
  
  decisionPath.push(`kind="settlement" filter: ${kindSettlementCandidates.length} candidates with Polygon/MultiPolygon + valid sid`);
  
  // Strategy 4: All Polygon/MultiPolygon with valid sid (no type filter)
  const allPolygonCandidates: Array<{ feature: GeoJSONFeature; index: number }> = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    if (isPolygonGeometry(feature.geometry)) {
      const sid = extractSid(feature.properties);
      if (sid !== null) {
        allPolygonCandidates.push({ feature, index: i });
      }
    }
  }
  
  decisionPath.push(`All Polygon/MultiPolygon with valid sid: ${allPolygonCandidates.length} candidates`);
  
  // Choose filter: prefer explicit filters over "all_polygons"
  // Priority: layer > feature_type > kind > all_polygons (if explicit filters yield reasonable counts)
  let chosen: { name: string; candidates: Array<{ feature: GeoJSONFeature; index: number }> };
  
  if (layerSettlementCandidates.length > 0) {
    chosen = { name: 'layer="settlement"', candidates: layerSettlementCandidates };
    decisionPath.push(`Chosen filter: ${chosen.name} (${chosen.candidates.length} candidates) - explicit layer filter preferred`);
  } else if (featureTypeSettlementCandidates.length > 0) {
    chosen = { name: 'feature_type="settlement"', candidates: featureTypeSettlementCandidates };
    decisionPath.push(`Chosen filter: ${chosen.name} (${chosen.candidates.length} candidates) - explicit feature_type filter preferred`);
  } else if (kindSettlementCandidates.length > 0) {
    chosen = { name: 'kind="settlement"', candidates: kindSettlementCandidates };
    decisionPath.push(`Chosen filter: ${chosen.name} (${chosen.candidates.length} candidates) - explicit kind filter preferred`);
  } else {
    chosen = { name: 'all_polygons', candidates: allPolygonCandidates };
    decisionPath.push(`Chosen filter: ${chosen.name} (${chosen.candidates.length} candidates) - no explicit type filter found, using all polygons`);
  }
  
  return {
    candidates: chosen.candidates,
    method: 'deterministic_filter_selection',
    filter: chosen.name,
    decisionPath
  };
}

async function main(): Promise<void> {
  const sourcePath = resolve('data/source/bih_master.geojson');
  const outputPath = resolve('data/derived/settlements_substrate.geojson');
  const auditJsonPath = resolve('data/derived/settlements_substrate.audit.json');
  const auditTxtPath = resolve('data/derived/settlements_substrate.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });
  
  // Load source GeoJSON
  process.stdout.write(`Loading ${sourcePath}...\n`);
  const sourceContent = readFileSync(sourcePath, 'utf8');
  const sourceGeoJSON = JSON.parse(sourceContent) as GeoJSONFC;
  
  if (sourceGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${sourceGeoJSON.type}`);
  }
  
  const features = sourceGeoJSON.features;
  process.stdout.write(`Loaded ${features.length} features\n`);
  
  // Detect settlement features
  process.stdout.write(`Detecting settlement features...\n`);
  const detection = detectSettlementFeatures(features);
  process.stdout.write(`Detected ${detection.candidates.length} settlement candidates using filter: ${detection.filter}\n`);
  
  // Process candidates into output features
  const outputFeatures: OutputFeature[] = [];
  const missingSidIndices: number[] = [];
  const invalidGeometrySamples: Array<{ source_index: number; reason: string; detail?: string }> = [];
  const invalidGeometryReasons = {
    non_polygon: 0,
    non_finite_coords: 0,
    ring_too_short: 0,
    ring_not_closed: 0
  };
  const sidToIndices = new Map<string, number[]>();
  const bboxes: Array<{ width: number; height: number }> = [];
  let municipalityIdPresent = 0;
  let municipalityIdMissing = 0;
  
  for (const { feature, index } of detection.candidates) {
    const props = feature.properties;
    const sid = extractSid(props);
    
    if (sid === null) {
      missingSidIndices.push(index);
      continue;
    }
    
    // Track sid for duplicate detection
    if (!sidToIndices.has(sid)) {
      sidToIndices.set(sid, []);
    }
    sidToIndices.get(sid)!.push(index);
    
    // Validate geometry
    const geomCheck = validateGeometry(feature.geometry);
    if (!geomCheck.valid) {
      invalidGeometryReasons[geomCheck.reason as keyof typeof invalidGeometryReasons]++;
      if (invalidGeometrySamples.length < 20) {
        invalidGeometrySamples.push({
          source_index: index,
          reason: geomCheck.reason || 'unknown',
          detail: geomCheck.detail
        });
      }
      continue;
    }
    
    // Extract properties
    const name = extractName(props);
    const municipalityId = extractMunicipalityId(props);
    
    if (municipalityId !== null) {
      municipalityIdPresent++;
    } else {
      municipalityIdMissing++;
    }
    
    // Compute bbox
    const bbox = computeBbox(feature.geometry);
    if (bbox) {
      bboxes.push({
        width: bbox.maxx - bbox.minx,
        height: bbox.maxy - bbox.miny
      });
    }
    
    // Create output feature
    const outputFeature: OutputFeature = {
      type: 'Feature',
      properties: {
        sid: sid,
        name: name,
        municipality_id: municipalityId,
        source_index: index,
        source: 'bih_master.geojson'
      },
      geometry: feature.geometry as { type: 'Polygon' | 'MultiPolygon'; coordinates: Polygon | MultiPolygon }
    };
    
    outputFeatures.push(outputFeature);
  }
  
  // Sort output features deterministically: by sid (string compare), then source_index
  outputFeatures.sort((a, b) => {
    const sidCompare = a.properties.sid.localeCompare(b.properties.sid);
    if (sidCompare !== 0) {
      return sidCompare;
    }
    return a.properties.source_index - b.properties.source_index;
  });
  
  // Compute global bbox
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  for (const feature of outputFeatures) {
    const bbox = computeBbox(feature.geometry);
    if (bbox) {
      globalMinx = Math.min(globalMinx, bbox.minx);
      globalMiny = Math.min(globalMiny, bbox.miny);
      globalMaxx = Math.max(globalMaxx, bbox.maxx);
      globalMaxy = Math.max(globalMaxy, bbox.maxy);
    }
  }
  
  // Compute per-feature bbox stats
  const widths = bboxes.map(b => b.width).sort((a, b) => a - b);
  const heights = bboxes.map(b => b.height).sort((a, b) => a - b);
  
  const median = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 === 0 ? (arr[mid - 1] + arr[mid]) / 2 : arr[mid];
  };
  
  const p90 = (arr: number[]) => {
    if (arr.length === 0) return 0;
    const idx = Math.floor(arr.length * 0.9);
    return arr[Math.min(idx, arr.length - 1)];
  };
  
  // Find duplicate sids
  const duplicateSids: Array<{ sid: string; count: number; source_indices: number[] }> = [];
  for (const [sid, indices] of sidToIndices.entries()) {
    if (indices.length > 1) {
      duplicateSids.push({
        sid,
        count: indices.length,
        source_indices: indices.slice(0, 20) // Sample first 20
      });
    }
  }
  duplicateSids.sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }
    return a.sid.localeCompare(b.sid);
  });
  
  // Build audit report
  const geometryTypeCounts: Record<string, number> = {};
  for (const feature of features) {
    const type = feature.geometry.type;
    geometryTypeCounts[type] = (geometryTypeCounts[type] || 0) + 1;
  }
  
  const layerTypeCounts: Record<string, number> = {};
  const featureTypeCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  
  for (const feature of features) {
    const props = feature.properties;
    if (props.layer && typeof props.layer === 'string') {
      layerTypeCounts[props.layer] = (layerTypeCounts[props.layer] || 0) + 1;
    }
    if (props.feature_type && typeof props.feature_type === 'string') {
      featureTypeCounts[props.feature_type] = (featureTypeCounts[props.feature_type] || 0) + 1;
    }
    if (props.kind && typeof props.kind === 'string') {
      kindCounts[props.kind] = (kindCounts[props.kind] || 0) + 1;
    }
  }
  
  const auditReport: AuditReport = {
    input: {
      total_features: features.length,
      geometry_type_counts: geometryTypeCounts,
      layer_type_counts: Object.keys(layerTypeCounts).length > 0 ? layerTypeCounts : undefined,
      feature_type_counts: Object.keys(featureTypeCounts).length > 0 ? featureTypeCounts : undefined,
      kind_counts: Object.keys(kindCounts).length > 0 ? kindCounts : undefined
    },
    settlement_detection: {
      method: detection.method,
      filter_applied: detection.filter,
      candidate_count: detection.candidates.length,
      decision_path: detection.decisionPath
    },
    output: {
      feature_count: outputFeatures.length,
      missing_sid_count: missingSidIndices.length,
      missing_sid_sample_indices: missingSidIndices.slice(0, 20),
      invalid_geometry_count: invalidGeometrySamples.length,
      invalid_geometry_reasons: invalidGeometryReasons,
      invalid_geometry_samples: invalidGeometrySamples
    },
    sid_stats: {
      unique_count: sidToIndices.size,
      duplicates_count: duplicateSids.length,
      duplicate_samples: duplicateSids.slice(0, 20)
    },
    municipality_id_stats: {
      present_count: municipalityIdPresent,
      missing_count: municipalityIdMissing,
      present_percentage: outputFeatures.length > 0 ? (municipalityIdPresent / outputFeatures.length) * 100 : 0
    },
    bbox: {
      global: {
        minx: globalMinx === Infinity ? 0 : globalMinx,
        miny: globalMiny === Infinity ? 0 : globalMiny,
        maxx: globalMaxx === -Infinity ? 0 : globalMaxx,
        maxy: globalMaxy === -Infinity ? 0 : globalMaxy
      },
      per_feature: {
        min_width: widths.length > 0 ? widths[0] : 0,
        median_width: median(widths),
        p90_width: p90(widths),
        max_width: widths.length > 0 ? widths[widths.length - 1] : 0,
        min_height: heights.length > 0 ? heights[0] : 0,
        median_height: median(heights),
        p90_height: p90(heights),
        max_height: heights.length > 0 ? heights[heights.length - 1] : 0
      }
    },
    note: 'This derived file is a minimal substrate. Population/ethnicity remains in separate authoritative datasets and will be joined into derived start-state tables.'
  };
  
  // Check for systemic issues
  if (duplicateSids.length > 0) {
    appendMistake({
      key: 'settlement.substrate.duplicate_sids',
      date: '2026-01-26',
      title: 'Settlement substrate has duplicate SIDs',
      description: `Found ${duplicateSids.length} duplicate SID groups in bih_master.geojson. Multiple polygons share the same sid. This may indicate multi-polygon settlement identity assumptions that need clarification.`,
      correctiveAction: 'Do not merge duplicate polygons automatically. Keep all polygons, but flag that FORAWWV.md may need an addendum about multi-polygon settlement identity assumptions.'
    });
  }
  
  if (missingSidIndices.length > 0) {
    appendMistake({
      key: 'settlement.substrate.missing_stable_ids',
      date: '2026-01-26',
      title: 'Settlement substrate has features missing stable SIDs',
      description: `Found ${missingSidIndices.length} settlement candidate features without valid SID keys in bih_master.geojson. These features were excluded from output.`,
      correctiveAction: 'Excluded features are reported in audit. If this indicates a systemic schema issue, FORAWWV.md may require an addendum.'
    });
  }
  
  // Write output GeoJSON
  const outputGeoJSON: GeoJSONFC = {
    type: 'FeatureCollection',
    features: outputFeatures as unknown as GeoJSONFeature[]
  };
  
  writeFileSync(outputPath, JSON.stringify(outputGeoJSON, null, 2), 'utf8');
  process.stdout.write(`Wrote ${outputFeatures.length} features to ${outputPath}\n`);
  
  // Write audit JSON
  writeFileSync(auditJsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditJsonPath}\n`);
  
  // Write audit TXT
  const txtLines: string[] = [];
  txtLines.push('SETTLEMENT SUBSTRATE DERIVATION AUDIT');
  txtLines.push('=====================================');
  txtLines.push('');
  txtLines.push('INPUT:');
  txtLines.push(`  Total features: ${auditReport.input.total_features}`);
  txtLines.push(`  Geometry types: ${Object.entries(auditReport.input.geometry_type_counts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (auditReport.input.layer_type_counts) {
    txtLines.push(`  Layer values (top 20): ${Object.entries(auditReport.input.layer_type_counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (auditReport.input.feature_type_counts) {
    txtLines.push(`  Feature type values (top 20): ${Object.entries(auditReport.input.feature_type_counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (auditReport.input.kind_counts) {
    txtLines.push(`  Kind values (top 20): ${Object.entries(auditReport.input.kind_counts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  txtLines.push('');
  txtLines.push('SETTLEMENT DETECTION:');
  txtLines.push(`  Method: ${auditReport.settlement_detection.method}`);
  txtLines.push(`  Filter applied: ${auditReport.settlement_detection.filter_applied}`);
  txtLines.push(`  Candidate count: ${auditReport.settlement_detection.candidate_count}`);
  txtLines.push('  Decision path:');
  for (const step of auditReport.settlement_detection.decision_path) {
    txtLines.push(`    - ${step}`);
  }
  txtLines.push('');
  txtLines.push('OUTPUT:');
  txtLines.push(`  Feature count: ${auditReport.output.feature_count}`);
  txtLines.push(`  Missing SID count: ${auditReport.output.missing_sid_count}`);
  if (auditReport.output.missing_sid_count > 0) {
    txtLines.push(`  Missing SID sample indices (first 20): ${auditReport.output.missing_sid_sample_indices.join(', ')}`);
  }
  txtLines.push(`  Invalid geometry count: ${auditReport.output.invalid_geometry_count}`);
  txtLines.push(`  Invalid geometry reasons:`);
  txtLines.push(`    - Non-polygon: ${auditReport.output.invalid_geometry_reasons.non_polygon}`);
  txtLines.push(`    - Non-finite coords: ${auditReport.output.invalid_geometry_reasons.non_finite_coords}`);
  txtLines.push(`    - Ring too short: ${auditReport.output.invalid_geometry_reasons.ring_too_short}`);
  txtLines.push(`    - Ring not closed: ${auditReport.output.invalid_geometry_reasons.ring_not_closed}`);
  if (auditReport.output.invalid_geometry_samples.length > 0) {
    txtLines.push(`  Invalid geometry samples (first 20):`);
    for (const sample of auditReport.output.invalid_geometry_samples) {
      txtLines.push(`    - Index ${sample.source_index}: ${sample.reason}${sample.detail ? ` (${sample.detail})` : ''}`);
    }
  }
  txtLines.push('');
  txtLines.push('SID STATISTICS:');
  txtLines.push(`  Unique SIDs: ${auditReport.sid_stats.unique_count}`);
  txtLines.push(`  Duplicate SID groups: ${auditReport.sid_stats.duplicates_count}`);
  if (auditReport.sid_stats.duplicate_samples.length > 0) {
    txtLines.push(`  Duplicate SID samples (first 20):`);
    for (const dup of auditReport.sid_stats.duplicate_samples) {
      txtLines.push(`    - ${dup.sid}: ${dup.count} occurrences (indices: ${dup.source_indices.join(', ')})`);
    }
  }
  txtLines.push('');
  txtLines.push('MUNICIPALITY ID STATISTICS:');
  txtLines.push(`  Present: ${auditReport.municipality_id_stats.present_count} (${auditReport.municipality_id_stats.present_percentage.toFixed(1)}%)`);
  txtLines.push(`  Missing: ${auditReport.municipality_id_stats.missing_count}`);
  txtLines.push('');
  txtLines.push('BOUNDING BOX:');
  txtLines.push(`  Global: [${auditReport.bbox.global.minx.toFixed(6)}, ${auditReport.bbox.global.miny.toFixed(6)}, ${auditReport.bbox.global.maxx.toFixed(6)}, ${auditReport.bbox.global.maxy.toFixed(6)}]`);
  txtLines.push(`  Per-feature width: min=${auditReport.bbox.per_feature.min_width.toFixed(6)}, median=${auditReport.bbox.per_feature.median_width.toFixed(6)}, p90=${auditReport.bbox.per_feature.p90_width.toFixed(6)}, max=${auditReport.bbox.per_feature.max_width.toFixed(6)}`);
  txtLines.push(`  Per-feature height: min=${auditReport.bbox.per_feature.min_height.toFixed(6)}, median=${auditReport.bbox.per_feature.median_height.toFixed(6)}, p90=${auditReport.bbox.per_feature.p90_height.toFixed(6)}, max=${auditReport.bbox.per_feature.max_height.toFixed(6)}`);
  txtLines.push('');
  txtLines.push('NOTE:');
  txtLines.push(`  ${auditReport.note}`);
  
  if (auditReport.sid_stats.duplicates_count > 0) {
    txtLines.push('');
    txtLines.push('WARNING: Duplicate SIDs found. Multiple polygons share the same sid.');
    txtLines.push('  This may indicate multi-polygon settlement identity assumptions.');
    txtLines.push('  FORAWWV.md may require an addendum. Do NOT edit it automatically.');
  }
  
  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit report to ${auditTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Output count: ${auditReport.output.feature_count}\n`);
  process.stdout.write(`  Missing SID: ${auditReport.output.missing_sid_count}\n`);
  process.stdout.write(`  Invalid geometry: ${auditReport.output.invalid_geometry_count}\n`);
  process.stdout.write(`  Duplicate SID groups: ${auditReport.sid_stats.duplicates_count}\n`);
  process.stdout.write(`  Global bbox: [${auditReport.bbox.global.minx.toFixed(6)}, ${auditReport.bbox.global.miny.toFixed(6)}, ${auditReport.bbox.global.maxx.toFixed(6)}, ${auditReport.bbox.global.maxy.toFixed(6)}]\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
