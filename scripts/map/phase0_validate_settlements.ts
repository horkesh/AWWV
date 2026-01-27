/**
 * Phase 0 Settlement Substrate Validation
 * 
 * Validates settlement GeoJSON and census data, produces validation reports
 * and viewer data index. Read-only validation - no geometry modification.
 * 
 * Usage:
 *   tsx scripts/map/phase0_validate_settlements.ts
 * 
 * Outputs:
 *   - data/derived/phase0_validation_report.json
 *   - data/derived/phase0_validation_report.txt
 *   - data/derived/phase0_viewer/data_index.json
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat, appendMistake } from '../../tools/assistant/mistake_guard';
import { recordAssumptionInvalidated } from '../../tools/assistant/mistake_helpers';

// Mistake guard
loadMistakes();
assertNoRepeat("Viewer render-space Y-axis flip for embedded settlement GeoJSON orientation");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  id?: string | number;
  properties: {
    id?: string | number;
    sid?: string;
    settlement_id?: string;
    municipality_id?: string;
    mun_id?: string;
    municipality?: string;
    [key: string]: unknown;
  };
  geometry: {
    type: 'Polygon' | 'MultiPolygon' | string;
    coordinates: Polygon | MultiPolygon;
  };
}

interface GeoJSONFC {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
}

interface CensusMunicipality {
  n: string; // name
  p: number[]; // [total, bosniak, croat, serb, other]
  s?: string[]; // settlement IDs
}

interface CensusSettlement {
  p?: number[]; // [total, bosniak, croat, serb, other] - optional, may not exist
  [key: string]: unknown;
}

interface CensusData {
  municipalities?: Record<string, CensusMunicipality>;
  settlements?: Record<string, CensusSettlement>;
  naselja?: Record<string, CensusSettlement>;
  settlement?: Record<string, CensusSettlement>;
  naselje?: Record<string, CensusSettlement>;
  [key: string]: unknown; // Allow other top-level keys
}

interface ValidationReport {
  counts: {
    total_features: number;
    missing_sid: number;
    duplicate_sid_count: number;
    missing_municipality_id: number;
    missing_in_census: number;
    geometry_warnings_count: number;
  };
  global_bbox: {
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  };
  distribution_stats: {
    bbox_width: { min: number; median: number; p90: number; max: number };
    bbox_height: { min: number; median: number; p90: number; max: number };
  };
  top_warnings: Array<{
    sid: string;
    warning: string;
    feature_index: number;
  }>;
  duplicate_sids: Array<{
    sid: string;
    count: number;
    sample_indices: number[];
  }>;
  missing_municipality_samples: string[];
  missing_in_census_samples: string[];
  coordinate_regime_suspicion?: string;
  viewer_display?: {
    y_flip_default: boolean;
    reason: string;
    systemic_insight?: string;
  };
  census_validation: {
    settlement_level_census_available: boolean;
    census_settlement_key_used?: string;
    census_settlement_overlap_count?: number;
    settlement_p_sum_pass_count: number;
    settlement_p_sum_fail_count: number;
    settlement_p_sum_fail_rate: number;
    matched_settlement_census_count: number;
    no_settlement_census_count: number;
    invalid_settlement_p_count: number;
    missing_sid_count: number;
  };
}

interface ViewerIndex {
  global_bbox: { minx: number; miny: number; maxx: number; maxy: number };
  settlements: Array<{
    sid: string | null;
    source_index: number;
    bbox: { minx: number; miny: number; maxx: number; maxy: number };
    centroid: { x: number; y: number };
    data_provenance: 'settlement' | 'no_settlement_census' | 'invalid_settlement_p' | 'missing_sid';
    majority_ethnicity: 'bosniak' | 'croat' | 'serb' | 'other' | 'unknown' | 'p1' | 'p2' | 'p3' | 'p4';
    shares: { bosniak?: number; croat?: number; serb?: number; other?: number } | { p1: number; p2: number; p3: number; p4: number };
  }>;
  legend_labels: {
    bosniak?: string;
    croat?: string;
    serb?: string;
    other?: string;
    p1?: string;
    p2?: string;
    p3?: string;
    p4?: string;
  };
  counts_by_majority: {
    bosniak?: number;
    croat?: number;
    serb?: number;
    other?: number;
    unknown?: number;
    p1?: number;
    p2?: number;
    p3?: number;
    p4?: number;
  };
  provenance_counts: {
    settlement: number;
    no_settlement_census: number;
    invalid_settlement_p: number;
    missing_sid: number;
  };
  census_ordering_validated: boolean;
  ordering_mode: 'named' | 'ambiguous';
  settlement_level_census_available: boolean;
  census_settlement_key_used?: string;
  census_settlement_overlap_count?: number;
  settlement_p_sum_fail_rate?: number;
  feature_count: number;
  matched_settlement_census_count: number;
  unknown_count: number;
}

// Deterministic tie-breaking order for majority ethnicity
const ETHNICITY_ORDER = ['bosniak', 'serb', 'croat', 'other'] as const;

function extractSid(feature: GeoJSONFeature, index: number): { sid: string | null; source: string } {
  // Exact key match only, in priority order: sid, SID, settlement_id, settlementId, id
  if (feature.properties.sid !== undefined) {
    return { sid: String(feature.properties.sid), source: 'sid' };
  }
  if (feature.properties.SID !== undefined) {
    return { sid: String(feature.properties.SID), source: 'SID' };
  }
  if (feature.properties.settlement_id !== undefined) {
    return { sid: String(feature.properties.settlement_id), source: 'settlement_id' };
  }
  if (feature.properties.settlementId !== undefined) {
    return { sid: String(feature.properties.settlementId), source: 'settlementId' };
  }
  if (feature.properties.id !== undefined) {
    return { sid: String(feature.properties.id), source: 'id' };
  }
  if (feature.id !== undefined) {
    return { sid: String(feature.id), source: 'feature.id' };
  }
  return { sid: null, source: 'none' };
}

function extractMunicipalityId(feature: GeoJSONFeature): string | null {
  // Exact key match only, in priority order: municipality_id, mun_id, municipalityId, munId, municipality, opstina_id, opstinaId, mun_code
  if (feature.properties.municipality_id !== undefined) {
    return String(feature.properties.municipality_id);
  }
  if (feature.properties.mun_id !== undefined) {
    return String(feature.properties.mun_id);
  }
  if (feature.properties.municipalityId !== undefined) {
    return String(feature.properties.municipalityId);
  }
  if (feature.properties.munId !== undefined) {
    return String(feature.properties.munId);
  }
  if (feature.properties.municipality !== undefined) {
    return String(feature.properties.municipality);
  }
  if (feature.properties.opstina_id !== undefined) {
    return String(feature.properties.opstina_id);
  }
  if (feature.properties.opstinaId !== undefined) {
    return String(feature.properties.opstinaId);
  }
  if (feature.properties.mun_code !== undefined) {
    return String(feature.properties.mun_code);
  }
  return null;
}

function computeBbox(coords: Polygon | MultiPolygon): { minx: number; miny: number; maxx: number; maxy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;

  const processRing = (ring: Ring) => {
    for (const pt of ring) {
      if (!Array.isArray(pt) || pt.length < 2) continue;
      const [x, y] = pt;
      if (!isFinite(x) || !isFinite(y)) continue;
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
  };

  // Check if MultiPolygon:
  // Polygon: coords[0][0][0] is a number (x coordinate)
  // MultiPolygon: coords[0][0][0] is an array [x,y] (first point of first ring of first polygon)
  const isMultiPolygon = Array.isArray(coords) && 
                         coords.length > 0 && 
                         Array.isArray(coords[0]) && 
                         coords[0].length > 0 && 
                         Array.isArray(coords[0][0]) && 
                         coords[0][0].length > 0 && 
                         Array.isArray(coords[0][0][0]);

  if (isMultiPolygon) {
    // MultiPolygon
    for (const poly of coords as MultiPolygon) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        processRing(ring);
      }
    }
  } else {
    // Polygon
    for (const ring of coords as Polygon) {
      if (!Array.isArray(ring)) continue;
      processRing(ring);
    }
  }

  // Return 0-based bbox if no valid coordinates found
  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  }

  return { minx, miny, maxx, maxy };
}

function computeSignedArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

function validateGeometry(feature: GeoJSONFeature, index: number): string[] {
  const warnings: string[] = [];
  const { geometry } = feature;

  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    warnings.push(`geometry_type_not_polygon: ${geometry.type}`);
    return warnings;
  }

  const coords = geometry.coordinates;
  const epsilon = 1e-9;

  // Check if MultiPolygon: coords[0][0][0] should be an array (polygon -> ring -> point -> [x,y])
  // vs Polygon: coords[0][0] is a number (ring -> point -> x)
  const isMultiPolygon = Array.isArray(coords) && 
                         coords.length > 0 && 
                         Array.isArray(coords[0]) && 
                         coords[0].length > 0 && 
                         Array.isArray(coords[0][0]) && 
                         coords[0][0].length > 0 && 
                         Array.isArray(coords[0][0][0]);

  if (isMultiPolygon) {
    // MultiPolygon
    for (let polyIdx = 0; polyIdx < coords.length; polyIdx++) {
      const poly = (coords as MultiPolygon)[polyIdx];
      if (!Array.isArray(poly)) continue;
      for (let ringIdx = 0; ringIdx < poly.length; ringIdx++) {
        const ring = poly[ringIdx];
        if (!Array.isArray(ring)) continue;
        if (ring.length < 4) {
          warnings.push(`ring_too_short: poly[${polyIdx}].ring[${ringIdx}] has ${ring.length} points`);
        }
        if (ring.length > 0 && Array.isArray(ring[0]) && ring[0].length >= 2) {
          const first = ring[0] as Point;
          const last = ring[ring.length - 1] as Point;
          if (!Array.isArray(last) || last.length < 2) continue;
          const closed = Math.abs(first[0] - last[0]) < epsilon && Math.abs(first[1] - last[1]) < epsilon;
          if (!closed) {
            warnings.push(`ring_not_closed: poly[${polyIdx}].ring[${ringIdx}]`);
          }
          // Check for consecutive duplicates
          for (let i = 0; i < ring.length - 1; i++) {
            const pt1 = ring[i] as Point;
            const pt2 = ring[i + 1] as Point;
            if (!Array.isArray(pt1) || pt1.length < 2 || !Array.isArray(pt2) || pt2.length < 2) continue;
            const [x1, y1] = pt1;
            const [x2, y2] = pt2;
            if (Math.abs(x1 - x2) < epsilon && Math.abs(y1 - y2) < epsilon) {
              warnings.push(`consecutive_duplicate_vertex: poly[${polyIdx}].ring[${ringIdx}].point[${i}]`);
              break; // Only report first per ring
            }
          }
          // Check area for outer ring
          if (ringIdx === 0) {
            const area = Math.abs(computeSignedArea(ring));
            if (area < epsilon) {
              warnings.push(`near_zero_area: poly[${polyIdx}].ring[0] area=${area.toExponential()}`);
            }
          }
        }
      }
    }
  } else {
    // Polygon
    for (let ringIdx = 0; ringIdx < coords.length; ringIdx++) {
      const ring = (coords as Polygon)[ringIdx];
      if (!Array.isArray(ring)) continue;
      if (ring.length < 4) {
        warnings.push(`ring_too_short: ring[${ringIdx}] has ${ring.length} points`);
      }
      if (ring.length > 0 && Array.isArray(ring[0]) && ring[0].length >= 2) {
        const first = ring[0] as Point;
        const last = ring[ring.length - 1] as Point;
        if (!Array.isArray(last) || last.length < 2) continue;
        const closed = Math.abs(first[0] - last[0]) < epsilon && Math.abs(first[1] - last[1]) < epsilon;
        if (!closed) {
          warnings.push(`ring_not_closed: ring[${ringIdx}]`);
        }
        // Check for consecutive duplicates
        for (let i = 0; i < ring.length - 1; i++) {
          const pt1 = ring[i] as Point;
          const pt2 = ring[i + 1] as Point;
          if (!Array.isArray(pt1) || pt1.length < 2 || !Array.isArray(pt2) || pt2.length < 2) continue;
          const [x1, y1] = pt1;
          const [x2, y2] = pt2;
          if (Math.abs(x1 - x2) < epsilon && Math.abs(y1 - y2) < epsilon) {
            warnings.push(`consecutive_duplicate_vertex: ring[${ringIdx}].point[${i}]`);
            break;
          }
        }
        // Check area for outer ring
        if (ringIdx === 0) {
          const area = Math.abs(computeSignedArea(ring));
          if (area < epsilon) {
            warnings.push(`near_zero_area: ring[0] area=${area.toExponential()}`);
          }
        }
      }
    }
  }

  return warnings;
}

function computePercentiles(values: number[]): { min: number; median: number; p90: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p90: sorted[Math.floor(sorted.length * 0.9)] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function determineMajorityEthnicity(shares: { bosniak: number; croat: number; serb: number; other: number }): string {
  let maxShare = -1;
  let majority = 'other';

  // Deterministic tie-breaking: bosniak > serb > croat > other
  for (const eth of ETHNICITY_ORDER) {
    if (shares[eth] > maxShare) {
      maxShare = shares[eth];
      majority = eth;
    }
  }

  return majority;
}

async function main(): Promise<void> {
  const settlementsPath = resolve('data/source/bih_settlements_1991_from_embedded.geojson');
  const censusPath = resolve('data/source/bih_census_1991.json');
  const reportJsonPath = resolve('data/derived/phase0_embedded_validation_report.json');
  const reportTxtPath = resolve('data/derived/phase0_embedded_validation_report.txt');
  const viewerIndexPath = resolve('data/derived/phase0_embedded_viewer/data_index.json');

  console.log('Loading settlement GeoJSON...');
  const settlementsData: GeoJSONFC = JSON.parse(readFileSync(settlementsPath, 'utf8'));

  console.log('Loading census data...');
  const censusData: CensusData = JSON.parse(readFileSync(censusPath, 'utf8'));

  // 1. File-level sanity
  if (settlementsData.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${settlementsData.type}`);
  }

  const features = settlementsData.features;
  console.log(`Processing ${features.length} features...`);

  // Deterministic sorting: by sid (string compare) then by original index
  const indexedFeatures = features.map((f, idx) => ({ feature: f, originalIndex: idx }));
  indexedFeatures.sort((a, b) => {
    const sidA = extractSid(a.feature, a.originalIndex).sid ?? '';
    const sidB = extractSid(b.feature, b.originalIndex).sid ?? '';
    const cmp = sidA.localeCompare(sidB);
    if (cmp !== 0) return cmp;
    return a.originalIndex - b.originalIndex;
  });

  // 2. Settlement ID validation
  const sidMap = new Map<string, number[]>();
  const missingSidIndices: number[] = [];
  const allWarnings: Array<{ sid: string; warning: string; feature_index: number }> = [];

  for (let i = 0; i < indexedFeatures.length; i++) {
    const { feature, originalIndex } = indexedFeatures[i];
    const { sid, source } = extractSid(feature, originalIndex);

    if (!sid) {
      missingSidIndices.push(originalIndex);
      continue;
    }

    if (!sidMap.has(sid)) {
      sidMap.set(sid, []);
    }
    sidMap.get(sid)!.push(originalIndex);
  }

  const duplicateSids: Array<{ sid: string; count: number; sample_indices: number[] }> = [];
  for (const [sid, indices] of sidMap.entries()) {
    if (indices.length > 1) {
      duplicateSids.push({
        sid,
        count: indices.length,
        sample_indices: indices.slice(0, 10), // Sample first 10
      });
    }
  }
  duplicateSids.sort((a, b) => b.count - a.count || a.sid.localeCompare(b.sid));

  // 3. Municipality metadata validation
  const missingMuniIdSids: string[] = [];
  const missingInCensusSids: string[] = [];

  for (const { feature, originalIndex } of indexedFeatures) {
    const { sid } = extractSid(feature, originalIndex);
    if (!sid) continue;

    const muniId = extractMunicipalityId(feature);
    if (!muniId) {
      missingMuniIdSids.push(sid);
      if (missingMuniIdSids.length <= 20) {
        allWarnings.push({ sid, warning: 'missing_municipality_id', feature_index: originalIndex });
      }
      continue;
    }

    if (!censusData.municipalities[muniId]) {
      missingInCensusSids.push(sid);
      if (missingInCensusSids.length <= 20) {
        allWarnings.push({ sid, warning: `missing_in_census: municipality_id=${muniId}`, feature_index: originalIndex });
      }
    }
  }

  // 4. Geometry validation
  let geometryWarningsCount = 0;
  for (const { feature, originalIndex } of indexedFeatures) {
    const { sid } = extractSid(feature, originalIndex);
    if (!sid) continue;

    const warnings = validateGeometry(feature, originalIndex);
    for (const warning of warnings) {
      geometryWarningsCount++;
      allWarnings.push({ sid, warning, feature_index: originalIndex });
    }
  }

  // 5. Coordinate regime audit
  const bboxes: Array<{ minx: number; miny: number; maxx: number; maxy: number }> = [];
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;

  for (const { feature } of indexedFeatures) {
    const { sid } = extractSid(feature, 0);
    if (!sid) continue;

    try {
      const bbox = computeBbox(feature.geometry.coordinates as Polygon | MultiPolygon);
      bboxes.push(bbox);
      globalMinx = Math.min(globalMinx, bbox.minx);
      globalMiny = Math.min(globalMiny, bbox.miny);
      globalMaxx = Math.max(globalMaxx, bbox.maxx);
      globalMaxy = Math.max(globalMaxy, bbox.maxy);
    } catch (err) {
      // Skip invalid geometry
    }
  }

  // Only compute global bbox if we have valid bboxes
  const globalBbox = bboxes.length > 0 
    ? { minx: globalMinx, miny: globalMiny, maxx: globalMaxx, maxy: globalMaxy }
    : { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  
  const widths = bboxes.map(b => b.maxx - b.minx);
  const heights = bboxes.map(b => b.maxy - b.miny);
  const distributionStats = {
    bbox_width: computePercentiles(widths.length > 0 ? widths : [0]),
    bbox_height: computePercentiles(heights.length > 0 ? heights : [0]),
  };

  let coordinateRegimeSuspicion: string | undefined;
  const globalWidth = bboxes.length > 0 ? globalMaxx - globalMinx : 0;
  const globalHeight = bboxes.length > 0 ? globalMaxy - globalMiny : 0;
  if (globalWidth > 5000 || globalHeight > 5000 || globalMinx < -1000 || globalMiny < -1000) {
    coordinateRegimeSuspicion = `Global bbox spans large range: width=${globalWidth.toFixed(2)}, height=${globalHeight.toFixed(2)}`;
  }

  // Simple deterministic clustering: split by median x
  const medianX = distributionStats.bbox_width.median;
  const cluster1Centers: number[] = [];
  const cluster2Centers: number[] = [];
  for (const bbox of bboxes) {
    const centerX = (bbox.minx + bbox.maxx) / 2;
    if (centerX < medianX) {
      cluster1Centers.push(centerX);
    } else {
      cluster2Centers.push(centerX);
    }
  }
  if (cluster1Centers.length > 0 && cluster2Centers.length > 0) {
    const c1Avg = cluster1Centers.reduce((a, b) => a + b, 0) / cluster1Centers.length;
    const c2Avg = cluster2Centers.reduce((a, b) => a + b, 0) / cluster2Centers.length;
    const separation = Math.abs(c2Avg - c1Avg);
    if (separation > globalWidth * 0.3) {
      coordinateRegimeSuspicion = (coordinateRegimeSuspicion ? coordinateRegimeSuspicion + '; ' : '') +
        `Bimodal distribution detected: cluster separation=${separation.toFixed(2)}`;
    }
  }

  // 6. Census ethnicity mapping (settlement-level only, no municipality fallback)
  // 6a. Detect settlement-level census availability
  // Look for settlement-level data in top-level keys: settlements, naselja, settlement, naselje
  let settlementCensusMap: Record<string, CensusSettlement> | null = null;
  let censusSettlementKeyUsed: string | undefined = undefined;
  let maxOverlapCount = 0;
  
  // Get all GeoJSON SIDs for overlap checking
  const geojsonSids = new Set<string>();
  for (const { feature, originalIndex } of indexedFeatures) {
    const { sid } = extractSid(feature, originalIndex);
    if (sid) geojsonSids.add(sid);
  }
  
  // Check candidate keys (preferred named keys)
  const candidateKeys = ['settlements', 'naselja', 'settlement', 'naselje'];
  const candidateResults: Array<{ key: string; overlap: number; validCount: number; map: Record<string, CensusSettlement> }> = [];
  
  for (const key of candidateKeys) {
    const candidate = censusData[key];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      // Check if values are objects with p arrays
      let validCount = 0;
      let overlapCount = 0;
      for (const [k, v] of Object.entries(candidate)) {
        if (v && typeof v === 'object' && 'p' in v && Array.isArray((v as any).p) && (v as any).p.length >= 5) {
          validCount++;
          if (geojsonSids.has(k)) {
            overlapCount++;
          }
        }
      }
      if (validCount >= 5) { // Only consider if has at least 5 valid records
        candidateResults.push({
          key,
          overlap: overlapCount,
          validCount,
          map: candidate as Record<string, CensusSettlement>
        });
      }
    }
  }
  
  // If no candidate found in preferred keys, check all top-level keys for objects with p arrays
  if (candidateResults.length === 0) {
    for (const [key, value] of Object.entries(censusData)) {
      if (candidateKeys.includes(key)) continue; // Already checked
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        let validCount = 0;
        let overlapCount = 0;
        for (const [k, v] of Object.entries(value)) {
          if (v && typeof v === 'object' && 'p' in v && Array.isArray((v as any).p) && (v as any).p.length >= 5) {
            validCount++;
            if (geojsonSids.has(k)) {
              overlapCount++;
            }
          }
        }
        if (validCount >= 5) {
          candidateResults.push({
            key,
            overlap: overlapCount,
            validCount,
            map: value as Record<string, CensusSettlement>
          });
        }
      }
    }
  }
  
  // Choose candidate with maximum overlap; tie-break by key name sort
  if (candidateResults.length > 0) {
    candidateResults.sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return a.key.localeCompare(b.key); // Tie-break by key name (ascending)
    });
    const best = candidateResults[0];
    maxOverlapCount = best.overlap;
    settlementCensusMap = best.map;
    censusSettlementKeyUsed = best.key;
  }
  
  const settlementLevelCensusAvailable = !!(settlementCensusMap && maxOverlapCount > 0);
  
  // 6b. Validate settlement-level p-sum to determine ordering
  const settlementsWithPMismatch: string[] = [];
  let settlementPSumPassCount = 0;
  let settlementPSumFailCount = 0;
  
  if (settlementLevelCensusAvailable && settlementCensusMap) {
    for (const [sid, settlement] of Object.entries(settlementCensusMap)) {
      const p = settlement.p;
      if (!p || p.length < 5) continue;
      const [total, p1, p2, p3, p4] = p;
      const sum = p1 + p2 + p3 + p4;
      const diff = Math.abs(total - sum);
      if (diff > 1) { // Allow 1 person rounding error
        settlementsWithPMismatch.push(sid);
        settlementPSumFailCount++;
      } else {
        settlementPSumPassCount++;
      }
    }
  }
  
  // Determine if census ordering is validated (if >10% mismatch, treat as ambiguous)
  const totalSettlementsWithP = settlementPSumPassCount + settlementPSumFailCount;
  const settlementPSumFailRate = totalSettlementsWithP > 0 ? settlementPSumFailCount / totalSettlementsWithP : 0;
  const censusOrderingValidated = settlementPSumFailRate <= 0.1; // <=10% mismatch means validated

  // If ordering is ambiguous, log mistake and flag FORAWWV.md
  if (!censusOrderingValidated && totalSettlementsWithP > 0) {
    recordAssumptionInvalidated({
      area: 'census_data',
      issue: 'ethnicity_ordering_ambiguous',
      date: '2026-01-26',
      title: 'Census ethnicity ordering ambiguous - settlement-level p-sum validation failed',
      description: `Settlement-level census data p-sum validation failed for ${settlementPSumFailCount}/${totalSettlementsWithP} settlements (${(settlementPSumFailRate * 100).toFixed(1)}%). Cannot assume p = [total, bosniak, croat, serb, other].`,
      correctiveAction: 'When p-sum validation fails for >10% of settlements, do NOT guess ordering. Label as p1..p4 in viewer and reports, log the issue, and flag that docs/FORAWWV.md may require an addendum.'
    });
    console.warn(`WARNING: Census ordering ambiguous. ${settlementPSumFailCount}/${totalSettlementsWithP} settlements have p-sum mismatch. Using p1..p4 labels.`);
    console.warn('NOTE: docs/FORAWWV.md may require an addendum describing census data structure.');
  }

  // Build viewer index (settlement-level census only, no municipality fallback)
  const viewerSettlements: ViewerIndex['settlements'] = [];
  const ethnicityCounts: Record<string, number> = {};
  const provenanceCounts: { settlement: number; no_settlement_census: number; invalid_settlement_p: number; missing_sid: number } = {
    settlement: 0,
    no_settlement_census: 0,
    invalid_settlement_p: 0,
    missing_sid: 0,
  };

  for (const { feature, originalIndex } of indexedFeatures) {
    const { sid } = extractSid(feature, originalIndex);

    try {
      const bbox = computeBbox(feature.geometry.coordinates as Polygon | MultiPolygon);
      const centroid = {
        x: (bbox.minx + bbox.maxx) / 2,
        y: (bbox.miny + bbox.maxy) / 2,
      };

      let majority: string | null = null;
      let shares: { bosniak?: number; croat?: number; serb?: number; other?: number } | { p1: number; p2: number; p3: number; p4: number } | null = null;
      let dataProvenance: 'settlement' | 'no_settlement_census' | 'invalid_settlement_p' | 'missing_sid' = 'missing_sid';

      // Check if sid is missing
      if (!sid) {
        dataProvenance = 'missing_sid';
        majority = 'unknown';
        shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
        ethnicityCounts.unknown = (ethnicityCounts.unknown || 0) + 1;
        provenanceCounts.missing_sid++;
      } else if (!settlementLevelCensusAvailable || !settlementCensusMap || !settlementCensusMap[sid]) {
        // No settlement-level census data available for this sid
        dataProvenance = 'no_settlement_census';
        majority = 'unknown';
        shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
        ethnicityCounts.unknown = (ethnicityCounts.unknown || 0) + 1;
        provenanceCounts.no_settlement_census++;
      } else {
        // Settlement-level census data exists
        const settlement = settlementCensusMap[sid];
        const p = settlement.p;
        if (!p || p.length < 5) {
          dataProvenance = 'invalid_settlement_p';
          majority = 'unknown';
          shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
          ethnicityCounts.unknown = (ethnicityCounts.unknown || 0) + 1;
          provenanceCounts.invalid_settlement_p++;
        } else {
          // Validate p-sum
          const [total, p1, p2, p3, p4] = p;
          const sum = p1 + p2 + p3 + p4;
          const diff = Math.abs(total - sum);
          if (diff > 1) { // Invalid p-sum
            dataProvenance = 'invalid_settlement_p';
            majority = 'unknown';
            shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
            ethnicityCounts.unknown = (ethnicityCounts.unknown || 0) + 1;
            provenanceCounts.invalid_settlement_p++;
          } else {
            // Valid settlement-level data
            dataProvenance = 'settlement';
            if (censusOrderingValidated) {
              // Assume p = [total, bosniak, croat, serb, other]
              const bosniak = p1;
              const croat = p2;
              const serb = p3;
              const other = p4;
              shares = {
                bosniak: total > 0 ? bosniak / total : 0,
                croat: total > 0 ? croat / total : 0,
                serb: total > 0 ? serb / total : 0,
                other: total > 0 ? other / total : 0,
              };
              majority = determineMajorityEthnicity(shares as { bosniak: number; croat: number; serb: number; other: number });
              ethnicityCounts[majority] = (ethnicityCounts[majority] || 0) + 1;
              provenanceCounts.settlement++;
            } else {
              // Ambiguous ordering - use p1..p4
              shares = {
                p1: total > 0 ? p1 / total : 0,
                p2: total > 0 ? p2 / total : 0,
                p3: total > 0 ? p3 / total : 0,
                p4: total > 0 ? p4 / total : 0,
              };
              const maxShare = Math.max(p1, p2, p3, p4);
              if (p1 === maxShare) majority = 'p1';
              else if (p2 === maxShare) majority = 'p2';
              else if (p3 === maxShare) majority = 'p3';
              else majority = 'p4';
              ethnicityCounts[majority] = (ethnicityCounts[majority] || 0) + 1;
              provenanceCounts.settlement++;
            }
          }
        }
      }

      viewerSettlements.push({
        sid: sid || null,
        source_index: originalIndex,
        bbox,
        centroid,
        majority_ethnicity: majority || 'unknown',
        shares: shares || (censusOrderingValidated ? { bosniak: 0, croat: 0, serb: 0, other: 0 } : { p1: 0, p2: 0, p3: 0, p4: 0 }),
        data_provenance: dataProvenance,
      });
    } catch (err) {
      // Skip invalid geometry but still include in index with null values
      const { sid: sidErr } = extractSid(feature, originalIndex);
      viewerSettlements.push({
        sid: sidErr || null,
        source_index: originalIndex,
        bbox: { minx: 0, miny: 0, maxx: 0, maxy: 0 },
        centroid: { x: 0, y: 0 },
        majority_ethnicity: 'unknown',
        shares: censusOrderingValidated ? { bosniak: 0, croat: 0, serb: 0, other: 0 } : { p1: 0, p2: 0, p3: 0, p4: 0 },
        data_provenance: sidErr ? 'no_settlement_census' : 'missing_sid',
      });
      ethnicityCounts.unknown = (ethnicityCounts.unknown || 0) + 1;
      if (sidErr) {
        provenanceCounts.no_settlement_census++;
      } else {
        provenanceCounts.missing_sid++;
      }
    }
  }

  // Sort viewer settlements: null sids last, then by sid (string compare), then by source_index
  viewerSettlements.sort((a, b) => {
    if (a.sid === null && b.sid !== null) return 1;
    if (a.sid !== null && b.sid === null) return -1;
    if (a.sid === null && b.sid === null) return a.source_index - b.source_index;
    const cmp = a.sid!.localeCompare(b.sid!);
    if (cmp !== 0) return cmp;
    return a.source_index - b.source_index;
  });

  // Build validation report
  const report: ValidationReport = {
    counts: {
      total_features: features.length,
      missing_sid: missingSidIndices.length,
      duplicate_sid_count: duplicateSids.length,
      missing_municipality_id: missingMuniIdSids.length,
      missing_in_census: missingInCensusSids.length,
      geometry_warnings_count: geometryWarningsCount,
    },
    global_bbox: globalBbox,
    distribution_stats: distributionStats,
    top_warnings: allWarnings.slice(0, 100).sort((a, b) => a.sid.localeCompare(b.sid)),
    duplicate_sids: duplicateSids,
    missing_municipality_samples: missingMuniIdSids.slice(0, 20),
    missing_in_census_samples: missingInCensusSids.slice(0, 20),
    coordinate_regime_suspicion: coordinateRegimeSuspicion,
    viewer_display: {
      y_flip_default: true,
      reason: 'embedded dataset appears in Y-down coordinate space; viewer flips Y at render time only',
      systemic_insight: 'Potential systemic insight: some settlement sources are in Y-down planar coordinates; may require FORAWWV.md addendum.'
    },
    census_validation: {
      settlement_level_census_available: settlementLevelCensusAvailable,
      census_settlement_key_used: censusSettlementKeyUsed,
      census_settlement_overlap_count: maxOverlapCount,
      settlement_p_sum_pass_count: settlementPSumPassCount,
      settlement_p_sum_fail_count: settlementPSumFailCount,
      settlement_p_sum_fail_rate: settlementPSumFailRate,
      matched_settlement_census_count: provenanceCounts.settlement,
      no_settlement_census_count: provenanceCounts.no_settlement_census,
      invalid_settlement_p_count: provenanceCounts.invalid_settlement_p,
      missing_sid_count: provenanceCounts.missing_sid,
    },
  };

  // Build viewer index
  const viewerIndex: ViewerIndex = {
    global_bbox: globalBbox,
    settlements: viewerSettlements,
    legend_labels: censusOrderingValidated
      ? { bosniak: 'Bosniak', croat: 'Croat', serb: 'Serb', other: 'Other', unknown: 'Unknown' }
      : { p1: 'p1', p2: 'p2', p3: 'p3', p4: 'p4', unknown: 'Unknown' },
    counts_by_majority: ethnicityCounts,
    provenance_counts: provenanceCounts,
    census_ordering_validated: censusOrderingValidated,
    ordering_mode: censusOrderingValidated ? 'named' : 'ambiguous',
    settlement_level_census_available: settlementLevelCensusAvailable,
    census_settlement_key_used: censusSettlementKeyUsed,
    census_settlement_overlap_count: maxOverlapCount,
    settlement_p_sum_fail_rate: settlementPSumFailRate,
    feature_count: features.length,
    matched_settlement_census_count: provenanceCounts.settlement,
    unknown_count: provenanceCounts.no_settlement_census + provenanceCounts.invalid_settlement_p + provenanceCounts.missing_sid,
  };

  // Write outputs
  console.log('Writing reports...');
  mkdirSync(dirname(reportJsonPath), { recursive: true });
  mkdirSync(dirname(viewerIndexPath), { recursive: true });

  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(viewerIndexPath, JSON.stringify(viewerIndex, null, 2), 'utf8');

  // Write TXT report
  const txtLines: string[] = [];
  txtLines.push('Phase 0 Embedded Settlement Validation Report');
  txtLines.push('===========================================');
  txtLines.push('');
  txtLines.push(`Total features: ${report.counts.total_features}`);
  txtLines.push(`Missing SID: ${report.counts.missing_sid}`);
  txtLines.push(`Duplicate SID count: ${report.counts.duplicate_sid_count}`);
  txtLines.push(`Missing municipality ID: ${report.counts.missing_municipality_id}`);
  txtLines.push(`Missing in census: ${report.counts.missing_in_census}`);
  txtLines.push(`Geometry warnings: ${report.counts.geometry_warnings_count}`);
  txtLines.push('');
  txtLines.push('Global BBox:');
  txtLines.push(`  minx: ${globalBbox.minx.toFixed(3)}, miny: ${globalBbox.miny.toFixed(3)}`);
  txtLines.push(`  maxx: ${globalBbox.maxx.toFixed(3)}, maxy: ${globalBbox.maxy.toFixed(3)}`);
  txtLines.push(`  width: ${globalWidth.toFixed(3)}, height: ${globalHeight.toFixed(3)}`);
  txtLines.push('');
  txtLines.push('BBox Distribution:');
  txtLines.push(`  Width: min=${distributionStats.bbox_width.min.toFixed(3)}, median=${distributionStats.bbox_width.median.toFixed(3)}, p90=${distributionStats.bbox_width.p90.toFixed(3)}, max=${distributionStats.bbox_width.max.toFixed(3)}`);
  txtLines.push(`  Height: min=${distributionStats.bbox_height.min.toFixed(3)}, median=${distributionStats.bbox_height.median.toFixed(3)}, p90=${distributionStats.bbox_height.p90.toFixed(3)}, max=${distributionStats.bbox_height.max.toFixed(3)}`);
  txtLines.push('');
  if (coordinateRegimeSuspicion) {
    txtLines.push(`Coordinate Regime Suspicion: ${coordinateRegimeSuspicion}`);
    txtLines.push('');
  }
  if (report.viewer_display) {
    txtLines.push('Viewer Display:');
    txtLines.push(`  Y-flip default: ${report.viewer_display.y_flip_default ? 'ON' : 'OFF'}`);
    txtLines.push(`  Reason: ${report.viewer_display.reason}`);
    if (report.viewer_display.systemic_insight) {
      txtLines.push(`  ${report.viewer_display.systemic_insight}`);
    }
    txtLines.push('');
  }
  txtLines.push('Census Validation (Settlement-Level Only, No Municipality Fallback):');
  txtLines.push(`  Settlement-level census available: ${report.census_validation.settlement_level_census_available ? 'YES' : 'NO'}`);
  if (report.census_validation.settlement_level_census_available) {
    txtLines.push(`  Census settlement key used: ${report.census_validation.census_settlement_key_used || 'unknown'}`);
    txtLines.push(`  Settlement overlap count: ${report.census_validation.census_settlement_overlap_count || 0}`);
    txtLines.push(`  Settlement p-sum pass count: ${report.census_validation.settlement_p_sum_pass_count}`);
    txtLines.push(`  Settlement p-sum fail count: ${report.census_validation.settlement_p_sum_fail_count}`);
    txtLines.push(`  Settlement p-sum fail rate: ${(report.census_validation.settlement_p_sum_fail_rate * 100).toFixed(1)}%`);
    txtLines.push(`  Census ordering validated: ${censusOrderingValidated ? 'YES' : 'NO (using p1..p4 labels)'}`);
    txtLines.push('');
    txtLines.push('Settlement-Level Census Matching:');
    txtLines.push(`  Matched (valid settlement-level data): ${report.census_validation.matched_settlement_census_count}`);
    txtLines.push(`  No settlement census: ${report.census_validation.no_settlement_census_count}`);
    txtLines.push(`  Invalid settlement p: ${report.census_validation.invalid_settlement_p_count}`);
    txtLines.push(`  Missing SID: ${report.census_validation.missing_sid_count}`);
  } else {
    txtLines.push('  WARNING: No settlement-level census data found. All settlements will be marked as Unknown.');
    txtLines.push('  NOTE: Municipality fallback is disabled by design. Viewer will show Unknown for all settlements.');
  }
  if (!censusOrderingValidated && report.census_validation.settlement_level_census_available) {
    txtLines.push('');
    txtLines.push('  WARNING: Census ethnicity ordering is ambiguous. Viewer uses p1..p4 labels.');
    txtLines.push('  NOTE: docs/FORAWWV.md may require an addendum describing census data structure.');
  }
  txtLines.push('');
  if (duplicateSids.length > 0) {
    txtLines.push('Top Duplicate SIDs:');
    for (const dup of duplicateSids.slice(0, 20)) {
      txtLines.push(`  ${dup.sid}: ${dup.count} occurrences (sample indices: ${dup.sample_indices.join(', ')})`);
    }
    txtLines.push('');
  }
  if (missingMuniIdSids.length > 0) {
    txtLines.push(`Missing Municipality ID (first 20): ${missingMuniIdSids.slice(0, 20).join(', ')}`);
    txtLines.push('');
  }
  if (missingInCensusSids.length > 0) {
    txtLines.push(`Missing in Census (first 20): ${missingInCensusSids.slice(0, 20).join(', ')}`);
    txtLines.push('');
  }

  writeFileSync(reportTxtPath, txtLines.join('\n'), 'utf8');

  console.log('Validation complete!');
  console.log(`  Report JSON: ${reportJsonPath}`);
  console.log(`  Report TXT: ${reportTxtPath}`);
  console.log(`  Viewer index: ${viewerIndexPath}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
