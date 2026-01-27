/**
 * Build Substrate Viewer Index
 * 
 * CANONICAL SCRIPT FOR PHASE 0 SUBSTRATE VIEWER
 * 
 * This script is canonical for Phase 0 settlement substrate viewer. It creates
 * a lightweight lookup table keyed by sid for the substrate viewer and joins
 * settlement-level census data from bih_census_1991.json.
 * 
 * Usage:
 *   npm run map:viewer:substrate:index
 *   or: tsx scripts/map/build_substrate_viewer_index.ts
 * 
 * Outputs:
 *   - data/derived/substrate_viewer/data_index.json (canonical Phase 0 viewer index)
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
  properties: {
    sid: string;
    name?: string | null;
    municipality_id?: string | null;
    [key: string]: unknown;
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

interface CensusSettlement {
  p?: number[]; // [total, bosniak, croat, serb, other] or ambiguous
  [key: string]: unknown;
}

interface CensusData {
  settlements?: Record<string, CensusSettlement>;
  naselja?: Record<string, CensusSettlement>;
  settlement?: Record<string, CensusSettlement>;
  naselje?: Record<string, CensusSettlement>;
  [key: string]: unknown;
}

interface SettlementIndexEntry {
  name: string | null;
  municipality_id: string | null;
  bbox: [number, number, number, number];
  centroid: [number, number];
  majority: 'bosniak' | 'serb' | 'croat' | 'other' | 'unknown';
  shares: {
    bosniak: number;
    croat: number;
    serb: number;
    other: number;
  };
  provenance: 'settlement' | 'no_settlement_census' | 'ambiguous_ordering';
}

interface ViewerIndex {
  meta: {
    geometry_path: string;
    census_path: string;
    settlement_census_key: string | null;
    ordering_mode: 'named' | 'ambiguous' | 'missing';
    counts: {
      features: number;
      matched_settlement_census: number;
      unknown: number;
      majority: {
        bosniak: number;
        serb: number;
        croat: number;
        other: number;
        unknown: number;
      };
    };
    global_bbox: [number, number, number, number];
  };
  by_sid: Record<string, SettlementIndexEntry>;
}

/**
 * Compute bbox for a feature
 */
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

  const isMultiPolygon = Array.isArray(coords) && 
                         coords.length > 0 && 
                         Array.isArray(coords[0]) && 
                         coords[0].length > 0 && 
                         Array.isArray(coords[0][0]) && 
                         coords[0][0].length > 0 && 
                         Array.isArray(coords[0][0][0]);

  if (isMultiPolygon) {
    for (const poly of coords as MultiPolygon) {
      if (!Array.isArray(poly)) continue;
      for (const ring of poly) {
        if (!Array.isArray(ring)) continue;
        processRing(ring);
      }
    }
  } else {
    for (const ring of coords as Polygon) {
      if (!Array.isArray(ring)) continue;
      processRing(ring);
    }
  }

  if (!isFinite(minx) || !isFinite(miny) || !isFinite(maxx) || !isFinite(maxy)) {
    return { minx: 0, miny: 0, maxx: 0, maxy: 0 };
  }

  return { minx, miny, maxx, maxy };
}

/**
 * Compute centroid (bbox center)
 */
function computeCentroid(bbox: { minx: number; miny: number; maxx: number; maxy: number }): [number, number] {
  return [
    (bbox.minx + bbox.maxx) / 2,
    (bbox.miny + bbox.maxy) / 2
  ];
}

/**
 * Detect settlement-level census table
 */
function detectSettlementCensusTable(census: CensusData, substrateSids: Set<string>): {
  key: string | null;
  table: Record<string, CensusSettlement> | null;
  overlap: number;
} {
  // Prefer explicit keys
  const explicitKeys = ['settlements', 'naselja', 'settlement', 'naselje'];
  for (const key of explicitKeys) {
    const table = census[key] as Record<string, CensusSettlement> | undefined;
    if (table && typeof table === 'object') {
      const overlap = Object.keys(table).filter(sid => substrateSids.has(sid)).length;
      if (overlap > 0) {
        return { key, table, overlap };
      }
    }
  }

  // Otherwise scan top-level objects with p arrays (len >= 5)
  let bestCandidate: { key: string; table: Record<string, CensusSettlement>; overlap: number } | null = null;
  
  for (const [key, value] of Object.entries(census)) {
    if (explicitKeys.includes(key)) continue; // Already checked
    if (key === 'metadata' || key === 'municipalities') continue; // Skip known non-settlement keys
    
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const table = value as Record<string, unknown>;
      // Check if values have p arrays
      let hasPArrays = false;
      let overlap = 0;
      
      for (const [sid, record] of Object.entries(table)) {
        if (substrateSids.has(sid)) {
          overlap++;
        }
        if (record && typeof record === 'object') {
          const rec = record as Record<string, unknown>;
          if (Array.isArray(rec.p) && rec.p.length >= 5) {
            hasPArrays = true;
          }
        }
      }
      
      if (hasPArrays && overlap > 0) {
        if (!bestCandidate || overlap > bestCandidate.overlap || 
            (overlap === bestCandidate.overlap && key < bestCandidate.key)) {
          bestCandidate = { key, table: table as Record<string, CensusSettlement>, overlap };
        }
      }
    }
  }
  
  if (bestCandidate) {
    return bestCandidate;
  }
  
  return { key: null, table: null, overlap: 0 };
}

/**
 * Validate p-sum: p[0] == p[1] + p[2] + p[3] + p[4]
 */
function validatePSum(p: number[]): boolean {
  if (!Array.isArray(p) || p.length < 5) return false;
  const total = p[0];
  const sum = p[1] + p[2] + p[3] + p[4];
  return Math.abs(total - sum) < 0.5; // Allow small floating point errors
}

/**
 * Compute majority ethnicity with deterministic tie-breaking
 */
function computeMajority(p: number[]): 'bosniak' | 'serb' | 'croat' | 'other' {
  if (!Array.isArray(p) || p.length < 5) return 'other';
  
  const bosniak = p[1] || 0;
  const croat = p[2] || 0;
  const serb = p[3] || 0;
  const other = p[4] || 0;
  
  const max = Math.max(bosniak, serb, croat, other);
  
  // Tie-breaking: bosniak > serb > croat > other
  if (bosniak === max) return 'bosniak';
  if (serb === max) return 'serb';
  if (croat === max) return 'croat';
  return 'other';
}

async function main(): Promise<void> {
  const substratePath = resolve('data/derived/settlements_substrate.geojson');
  const censusPath = resolve('data/source/bih_census_1991.json');
  const outputPath = resolve('data/derived/substrate_viewer/data_index.json');
  
  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });
  
  // Load substrate
  process.stdout.write(`Loading ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrateGeoJSON = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrateGeoJSON.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrateGeoJSON.type}`);
  }
  
  const features = substrateGeoJSON.features;
  process.stdout.write(`Loaded ${features.length} features\n`);
  
  // Load census
  process.stdout.write(`Loading ${censusPath}...\n`);
  const censusContent = readFileSync(censusPath, 'utf8');
  const census = JSON.parse(censusContent) as CensusData;
  process.stdout.write(`Loaded census data\n`);
  
  // Extract substrate SIDs
  const substrateSids = new Set<string>();
  for (const feature of features) {
    if (feature.properties.sid) {
      substrateSids.add(String(feature.properties.sid));
    }
  }
  
  // Detect settlement-level census table
  process.stdout.write(`Detecting settlement-level census table...\n`);
  const censusDetection = detectSettlementCensusTable(census, substrateSids);
  
  if (!censusDetection.table) {
    process.stdout.write(`WARNING: No settlement-level census table found\n`);
    appendMistake({
      key: 'substrate.viewer.missing_settlement_census',
      date: '2026-01-26',
      title: 'Substrate viewer: settlement-level census table missing',
      description: `No settlement-level census table found in bih_census_1991.json. Viewer will show all settlements as Unknown.`,
      correctiveAction: 'Verify census file structure. If settlement-level census is truly missing, docs/FORAWWV.md may require an addendum about demographic data granularity assumptions.'
    });
  }
  
  // Validate ordering if table exists
  let orderingMode: 'named' | 'ambiguous' | 'missing' = 'missing';
  let pSumFailCount = 0;
  let pSumPassCount = 0;
  
  if (censusDetection.table) {
    process.stdout.write(`Validating census ordering (p-sum checks)...\n`);
    for (const [sid, record] of Object.entries(censusDetection.table)) {
      if (!substrateSids.has(sid)) continue;
      if (record.p && Array.isArray(record.p) && record.p.length >= 5) {
        if (validatePSum(record.p)) {
          pSumPassCount++;
        } else {
          pSumFailCount++;
        }
      }
    }
    
    const totalMatched = pSumPassCount + pSumFailCount;
    const failRate = totalMatched > 0 ? pSumFailCount / totalMatched : 0;
    
    if (failRate > 0.1) {
      orderingMode = 'ambiguous';
      process.stdout.write(`WARNING: Census ordering ambiguous (${(failRate * 100).toFixed(1)}% p-sum failures)\n`);
      appendMistake({
        key: 'substrate.viewer.ambiguous_census_ordering',
        date: '2026-01-26',
        title: 'Substrate viewer: settlement-level census ordering ambiguous',
        description: `Settlement-level census p-sum validation failed for ${(failRate * 100).toFixed(1)}% of matched settlements. Ordering treated as ambiguous.`,
        correctiveAction: 'Viewer will color all settlements as Unknown and display warning banner. docs/FORAWWV.md may require an addendum about census data encoding assumptions.'
      });
    } else {
      orderingMode = 'named';
      process.stdout.write(`Census ordering validated: [total, bosniak, croat, serb, other]\n`);
    }
  }
  
  // Build index
  const bySid: Record<string, SettlementIndexEntry> = {};
  let globalMinx = Infinity;
  let globalMiny = Infinity;
  let globalMaxx = -Infinity;
  let globalMaxy = -Infinity;
  
  const majorityCounts = {
    bosniak: 0,
    serb: 0,
    croat: 0,
    other: 0,
    unknown: 0
  };
  
  let matchedSettlementCensus = 0;
  let unknownCount = 0;
  
  for (const feature of features) {
    const sid = String(feature.properties.sid);
    const name = feature.properties.name || null;
    const municipalityId = feature.properties.municipality_id || null;
    
    // Compute bbox and centroid
    const bbox = computeBbox(feature.geometry.coordinates);
    const centroid = computeCentroid(bbox);
    
    // Update global bbox
    globalMinx = Math.min(globalMinx, bbox.minx);
    globalMiny = Math.min(globalMiny, bbox.miny);
    globalMaxx = Math.max(globalMaxx, bbox.maxx);
    globalMaxy = Math.max(globalMaxy, bbox.maxy);
    
    // Join census
    let majority: 'bosniak' | 'serb' | 'croat' | 'other' | 'unknown' = 'unknown';
    let shares = { bosniak: 0, croat: 0, serb: 0, other: 0 };
    let provenance: 'settlement' | 'no_settlement_census' | 'ambiguous_ordering' = 'no_settlement_census';
    
    if (censusDetection.table && orderingMode !== 'missing') {
      const censusRecord = censusDetection.table[sid];
      if (censusRecord && censusRecord.p && Array.isArray(censusRecord.p) && censusRecord.p.length >= 5) {
        if (orderingMode === 'named' && validatePSum(censusRecord.p)) {
          // Valid ordering: [total, bosniak, croat, serb, other]
          const total = censusRecord.p[0];
          if (total > 0) {
            shares = {
              bosniak: censusRecord.p[1] / total,
              croat: censusRecord.p[2] / total,
              serb: censusRecord.p[3] / total,
              other: censusRecord.p[4] / total
            };
          }
          majority = computeMajority(censusRecord.p);
          provenance = 'settlement';
          matchedSettlementCensus++;
        } else {
          // Ambiguous ordering
          provenance = 'ambiguous_ordering';
          majority = 'unknown';
          unknownCount++;
        }
      } else {
        // No census record
        provenance = 'no_settlement_census';
        majority = 'unknown';
        unknownCount++;
      }
    } else {
      // No census table or missing
      provenance = 'no_settlement_census';
      majority = 'unknown';
      unknownCount++;
    }
    
    majorityCounts[majority]++;
    
    bySid[sid] = {
      name,
      municipality_id: municipalityId,
      bbox: [bbox.minx, bbox.miny, bbox.maxx, bbox.maxy],
      centroid,
      majority,
      shares,
      provenance
    };
  }
  
  // Sort by_sid keys deterministically
  const sortedSids = Object.keys(bySid).sort((a, b) => a.localeCompare(b));
  const sortedBySid: Record<string, SettlementIndexEntry> = {};
  for (const sid of sortedSids) {
    sortedBySid[sid] = bySid[sid];
  }
  
  // Build index
  const index: ViewerIndex = {
    meta: {
      geometry_path: '/data/derived/settlements_substrate.geojson',
      census_path: '/data/source/bih_census_1991.json',
      settlement_census_key: censusDetection.key,
      ordering_mode: orderingMode,
      counts: {
        features: features.length,
        matched_settlement_census: matchedSettlementCensus,
        unknown: unknownCount,
        majority: majorityCounts
      },
      global_bbox: [globalMinx, globalMiny, globalMaxx, globalMaxy]
    },
    by_sid: sortedBySid
  };
  
  // Write output
  writeFileSync(outputPath, JSON.stringify(index, null, 2), 'utf8');
  process.stdout.write(`Wrote index to ${outputPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Features: ${index.meta.counts.features}\n`);
  process.stdout.write(`  Settlement census key: ${index.meta.settlement_census_key || 'null'}\n`);
  process.stdout.write(`  Ordering mode: ${index.meta.ordering_mode}\n`);
  process.stdout.write(`  Matched settlement census: ${index.meta.counts.matched_settlement_census}\n`);
  process.stdout.write(`  Unknown: ${index.meta.counts.unknown}\n`);
  process.stdout.write(`  Majority counts: bosniak=${index.meta.counts.majority.bosniak}, serb=${index.meta.counts.majority.serb}, croat=${index.meta.counts.majority.croat}, other=${index.meta.counts.majority.other}, unknown=${index.meta.counts.majority.unknown}\n`);
  process.stdout.write(`  Global bbox: [${globalMinx.toFixed(6)}, ${globalMiny.toFixed(6)}, ${globalMaxx.toFixed(6)}, ${globalMaxy.toFixed(6)}]\n`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
