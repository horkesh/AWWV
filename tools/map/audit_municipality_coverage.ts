/**
 * Municipality Coverage Audit
 *
 * Compares expected municipalities (from settlements_meta.csv) vs present
 * municipalities (from municipality_borders.geojson). Produces missing/extra
 * lists and summary stats. Deterministic: stable sort, no timestamps.
 *
 * Usage:
 *   tsx tools/map/audit_municipality_coverage.ts
 *   npm run audit:muni
 *
 * Inputs:
 *   - data/derived/settlements_meta.csv
 *   - data/derived/municipality_borders.geojson
 *
 * Outputs:
 *   - data/derived/municipality_coverage_report.json
 *   - data/derived/municipality_missing_borders.csv
 *   - data/derived/municipality_missing_borders.json
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Guards
// ============================================================================

loadMistakes();
assertNoRepeat('Normalize municipality IDs via explicit crosswalk before auditing border coverage');
loadLedger();
assertLedgerFresh('Normalize municipality IDs via explicit crosswalk before auditing border coverage');

// ============================================================================
// Paths
// ============================================================================

const DERIVED = resolve('data/derived');
const REFS = resolve('data/refs');
const SETTLEMENTS_META_PATH = resolve(DERIVED, 'settlements_meta.csv');
const BORDERS_PATH = resolve(DERIVED, 'municipality_borders.geojson');
const CROSSWALK_PATH = resolve(REFS, 'municipality_id_crosswalk.csv');
const REPORT_JSON_PATH = resolve(DERIVED, 'municipality_coverage_report.json');
const MISSING_CSV_PATH = resolve(DERIVED, 'municipality_missing_borders.csv');
const MISSING_JSON_PATH = resolve(DERIVED, 'municipality_missing_borders.json');

const MUNI_ID_HEADERS = ['mid', 'municipality_id', 'mun_id', 'mun_code'] as const;
const BORDERS_ID_KEYS = ['mid', 'munID', 'mun_id', 'mun_code'] as const;

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

function hasAggregateSymbol(fields: string[]): boolean {
  return fields.some((c) => String(c).includes('∑'));
}

// ============================================================================
// Sort (deterministic: numeric if all numeric, else string)
// ============================================================================

function stableSortIds(ids: string[]): string[] {
  const normalized = [...ids];
  const allNumeric = normalized.every((id) => {
    const n = Number(id);
    return Number.isFinite(n) && !Number.isNaN(n);
  });
  if (allNumeric) {
    normalized.sort((a, b) => Number(a) - Number(b));
  } else {
    normalized.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }
  return normalized;
}

// ============================================================================
// Settlements meta → expected mids
// ============================================================================

async function loadExpectedMids(): Promise<{
  expectedMidSet: Set<string>;
  settlement_rows_count: number;
  aggregate_rows_skipped: number;
}> {
  const content = await readFile(SETTLEMENTS_META_PATH, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }

  const header = parseCSVLine(lines[0]);
  let muniColIdx = -1;
  for (const h of MUNI_ID_HEADERS) {
    const idx = header.indexOf(h);
    if (idx !== -1) {
      muniColIdx = idx;
      break;
    }
  }
  if (muniColIdx === -1) {
    throw new Error(
      `settlements_meta.csv: no municipality id column found. Tried: ${MUNI_ID_HEADERS.join(', ')}. Headers: ${header.join(', ')}`
    );
  }

  const expectedMidSet = new Set<string>();
  let aggregate_rows_skipped = 0;
  let settlement_rows_count = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (hasAggregateSymbol(fields)) {
      aggregate_rows_skipped++;
      continue;
    }
    if (fields.length <= muniColIdx) continue;
    const raw = fields[muniColIdx]?.trim();
    if (!raw) continue;
    settlement_rows_count++;
    expectedMidSet.add(String(raw).trim());
  }

  return { expectedMidSet, settlement_rows_count, aggregate_rows_skipped };
}

// ============================================================================
// Load crosswalk
// ============================================================================

interface CrosswalkEntry {
  munid_5: string;
  mid_7: string;
  name?: string;
}

async function loadCrosswalk(): Promise<{
  munid5ToMid7: Map<string, string>;
  mid7ToMunid5: Map<string, string>;
  stats: { rows: number; unique_munid_5: number; unique_mid_7: number };
}> {
  const munid5ToMid7 = new Map<string, string>();
  const mid7ToMunid5 = new Map<string, string>();
  
  try {
    const content = await readFile(CROSSWALK_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      console.warn(`Crosswalk file ${CROSSWALK_PATH} has no data rows (only header or empty)`);
      return {
        munid5ToMid7,
        mid7ToMunid5,
        stats: { rows: 0, unique_munid_5: 0, unique_mid_7: 0 },
      };
    }

    const header = parseCSVLine(lines[0]);
    const munid5Idx = header.indexOf('munid_5');
    const mid7Idx = header.indexOf('mid_7');
    
    if (munid5Idx === -1 || mid7Idx === -1) {
      throw new Error(`Crosswalk CSV missing required columns: munid_5=${munid5Idx === -1}, mid_7=${mid7Idx === -1}`);
    }

    const seenMunid5 = new Set<string>();
    const seenMid7 = new Set<string>();
    let rows = 0;

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCSVLine(lines[i]);
      if (fields.length <= Math.max(munid5Idx, mid7Idx)) continue;
      
      const munid5 = String(fields[munid5Idx] ?? '').trim();
      const mid7 = String(fields[mid7Idx] ?? '').trim();
      
      if (!munid5 || !mid7) continue;
      
      // Validate no duplicates
      if (seenMunid5.has(munid5)) {
        throw new Error(`Duplicate munid_5 in crosswalk: ${munid5}`);
      }
      if (seenMid7.has(mid7)) {
        throw new Error(`Duplicate mid_7 in crosswalk: ${mid7}`);
      }
      
      seenMunid5.add(munid5);
      seenMid7.add(mid7);
      munid5ToMid7.set(munid5, mid7);
      mid7ToMunid5.set(mid7, munid5);
      rows++;
    }

    return {
      munid5ToMid7,
      mid7ToMunid5,
      stats: {
        rows,
        unique_munid_5: seenMunid5.size,
        unique_mid_7: seenMid7.size,
      },
    };
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      console.warn(`Crosswalk file ${CROSSWALK_PATH} not found. Border IDs will be treated as unmapped.`);
      return {
        munid5ToMid7,
        mid7ToMunid5,
        stats: { rows: 0, unique_munid_5: 0, unique_mid_7: 0 },
      };
    }
    throw err;
  }
}

// ============================================================================
// Municipality borders GeoJSON → present mids (normalized via crosswalk)
// ============================================================================

async function loadPresentMids(
  crosswalk: Map<string, string>
): Promise<{
  presentMid7Set: Set<string>;
  borders_features_count: number;
  borders_features_missing_id_count: number;
  unmapped_border_ids: string[];
}> {
  const content = await readFile(BORDERS_PATH, 'utf8');
  const geojson = JSON.parse(content) as { type: string; features?: Array<{ properties?: Record<string, unknown> }> };
  const features = geojson?.features ?? [];
  const presentMid7Set = new Set<string>();
  const unmappedBorderIds: string[] = [];
  let borders_features_missing_id_count = 0;

  for (const f of features) {
    const p = f.properties ?? {};
    let munid5: string | number | undefined;
    for (const k of BORDERS_ID_KEYS) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== '') {
        munid5 = v as string | number;
        break;
      }
    }
    if (munid5 === undefined) {
      borders_features_missing_id_count++;
      continue;
    }
    
    const munid5Str = String(munid5).trim();
    const mid7 = crosswalk.get(munid5Str);
    
    if (mid7) {
      presentMid7Set.add(mid7);
    } else {
      unmappedBorderIds.push(munid5Str);
    }
  }

  return {
    presentMid7Set,
    borders_features_count: features.length,
    borders_features_missing_id_count,
    unmapped_border_ids: stableSortIds(unmappedBorderIds),
  };
}

// ============================================================================
// Optional: mtime for a file
// ============================================================================

async function getMtime(path: string): Promise<number | undefined> {
  try {
    const st = await stat(path);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Load crosswalk
  const crosswalk = await loadCrosswalk();
  
  // Load expected mids (7-digit, from settlements)
  const { expectedMidSet, settlement_rows_count, aggregate_rows_skipped } = await loadExpectedMids();
  
  // Load present mids (normalized from 5-digit border IDs via crosswalk)
  const {
    presentMid7Set,
    borders_features_count,
    borders_features_missing_id_count,
    unmapped_border_ids,
  } = await loadPresentMids(crosswalk.munid5ToMid7);

  const expected_count = expectedMidSet.size;
  const present_count = presentMid7Set.size;
  const missingSet = new Set<string>();
  const extraSet = new Set<string>();
  for (const id of expectedMidSet) {
    if (!presentMid7Set.has(id)) missingSet.add(id);
  }
  for (const id of presentMid7Set) {
    if (!expectedMidSet.has(id)) extraSet.add(id);
  }
  const missing_count = missingSet.size;
  const extra_count = extraSet.size;

  const missingSorted = stableSortIds([...missingSet]);
  const extraSorted = stableSortIds([...extraSet]);

  const input_files: Record<string, { mtime_ms?: number }> = {
    settlements_meta_csv: {},
    municipality_borders_geojson: {},
    municipality_id_crosswalk_csv: {},
  };
  const m1 = await getMtime(SETTLEMENTS_META_PATH);
  const m2 = await getMtime(BORDERS_PATH);
  const m3 = await getMtime(CROSSWALK_PATH);
  if (m1 != null) input_files.settlements_meta_csv.mtime_ms = m1;
  if (m2 != null) input_files.municipality_borders_geojson.mtime_ms = m2;
  if (m3 != null) input_files.municipality_id_crosswalk_csv.mtime_ms = m3;

  const report = {
    id_scheme: {
      settlements_expected: 'mid_7',
      borders_raw: 'munid_5',
      borders_normalized: 'mid_7_via_crosswalk',
    },
    expected_count,
    present_count,
    missing_count,
    extra_count,
    settlement_rows_count,
    aggregate_rows_skipped,
    borders_features_count,
    borders_features_missing_id_count,
    unmapped_border_ids,
    crosswalk_stats: crosswalk.stats,
    missing: missingSorted,
    extra: extraSorted,
    input_files,
  };

  await writeFile(REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');

  const csvLines = ['municipality_id', ...missingSorted.map((id) => id)];
  await writeFile(MISSING_CSV_PATH, csvLines.join('\n') + '\n', 'utf8');

  const missingJson = { missing: missingSorted, extra: extraSorted };
  await writeFile(MISSING_JSON_PATH, JSON.stringify(missingJson, null, 2), 'utf8');

  console.log('Municipality coverage audit');
  console.log('  ID scheme:');
  console.log('    settlements_expected: mid_7 (7-digit canonical pre-1991 municipality IDs)');
  console.log('    borders_raw: munid_5 (5-digit IDs from drzava.js)');
  console.log('    borders_normalized: mid_7_via_crosswalk (mapped via explicit crosswalk)');
  console.log('  expected_count:', expected_count);
  console.log('  present_count:', present_count);
  console.log('  missing_count:', missing_count);
  console.log('  extra_count:', extra_count);
  console.log('  settlement_rows_count:', settlement_rows_count);
  console.log('  aggregate_rows_skipped:', aggregate_rows_skipped);
  console.log('  borders_features_count:', borders_features_count);
  console.log('  borders_features_missing_id_count:', borders_features_missing_id_count);
  console.log('  crosswalk_stats:', JSON.stringify(crosswalk.stats, null, 2));
  console.log('  unmapped_border_ids_count:', unmapped_border_ids.length);
  if (unmapped_border_ids.length > 0) {
    console.log('  unmapped_border_ids (first 10):', unmapped_border_ids.slice(0, 10).join(', '));
  }
  console.log('');
  console.log('Outputs:');
  console.log('  ', REPORT_JSON_PATH);
  console.log('  ', MISSING_CSV_PATH);
  console.log('  ', MISSING_JSON_PATH);
  if (missing_count > 0) {
    console.log('');
    console.log('Missing municipality ids (first 20):', missingSorted.slice(0, 20).join(', '));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
