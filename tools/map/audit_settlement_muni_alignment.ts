/**
 * Settlement-to-Municipality Alignment Audit
 *
 * Validates settlement metadata municipality references against the authoritative
 * post-1995 municipality set as present in the border GeoJSON (drzava.js lineage).
 * No geometry generation or modification. No inference, no heuristics, no automatic remapping.
 * Purely reports mismatches and coverage gaps.
 *
 * Usage:
 *   tsx tools/map/audit_settlement_muni_alignment.ts
 *   npm run audit:settlements:muni
 *
 * Inputs:
 *   - data/derived/settlements_meta.csv (settlement metadata)
 *   - data/derived/municipality_borders.geojson (authoritative post-1995 municipality set)
 *
 * Outputs (in data/derived/municipality_audit/):
 *   - settlement_muni_alignment_report.json
 *   - settlements_missing_muni_ref.csv
 *   - settlements_unknown_muni_ref.csv
 *   - municipalities_zero_settlements.csv
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';

// ============================================================================
// Guards
// ============================================================================

loadMistakes();
assertNoRepeat('Audit settlement municipality references against authoritative post-1995 municipality IDs (no inference)');

// ============================================================================
// Paths
// ============================================================================

const DERIVED = resolve('data/derived');
const AUDIT_DIR = resolve(DERIVED, 'municipality_audit');
const SETTLEMENTS_META_PATH = resolve(DERIVED, 'settlements_meta.csv');
const BORDERS_PATH = resolve(DERIVED, 'municipality_borders.geojson');
const REPORT_JSON_PATH = resolve(AUDIT_DIR, 'settlement_muni_alignment_report.json');
const MISSING_MUNI_REF_CSV_PATH = resolve(AUDIT_DIR, 'settlements_missing_muni_ref.csv');
const UNKNOWN_MUNI_REF_CSV_PATH = resolve(AUDIT_DIR, 'settlements_unknown_muni_ref.csv');
const ZERO_SETTLEMENTS_CSV_PATH = resolve(AUDIT_DIR, 'municipalities_zero_settlements.csv');

// Priority order for municipality reference fields in settlements
const SETTLEMENT_MUNI_FIELDS = ['munid_5', 'munID', 'mun_id', 'mun_code', 'mid'] as const;

// Keys to check in border features (same as diagnose_border_ids.ts)
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
// Load authoritative municipalities from borders GeoJSON
// ============================================================================

async function loadAuthoritativeMunicipalities(): Promise<{
  authoritativeSet: Set<string>;
  authoritativeIds: string[];
  municipalityNames: Map<string, string>;
}> {
  const content = await readFile(BORDERS_PATH, 'utf8');
  const geojson = JSON.parse(content) as {
    type: string;
    features?: Array<{ properties?: Record<string, unknown> }>;
  };
  const features = geojson?.features ?? [];
  
  const authoritativeSet = new Set<string>();
  const municipalityNames = new Map<string, string>();

  for (const f of features) {
    const p = f.properties ?? {};
    let munid5: string | number | undefined;
    
    // Extract ID using same logic as diagnose_border_ids.ts
    for (const k of BORDERS_ID_KEYS) {
      const v = p[k];
      if (v !== undefined && v !== null && v !== '') {
        munid5 = v as string | number;
        break;
      }
    }
    
    if (munid5 !== undefined) {
      const munid5Str = String(munid5).trim();
      authoritativeSet.add(munid5Str);
      
      // Try to get municipality name if available
      const name = p.name || p.municipality_name || p.mun || '';
      if (name && typeof name === 'string') {
        municipalityNames.set(munid5Str, name);
      }
    }
  }

  const authoritativeIds = stableSortIds([...authoritativeSet]);

  return { authoritativeSet, authoritativeIds, municipalityNames };
}

// ============================================================================
// Extract municipality reference from settlement row
// ============================================================================

function extractMunicipalityReference(
  fields: string[],
  header: string[],
  fieldIndices: Map<string, number>
): {
  found: boolean;
  source_field: string | null;
  raw_value: string | null;
} {
  // Check fields in priority order
  for (const fieldName of SETTLEMENT_MUNI_FIELDS) {
    const idx = fieldIndices.get(fieldName);
    if (idx !== undefined && idx >= 0 && idx < fields.length) {
      const raw = fields[idx]?.trim();
      if (raw && raw !== '') {
        return {
          found: true,
          source_field: fieldName,
          raw_value: raw,
        };
      }
    }
  }
  
  return {
    found: false,
    source_field: null,
    raw_value: null,
  };
}

// ============================================================================
// Load settlements and audit municipality references
// ============================================================================

interface SettlementMuniRef {
  sid_excel: string;
  settlement_name: string;
  source_field: string | null;
  raw_value: string | null;
  is_valid: boolean;
  is_unknown: boolean;
}

async function loadAndAuditSettlements(
  authoritativeSet: Set<string>
): Promise<{
  settlements: SettlementMuniRef[];
  stats: {
    total_rows: number;
    used_rows: number;
    skipped_aggregate_rows: number;
    with_valid_muni_ref: number;
    with_missing_muni_ref: number;
    with_unknown_muni_ref: number;
  };
}> {
  const content = await readFile(SETTLEMENTS_META_PATH, 'utf8');
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }

  const header = parseCSVLine(lines[0]);
  
  // Build field index map
  const fieldIndices = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    fieldIndices.set(header[i], i);
  }
  
  // Find required columns
  const sidIdx = fieldIndices.get('sid');
  const nameIdx = fieldIndices.get('name');
  
  if (sidIdx === undefined || sidIdx < 0) {
    throw new Error('settlements_meta.csv missing required column: sid');
  }
  if (nameIdx === undefined || nameIdx < 0) {
    throw new Error('settlements_meta.csv missing required column: name');
  }

  const settlements: SettlementMuniRef[] = [];
  let total_rows = 0;
  let used_rows = 0;
  let skipped_aggregate_rows = 0;
  let with_valid_muni_ref = 0;
  let with_missing_muni_ref = 0;
  let with_unknown_muni_ref = 0;

  for (let i = 1; i < lines.length; i++) {
    total_rows++;
    const fields = parseCSVLine(lines[i]);
    
    // Skip aggregate rows
    if (hasAggregateSymbol(fields)) {
      skipped_aggregate_rows++;
      continue;
    }
    
    if (fields.length <= Math.max(sidIdx, nameIdx)) continue;
    
    used_rows++;
    const sid_excel = fields[sidIdx]?.trim() || '';
    const settlement_name = fields[nameIdx]?.trim() || '';
    
    // Extract municipality reference
    const muniRef = extractMunicipalityReference(fields, header, fieldIndices);
    
    let is_valid = false;
    let is_unknown = false;
    
    if (!muniRef.found) {
      with_missing_muni_ref++;
    } else {
      // Check if raw_value exactly matches an authoritative munid_5
      const rawValueStr = String(muniRef.raw_value).trim();
      if (authoritativeSet.has(rawValueStr)) {
        is_valid = true;
        with_valid_muni_ref++;
      } else {
        is_unknown = true;
        with_unknown_muni_ref++;
      }
    }
    
    settlements.push({
      sid_excel,
      settlement_name,
      source_field: muniRef.source_field,
      raw_value: muniRef.raw_value,
      is_valid,
      is_unknown,
    });
  }

  return {
    settlements,
    stats: {
      total_rows,
      used_rows,
      skipped_aggregate_rows,
      with_valid_muni_ref,
      with_missing_muni_ref,
      with_unknown_muni_ref,
    },
  };
}

// ============================================================================
// Compute municipality settlement counts
// ============================================================================

function computeMunicipalityCounts(
  settlements: SettlementMuniRef[],
  authoritativeIds: string[],
  municipalityNames: Map<string, string>
): {
  with_zero_settlements: number;
  with_some_settlements: number;
  zeroSettlementMunicipalities: Array<{ munid_5: string; municipality_name: string }>;
} {
  const muniToCount = new Map<string, number>();
  
  // Initialize all authoritative municipalities to zero
  for (const munid of authoritativeIds) {
    muniToCount.set(munid, 0);
  }
  
  // Count settlements per municipality
  for (const s of settlements) {
    if (s.is_valid && s.raw_value) {
      const count = muniToCount.get(s.raw_value) || 0;
      muniToCount.set(s.raw_value, count + 1);
    }
  }
  
  let with_zero_settlements = 0;
  let with_some_settlements = 0;
  const zeroSettlementMunicipalities: Array<{ munid_5: string; municipality_name: string }> = [];
  
  for (const munid of authoritativeIds) {
    const count = muniToCount.get(munid) || 0;
    if (count === 0) {
      with_zero_settlements++;
      zeroSettlementMunicipalities.push({
        munid_5: munid,
        municipality_name: municipalityNames.get(munid) || '',
      });
    } else {
      with_some_settlements++;
    }
  }
  
  return {
    with_zero_settlements,
    with_some_settlements,
    zeroSettlementMunicipalities: zeroSettlementMunicipalities.sort((a, b) => {
      // Sort by munid_5 (numeric if all numeric, else string)
      const aNum = Number(a.munid_5);
      const bNum = Number(b.munid_5);
      if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
        return aNum - bNum;
      }
      return a.munid_5.localeCompare(b.munid_5);
    }),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Ensure output directory exists
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code !== 'EEXIST') {
      throw err;
    }
  }

  // Load authoritative municipalities
  const { authoritativeSet, authoritativeIds, municipalityNames } = await loadAuthoritativeMunicipalities();
  console.log(`Loaded authoritative municipalities: ${authoritativeIds.length} (from borders GeoJSON)`);

  // Load and audit settlements
  const { settlements, stats } = await loadAndAuditSettlements(authoritativeSet);
  console.log(`Loaded settlements: ${stats.used_rows} used rows (${stats.skipped_aggregate_rows} aggregate rows skipped)`);

  // Compute municipality counts
  const muniCounts = computeMunicipalityCounts(settlements, authoritativeIds, municipalityNames);

  // Collect unknown municipality references
  const unknownMuniRefs = new Set<string>();
  for (const s of settlements) {
    if (s.is_unknown && s.raw_value) {
      unknownMuniRefs.add(s.raw_value);
    }
  }
  const unknownMuniRefsSorted = stableSortIds([...unknownMuniRefs]);

  // Build report
  const report = {
    authoritative_municipalities: {
      count: authoritativeIds.length,
      ids: authoritativeIds,
    },
    settlements: stats,
    municipalities: {
      with_zero_settlements: muniCounts.with_zero_settlements,
      with_some_settlements: muniCounts.with_some_settlements,
    },
    unknown_muni_refs: unknownMuniRefsSorted,
    id_scheme: {
      authoritative: 'munid_5 (border geojson id)',
      settlements: 'raw muni fields (as present in settlement metadata)',
    },
  };

  // Write JSON report
  await writeFile(REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');

  // Write CSV: settlements with missing muni ref
  const missingMuniRefLines: string[] = ['sid_excel,settlement_name,source_field,raw_value'];
  for (const s of settlements) {
    if (!s.source_field) {
      missingMuniRefLines.push([
        s.sid_excel,
        s.settlement_name,
        '',
        '',
      ].map(field => {
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','));
    }
  }
  await writeFile(MISSING_MUNI_REF_CSV_PATH, missingMuniRefLines.join('\n') + '\n', 'utf8');

  // Write CSV: settlements with unknown muni ref
  const unknownMuniRefLines: string[] = ['sid_excel,settlement_name,source_field,raw_value'];
  for (const s of settlements) {
    if (s.is_unknown) {
      unknownMuniRefLines.push([
        s.sid_excel,
        s.settlement_name,
        s.source_field || '',
        s.raw_value || '',
      ].map(field => {
        const str = String(field);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      }).join(','));
    }
  }
  await writeFile(UNKNOWN_MUNI_REF_CSV_PATH, unknownMuniRefLines.join('\n') + '\n', 'utf8');

  // Write CSV: municipalities with zero settlements
  const zeroSettlementsLines: string[] = ['munid_5,municipality_name'];
  for (const muni of muniCounts.zeroSettlementMunicipalities) {
    zeroSettlementsLines.push([
      muni.munid_5,
      muni.municipality_name,
    ].map(field => {
      const str = String(field);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(','));
  }
  await writeFile(ZERO_SETTLEMENTS_CSV_PATH, zeroSettlementsLines.join('\n') + '\n', 'utf8');

  // Print summary
  console.log('\nSettlement-to-Municipality Alignment Audit Summary:');
  console.log(`  Authoritative municipalities: ${authoritativeIds.length}`);
  console.log(`  Settlement rows:`);
  console.log(`    Total: ${stats.total_rows}`);
  console.log(`    Used: ${stats.used_rows}`);
  console.log(`    Skipped (aggregate): ${stats.skipped_aggregate_rows}`);
  console.log(`  Settlement municipality references:`);
  console.log(`    Valid: ${stats.with_valid_muni_ref}`);
  console.log(`    Missing: ${stats.with_missing_muni_ref}`);
  console.log(`    Unknown: ${stats.with_unknown_muni_ref}`);
  console.log(`  Municipalities:`);
  console.log(`    With zero settlements: ${muniCounts.with_zero_settlements}`);
  console.log(`    With some settlements: ${muniCounts.with_some_settlements}`);
  console.log(`  Unknown municipality references: ${unknownMuniRefsSorted.length}`);
  if (unknownMuniRefsSorted.length > 0) {
    console.log(`    (first 10): ${unknownMuniRefsSorted.slice(0, 10).join(', ')}`);
  }
  console.log('\nOutputs:');
  console.log('  ', REPORT_JSON_PATH);
  console.log('  ', MISSING_MUNI_REF_CSV_PATH);
  console.log('  ', UNKNOWN_MUNI_REF_CSV_PATH);
  console.log('  ', ZERO_SETTLEMENTS_CSV_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
