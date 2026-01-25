/**
 * Border ID Extraction Diagnostic
 *
 * Deterministic diagnostic to explain why only 13/138 border features map via the crosswalk.
 * Read-only analysis: reports raw vs normalized ID differences, no geometry changes, no inference.
 *
 * Usage:
 *   tsx tools/map/diagnose_border_ids.ts
 *   npm run audit:muni:diagnose-borders
 *
 * Inputs:
 *   - data/derived/municipality_borders.geojson
 *   - data/refs/municipality_id_crosswalk.csv
 *
 * Outputs:
 *   - data/derived/municipality_audit/border_id_diagnostic.json
 *   - data/derived/municipality_audit/border_id_diagnostic.csv
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';

// ============================================================================
// Guards
// ============================================================================

loadMistakes();
assertNoRepeat('Diagnose why border IDs do not map to crosswalk; report raw keys/values deterministically');

// ============================================================================
// Paths
// ============================================================================

const DERIVED = resolve('data/derived');
const REFS = resolve('data/refs');
const BORDERS_PATH = resolve(DERIVED, 'municipality_borders.geojson');
const CROSSWALK_PATH = resolve(REFS, 'municipality_id_crosswalk.csv');
const AUDIT_DIR = resolve(DERIVED, 'municipality_audit');
const DIAGNOSTIC_JSON_PATH = resolve(AUDIT_DIR, 'border_id_diagnostic.json');
const DIAGNOSTIC_CSV_PATH = resolve(AUDIT_DIR, 'border_id_diagnostic.csv');

// Candidate keys to check (in priority order, matching audit script)
const CANDIDATE_KEYS = ['mid', 'munID', 'mun_id', 'mun_code', 'id', 'ID', 'MUNID', 'municipality_id'] as const;

// ============================================================================
// CSV parsing
// ============================================================================

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      if (inQuotes && line[j + 1] === '"') {
        current += '"';
        j++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

// ============================================================================
// Load crosswalk
// ============================================================================

interface CrosswalkEntry {
  munid_5: string;
  mid_7: string;
  name?: string;
}

async function loadCrosswalk(): Promise<Map<string, CrosswalkEntry>> {
  const crosswalkMap = new Map<string, CrosswalkEntry>();
  
  try {
    const content = await readFile(CROSSWALK_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      console.warn(`Crosswalk file ${CROSSWALK_PATH} has no data rows (only header or empty)`);
      return crosswalkMap;
    }

    const header = parseCSVLine(lines[0]);
    const munid5Idx = header.indexOf('munid_5');
    const mid7Idx = header.indexOf('mid_7');
    const nameIdx = header.indexOf('name');
    
    if (munid5Idx === -1 || mid7Idx === -1) {
      throw new Error(`Crosswalk CSV missing required columns: munid_5=${munid5Idx === -1}, mid_7=${mid7Idx === -1}`);
    }

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length <= Math.max(munid5Idx, mid7Idx)) continue;
      
      const munid5 = String(fields[munid5Idx] ?? '').trim();
      const mid7 = String(fields[mid7Idx] ?? '').trim();
      const name = nameIdx >= 0 && fields[nameIdx] ? String(fields[nameIdx] ?? '').trim() : undefined;
      
      if (!munid5 || !mid7) continue;
      
      crosswalkMap.set(munid5, { munid_5: munid5, mid_7: mid7, name });
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      console.warn(`Crosswalk file ${CROSSWALK_PATH} not found. Diagnostic will show no matches.`);
      return crosswalkMap;
    }
    throw err;
  }
  
  return crosswalkMap;
}

// ============================================================================
// Normalization strategies (diagnostic only, not used to change audit)
// ============================================================================

function normalizeId(raw: string | number | null | undefined): {
  raw_string: string;
  trimmed: string;
  digits_only: string;
  padded_5_if_digits: string;
} {
  const rawStr = raw === null || raw === undefined ? '' : String(raw);
  const trimmed = rawStr.trim();
  const digitsOnly = trimmed.replace(/\D/g, '');
  const padded5 = digitsOnly.length > 0 && digitsOnly.length < 5
    ? digitsOnly.padStart(5, '0')
    : digitsOnly;

  return {
    raw_string: rawStr,
    trimmed,
    digits_only: digitsOnly,
    padded_5_if_digits: padded5,
  };
}

// ============================================================================
// Check crosswalk matches
// ============================================================================

function checkCrosswalkMatches(
  normalized: ReturnType<typeof normalizeId>,
  crosswalk: Map<string, CrosswalkEntry>
): {
  direct_match: boolean;
  trimmed_match: boolean;
  digits_only_match: boolean;
  padded_5_match: boolean;
  matched_munid_5: string | null;
  matched_mid_7: string | null;
} {
  let matched_munid_5: string | null = null;
  let matched_mid_7: string | null = null;

  // Try direct match
  const directEntry = crosswalk.get(normalized.raw_string);
  if (directEntry) {
    matched_munid_5 = directEntry.munid_5;
    matched_mid_7 = directEntry.mid_7;
    return {
      direct_match: true,
      trimmed_match: false,
      digits_only_match: false,
      padded_5_match: false,
      matched_munid_5,
      matched_mid_7,
    };
  }

  // Try trimmed match
  const trimmedEntry = crosswalk.get(normalized.trimmed);
  if (trimmedEntry) {
    matched_munid_5 = trimmedEntry.munid_5;
    matched_mid_7 = trimmedEntry.mid_7;
    return {
      direct_match: false,
      trimmed_match: true,
      digits_only_match: false,
      padded_5_match: false,
      matched_munid_5,
      matched_mid_7,
    };
  }

  // Try digits_only match
  const digitsEntry = crosswalk.get(normalized.digits_only);
  if (digitsEntry) {
    matched_munid_5 = digitsEntry.munid_5;
    matched_mid_7 = digitsEntry.mid_7;
    return {
      direct_match: false,
      trimmed_match: false,
      digits_only_match: true,
      padded_5_match: false,
      matched_munid_5,
      matched_mid_7,
    };
  }

  // Try padded_5 match
  const paddedEntry = crosswalk.get(normalized.padded_5_if_digits);
  if (paddedEntry) {
    matched_munid_5 = paddedEntry.munid_5;
    matched_mid_7 = paddedEntry.mid_7;
    return {
      direct_match: false,
      trimmed_match: false,
      digits_only_match: false,
      padded_5_match: true,
      matched_munid_5,
      matched_mid_7,
    };
  }

  return {
    direct_match: false,
    trimmed_match: false,
    digits_only_match: false,
    padded_5_match: false,
    matched_munid_5: null,
    matched_mid_7: null,
  };
}

// ============================================================================
// Extract candidate keys from feature properties
// ============================================================================

function extractCandidateKeys(properties: Record<string, unknown>): Record<string, string | number | null> {
  const candidates: Record<string, string | number | null> = {};
  for (const key of CANDIDATE_KEYS) {
    const value = properties[key];
    if (value !== undefined) {
      candidates[key] = value as string | number | null;
    }
  }
  return candidates;
}

// ============================================================================
// Extract raw ID (matching audit script logic)
// ============================================================================

function extractRawId(properties: Record<string, unknown>): {
  extracted_raw_id: string | number | null;
  extracted_raw_id_type: 'string' | 'number' | 'null';
  extracted_from_key: string | null;
} {
  for (const key of CANDIDATE_KEYS) {
    const value = properties[key];
    if (value !== undefined && value !== null && value !== '') {
      return {
        extracted_raw_id: value as string | number,
        extracted_raw_id_type: typeof value === 'number' ? 'number' : typeof value === 'string' ? 'string' : 'null',
        extracted_from_key: key,
      };
    }
  }
  return {
    extracted_raw_id: null,
    extracted_raw_id_type: 'null',
    extracted_from_key: null,
  };
}

// ============================================================================
// Main diagnostic
// ============================================================================

interface DiagnosticEntry {
  feature_index: number;
  extracted_raw_id: string | number | null;
  extracted_raw_id_type: 'string' | 'number' | 'null';
  extracted_from_key: string | null;
  all_candidate_keys_present: Record<string, string | number | null>;
  normalized_id_attempt: {
    raw_string: string;
    trimmed: string;
    digits_only: string;
    padded_5_if_digits: string;
  };
  crosswalk_match_status: {
    direct_match: boolean;
    trimmed_match: boolean;
    digits_only_match: boolean;
    padded_5_match: boolean;
    matched_munid_5: string | null;
    matched_mid_7: string | null;
  };
}

async function main(): Promise<void> {
  // Ensure output directory exists
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code !== 'EEXIST') {
      throw err;
    }
  }

  // Load crosswalk
  const crosswalk = await loadCrosswalk();
  console.log(`Loaded crosswalk: ${crosswalk.size} entries`);

  // Load borders GeoJSON
  const bordersContent = await readFile(BORDERS_PATH, 'utf8');
  const bordersGeoJSON = JSON.parse(bordersContent) as {
    type: string;
    features?: Array<{ properties?: Record<string, unknown> }>;
  };
  const features = bordersGeoJSON?.features ?? [];
  console.log(`Loaded borders: ${features.length} features`);

  // Process each feature
  const diagnostics: DiagnosticEntry[] = [];
  for (let i = 0; i < features.length; i++) {
    const feature = features[i];
    const properties = feature.properties ?? {};

    // Extract raw ID (matching audit script logic)
    const { extracted_raw_id, extracted_raw_id_type, extracted_from_key } = extractRawId(properties);

    // Collect all candidate keys present
    const all_candidate_keys_present = extractCandidateKeys(properties);

    // Normalize ID (diagnostic only)
    const normalized_id_attempt = normalizeId(extracted_raw_id);

    // Check crosswalk matches
    const crosswalk_match_status = checkCrosswalkMatches(normalized_id_attempt, crosswalk);

    diagnostics.push({
      feature_index: i,
      extracted_raw_id,
      extracted_raw_id_type,
      extracted_from_key,
      all_candidate_keys_present,
      normalized_id_attempt,
      crosswalk_match_status,
    });
  }

  // Write JSON output (stable sorted by feature_index)
  const jsonOutput = diagnostics.sort((a, b) => a.feature_index - b.feature_index);
  await writeFile(DIAGNOSTIC_JSON_PATH, JSON.stringify(jsonOutput, null, 2), 'utf8');

  // Write CSV output
  const csvLines: string[] = [];
  csvLines.push([
    'feature_index',
    'extracted_raw_id',
    'extracted_raw_id_type',
    'extracted_from_key',
    'all_candidate_keys_present',
    'normalized_raw_string',
    'normalized_trimmed',
    'normalized_digits_only',
    'normalized_padded_5_if_digits',
    'crosswalk_direct_match',
    'crosswalk_trimmed_match',
    'crosswalk_digits_only_match',
    'crosswalk_padded_5_match',
    'matched_munid_5',
    'matched_mid_7',
  ].join(','));

  for (const diag of jsonOutput) {
    const candidateKeysStr = JSON.stringify(diag.all_candidate_keys_present);
    csvLines.push([
      String(diag.feature_index),
      diag.extracted_raw_id === null ? '' : String(diag.extracted_raw_id),
      diag.extracted_raw_id_type,
      diag.extracted_from_key ?? '',
      candidateKeysStr,
      diag.normalized_id_attempt.raw_string,
      diag.normalized_id_attempt.trimmed,
      diag.normalized_id_attempt.digits_only,
      diag.normalized_id_attempt.padded_5_if_digits,
      String(diag.crosswalk_match_status.direct_match),
      String(diag.crosswalk_match_status.trimmed_match),
      String(diag.crosswalk_match_status.digits_only_match),
      String(diag.crosswalk_match_status.padded_5_match),
      diag.crosswalk_match_status.matched_munid_5 ?? '',
      diag.crosswalk_match_status.matched_mid_7 ?? '',
    ].map(field => {
      // Escape quotes and wrap in quotes if contains comma, quote, or newline
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(','));
  }

  await writeFile(DIAGNOSTIC_CSV_PATH, csvLines.join('\n') + '\n', 'utf8');

  // Summary statistics
  const total = diagnostics.length;
  const withRawId = diagnostics.filter(d => d.extracted_raw_id !== null).length;
  const withMatch = diagnostics.filter(d => 
    d.crosswalk_match_status.direct_match ||
    d.crosswalk_match_status.trimmed_match ||
    d.crosswalk_match_status.digits_only_match ||
    d.crosswalk_match_status.padded_5_match
  ).length;
  const directMatches = diagnostics.filter(d => d.crosswalk_match_status.direct_match).length;
  const trimmedMatches = diagnostics.filter(d => d.crosswalk_match_status.trimmed_match).length;
  const digitsOnlyMatches = diagnostics.filter(d => d.crosswalk_match_status.digits_only_match).length;
  const padded5Matches = diagnostics.filter(d => d.crosswalk_match_status.padded_5_match).length;

  console.log('\nBorder ID Diagnostic Summary:');
  console.log(`  Total features: ${total}`);
  console.log(`  Features with extracted ID: ${withRawId}`);
  console.log(`  Features with crosswalk match: ${withMatch}`);
  console.log(`    Direct matches: ${directMatches}`);
  console.log(`    Trimmed matches: ${trimmedMatches}`);
  console.log(`    Digits-only matches: ${digitsOnlyMatches}`);
  console.log(`    Padded-5 matches: ${padded5Matches}`);
  console.log(`  Features without match: ${total - withMatch}`);
  console.log('\nOutputs:');
  console.log('  ', DIAGNOSTIC_JSON_PATH);
  console.log('  ', DIAGNOSTIC_CSV_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
