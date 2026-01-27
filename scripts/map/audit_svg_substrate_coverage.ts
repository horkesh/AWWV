/**
 * Audit SVG Substrate Census Coverage
 * 
 * EXPERIMENTAL SCRIPT - VALIDATION ONLY
 * 
 * This script audits the experimental SVG-derived substrate against the 1991 census
 * to validate settlement identity, census coverage, and municipality distribution.
 * 
 * Validation-only: does NOT modify any substrate or canonical files.
 * 
 * Usage:
 *   npm run map:audit:svg_substrate:coverage
 *   or: tsx scripts/map/audit_svg_substrate_coverage.ts
 * 
 * Outputs:
 *   - data/derived/svg_substrate/settlements_svg_substrate.coverage.audit.json
 *   - data/derived/svg_substrate/settlements_svg_substrate.coverage.audit.txt
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../../tools/assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Validate SVG-derived substrate: census coverage, SID uniqueness, missing/duplicate settlement identity, and geometry validity reasons");

type Point = [number, number];
type Ring = Point[];
type Polygon = Ring[];
type MultiPolygon = Polygon[];

interface GeoJSONFeature {
  type: 'Feature';
  properties: {
    sid: string;
    settlement_name?: string | null;
    municipality_id?: string | null;
    source_file?: string;
    source_shape_id?: string;
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

interface CoverageAudit {
  census_total: number;
  features_total: number;
  sid_validation: {
    missing_sid_count: number;
    duplicate_sid_count: number;
    duplicate_sid_list: string[];
    unmatched_placeholder_count: number;
  };
  identity_mode_used: 'census_id' | 'name_municipality' | 'none';
  coverage: {
    matched_count: number;
    missing_census_count: number;
    missing_census_list: string[];
    extra_feature_count: number;
    extra_feature_list: string[];
    ambiguous_keys_count: number;
    ambiguous_keys_examples: Array<{
      key: string;
      feature_count: number;
      sids: string[];
    }>;
  };
  municipality_counts: Array<{
    municipality_id: string;
    feature_count: number;
    census_count: number | null;
    census_name: string | null;
  }>;
  geometry_bounds: {
    minx: number;
    miny: number;
    maxx: number;
    maxy: number;
  };
  notes: string[];
  warnings: string[];
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
 * Extract census settlement ID from SID (strip "S" prefix)
 */
function extractCensusId(sid: string): string | null {
  if (!sid || typeof sid !== 'string') return null;
  if (sid.startsWith('S')) {
    return sid.substring(1);
  }
  if (sid.startsWith('UNMATCHED::')) {
    return null; // Placeholder, not a real ID
  }
  // Try as-is
  return sid;
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

async function main(): Promise<void> {
  const censusPath = resolve('data/source/bih_census_1991.json');
  const substratePath = resolve('data/derived/svg_substrate/settlements_svg_substrate.geojson');
  const outputDir = resolve('data/derived/svg_substrate');
  const auditJsonPath = resolve(outputDir, 'settlements_svg_substrate.coverage.audit.json');
  const auditTxtPath = resolve(outputDir, 'settlements_svg_substrate.coverage.audit.txt');
  
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });
  
  // Load census
  process.stdout.write(`Loading census from ${censusPath}...\n`);
  const censusContent = readFileSync(censusPath, 'utf8');
  const census = JSON.parse(censusContent) as CensusData;
  
  // Build canonical census settlement ID set
  const censusSettlementIds = new Set<string>();
  const censusSettlementToMunicipality = new Map<string, string>();
  const municipalitySettlementCounts = new Map<string, number>();
  
  for (const [munId, mun] of Object.entries(census.municipalities)) {
    if (!mun.s || !Array.isArray(mun.s)) continue;
    
    municipalitySettlementCounts.set(munId, mun.s.length);
    
    for (const settlementId of mun.s) {
      censusSettlementIds.add(settlementId);
      censusSettlementToMunicipality.set(settlementId, munId);
    }
  }
  
  const censusTotal = censusSettlementIds.size;
  process.stdout.write(`Loaded ${censusTotal} census settlements from ${census.municipalities ? Object.keys(census.municipalities).length : 0} municipalities\n`);
  
  // Load substrate
  process.stdout.write(`Loading substrate from ${substratePath}...\n`);
  const substrateContent = readFileSync(substratePath, 'utf8');
  const substrate = JSON.parse(substrateContent) as GeoJSONFC;
  
  if (substrate.type !== 'FeatureCollection') {
    throw new Error(`Expected FeatureCollection, got ${substrate.type}`);
  }
  
  const features = substrate.features;
  const featuresTotal = features.length;
  process.stdout.write(`Loaded ${featuresTotal} features\n`);
  
  // Initialize audit
  const audit: CoverageAudit = {
    census_total: censusTotal,
    features_total: featuresTotal,
    sid_validation: {
      missing_sid_count: 0,
      duplicate_sid_count: 0,
      duplicate_sid_list: [],
      unmatched_placeholder_count: 0
    },
    identity_mode_used: 'none',
    coverage: {
      matched_count: 0,
      missing_census_count: 0,
      missing_census_list: [],
      extra_feature_count: 0,
      extra_feature_list: [],
      ambiguous_keys_count: 0,
      ambiguous_keys_examples: []
    },
    municipality_counts: [],
    geometry_bounds: { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity },
    notes: [],
    warnings: []
  };
  
  // Validate SIDs
  const sidCounts = new Map<string, number>();
  const sidToFeatures = new Map<string, GeoJSONFeature[]>();
  
  for (const feature of features) {
    const sid = feature.properties?.sid;
    
    if (!sid || typeof sid !== 'string') {
      audit.sid_validation.missing_sid_count++;
      continue;
    }
    
    if (sid.startsWith('UNMATCHED::')) {
      audit.sid_validation.unmatched_placeholder_count++;
    }
    
    const count = sidCounts.get(sid) || 0;
    sidCounts.set(sid, count + 1);
    
    if (!sidToFeatures.has(sid)) {
      sidToFeatures.set(sid, []);
    }
    sidToFeatures.get(sid)!.push(feature);
  }
  
  // Find duplicates
  for (const [sid, count] of sidCounts.entries()) {
    if (count > 1) {
      audit.sid_validation.duplicate_sid_count += count - 1; // Extra occurrences
      audit.sid_validation.duplicate_sid_list.push(sid);
    }
  }
  audit.sid_validation.duplicate_sid_list.sort();
  
  // Determine identity mode and check coverage
  // Check if features have census_id (extracted from SID)
  let hasCensusId = false;
  let hasNameMunicipality = false;
  
  for (const feature of features) {
    const sid = feature.properties?.sid;
    const censusId = sid ? extractCensusId(sid) : null;
    if (censusId && !sid.startsWith('UNMATCHED::')) {
      hasCensusId = true;
    }
    
    if (feature.properties?.settlement_name && feature.properties?.municipality_id) {
      hasNameMunicipality = true;
    }
  }
  
  if (hasCensusId) {
    audit.identity_mode_used = 'census_id';
    
    // Coverage by census_id
    const matchedCensusIds = new Set<string>();
    const featureCensusIds = new Set<string>();
    
    for (const feature of features) {
      const sid = feature.properties?.sid;
      if (!sid) continue;
      
      const censusId = extractCensusId(sid);
      if (censusId && !sid.startsWith('UNMATCHED::')) {
        featureCensusIds.add(censusId);
        if (censusSettlementIds.has(censusId)) {
          matchedCensusIds.add(censusId);
        }
      }
    }
    
    audit.coverage.matched_count = matchedCensusIds.size;
    
    // Missing census IDs (in census but not in features)
    for (const censusId of censusSettlementIds) {
      if (!featureCensusIds.has(censusId)) {
        audit.coverage.missing_census_list.push(censusId);
      }
    }
    audit.coverage.missing_census_count = audit.coverage.missing_census_list.length;
    audit.coverage.missing_census_list.sort();
    if (audit.coverage.missing_census_list.length > 500) {
      audit.coverage.missing_census_list = audit.coverage.missing_census_list.slice(0, 500);
      audit.notes.push(`Missing census list truncated to 500 (total: ${audit.coverage.missing_census_count})`);
    }
    
    // Extra feature IDs (in features but not in census)
    for (const censusId of featureCensusIds) {
      if (!censusSettlementIds.has(censusId)) {
        audit.coverage.extra_feature_list.push(censusId);
      }
    }
    audit.coverage.extra_feature_count = audit.coverage.extra_feature_list.length;
    audit.coverage.extra_feature_list.sort();
    if (audit.coverage.extra_feature_list.length > 500) {
      audit.coverage.extra_feature_list = audit.coverage.extra_feature_list.slice(0, 500);
      audit.notes.push(`Extra feature list truncated to 500 (total: ${audit.coverage.extra_feature_count})`);
    }
    
  } else if (hasNameMunicipality) {
    audit.identity_mode_used = 'name_municipality';
    
    // Coverage by (normalized_name, municipality_id)
    const nameMunKeyToFeatures = new Map<string, GeoJSONFeature[]>();
    
    for (const feature of features) {
      const name = feature.properties?.settlement_name;
      const munId = feature.properties?.municipality_id;
      
      if (name && munId) {
        const normalizedName = normalizeString(String(name));
        const key = `${normalizedName}::${munId}`;
        
        if (!nameMunKeyToFeatures.has(key)) {
          nameMunKeyToFeatures.set(key, []);
        }
        nameMunKeyToFeatures.get(key)!.push(feature);
      }
    }
    
    // Check for ambiguous keys (multiple features mapping to same key)
    for (const [key, featureList] of nameMunKeyToFeatures.entries()) {
      if (featureList.length > 1) {
        audit.coverage.ambiguous_keys_count++;
        if (audit.coverage.ambiguous_keys_examples.length < 200) {
          audit.coverage.ambiguous_keys_examples.push({
            key,
            feature_count: featureList.length,
            sids: featureList.map(f => f.properties?.sid || '(missing)').sort()
          });
        }
      }
    }
    
    audit.coverage.matched_count = Array.from(nameMunKeyToFeatures.values())
      .filter(features => features.length === 1).length;
    
    audit.notes.push('Coverage by name+municipality: cannot determine missing/extra without census name+municipality mapping');
    
  } else {
    audit.identity_mode_used = 'none';
    audit.warnings.push('No settlement-level identity present; cannot validate census coverage beyond municipality tagging.');
  }
  
  // Municipality distribution
  const municipalityFeatureCounts = new Map<string, number>();
  
  for (const feature of features) {
    const munId = feature.properties?.municipality_id;
    if (munId) {
      const count = municipalityFeatureCounts.get(munId) || 0;
      municipalityFeatureCounts.set(munId, count + 1);
    }
  }
  
  const allMunicipalityIds = new Set<string>();
  for (const munId of municipalityFeatureCounts.keys()) {
    allMunicipalityIds.add(munId);
  }
  for (const munId of municipalitySettlementCounts.keys()) {
    allMunicipalityIds.add(munId);
  }
  
  for (const munId of Array.from(allMunicipalityIds).sort()) {
    const featureCount = municipalityFeatureCounts.get(munId) || 0;
    const censusCount = municipalitySettlementCounts.get(munId) || null;
    const censusMun = census.municipalities[munId];
    const censusName = censusMun?.n || null;
    
    audit.municipality_counts.push({
      municipality_id: munId,
      feature_count: featureCount,
      census_count: censusCount,
      census_name: censusName
    });
    
    // Flag issues
    if (censusCount !== null && featureCount === 0 && censusCount > 0) {
      audit.warnings.push(`Municipality ${munId} (${censusName || 'unknown'}) has ${censusCount} census settlements but 0 features`);
    }
    
    if (censusCount !== null && featureCount > 0) {
      const diff = Math.abs(featureCount - censusCount);
      const diffPercent = (diff / censusCount) * 100;
      if (diffPercent > 20 || diff > 50) {
        audit.warnings.push(`Municipality ${munId} (${censusName || 'unknown'}) has significant count divergence: ${featureCount} features vs ${censusCount} census settlements (${diffPercent.toFixed(1)}% diff)`);
      }
    }
  }
  
  // Sort municipality counts by feature count (descending)
  audit.municipality_counts.sort((a, b) => b.feature_count - a.feature_count);
  
  // Geometry bounds
  for (const feature of features) {
    const bbox = computeBbox(feature.geometry.coordinates);
    audit.geometry_bounds.minx = Math.min(audit.geometry_bounds.minx, bbox.minx);
    audit.geometry_bounds.miny = Math.min(audit.geometry_bounds.miny, bbox.miny);
    audit.geometry_bounds.maxx = Math.max(audit.geometry_bounds.maxx, bbox.maxx);
    audit.geometry_bounds.maxy = Math.max(audit.geometry_bounds.maxy, bbox.maxy);
  }
  
  // Write audit JSON
  writeFileSync(auditJsonPath, JSON.stringify(audit, null, 2), 'utf8');
  process.stdout.write(`Wrote audit JSON to ${auditJsonPath}\n`);
  
  // Write audit TXT
  const txtLines: string[] = [
    'SVG SUBSTRATE CENSUS COVERAGE AUDIT',
    '='.repeat(60),
    '',
    `Census total: ${audit.census_total} settlements`,
    `Features total: ${audit.features_total}`,
    '',
    'SID VALIDATION:',
    `  Missing SID: ${audit.sid_validation.missing_sid_count}`,
    `  Duplicate SID count: ${audit.sid_validation.duplicate_sid_count}`,
    `  Duplicate SIDs: ${audit.sid_validation.duplicate_sid_list.length > 0 ? audit.sid_validation.duplicate_sid_list.join(', ') : '(none)'}`,
    `  Unmatched placeholder count: ${audit.sid_validation.unmatched_placeholder_count}`,
    '',
    `Identity mode used: ${audit.identity_mode_used}`,
    '',
    'COVERAGE:',
    `  Matched: ${audit.coverage.matched_count}`,
    `  Missing census: ${audit.coverage.missing_census_count}`,
    `  Extra features: ${audit.coverage.extra_feature_count}`,
    `  Ambiguous keys: ${audit.coverage.ambiguous_keys_count}`,
  ];
  
  if (audit.coverage.missing_census_list.length > 0) {
    txtLines.push('');
    txtLines.push(`Missing census IDs (first 100):`);
    for (const id of audit.coverage.missing_census_list.slice(0, 100)) {
      txtLines.push(`  ${id}`);
    }
    if (audit.coverage.missing_census_list.length > 100) {
      txtLines.push(`  ... (${audit.coverage.missing_census_list.length - 100} more)`);
    }
  }
  
  if (audit.coverage.extra_feature_list.length > 0) {
    txtLines.push('');
    txtLines.push(`Extra feature IDs (first 100):`);
    for (const id of audit.coverage.extra_feature_list.slice(0, 100)) {
      txtLines.push(`  ${id}`);
    }
    if (audit.coverage.extra_feature_list.length > 100) {
      txtLines.push(`  ... (${audit.coverage.extra_feature_list.length - 100} more)`);
    }
  }
  
  if (audit.coverage.ambiguous_keys_examples.length > 0) {
    txtLines.push('');
    txtLines.push(`Ambiguous keys (first 20):`);
    for (const example of audit.coverage.ambiguous_keys_examples.slice(0, 20)) {
      txtLines.push(`  ${example.key}: ${example.feature_count} features (SIDs: ${example.sids.join(', ')})`);
    }
    if (audit.coverage.ambiguous_keys_examples.length > 20) {
      txtLines.push(`  ... (${audit.coverage.ambiguous_keys_examples.length - 20} more)`);
    }
  }
  
  txtLines.push('');
  txtLines.push('MUNICIPALITY COUNTS (top 20 by feature count):');
  for (const mun of audit.municipality_counts.slice(0, 20)) {
    const censusInfo = mun.census_count !== null ? ` (census: ${mun.census_count})` : ' (no census data)';
    const nameInfo = mun.census_name ? ` - ${mun.census_name}` : '';
    txtLines.push(`  ${mun.municipality_id}${nameInfo}: ${mun.feature_count} features${censusInfo}`);
  }
  
  txtLines.push('');
  txtLines.push('GEOMETRY BOUNDS:');
  txtLines.push(`  [${audit.geometry_bounds.minx.toFixed(6)}, ${audit.geometry_bounds.miny.toFixed(6)}, ${audit.geometry_bounds.maxx.toFixed(6)}, ${audit.geometry_bounds.maxy.toFixed(6)}]`);
  
  if (audit.notes.length > 0) {
    txtLines.push('');
    txtLines.push('NOTES:');
    for (const note of audit.notes) {
      txtLines.push(`  - ${note}`);
    }
  }
  
  if (audit.warnings.length > 0) {
    txtLines.push('');
    txtLines.push('WARNINGS:');
    for (const warning of audit.warnings) {
      txtLines.push(`  - ${warning}`);
    }
  }
  
  writeFileSync(auditTxtPath, txtLines.join('\n'), 'utf8');
  process.stdout.write(`Wrote audit TXT to ${auditTxtPath}\n`);
  
  // Print summary
  process.stdout.write('\n');
  process.stdout.write('SUMMARY:\n');
  process.stdout.write(`  Census total: ${audit.census_total}\n`);
  process.stdout.write(`  Features total: ${audit.features_total}\n`);
  process.stdout.write(`  Identity mode: ${audit.identity_mode_used}\n`);
  process.stdout.write(`  Matched: ${audit.coverage.matched_count}\n`);
  process.stdout.write(`  Missing census: ${audit.coverage.missing_census_count}\n`);
  process.stdout.write(`  Extra features: ${audit.coverage.extra_feature_count}\n`);
  process.stdout.write(`  Duplicate SIDs: ${audit.sid_validation.duplicate_sid_count}\n`);
  process.stdout.write(`  Unmatched placeholders: ${audit.sid_validation.unmatched_placeholder_count}\n`);
  if (audit.warnings.length > 0) {
    process.stdout.write(`  Warnings: ${audit.warnings.length}\n`);
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
