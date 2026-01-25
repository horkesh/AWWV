/**
 * Build Crosswalk: Create deterministic crosswalk between Excel and SVG settlements
 * 
 * Builds an explicit crosswalk between Excel settlements and SVG polygons using
 * deterministic (mid + normalized_name) matching, 1:1 only.
 * 
 * Outputs:
 *   - data/derived/sid_crosswalk.csv
 *   - data/derived/sid_crosswalk_unresolved.csv
 * 
 * Usage:
 *   tsx tools/map/build_crosswalk.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';
import { normalizeName, makeJoinKey } from './name_normalize';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild: crosswalk excel settlement ids to svg polygons, rekey geojson, build inspector html");
loadLedger();
assertLedgerFresh("map rebuild: crosswalk excel settlement ids to svg polygons, rekey geojson, build inspector html");

// ============================================================================
// Types
// ============================================================================

interface ExcelSettlement {
  sid_excel: string;
  mid: string;
  name: string;
}

interface SVGFeature {
  sid_html: string;
  mun_code: string;
  name: string;
  mid_html?: string; // Derived from mun_code if different from Excel mid
}

interface CrosswalkMatch {
  sid_excel: string;
  mid: string;
  name_excel: string;
  sid_html: string;
  name_html: string;
  join_key: string;
  match_method: string;
  match_confidence: string;
}

interface UnresolvedCase {
  join_key: string;
  mid: string;
  excel_count: number;
  svg_count: number;
  example_excel_sids: string[];
  example_svg_ids: string[];
  excel_names: string[];
  svg_names: string[];
}

// ============================================================================
// Constants
// ============================================================================

const META_PATH = resolve('data/derived/settlements_meta.csv');
const SVG_PATHS_PATH = resolve('data/derived/settlement_svgpaths.json');
const CROSSWALK_OUTPUT_PATH = resolve('data/derived/sid_crosswalk.csv');
const UNRESOLVED_OUTPUT_PATH = resolve('data/derived/sid_crosswalk_unresolved.csv');
const DERIVED_DIR = resolve('data/derived');

// ============================================================================
// CSV Parsing
// ============================================================================

/**
 * Parse CSV line handling quoted fields
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    if (char === '"') {
      if (inQuotes && line[j + 1] === '"') {
        // Escaped quote
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

/**
 * Escape CSV field
 */
function escapeCSV(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

// ============================================================================
// Data Loading
// ============================================================================

async function loadExcelMeta(): Promise<ExcelSettlement[]> {
  const content = await readFile(META_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    throw new Error('settlements_meta.csv must have at least a header and one data row');
  }
  
  const header = parseCSVLine(lines[0]);
  const sidIdx = header.indexOf('sid');
  const nameIdx = header.indexOf('name');
  const midIdx = header.indexOf('mid');
  
  if (sidIdx === -1 || nameIdx === -1 || midIdx === -1) {
    throw new Error('settlements_meta.csv missing required columns: sid, name, mid');
  }
  
  const settlements: ExcelSettlement[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    
    if (fields.length <= Math.max(sidIdx, nameIdx, midIdx)) continue;
    
    const sid = fields[sidIdx]?.trim();
    const name = fields[nameIdx]?.trim() || '';
    const mid = fields[midIdx]?.trim() || '';
    
    if (!sid || !mid) continue;
    
    settlements.push({
      sid_excel: sid,
      mid,
      name
    });
  }
  
  return settlements;
}

async function loadSVGFeatures(): Promise<SVGFeature[]> {
  const content = await readFile(SVG_PATHS_PATH, 'utf8');
  const rawFeatures = JSON.parse(content) as Array<{
    sid: string;
    mun_code: string;
    name: string;
    d?: string;
  }>;
  
  return rawFeatures.map(f => ({
    sid_html: String(f.sid),
    mun_code: f.mun_code || '',
    name: f.name || '',
    mid_html: f.mun_code || undefined
  }));
}

// ============================================================================
// Crosswalk Building
// ============================================================================

async function buildCrosswalk(): Promise<{
  matched: CrosswalkMatch[];
  unresolved: UnresolvedCase[];
  stats: {
    crosswalk_matched: number;
    crosswalk_unresolved: number;
    crosswalk_ambiguous: number;
  };
}> {
  const excelSettlements = await loadExcelMeta();
  const svgFeatures = await loadSVGFeatures();
  
  console.log(`Loaded ${excelSettlements.length} Excel settlements`);
  console.log(`Loaded ${svgFeatures.length} SVG features\n`);
  
  // Build maps keyed by join_key
  const excelByKey = new Map<string, ExcelSettlement[]>();
  const svgByKey = new Map<string, SVGFeature[]>();
  
  // Index Excel by join_key
  for (const excel of excelSettlements) {
    const joinKey = makeJoinKey(excel.mid, excel.name);
    if (!excelByKey.has(joinKey)) {
      excelByKey.set(joinKey, []);
    }
    excelByKey.get(joinKey)!.push(excel);
  }
  
  // Index SVG by join_key
  // Try matching using Excel mid first, then fallback to mun_code as mid_html
  for (const svg of svgFeatures) {
    // First try: use Excel mid if mun_code matches
    // We'll try both the Excel mid and mun_code as potential mids
    const possibleMids = [svg.mun_code];
    
    // If we have a mapping later, we can use it, but for now just use mun_code
    for (const mid of possibleMids) {
      if (!mid) continue;
      const joinKey = makeJoinKey(mid, svg.name);
      if (!svgByKey.has(joinKey)) {
        svgByKey.set(joinKey, []);
      }
      svgByKey.get(joinKey)!.push(svg);
    }
  }
  
  // Find 1:1 matches
  const matched: CrosswalkMatch[] = [];
  const unresolved: UnresolvedCase[] = [];
  const matchedKeys = new Set<string>();
  
  // Check all Excel join keys
  for (const [joinKey, excelList] of excelByKey.entries()) {
    const svgList = svgByKey.get(joinKey) || [];
    
    if (excelList.length === 1 && svgList.length === 1) {
      // Perfect 1:1 match
      const excel = excelList[0];
      const svg = svgList[0];
      
      matched.push({
        sid_excel: excel.sid_excel,
        mid: excel.mid,
        name_excel: excel.name,
        sid_html: svg.sid_html,
        name_html: svg.name,
        join_key: joinKey,
        match_method: 'mid+normalized_name',
        match_confidence: 'high'
      });
      
      matchedKeys.add(joinKey);
    }
  }
  
  // Find unresolved cases
  for (const [joinKey, excelList] of excelByKey.entries()) {
    if (matchedKeys.has(joinKey)) continue; // Already matched
    
    const svgList = svgByKey.get(joinKey) || [];
    
    if (excelList.length !== 1 || svgList.length !== 1) {
      unresolved.push({
        join_key: joinKey,
        mid: excelList.length > 0 ? excelList[0].mid : (svgList.length > 0 ? svgList[0].mun_code : ''),
        excel_count: excelList.length,
        svg_count: svgList.length,
        example_excel_sids: excelList.slice(0, 3).map(e => e.sid_excel),
        example_svg_ids: svgList.slice(0, 3).map(s => s.sid_html),
        excel_names: excelList.slice(0, 3).map(e => e.name),
        svg_names: svgList.slice(0, 3).map(s => s.name)
      });
    }
  }
  
  // Also check SVG keys that don't have Excel matches
  for (const [joinKey, svgList] of svgByKey.entries()) {
    if (matchedKeys.has(joinKey)) continue; // Already matched
    if (excelByKey.has(joinKey)) continue; // Already in unresolved
    
    unresolved.push({
      join_key: joinKey,
      mid: svgList.length > 0 ? svgList[0].mun_code : '',
      excel_count: 0,
      svg_count: svgList.length,
      example_excel_sids: [],
      example_svg_ids: svgList.slice(0, 3).map(s => s.sid_html),
      excel_names: [],
      svg_names: svgList.slice(0, 3).map(s => s.name)
    });
  }
  
  // Sort for determinism
  matched.sort((a, b) => {
    if (a.mid !== b.mid) return a.mid.localeCompare(b.mid);
    const nameA = normalizeName(a.name_excel);
    const nameB = normalizeName(b.name_excel);
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return a.sid_excel.localeCompare(b.sid_excel);
  });
  
  unresolved.sort((a, b) => {
    if (a.mid !== b.mid) return a.mid.localeCompare(b.mid);
    return a.join_key.localeCompare(b.join_key);
  });
  
  const ambiguous = unresolved.filter(u => u.excel_count > 1 || u.svg_count > 1).length;
  
  return {
    matched,
    unresolved,
    stats: {
      crosswalk_matched: matched.length,
      crosswalk_unresolved: unresolved.length,
      crosswalk_ambiguous: ambiguous
    }
  };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Building crosswalk between Excel and SVG settlements...\n');
  
  try {
    await mkdir(DERIVED_DIR, { recursive: true });
    
    const { matched, unresolved, stats } = await buildCrosswalk();
    
    // Write crosswalk CSV
    const crosswalkHeader = 'sid_excel,mid,name_excel,sid_html,name_html,join_key,match_method,match_confidence\n';
    const crosswalkRows = matched.map(m => [
      escapeCSV(m.sid_excel),
      escapeCSV(m.mid),
      escapeCSV(m.name_excel),
      escapeCSV(m.sid_html),
      escapeCSV(m.name_html),
      escapeCSV(m.join_key),
      escapeCSV(m.match_method),
      escapeCSV(m.match_confidence)
    ].join(','));
    
    await writeFile(CROSSWALK_OUTPUT_PATH, crosswalkHeader + crosswalkRows.join('\n'), 'utf8');
    
    // Write unresolved CSV
    const unresolvedHeader = 'join_key,mid,excel_count,svg_count,example_excel_sids,example_svg_ids,excel_names,svg_names\n';
    const unresolvedRows = unresolved.map(u => [
      escapeCSV(u.join_key),
      escapeCSV(u.mid),
      String(u.excel_count),
      String(u.svg_count),
      escapeCSV(u.example_excel_sids.join('; ')),
      escapeCSV(u.example_svg_ids.join('; ')),
      escapeCSV(u.excel_names.join('; ')),
      escapeCSV(u.svg_names.join('; '))
    ].join(','));
    
    await writeFile(UNRESOLVED_OUTPUT_PATH, unresolvedHeader + unresolvedRows.join('\n'), 'utf8');
    
    console.log('\nResults:');
    console.log(`  Matched (1:1): ${stats.crosswalk_matched}`);
    console.log(`  Unresolved: ${stats.crosswalk_unresolved}`);
    console.log(`  Ambiguous (count != 1): ${stats.crosswalk_ambiguous}`);
    console.log(`\nOutput:`);
    console.log(`  Crosswalk: ${CROSSWALK_OUTPUT_PATH}`);
    console.log(`  Unresolved: ${UNRESOLVED_OUTPUT_PATH}`);
    console.log('✓ Crosswalk build complete');
  } catch (err) {
    console.error('Error building crosswalk:', err);
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
