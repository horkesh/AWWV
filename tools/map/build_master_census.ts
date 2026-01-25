/**
 * Master Census Builder: Create canonical master census dataset from authority inputs.
 * 
 * Inputs:
 *   - data/source/master_settlements.xlsx (settlement census data by municipality)
 *   - data/source/settlements_pack.zip (SVG data for settlements)
 * 
 * Outputs:
 *   - data/source/master_census_clean.csv
 *   - data/source/master_census_clean.json
 *   - data/source/master_municipalities.json
 *   - data/source/master_census_issues.json
 * 
 * Usage:
 *   tsx tools/map/build_master_census.ts [--dry-run]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Types
// ============================================================================

interface CensusRow {
  mid: string;
  municipality_name: string;
  sid: string;
  settlement_name: string;
  total_population: number | null;
  bosniaks: number | null;
  croats: number | null;
  serbs: number | null;
  others: number | null;
  [key: string]: unknown; // Additional census fields
  geometry_key: string;
  svg_source: string | null;
  has_svg: boolean;
  svg_path: string | null;
  is_urban_center: boolean;
  is_municipality_capital: boolean;
}

interface MunicipalityData {
  municipality_id: string;
  name: string;
  capital_sid: string;
  totals: {
    total_population: number;
    bosniaks: number;
    croats: number;
    serbs: number;
    others: number;
  };
  settlements: Array<{
    settlement_id: string;
    name: string;
    census: {
      total_population: number | null;
      bosniaks: number | null;
      croats: number | null;
      serbs: number | null;
      others: number | null;
      [key: string]: unknown;
    };
    settlement_type: string;
    is_urban_center: boolean;
    is_municipality_capital: boolean;
    svg_path: string | null;
    mapping_note: string | null;
  }>;
}

interface MasterMunicipalitiesOutput {
  version: string;
  source: {
    census: string;
    svg_pack: string;
  };
  municipalities: MunicipalityData[];
}

interface IssuesReport {
  skipped_aggregate_rows: Array<{
    sheet: string;
    row: number;
    reason: string;
    raw_cells_preview: string[];
  }>;
  missing_required_fields: Array<{
    sheet: string;
    missing_columns: string[];
  }>;
  generated_settlement_ids: Array<{
    mid: string;
    name: string;
    old_sid: string | null;
    new_sid: string;
  }>;
  duplicate_settlement_ids_fixed: Array<{
    sid: string;
    occurrences: Array<{ mid: string; name: string }>;
    resolution: string;
  }>;
  svg_unmatched_settlements: Array<{
    mid: string;
    sid: string;
    name: string;
    geometry_key: string;
  }>;
  svg_unmatched_svgs: Array<{
    svg_source: string;
    derived_key: string;
  }>;
  municipality_total_mismatches_vs_aggregate: Array<{
    mid: string;
    name: string;
    aggregate_row_totals: {
      total_population: number | null;
      bosniaks: number | null;
      croats: number | null;
      serbs: number | null;
      others: number | null;
    };
    computed_totals: {
      total_population: number;
      bosniaks: number;
      croats: number;
      serbs: number;
      others: number;
    };
    delta: {
      total_population: number;
      bosniaks: number;
      croats: number;
      serbs: number;
      others: number;
    };
  }>;
  missing_population_for_urban_flag: Array<{
    mid: string;
    sid: string;
    name: string;
  }>;
  capital_name_ambiguous: Array<{
    mid: string;
    name: string;
    matches: Array<{ sid: string; name: string; total_population: number | null }>;
    chosen_sid: string;
  }>;
  capital_fallback_largest_used: Array<{
    mid: string;
    name: string;
    chosen_sid: string;
    chosen_name: string;
    chosen_population: number | null;
  }>;
  capital_population_missing_all: Array<{
    mid: string;
    name: string;
    chosen_sid: string;
    chosen_name: string;
  }>;
}

interface GeometryIndexEntry {
  svg_file: string;
  svg_path_count: number;
  svg_d_concat: string;
}

interface GeometryIndex {
  by_sid: Map<string, GeometryIndexEntry>;
  by_mid_name: Map<string, GeometryIndexEntry>;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Normalize name: trim, collapse whitespace, lowercase, remove diacritics
 */
function normalizeName(s: string): string {
  return s
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * FNV-1a 32-bit hash function
 */
function fnv1a32(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash = hash >>> 0;
  }
  return hash;
}

/**
 * Check if a row is an aggregate row (contains "∑" character)
 */
function isAggregateRow(row: XLSX.CellObject[]): boolean {
  for (const cell of row) {
    if (cell && cell.v != null) {
      const cellStr = String(cell.v);
      if (cellStr.includes('∑')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get cell value as string, null if empty
 */
function getCellString(cell: XLSX.CellObject | undefined): string | null {
  if (!cell || cell.v == null) return null;
  return String(cell.v).trim() || null;
}

/**
 * Get cell value as number, null if not a number
 */
function getCellNumber(cell: XLSX.CellObject | undefined): number | null {
  if (!cell || cell.v == null) return null;
  const val = cell.v;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const num = parseFloat(val.trim());
    return isNaN(num) ? null : num;
  }
  return null;
}

// ============================================================================
// Excel Parsing
// ============================================================================

interface ParsedSheet {
  municipality_id: string;
  municipality_name: string;
  settlements: Array<{
    settlement_name: string;
    settlement_id: string | null;
    total_population: number | null;
    bosniaks: number | null;
    croats: number | null;
    serbs: number | null;
    others: number | null;
    [key: string]: unknown;
  }>;
  aggregate_row: {
    row: number;
    total_population: number | null;
    bosniaks: number | null;
    croats: number | null;
    serbs: number | null;
    others: number | null;
  } | null;
}

async function parseExcelFile(xlsxPath: string): Promise<{
  sheets: Map<string, ParsedSheet>;
  issues: IssuesReport;
}> {
  const buffer = await readFile(xlsxPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  const sheets = new Map<string, ParsedSheet>();
  const issues: IssuesReport = {
    skipped_aggregate_rows: [],
    missing_required_fields: [],
    generated_settlement_ids: [],
    duplicate_settlement_ids_fixed: [],
    svg_unmatched_settlements: [],
    svg_unmatched_svgs: [],
    municipality_total_mismatches_vs_aggregate: [],
    missing_population_for_urban_flag: [],
    capital_name_ambiguous: [],
    capital_fallback_largest_used: [],
    capital_population_missing_all: []
  };

  // Try to load municipality mapping from existing file
  let municipalityIdMap = new Map<string, string>();
  try {
    const munPath = resolve('data/source/master_municipalities.json');
    const existing = JSON.parse(await readFile(munPath, 'utf8')) as MasterMunicipalitiesOutput;
    if (existing.municipalities) {
      for (const muni of existing.municipalities) {
        municipalityIdMap.set(muni.name.toLowerCase().trim(), muni.municipality_id);
      }
    }
  } catch {
    // File doesn't exist or invalid, will derive IDs
  }

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    
    // Find header row - look for required columns
    // Try multiple patterns: English, Croatian/Bosnian/Serbian
    const namePatterns = ['settlement', 'name', 'naselje', 'naziv', 'ime'];
    const popPatterns = ['total', 'population', 'ukupno', 'stanovništvo', 'populacija', 'stanovnika'];
    
    let headerRow = -1;
    const headerMap = new Map<string, number>(); // column name -> column index
    
    // Check up to 20 rows for header
    for (let r = range.s.r; r <= Math.min(range.s.r + 20, range.e.r); r++) {
      let foundNameCol = false;
      let foundPopCol = false;
      const rowHeaderMap = new Map<string, number>();
      
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v != null) {
          const headerStr = String(cell.v).toLowerCase().trim();
          const normalized = headerStr.replace(/\s+/g, '_');
          rowHeaderMap.set(normalized, c);
          
          // Check if this looks like a name column
          if (namePatterns.some(p => headerStr.includes(p))) {
            foundNameCol = true;
          }
          // Check if this looks like a population column
          if (popPatterns.some(p => headerStr.includes(p))) {
            foundPopCol = true;
          }
        }
      }
      
      // If we found both name and population columns, this is likely the header row
      if (foundNameCol && foundPopCol) {
        headerRow = r;
        // Build full header map
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })];
          if (cell && cell.v != null) {
            const headerStr = String(cell.v).toLowerCase().trim().replace(/\s+/g, '_');
            headerMap.set(headerStr, c);
            // Also store original case version
            const origStr = String(cell.v).trim();
            if (origStr !== headerStr) {
              headerMap.set(origStr.toLowerCase(), c);
            }
          }
        }
        break;
      }
    }

    if (headerRow === -1) {
      // Print first 30 cells from first 5 rows for debugging
      const debugRows: string[] = [];
      for (let r = range.s.r; r <= Math.min(range.s.r + 5, range.e.r); r++) {
        const debugCells: string[] = [];
        for (let c = range.s.c; c <= Math.min(range.s.c + 30, range.e.c); c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })];
          debugCells.push(cell ? String(cell.v || '') : '');
        }
        debugRows.push(`Row ${r + 1}: ${debugCells.join(', ')}`);
      }
      throw new Error(
        `Could not detect header row in sheet "${sheetName}". ` +
        `Expected columns containing settlement/name and total/population. ` +
        `Checked first 5 rows:\n${debugRows.join('\n')}`
      );
    }

    // Check for required columns
    const hasSettlementName = Array.from(headerMap.keys()).some(k => 
      namePatterns.some(p => k.includes(p))
    );
    const hasTotalPopulation = Array.from(headerMap.keys()).some(k => 
      popPatterns.some(p => k.includes(p))
    );

    if (!hasSettlementName || !hasTotalPopulation) {
      issues.missing_required_fields.push({
        sheet: sheetName,
        missing_columns: [
          !hasSettlementName ? 'settlement name' : '',
          !hasTotalPopulation ? 'total population' : ''
        ].filter(Boolean)
      });
    }

    // Find municipality name (usually in first few rows or sheet name)
    let municipalityName = sheetName;
    // Try to find municipality name in first few rows (skip cells that look like codes or numbers)
    for (let r = range.s.r; r < headerRow; r++) {
      for (let c = range.s.c; c <= Math.min(range.s.c + 5, range.e.c); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v && typeof cell.v === 'string') {
          const val = cell.v.trim();
          // Skip if it looks like a code (starts with #, all digits, or very short)
          if (val.startsWith('#') || /^\d+$/.test(val) || val.length < 3) {
            continue;
          }
          // Skip common UI text like "Pretraži:" (Search:)
          if (val.includes('Pretraži') || val.includes('Search') || val.includes(':')) {
            continue;
          }
          // Use this as municipality name if it looks reasonable
          if (val.length > 2 && !val.includes('Popis') && !val.includes('**')) {
            municipalityName = val;
            break;
          }
        }
      }
      if (municipalityName !== sheetName) break;
    }

    // Derive municipality_id
    let municipalityId: string;
    const normalizedName = normalizeName(municipalityName);
    if (municipalityIdMap.has(normalizedName)) {
      municipalityId = municipalityIdMap.get(normalizedName)!;
    } else {
      // Derive from sheet name or municipality name
      const match = sheetName.match(/(\d+)/);
      if (match) {
        municipalityId = match[1];
      } else {
        // Use hash-based ID
        const hash = fnv1a32(sheetName);
        municipalityId = String(1000000 + (hash % 900000));
      }
      municipalityIdMap.set(normalizedName, municipalityId);
    }

    // Parse data rows
    const settlements: ParsedSheet['settlements'] = [];
    let aggregateRow: ParsedSheet['aggregate_row'] = null;

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const rowCells: XLSX.CellObject[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        rowCells.push(sheet[XLSX.utils.encode_cell({ r, c })]);
      }

      // Check if aggregate row
      if (isAggregateRow(rowCells)) {
        // Extract aggregate totals for validation
        const settlementNameCol = Array.from(headerMap.entries()).find(([k]) => 
          namePatterns.some(p => k.includes(p))
        )?.[1] ?? 0;
        
        const totalPopCol = Array.from(headerMap.entries()).find(([k]) => 
          popPatterns.some(p => k.includes(p))
        )?.[1];
        
        const bosniaksCol = Array.from(headerMap.entries()).find(([k]) => 
          k.includes('bosniak') || k.includes('bošnjak') || k.includes('bosnjak')
        )?.[1];
        
        const croatsCol = Array.from(headerMap.entries()).find(([k]) => 
          k.includes('croat') || k.includes('hrvat')
        )?.[1];
        
        const serbsCol = Array.from(headerMap.entries()).find(([k]) => 
          k.includes('serb') || k.includes('srbin')
        )?.[1];
        
        const othersCol = Array.from(headerMap.entries()).find(([k]) => 
          k.includes('other') || k.includes('ostal') || k.includes('ostalo')
        )?.[1];

        aggregateRow = {
          row: r + 1, // 1-indexed for reporting
          total_population: totalPopCol != null ? getCellNumber(rowCells[totalPopCol]) : null,
          bosniaks: bosniaksCol != null ? getCellNumber(rowCells[bosniaksCol]) : null,
          croats: croatsCol != null ? getCellNumber(rowCells[croatsCol]) : null,
          serbs: serbsCol != null ? getCellNumber(rowCells[serbsCol]) : null,
          others: othersCol != null ? getCellNumber(rowCells[othersCol]) : null
        };

        issues.skipped_aggregate_rows.push({
          sheet: sheetName,
          row: r + 1,
          reason: 'Contains ∑ symbol (aggregate row)',
          raw_cells_preview: rowCells.slice(0, 10).map(c => c ? String(c.v || '') : '').filter(Boolean)
        });
        continue;
      }

      // Extract settlement data
      // Find settlement name column (try multiple patterns)
      const settlementNameCol = Array.from(headerMap.entries()).find(([k]) => 
        namePatterns.some(p => k.includes(p))
      )?.[1] ?? 0;
      
      // Find settlement ID column
      const settlementIdCol = Array.from(headerMap.entries()).find(([k]) => 
        (k.includes('id') || k.includes('šifra') || k.includes('sifra')) && !k.includes('mun')
      )?.[1];
      
      // Find population columns
      const totalPopCol = Array.from(headerMap.entries()).find(([k]) => 
        popPatterns.some(p => k.includes(p))
      )?.[1];
      
      const bosniaksCol = Array.from(headerMap.entries()).find(([k]) => 
        k.includes('bosniak') || k.includes('bošnjak') || k.includes('bosnjak')
      )?.[1];
      
      const croatsCol = Array.from(headerMap.entries()).find(([k]) => 
        k.includes('croat') || k.includes('hrvat')
      )?.[1];
      
      const serbsCol = Array.from(headerMap.entries()).find(([k]) => 
        k.includes('serb') || k.includes('srbin')
      )?.[1];
      
      const othersCol = Array.from(headerMap.entries()).find(([k]) => 
        k.includes('other') || k.includes('ostal') || k.includes('ostalo')
      )?.[1];

      const settlementName = getCellString(rowCells[settlementNameCol]);
      if (!settlementName) continue; // Skip empty rows
      
      // Skip header-like rows (common header text patterns)
      const normalizedSettlementName = normalizeName(settlementName);
      const headerPatterns = [
        'naseljeno', 'mjesto', 'naseljeno_mjesto', 'naseljeno mjesto',
        'settlement', 'name', 'naziv', 'ime',
        'ukupno', 'total', 'population', 'populacija',
        'bošnjaci', 'bosniaks', 'hrvati', 'croats', 'srbi', 'serbs', 'ostali', 'others',
        '#', 'šifra', 'sifra', 'id'
      ];
      if (headerPatterns.some(p => normalizedSettlementName === normalizeName(p))) {
        continue; // Skip header rows
      }

      const settlement: ParsedSheet['settlements'][0] = {
        settlement_name: settlementName,
        settlement_id: settlementIdCol != null ? getCellString(rowCells[settlementIdCol]) : null,
        total_population: totalPopCol != null ? getCellNumber(rowCells[totalPopCol]) : null,
        bosniaks: bosniaksCol != null ? getCellNumber(rowCells[bosniaksCol]) : null,
        croats: croatsCol != null ? getCellNumber(rowCells[croatsCol]) : null,
        serbs: serbsCol != null ? getCellNumber(rowCells[serbsCol]) : null,
        others: othersCol != null ? getCellNumber(rowCells[othersCol]) : null
      };

      // Extract additional columns
      for (const [headerKey, colIdx] of headerMap.entries()) {
        if (!['settlement', 'name', 'id', 'total', 'population', 'bosniak', 'croat', 'serb', 'other'].some(k => headerKey.includes(k))) {
          const cell = rowCells[colIdx];
          if (cell && cell.v != null) {
            settlement[headerKey] = cell.v;
          }
        }
      }

      settlements.push(settlement);
    }

    sheets.set(sheetName, {
      municipality_id: municipalityId,
      municipality_name: municipalityName,
      settlements,
      aggregate_row: aggregateRow
    });
  }

  return { sheets, issues };
}

// ============================================================================
// SVG Pack Parsing
// ============================================================================

async function parseSvgPack(zipPath: string): Promise<GeometryIndex> {
  const zipBuffer = await readFile(zipPath);
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  
  const index: GeometryIndex = {
    by_sid: new Map(),
    by_mid_name: new Map()
  };

  for (const entry of entries) {
    if (!entry.entryName.endsWith('.svg')) continue;

    const content = entry.getData().toString('utf8');
    
    try {
      // Extract all <path d="..."> values using regex
      const pathRegex = /<path[^>]*\s+d\s*=\s*["']([^"']+)["'][^>]*>/gi;
      const paths: string[] = [];
      let match;
      
      while ((match = pathRegex.exec(content)) !== null) {
        if (match[1]) {
          paths.push(match[1]);
        }
      }
      
      const svgDConcat = paths.join(' | ');
      const svgPathCount = paths.length;

      // Try to determine settlement identifier from filename
      // Patterns: <sid>.svg, <name>.svg, <mid>_<name>.svg, etc.
      const filename = entry.entryName.replace(/\.svg$/i, '').replace(/^.*[\\/]/, '');
      
      // Try to extract SID from filename
      const sidMatch = filename.match(/^(\d+)$/);
      if (sidMatch) {
        index.by_sid.set(sidMatch[1], {
          svg_file: entry.entryName,
          svg_path_count: svgPathCount,
          svg_d_concat: svgDConcat
        });
      } else {
        // Try pattern: <mid>_<name> or <name>
        const midNameMatch = filename.match(/^(\d+)_(.+)$/);
        if (midNameMatch) {
          const mid = midNameMatch[1];
          const name = midNameMatch[2];
          const key = `${mid}:${normalizeName(name)}`;
          index.by_mid_name.set(key, {
            svg_file: entry.entryName,
            svg_path_count: svgPathCount,
            svg_d_concat: svgDConcat
          });
        } else {
          // Use normalized filename as key
          const key = normalizeName(filename);
          index.by_mid_name.set(key, {
            svg_file: entry.entryName,
            svg_path_count: svgPathCount,
            svg_d_concat: svgDConcat
          });
        }
      }
    } catch (err) {
      // Skip invalid SVG files
      continue;
    }
  }

  return index;
}

// ============================================================================
// Main Processing
// ============================================================================

async function buildMasterCensus(dryRun: boolean = false): Promise<void> {
  const xlsxPath = resolve('data/source/master_settlements.xlsx');
  const zipPath = resolve('data/source/settlements_pack.zip');
  
  const outputDir = resolve('data/source');
  await mkdir(outputDir, { recursive: true });

  process.stdout.write('Parsing Excel file...\n');
  const { sheets, issues: excelIssues } = await parseExcelFile(xlsxPath);
  process.stdout.write(`  Loaded ${sheets.size} municipality sheets\n`);

  process.stdout.write('Parsing SVG pack...\n');
  const geometryIndex = await parseSvgPack(zipPath);
  process.stdout.write(`  Indexed ${geometryIndex.by_sid.size} SVGs by SID, ${geometryIndex.by_mid_name.size} SVGs by name\n`);

  // Process all settlements
  const allSettlements: CensusRow[] = [];
  const allSettlementIds = new Set<string>();
  const municipalityMap = new Map<string, MunicipalityData>();

  // First pass: collect all settlements and generate IDs
  for (const [sheetName, sheetData] of sheets.entries()) {
    const muniData: MunicipalityData = {
      municipality_id: sheetData.municipality_id,
      name: sheetData.municipality_name,
      capital_sid: '', // Will be set during capital determination
      totals: {
        total_population: 0,
        bosniaks: 0,
        croats: 0,
        serbs: 0,
        others: 0
      },
      settlements: []
    };

    for (const settlement of sheetData.settlements) {
      // Generate or use settlement ID
      let sid: string;
      if (settlement.settlement_id && !allSettlementIds.has(settlement.settlement_id)) {
        sid = settlement.settlement_id;
      } else {
        // Generate deterministic ID
        const normalizedName = normalizeName(settlement.settlement_name);
        const hashInput = `${sheetData.municipality_id}:${normalizedName}`;
        const hash = fnv1a32(hashInput);
        let candidate = 900000000 + (hash % 90000000);
        let candidateStr = String(candidate);
        
        while (allSettlementIds.has(candidateStr)) {
          candidate++;
          candidateStr = String(candidate);
          if (candidate > 999999999) {
            throw new Error(`Cannot generate unique ID for ${sheetData.municipality_id}:${normalizedName}`);
          }
        }
        
        sid = candidateStr;
        
        if (!settlement.settlement_id) {
          excelIssues.generated_settlement_ids.push({
            mid: sheetData.municipality_id,
            name: settlement.settlement_name,
            old_sid: null,
            new_sid: sid
          });
        } else {
          excelIssues.duplicate_settlement_ids_fixed.push({
            sid: settlement.settlement_id,
            occurrences: [{ mid: sheetData.municipality_id, name: settlement.settlement_name }],
            resolution: `Remapped to ${sid}`
          });
        }
      }
      
      allSettlementIds.add(sid);

      // Find geometry
      let geometryKey: string;
      let svgEntry: GeometryIndexEntry | undefined;
      
      // Try by SID first
      svgEntry = geometryIndex.by_sid.get(sid);
      if (svgEntry) {
        geometryKey = sid;
      } else {
        // Try by mid:name
        const normalizedName = normalizeName(settlement.settlement_name);
        const midNameKey = `${sheetData.municipality_id}:${normalizedName}`;
        svgEntry = geometryIndex.by_mid_name.get(midNameKey);
        if (svgEntry) {
          geometryKey = midNameKey;
        } else {
          // Try by normalized name only
          svgEntry = geometryIndex.by_mid_name.get(normalizedName);
          if (svgEntry) {
            geometryKey = normalizedName;
          } else {
            geometryKey = `${sheetData.municipality_id}:${normalizedName}`;
            excelIssues.svg_unmatched_settlements.push({
              mid: sheetData.municipality_id,
              sid,
              name: settlement.settlement_name,
              geometry_key: geometryKey
            });
          }
        }
      }

      // Compute is_urban_center
      const isUrbanCenter = settlement.total_population != null && settlement.total_population >= 3000;
      if (settlement.total_population == null) {
        excelIssues.missing_population_for_urban_flag.push({
          mid: sheetData.municipality_id,
          sid,
          name: settlement.settlement_name
        });
      }

      const censusRow: CensusRow = {
        mid: sheetData.municipality_id,
        municipality_name: sheetData.municipality_name,
        sid,
        settlement_name: settlement.settlement_name,
        total_population: settlement.total_population,
        bosniaks: settlement.bosniaks,
        croats: settlement.croats,
        serbs: settlement.serbs,
        others: settlement.others,
        geometry_key: geometryKey,
        svg_source: svgEntry?.svg_file ?? null,
        has_svg: !!svgEntry,
        svg_path: svgEntry?.svg_d_concat ?? null,
        is_urban_center: isUrbanCenter,
        is_municipality_capital: false // Will be set later
      };

      // Add additional fields
      for (const [key, value] of Object.entries(settlement)) {
        if (!['settlement_name', 'settlement_id', 'total_population', 'bosniaks', 'croats', 'serbs', 'others'].includes(key)) {
          censusRow[key] = value;
        }
      }

      allSettlements.push(censusRow);

      // Add to municipality
      muniData.settlements.push({
        settlement_id: sid,
        name: settlement.settlement_name,
        census: {
          total_population: settlement.total_population,
          bosniaks: settlement.bosniaks,
          croats: settlement.croats,
          serbs: settlement.serbs,
          others: settlement.others,
          ...Object.fromEntries(
            Object.entries(settlement).filter(([k]) => 
              !['settlement_name', 'settlement_id', 'total_population', 'bosniaks', 'croats', 'serbs', 'others'].includes(k)
            )
          )
        },
        settlement_type: 'unknown',
        is_urban_center: isUrbanCenter,
        is_municipality_capital: false, // Will be set later
        svg_path: svgEntry?.svg_d_concat ?? null,
        mapping_note: null
      });

      // Accumulate totals
      if (settlement.total_population != null) {
        muniData.totals.total_population += settlement.total_population;
      }
      if (settlement.bosniaks != null) {
        muniData.totals.bosniaks += settlement.bosniaks;
      }
      if (settlement.croats != null) {
        muniData.totals.croats += settlement.croats;
      }
      if (settlement.serbs != null) {
        muniData.totals.serbs += settlement.serbs;
      }
      if (settlement.others != null) {
        muniData.totals.others += settlement.others;
      }
    }

    // Compare computed totals to aggregate row
    if (sheetData.aggregate_row) {
      const agg = sheetData.aggregate_row;
      const computed = muniData.totals;
      const delta = {
        total_population: (agg.total_population ?? 0) - computed.total_population,
        bosniaks: (agg.bosniaks ?? 0) - computed.bosniaks,
        croats: (agg.croats ?? 0) - computed.croats,
        serbs: (agg.serbs ?? 0) - computed.serbs,
        others: (agg.others ?? 0) - computed.others
      };
      
      const hasMismatch = Object.values(delta).some(v => Math.abs(v) > 0.01);
      if (hasMismatch) {
        excelIssues.municipality_total_mismatches_vs_aggregate.push({
          mid: sheetData.municipality_id,
          name: sheetData.municipality_name,
          aggregate_row_totals: agg,
          computed_totals: computed,
          delta
        });
      }
    }

    // Fail fast if municipality has no settlements
    if (muniData.settlements.length === 0) {
      throw new Error(`Municipality ${sheetData.municipality_id} (${sheetData.municipality_name}) has 0 settlements after skipping aggregate rows`);
    }

    municipalityMap.set(sheetData.municipality_id, muniData);
  }

  // Determine municipality capitals
  const municipalitySettlementMap = new Map<string, CensusRow[]>(); // mid -> settlements
  for (const row of allSettlements) {
    if (!municipalitySettlementMap.has(row.mid)) {
      municipalitySettlementMap.set(row.mid, []);
    }
    municipalitySettlementMap.get(row.mid)!.push(row);
  }

  // Capital assignment statistics
  let capitalsExactName = 0;
  let capitalsLargestFallback = 0;
  let capitalsAllNullPopulation = 0;

  // Debug: verify municipality map size
  if (municipalityMap.size !== sheets.size) {
    throw new Error(`Municipality map size mismatch: ${municipalityMap.size} vs ${sheets.size} sheets`);
  }

  for (const [mid, muniData] of municipalityMap.entries()) {
    const settlements = municipalitySettlementMap.get(mid) || [];
    
    // Safety check: should have already been validated, but double-check
    if (settlements.length === 0) {
      throw new Error(`Municipality ${mid} (${muniData.name}) has 0 settlements in capital determination`);
    }
    
    const muniName = muniData.name;
    const normalizedMuniName = normalizeName(muniName);

    // Rule A: Exact-name capital rule
    const nameMatches = settlements.filter(s => 
      normalizeName(s.settlement_name) === normalizedMuniName
    );

    let capitalSid: string;
    let capitalSettlement: CensusRow | undefined;

    if (nameMatches.length === 1) {
      // Exactly one match - use it
      capitalSettlement = nameMatches[0];
      capitalSid = capitalSettlement.sid;
      capitalsExactName++;
    } else if (nameMatches.length > 1) {
      // Multiple matches - choose highest population, then lowest sid
      nameMatches.sort((a, b) => {
        const popA = a.total_population ?? -1;
        const popB = b.total_population ?? -1;
        if (popA !== popB) return popB - popA; // Descending
        return a.sid.localeCompare(b.sid); // Ascending
      });
      capitalSettlement = nameMatches[0];
      capitalSid = capitalSettlement.sid;
      capitalsExactName++;
      
      excelIssues.capital_name_ambiguous.push({
        mid,
        name: muniName,
        matches: nameMatches.map(s => ({
          sid: s.sid,
          name: s.settlement_name,
          total_population: s.total_population
        })),
        chosen_sid: capitalSid
      });
    } else {
      // Rule B: Largest-settlement fallback
      const sorted = [...settlements].sort((a, b) => {
        const popA = a.total_population ?? -1;
        const popB = b.total_population ?? -1;
        if (popA !== popB) return popB - popA; // Descending
        return a.sid.localeCompare(b.sid); // Ascending
      });
      
      capitalSettlement = sorted[0];
      capitalSid = capitalSettlement.sid;
      
      // Check if all have null population
      const allNull = settlements.every(s => s.total_population == null);
      if (allNull) {
        capitalsAllNullPopulation++;
        excelIssues.capital_population_missing_all.push({
          mid,
          name: muniName,
          chosen_sid: capitalSid,
          chosen_name: capitalSettlement.settlement_name
        });
      } else {
        capitalsLargestFallback++;
        excelIssues.capital_fallback_largest_used.push({
          mid,
          name: muniName,
          chosen_sid: capitalSid,
          chosen_name: capitalSettlement.settlement_name,
          chosen_population: capitalSettlement.total_population
        });
      }
    }

    // Mark capital in all outputs
    capitalSettlement.is_municipality_capital = true;
    muniData.capital_sid = capitalSid;
    
    // Mark capital in municipality settlements array
    const muniSettlement = muniData.settlements.find(s => s.settlement_id === capitalSid);
    if (muniSettlement) {
      muniSettlement.is_municipality_capital = true;
    }
  }

  // Validate: exactly one capital per municipality
  const totalCapitals = Array.from(municipalityMap.values()).filter(m => m.capital_sid && m.capital_sid !== '').length;
  if (totalCapitals !== municipalityMap.size) {
    const missing = Array.from(municipalityMap.entries())
      .filter(([mid, m]) => !m.capital_sid || m.capital_sid === '')
      .map(([mid, m]) => `${mid}:${m.name}`)
      .slice(0, 10);
    throw new Error(
      `Capital assignment failed: ${totalCapitals} capitals assigned for ${municipalityMap.size} municipalities. ` +
      `Missing capitals (first 10): ${missing.join(', ')}`
    );
  }

  // Find unmatched SVGs
  const matchedSvgFiles = new Set<string>();
  for (const row of allSettlements) {
    if (row.svg_source) {
      matchedSvgFiles.add(row.svg_source);
    }
  }
  
  for (const [key, entry] of geometryIndex.by_sid.entries()) {
    if (!matchedSvgFiles.has(entry.svg_file)) {
      excelIssues.svg_unmatched_svgs.push({
        svg_source: entry.svg_file,
        derived_key: `sid:${key}`
      });
    }
  }
  
  for (const [key, entry] of geometryIndex.by_mid_name.entries()) {
    if (!matchedSvgFiles.has(entry.svg_file)) {
      excelIssues.svg_unmatched_svgs.push({
        svg_source: entry.svg_file,
        derived_key: `mid_name:${key}`
      });
    }
  }

  // Sort settlements
  allSettlements.sort((a, b) => {
    if (a.mid !== b.mid) return a.mid.localeCompare(b.mid);
    return a.sid.localeCompare(b.sid);
  });

  // ============================================================================
  // Invariant Checks (Fail Fast)
  // ============================================================================

  // Check 1: No duplicate settlement_ids
  const settlementIdCounts = new Map<string, number>();
  for (const row of allSettlements) {
    settlementIdCounts.set(row.sid, (settlementIdCounts.get(row.sid) || 0) + 1);
  }
  const duplicateSids = Array.from(settlementIdCounts.entries())
    .filter(([_, count]) => count > 1)
    .map(([sid]) => sid);
  if (duplicateSids.length > 0) {
    throw new Error(
      `INVARIANT VIOLATION: Duplicate settlement_id values found: ${duplicateSids.slice(0, 10).join(', ')}${duplicateSids.length > 10 ? ` (and ${duplicateSids.length - 10} more)` : ''}`
    );
  }

  // Check 2: No duplicate municipality_ids
  const municipalityIdSet = new Set<string>();
  for (const [mid] of municipalityMap.entries()) {
    if (municipalityIdSet.has(mid)) {
      throw new Error(`INVARIANT VIOLATION: Duplicate municipality_id found: ${mid}`);
    }
    municipalityIdSet.add(mid);
  }

  // Check 3: Each municipality has >= 1 settlement
  for (const [mid, muniData] of municipalityMap.entries()) {
    if (muniData.settlements.length === 0) {
      throw new Error(`INVARIANT VIOLATION: Municipality ${mid} (${muniData.name}) has 0 settlements`);
    }
  }

  // Check 4: Exactly one capital per municipality
  for (const [mid, muniData] of municipalityMap.entries()) {
    if (!muniData.capital_sid || muniData.capital_sid === '') {
      throw new Error(`INVARIANT VIOLATION: Municipality ${mid} (${muniData.name}) missing capital`);
    }
    // Check for multiple capitals (shouldn't happen, but verify)
    const capitalCount = muniData.settlements.filter(s => s.is_municipality_capital).length;
    if (capitalCount !== 1) {
      throw new Error(`INVARIANT VIOLATION: Municipality ${mid} (${muniData.name}) has ${capitalCount} capitals (expected 1)`);
    }
  }

  // Check 5: capital_sid exists and refers to a settlement in that municipality
  for (const [mid, muniData] of municipalityMap.entries()) {
    const capitalSettlement = muniData.settlements.find(s => s.settlement_id === muniData.capital_sid);
    if (!capitalSettlement) {
      throw new Error(
        `INVARIANT VIOLATION: Municipality ${mid} (${muniData.name}) capital_sid ${muniData.capital_sid} does not exist in its settlements`
      );
    }
    // Also check in allSettlements
    const capitalInAll = allSettlements.find(s => s.mid === mid && s.sid === muniData.capital_sid);
    if (!capitalInAll) {
      throw new Error(
        `INVARIANT VIOLATION: Municipality ${mid} (${muniData.name}) capital_sid ${muniData.capital_sid} not found in allSettlements`
      );
    }
    // Verify capital is in the same municipality
    if (capitalInAll.mid !== mid) {
      throw new Error(
        `INVARIANT VIOLATION: Municipality ${mid} capital_sid ${muniData.capital_sid} points to settlement in different municipality ${capitalInAll.mid}`
      );
    }
  }

  // Check 6: is_urban_center implies total_population >= 3000
  for (const row of allSettlements) {
    if (row.is_urban_center && (row.total_population == null || row.total_population < 3000)) {
      throw new Error(
        `INVARIANT VIOLATION: Settlement ${row.sid} (${row.settlement_name}) marked is_urban_center but total_population is ${row.total_population} (< 3000)`
      );
    }
  }

  // Check 7: No aggregate rows ingested (detect by "∑" in settlement name or any field)
  for (const row of allSettlements) {
    // Check settlement name
    if (row.settlement_name && String(row.settlement_name).includes('∑')) {
      throw new Error(
        `INVARIANT VIOLATION: Aggregate row detected in settlements: ${row.sid} (${row.settlement_name}) contains "∑"`
      );
    }
    // Check all string fields
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'string' && value.includes('∑')) {
        throw new Error(
          `INVARIANT VIOLATION: Aggregate row detected in settlements: ${row.sid} field ${key} contains "∑": ${value}`
        );
      }
    }
  }

  // ============================================================================
  // Audit Report Generation
  // ============================================================================

  // Calculate statistics for audit report
  const urbanCount = allSettlements.filter(r => r.is_urban_center).length;
  const svgMatched = allSettlements.filter(r => r.has_svg).length;
  const svgMissing = allSettlements.filter(r => !r.has_svg).length;

  async function generateAuditReport(): Promise<string> {
    const lines: string[] = [];
    
    // A) Header
    lines.push('=== MASTER CENSUS AUDIT REPORT ===');
    lines.push('');
    lines.push('A) SUMMARY STATISTICS');
    lines.push('─'.repeat(50));
    lines.push(`Municipalities parsed: ${sheets.size}`);
    lines.push(`Settlements parsed: ${allSettlements.length}`);
    lines.push(`Aggregate rows skipped: ${excelIssues.skipped_aggregate_rows.length}`);
    
    const nullPopCount = allSettlements.filter(r => r.total_population == null).length;
    lines.push(`Settlements with total_population null: ${nullPopCount}`);
    
    lines.push(`Settlements with svg matched: ${svgMatched}`);
    lines.push(`Settlements missing svg: ${svgMissing}`);
    lines.push(`Settlements marked urban (>=3000): ${urbanCount}`);
    
    const totalCapitals = capitalsExactName + capitalsLargestFallback + capitalsAllNullPopulation;
    lines.push(`Capitals assigned: ${totalCapitals}`);
    lines.push(`  - exact-name: ${capitalsExactName}`);
    lines.push(`  - largest-fallback: ${capitalsLargestFallback}`);
    lines.push(`  - all-null: ${capitalsAllNullPopulation}`);
    lines.push('');

    // B) Top lists (limit 30 each, deterministic sort)
    lines.push('B) TOP LISTS');
    lines.push('─'.repeat(50));
    
    // Municipalities with highest total population
    const municipalitiesByPop = Array.from(municipalityMap.values())
      .sort((a, b) => {
        if (b.totals.total_population !== a.totals.total_population) {
          return b.totals.total_population - a.totals.total_population;
        }
        return a.municipality_id.localeCompare(b.municipality_id);
      })
      .slice(0, 30);
    lines.push('Top 30 Municipalities by Total Population:');
    for (const muni of municipalitiesByPop) {
      lines.push(`  ${muni.municipality_id.padEnd(10)} ${muni.name.padEnd(40)} ${muni.totals.total_population.toLocaleString()}`);
    }
    lines.push('');

    // Municipalities with most settlements
    const municipalitiesBySettlementCount = Array.from(municipalityMap.values())
      .sort((a, b) => {
        if (b.settlements.length !== a.settlements.length) {
          return b.settlements.length - a.settlements.length;
        }
        return a.municipality_id.localeCompare(b.municipality_id);
      })
      .slice(0, 30);
    lines.push('Top 30 Municipalities by Settlement Count:');
    for (const muni of municipalitiesBySettlementCount) {
      lines.push(`  ${muni.municipality_id.padEnd(10)} ${muni.name.padEnd(40)} ${muni.settlements.length} settlements`);
    }
    lines.push('');

    // Largest settlements in the country
    const largestSettlements = [...allSettlements]
      .filter(s => s.total_population != null)
      .sort((a, b) => {
        const popA = a.total_population ?? 0;
        const popB = b.total_population ?? 0;
        if (popB !== popA) {
          return popB - popA;
        }
        if (a.sid !== b.sid) {
          return a.sid.localeCompare(b.sid);
        }
        return a.mid.localeCompare(b.mid);
      })
      .slice(0, 30);
    lines.push('Top 30 Largest Settlements (by total_population):');
    for (const s of largestSettlements) {
      lines.push(`  ${s.sid.padEnd(10)} ${s.settlement_name.padEnd(40)} ${(s.total_population ?? 0).toLocaleString()} (mid: ${s.mid})`);
    }
    lines.push('');

    // Urban settlements
    const urbanSettlements = [...allSettlements]
      .filter(s => s.is_urban_center && s.total_population != null)
      .sort((a, b) => {
        const popA = a.total_population ?? 0;
        const popB = b.total_population ?? 0;
        if (popB !== popA) {
          return popB - popA;
        }
        if (a.sid !== b.sid) {
          return a.sid.localeCompare(b.sid);
        }
        return a.mid.localeCompare(b.mid);
      })
      .slice(0, 30);
    lines.push('Top 30 Urban Settlements (by total_population):');
    for (const s of urbanSettlements) {
      lines.push(`  ${s.sid.padEnd(10)} ${s.settlement_name.padEnd(40)} ${(s.total_population ?? 0).toLocaleString()} (mid: ${s.mid})`);
    }
    lines.push('');

    // Municipalities where capital was chosen by fallback
    const fallbackCapitals = excelIssues.capital_fallback_largest_used
      .concat(excelIssues.capital_population_missing_all.map(c => ({
        mid: c.mid,
        name: c.name,
        chosen_sid: c.chosen_sid,
        chosen_name: c.chosen_name,
        chosen_population: null as number | null
      })))
      .sort((a, b) => {
        if (a.mid !== b.mid) {
          return a.mid.localeCompare(b.mid);
        }
        return a.chosen_sid.localeCompare(b.chosen_sid);
      })
      .slice(0, 30);
    lines.push('Top 30 Municipalities with Fallback Capital Selection:');
    for (const c of fallbackCapitals) {
      const popStr = c.chosen_population != null ? c.chosen_population.toLocaleString() : 'null';
      lines.push(`  ${c.mid.padEnd(10)} ${c.name.padEnd(40)} capital: ${c.chosen_sid} (${c.chosen_name}, pop: ${popStr})`);
    }
    lines.push('');

    // C) Integrity checks summary
    lines.push('C) INTEGRITY CHECKS');
    lines.push('─'.repeat(50));
    
    // Check 1: No aggregate rows ingested
    const hasAggregateRows = allSettlements.some(r => 
      (r.settlement_name && String(r.settlement_name).includes('∑')) ||
      Object.values(r).some(v => typeof v === 'string' && v.includes('∑'))
    );
    lines.push(hasAggregateRows ? 'FAIL: Aggregate "∑" rows ingested as settlements' : 'PASS: No aggregate "∑" rows ingested as settlements');
    
    // Check 2: settlement_id unique globally
    lines.push(duplicateSids.length === 0 ? 'PASS: settlement_id unique globally' : `FAIL: settlement_id duplicates found: ${duplicateSids.length}`);
    
    // Check 3: municipality_id unique globally
    const municipalityIds = Array.from(municipalityMap.keys());
    const uniqueMunicipalityIds = new Set(municipalityIds);
    const hasDuplicateMunicipalityIds = municipalityIds.length !== uniqueMunicipalityIds.size;
    lines.push(!hasDuplicateMunicipalityIds ? 'PASS: municipality_id unique globally' : 'FAIL: municipality_id duplicates found');
    
    // Check 4: Each municipality has >= 1 settlement
    const municipalitiesWithNoSettlements = Array.from(municipalityMap.values())
      .filter(m => m.settlements.length === 0);
    lines.push(municipalitiesWithNoSettlements.length === 0 
      ? 'PASS: Each municipality has >= 1 settlement' 
      : `FAIL: ${municipalitiesWithNoSettlements.length} municipality(ies) have 0 settlements`);
    
    // Check 5: Exactly one capital per municipality
    const municipalitiesWithoutCapital = Array.from(municipalityMap.values())
      .filter(m => !m.capital_sid || m.capital_sid === '');
    const municipalitiesWithMultipleCapitals = Array.from(municipalityMap.values())
      .filter(m => m.settlements.filter(s => s.is_municipality_capital).length !== 1);
    lines.push(municipalitiesWithoutCapital.length === 0 && municipalitiesWithMultipleCapitals.length === 0
      ? 'PASS: Exactly one capital per municipality'
      : `FAIL: ${municipalitiesWithoutCapital.length} missing capitals, ${municipalitiesWithMultipleCapitals.length} with multiple capitals`);
    
    // Check 6: capital_sid exists and refers to a settlement in that municipality
    let capitalSidIssues = 0;
    for (const [mid, muniData] of municipalityMap.entries()) {
      const capitalSettlement = muniData.settlements.find(s => s.settlement_id === muniData.capital_sid);
      const capitalInAll = allSettlements.find(s => s.mid === mid && s.sid === muniData.capital_sid);
      if (!capitalSettlement || !capitalInAll || capitalInAll.mid !== mid) {
        capitalSidIssues++;
      }
    }
    lines.push(capitalSidIssues === 0
      ? 'PASS: capital_sid exists and refers to a settlement in that municipality'
      : `FAIL: ${capitalSidIssues} capital_sid reference issue(s)`);
    
    // Check 7: is_urban_center implies total_population >= 3000
    const invalidUrbanCenters = allSettlements.filter(r => 
      r.is_urban_center && (r.total_population == null || r.total_population < 3000)
    );
    lines.push(invalidUrbanCenters.length === 0
      ? 'PASS: is_urban_center implies total_population >= 3000'
      : `FAIL: ${invalidUrbanCenters.length} settlement(s) marked is_urban_center with total_population < 3000`);
    
    // Check 8: Computed totals equal sum of settlements (always true by construction, but verify)
    let totalMismatchCount = 0;
    let maxDelta = 0;
    for (const [mid, muniData] of municipalityMap.entries()) {
      // Recompute totals from settlements
      const recomputed = {
        total_population: 0,
        bosniaks: 0,
        croats: 0,
        serbs: 0,
        others: 0
      };
      for (const s of muniData.settlements) {
        if (s.census.total_population != null) recomputed.total_population += s.census.total_population;
        if (s.census.bosniaks != null) recomputed.bosniaks += s.census.bosniaks;
        if (s.census.croats != null) recomputed.croats += s.census.croats;
        if (s.census.serbs != null) recomputed.serbs += s.census.serbs;
        if (s.census.others != null) recomputed.others += s.census.others;
      }
      const delta = Math.abs(recomputed.total_population - muniData.totals.total_population);
      if (delta > 0.01) {
        totalMismatchCount++;
        maxDelta = Math.max(maxDelta, delta);
      }
    }
    lines.push(totalMismatchCount === 0
      ? 'PASS: Computed totals equal sum of settlements'
      : `FAIL: ${totalMismatchCount} municipality(ies) with total mismatch (max delta: ${maxDelta.toFixed(2)})`);
    
    // Check 9: Aggregate row totals vs computed (report only, do not fail)
    const aggregateMismatchCount = excelIssues.municipality_total_mismatches_vs_aggregate.length;
    if (aggregateMismatchCount > 0) {
      const maxAggregateDelta = Math.max(
        ...excelIssues.municipality_total_mismatches_vs_aggregate.map(m => 
          Math.max(
            Math.abs(m.delta.total_population),
            Math.abs(m.delta.bosniaks),
            Math.abs(m.delta.croats),
            Math.abs(m.delta.serbs),
            Math.abs(m.delta.others)
          )
        )
      );
      lines.push(`INFO: ${aggregateMismatchCount} municipality(ies) with aggregate row total mismatch (max delta: ${maxAggregateDelta.toFixed(2)})`);
    } else {
      lines.push('INFO: All aggregate row totals match computed totals (or no aggregate rows present)');
    }
    
    lines.push('');
    lines.push('=== END OF AUDIT REPORT ===');
    
    return lines.join('\n');
  }

  // Generate and write audit report
  const auditReport = await generateAuditReport();

  // Generate outputs
  if (!dryRun) {
    // CSV
    const csvLines: string[] = [];
    const headers = ['mid', 'municipality_name', 'sid', 'settlement_name', 'total_population', 'bosniaks', 'croats', 'serbs', 'others', 'geometry_key', 'svg_source', 'has_svg', 'is_urban_center', 'is_municipality_capital'];
    csvLines.push(headers.join(','));
    
    for (const row of allSettlements) {
      const values = headers.map(h => {
        const val = row[h];
        if (val == null) return '';
        if (typeof val === 'string' && val.includes(',')) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return String(val);
      });
      csvLines.push(values.join(','));
    }
    
    await writeFile(
      resolve(outputDir, 'master_census_clean.csv'),
      csvLines.join('\n'),
      'utf8'
    );

    // JSON
    await writeFile(
      resolve(outputDir, 'master_census_clean.json'),
      JSON.stringify(allSettlements, null, 2),
      'utf8'
    );

    // Municipalities JSON
    const municipalitiesOutput: MasterMunicipalitiesOutput = {
      version: 'master_municipalities_v1',
      source: {
        census: 'master_settlements.xlsx',
        svg_pack: 'settlements_pack.zip'
      },
      municipalities: Array.from(municipalityMap.values()).sort((a, b) => 
        a.municipality_id.localeCompare(b.municipality_id)
      )
    };
    
    await writeFile(
      resolve(outputDir, 'master_municipalities.json'),
      JSON.stringify(municipalitiesOutput, null, 2),
      'utf8'
    );

    // Issues JSON
    await writeFile(
      resolve(outputDir, 'master_census_issues.json'),
      JSON.stringify(excelIssues, null, 2),
      'utf8'
    );

    // Audit report
    await writeFile(
      resolve(outputDir, 'master_census_audit.txt'),
      auditReport,
      'utf8'
    );
  }

  // Print report
  process.stdout.write('\n=== Build Report ===\n');
  process.stdout.write(`Municipalities parsed: ${sheets.size}\n`);
  process.stdout.write(`Settlements parsed: ${allSettlements.length}\n`);
  process.stdout.write(`Aggregate rows skipped: ${excelIssues.skipped_aggregate_rows.length}\n`);
  process.stdout.write(`Settlements marked urban (>=3000): ${urbanCount}\n`);
  process.stdout.write(`Capitals assigned:\n`);
  process.stdout.write(`  - Exact-name rule: ${capitalsExactName}\n`);
  process.stdout.write(`  - Largest-settlement fallback: ${capitalsLargestFallback}\n`);
  process.stdout.write(`  - All-null population (lowest sid): ${capitalsAllNullPopulation}\n`);
  process.stdout.write(`Settlements with SVG matched: ${svgMatched}\n`);
  process.stdout.write(`Settlements without SVG: ${svgMissing}\n`);
  process.stdout.write(`Municipality total mismatches vs ∑ row: ${excelIssues.municipality_total_mismatches_vs_aggregate.length}\n`);
  
  if (excelIssues.generated_settlement_ids.length > 0) {
    process.stdout.write(`\nGenerated ${excelIssues.generated_settlement_ids.length} settlement IDs\n`);
  }
  if (excelIssues.duplicate_settlement_ids_fixed.length > 0) {
    process.stdout.write(`Fixed ${excelIssues.duplicate_settlement_ids_fixed.length} duplicate settlement IDs\n`);
  }
  if (excelIssues.svg_unmatched_settlements.length > 0) {
    process.stdout.write(`Unmatched settlements: ${excelIssues.svg_unmatched_settlements.length}\n`);
  }
  if (excelIssues.svg_unmatched_svgs.length > 0) {
    process.stdout.write(`Unmatched SVG files: ${excelIssues.svg_unmatched_svgs.length}\n`);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  // Load mistake guard
  loadMistakes();
  assertNoRepeat('Master census cleaning and capital/urban derivation');
  loadLedger();
  assertLedgerFresh('Master census cleaning and capital/urban derivation');
  
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  
  if (dryRun) {
    process.stdout.write('Running in dry-run mode (no files will be written)\n\n');
  }

  try {
    await buildMasterCensus(dryRun);
    process.stdout.write('\n✓ Build complete!\n');
  } catch (err) {
    process.stderr.write(`\n✗ Build failed: ${err instanceof Error ? err.message : String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
    process.exit(1);
  }
}

main();
