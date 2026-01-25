/**
 * Read Excel Meta: Extract settlement metadata from Excel with ∑ filtering
 * 
 * Reads master_settlements.xlsx and produces settlements_meta.csv
 * with settlement-level data, excluding any rows containing "∑".
 * 
 * Outputs:
 *   - data/derived/settlements_meta.csv
 * 
 * Usage:
 *   tsx tools/map/read_excel_meta.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");
loadLedger();
assertLedgerFresh("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");

// ============================================================================
// Types
// ============================================================================

interface SettlementMeta {
  sid: string;
  name: string;
  mid: string;
  municipality_name: string;
  lat: number | null;
  lon: number | null;
  source_row_id: string;
}

// ============================================================================
// Constants
// ============================================================================

const EXCEL_PATH = resolve('data/source/master_settlements.xlsx');
const OUTPUT_PATH = resolve('data/derived/settlements_meta.csv');
const DERIVED_DIR = resolve('data/derived');

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
 * Check if a row is an aggregate row (contains "∑" symbol)
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

/**
 * Escape CSV field (add quotes if needed)
 */
function escapeCSV(field: string): string {
  if (field.includes(',') || field.includes('"') || field.includes('\n')) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

// ============================================================================
// Excel Parsing
// ============================================================================

async function parseExcelFile(xlsxPath: string): Promise<{
  settlements: SettlementMeta[];
  aggregateRowsFiltered: number;
}> {
  const buffer = await readFile(xlsxPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  
  const settlements: SettlementMeta[] = [];
  let aggregateRowsFiltered = 0;
  
  // Try to load municipality mapping from existing file
  let municipalityIdMap = new Map<string, string>();
  try {
    const munPath = resolve('data/source/master_municipalities.json');
    const existing = JSON.parse(await readFile(munPath, 'utf8')) as { municipalities?: Array<{ municipality_id: string; name: string }> };
    if (existing.municipalities) {
      for (const muni of existing.municipalities) {
        municipalityIdMap.set(normalizeName(muni.name), muni.municipality_id);
      }
    }
  } catch {
    // File doesn't exist or invalid, will derive IDs
  }
  
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    
    const range = XLSX.utils.decode_range(sheet['!ref']);
    
    // Find header row
    const namePatterns = ['settlement', 'name', 'naselje', 'naziv', 'ime'];
    const popPatterns = ['total', 'population', 'ukupno', 'stanovništvo', 'populacija', 'stanovnika'];
    
    let headerRow = -1;
    const headerMap = new Map<string, number>();
    
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
          
          if (namePatterns.some(p => headerStr.includes(p))) {
            foundNameCol = true;
          }
          if (popPatterns.some(p => headerStr.includes(p))) {
            foundPopCol = true;
          }
        }
      }
      
      if (foundNameCol && foundPopCol) {
        headerRow = r;
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r: headerRow, c })];
          if (cell && cell.v != null) {
            const headerStr = String(cell.v).toLowerCase().trim().replace(/\s+/g, '_');
            headerMap.set(headerStr, c);
          }
        }
        break;
      }
    }
    
    if (headerRow === -1) {
      console.warn(`Warning: Could not detect header row in sheet "${sheetName}", skipping`);
      continue;
    }
    
    // Find municipality name
    let municipalityName = sheetName;
    for (let r = range.s.r; r < headerRow; r++) {
      for (let c = range.s.c; c <= Math.min(range.s.c + 5, range.e.c); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v && typeof cell.v === 'string') {
          const val = cell.v.trim();
          if (val.startsWith('#') || /^\d+$/.test(val) || val.length < 3) continue;
          if (val.includes('Pretraži') || val.includes('Search') || val.includes(':')) continue;
          if (val.length > 2 && !val.includes('Popis') && !val.includes('**')) {
            municipalityName = val;
            break;
          }
        }
      }
      if (municipalityName !== sheetName) break;
    }
    
    // Derive municipality_id (pre-1991 mid)
    let municipalityId: string;
    const normalizedName = normalizeName(municipalityName);
    if (municipalityIdMap.has(normalizedName)) {
      municipalityId = municipalityIdMap.get(normalizedName)!;
    } else {
      const match = sheetName.match(/(\d+)/);
      if (match) {
        municipalityId = match[1];
      } else {
        // Use hash-based ID (deterministic)
        let hash = 0;
        for (let i = 0; i < sheetName.length; i++) {
          hash = ((hash << 5) - hash) + sheetName.charCodeAt(i);
          hash = hash & hash;
        }
        municipalityId = String(1000000 + (Math.abs(hash) % 900000));
      }
      municipalityIdMap.set(normalizedName, municipalityId);
    }
    
    // Parse data rows
    // Find column indices
    const settlementNameCol = Array.from(headerMap.entries()).find(([k]) => 
      namePatterns.some(p => k.includes(p))
    )?.[1] ?? 0;
    
    const settlementIdCol = Array.from(headerMap.entries()).find(([k]) => 
      (k.includes('id') || k.includes('šifra') || k.includes('sifra')) && !k.includes('mun')
    )?.[1];
    
    const latCol = Array.from(headerMap.entries()).find(([k]) => 
      k.includes('lat') || k.includes('latitude')
    )?.[1];
    
    const lonCol = Array.from(headerMap.entries()).find(([k]) => 
      k.includes('lon') || k.includes('lng') || k.includes('longitude')
    )?.[1];
    
    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const rowCells: XLSX.CellObject[] = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        rowCells.push(sheet[XLSX.utils.encode_cell({ r, c })]);
      }
      
      // CRITICAL: Filter aggregate rows (∑ symbol)
      if (isAggregateRow(rowCells)) {
        aggregateRowsFiltered++;
        continue;
      }
      
      const settlementName = getCellString(rowCells[settlementNameCol]);
      if (!settlementName) continue;
      
      // Skip header-like rows
      const normalizedSettlementName = normalizeName(settlementName);
      const headerPatterns = [
        'naseljeno', 'mjesto', 'settlement', 'name', 'naziv', 'ime',
        'ukupno', 'total', 'population', 'populacija'
      ];
      if (headerPatterns.some(p => normalizedSettlementName === normalizeName(p))) {
        continue;
      }
      
      // Determine sid
      const sourceId = settlementIdCol != null ? getCellString(rowCells[settlementIdCol]) : null;
      const sid = sourceId ? `${municipalityId}:${sourceId}` : `${municipalityId}:${r}`;
      
      const lat = latCol != null ? getCellNumber(rowCells[latCol]) : null;
      const lon = lonCol != null ? getCellNumber(rowCells[lonCol]) : null;
      
      const meta: SettlementMeta = {
        sid,
        name: settlementName,
        mid: municipalityId,
        municipality_name: municipalityName,
        lat,
        lon,
        source_row_id: `${sheetName}:${r}`
      };
      
      settlements.push(meta);
    }
  }
  
  // Stable sort by sid
  settlements.sort((a, b) => {
    const idA = parseInt(a.sid.split(':')[1] || '0', 10);
    const idB = parseInt(b.sid.split(':')[1] || '0', 10);
    if (a.mid !== b.mid) {
      return a.mid.localeCompare(b.mid);
    }
    if (!isNaN(idA) && !isNaN(idB)) {
      return idA - idB;
    }
    return a.sid.localeCompare(b.sid);
  });
  
  return { settlements, aggregateRowsFiltered };
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Reading Excel metadata...\n');
  console.log(`Input: ${EXCEL_PATH}`);
  
  try {
    const { settlements, aggregateRowsFiltered } = await parseExcelFile(EXCEL_PATH);
    
    console.log(`Extracted ${settlements.length} settlements`);
    console.log(`Filtered ${aggregateRowsFiltered} aggregate rows (∑)`);
    
    // Ensure output directory exists
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Write CSV
    const header = 'sid,name,mid,municipality_name,lat,lon,source_row_id\n';
    const rows = settlements.map(s => [
      escapeCSV(s.sid),
      escapeCSV(s.name),
      escapeCSV(s.mid),
      escapeCSV(s.municipality_name),
      s.lat != null ? String(s.lat) : '',
      s.lon != null ? String(s.lon) : '',
      escapeCSV(s.source_row_id)
    ].join(','));
    
    const csv = header + rows.join('\n');
    await writeFile(OUTPUT_PATH, csv, 'utf8');
    
    // Write stats to a separate file for reporting
    const statsPath = resolve('data/derived/excel_meta_stats.json');
    const stats = {
      aggregate_rows_filtered: aggregateRowsFiltered,
      settlements_extracted: settlements.length
    };
    await writeFile(statsPath, JSON.stringify(stats, null, 2), 'utf8');
    
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log(`Stats: ${statsPath}`);
    console.log('✓ Excel metadata extraction complete');
  } catch (err) {
    console.error('Error reading Excel:', err);
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
