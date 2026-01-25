/**
 * Aggregate Mismatch Investigation Tool
 * 
 * Investigates the municipality aggregate row mismatch reported in the audit.
 * 
 * Usage:
 *   tsx tools/map/audit_aggregate_mismatch.ts
 * 
 * Outputs:
 *   - data/source/master_census_mismatch_detail.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';

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
  [key: string]: unknown;
}

interface MismatchDetail {
  municipality: {
    mid: string;
    name: string;
  };
  aggregate_row: {
    found: boolean;
    row_index: number | null;
    values: {
      total_population: number | null;
      bosniaks: number | null;
      croats: number | null;
      serbs: number | null;
      others: number | null;
    };
    raw_cells_preview: string[];
  };
  computed_sum: {
    values: {
      total_population: number;
      bosniaks: number;
      croats: number;
      serbs: number;
      others: number;
    };
    settlement_count: number;
  };
  delta: {
    total_population: number;
    bosniaks: number;
    croats: number;
    serbs: number;
    others: number;
  };
  top_suspects: Array<{
    sid: string;
    name: string;
    reason: string;
    raw_cells_preview: string[];
    parsed_values: {
      total_population: number | null;
      bosniaks: number | null;
      croats: number | null;
      serbs: number | null;
      others: number | null;
    };
  }>;
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
    // Remove spaces, commas, and other formatting
    const cleaned = val.trim().replace(/[\s,]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  return null;
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
 * Get raw cell value as string for preview
 */
function getRawCellPreview(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.v == null) return '';
  return String(cell.v);
}

// ============================================================================
// Main Investigation
// ============================================================================

async function investigateMismatch(): Promise<void> {
  // Load issues JSON to find the mismatched municipality
  const issuesPath = resolve('data/source/master_census_issues.json');
  const issuesContent = await readFile(issuesPath, 'utf8');
  const issues = JSON.parse(issuesContent) as {
    municipality_total_mismatches_vs_aggregate: Array<{
      mid: string;
      name: string;
      aggregate_row_totals: {
        row: number;
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
  };

  if (issues.municipality_total_mismatches_vs_aggregate.length === 0) {
    throw new Error('No municipality mismatches found in issues file');
  }

  const mismatch = issues.municipality_total_mismatches_vs_aggregate[0];
  const municipalityMid = mismatch.mid;
  const municipalityName = mismatch.name;

  console.log(`Investigating mismatch for municipality: ${municipalityMid} (${municipalityName})`);
  console.log(`Delta: total_population=${mismatch.delta.total_population}, others=${mismatch.delta.others}`);

  // Load cleaned census data
  const cleanedPath = resolve('data/source/master_census_clean.json');
  const cleanedContent = await readFile(cleanedPath, 'utf8');
  const cleanedSettlements = JSON.parse(cleanedContent) as CensusRow[];

  // Filter settlements for this municipality
  const municipalitySettlements = cleanedSettlements.filter(s => s.mid === municipalityMid);
  console.log(`Found ${municipalitySettlements.length} settlements in cleaned data`);

  // Compute sum from cleaned data
  const computedSum = {
    total_population: 0,
    bosniaks: 0,
    croats: 0,
    serbs: 0,
    others: 0
  };

  for (const s of municipalitySettlements) {
    if (s.total_population != null) computedSum.total_population += s.total_population;
    if (s.bosniaks != null) computedSum.bosniaks += s.bosniaks;
    if (s.croats != null) computedSum.croats += s.croats;
    if (s.serbs != null) computedSum.serbs += s.serbs;
    if (s.others != null) computedSum.others += s.others;
  }

  // Load Excel file
  const xlsxPath = resolve('data/source/master_settlements.xlsx');
  const buffer = await readFile(xlsxPath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  // Find the sheet for this municipality
  let targetSheet: XLSX.WorkSheet | null = null;
  let targetSheetName: string | null = null;

  for (const sheetName of workbook.SheetNames) {
    // Try exact match first
    if (sheetName === municipalityName) {
      targetSheet = workbook.Sheets[sheetName];
      targetSheetName = sheetName;
      break;
    }
    // Try normalized match
    if (normalizeName(sheetName) === normalizeName(municipalityName)) {
      targetSheet = workbook.Sheets[sheetName];
      targetSheetName = sheetName;
      break;
    }
  }

  if (!targetSheet || !targetSheetName) {
    throw new Error(`Could not find sheet for municipality "${municipalityName}"`);
  }

  console.log(`Found Excel sheet: "${targetSheetName}"`);

  // Parse the sheet to find header and aggregate row
  if (!targetSheet['!ref']) {
    throw new Error(`Sheet "${targetSheetName}" has no data range`);
  }

  const range = XLSX.utils.decode_range(targetSheet['!ref']);

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
      const cell = targetSheet[XLSX.utils.encode_cell({ r, c })];
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
        const cell = targetSheet[XLSX.utils.encode_cell({ r: headerRow, c })];
        if (cell && cell.v != null) {
          const headerStr = String(cell.v).toLowerCase().trim().replace(/\s+/g, '_');
          headerMap.set(headerStr, c);
        }
      }
      break;
    }
  }

  if (headerRow === -1) {
    throw new Error(`Could not find header row in sheet "${targetSheetName}"`);
  }

  // Find column indices
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

  // Find aggregate row (row index from issues is 1-indexed, convert to 0-indexed)
  const aggregateRowIndex = mismatch.aggregate_row_totals.row - 1;
  let aggregateRowFound = false;
  let aggregateRowCells: XLSX.CellObject[] = [];
  let aggregateRowValues = {
    total_population: null as number | null,
    bosniaks: null as number | null,
    croats: null as number | null,
    serbs: null as number | null,
    others: null as number | null
  };
  let aggregateRowPreview: string[] = [];

  // Check the expected row and nearby rows
  for (let offset = -2; offset <= 2; offset++) {
    const checkRow = aggregateRowIndex + offset;
    if (checkRow < headerRow + 1 || checkRow > range.e.r) continue;

    const rowCells: XLSX.CellObject[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      rowCells.push(targetSheet[XLSX.utils.encode_cell({ r: checkRow, c })]);
    }

    if (isAggregateRow(rowCells)) {
      aggregateRowFound = true;
      aggregateRowCells = rowCells;
      aggregateRowPreview = rowCells.slice(0, 15).map(getRawCellPreview);

      if (totalPopCol != null) {
        aggregateRowValues.total_population = getCellNumber(rowCells[totalPopCol]);
      }
      if (bosniaksCol != null) {
        aggregateRowValues.bosniaks = getCellNumber(rowCells[bosniaksCol]);
      }
      if (croatsCol != null) {
        aggregateRowValues.croats = getCellNumber(rowCells[croatsCol]);
      }
      if (serbsCol != null) {
        aggregateRowValues.serbs = getCellNumber(rowCells[serbsCol]);
      }
      if (othersCol != null) {
        aggregateRowValues.others = getCellNumber(rowCells[othersCol]);
      }
      break;
    }
  }

  if (!aggregateRowFound) {
    console.warn(`Warning: Could not find aggregate row at expected index ${mismatch.aggregate_row_totals.row}`);
  }

  // Build suspect list
  const suspects: MismatchDetail['top_suspects'] = [];

  // Create a map of cleaned settlements by name for matching
  const cleanedByName = new Map<string, CensusRow>();
  for (const s of municipalitySettlements) {
    const normalized = normalizeName(s.settlement_name);
    cleanedByName.set(normalized, s);
  }

  // Track Excel settlements
  const excelSettlements = new Map<string, {
    name: string;
    row: number;
    parsedValues: {
      total_population: number | null;
      bosniaks: number | null;
      croats: number | null;
      serbs: number | null;
      others: number | null;
    };
    rawPreview: string[];
    isAggregate: boolean;
  }>();

  // Scan all data rows
  for (let r = headerRow + 1; r <= range.e.r; r++) {
    const rowCells: XLSX.CellObject[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      rowCells.push(targetSheet[XLSX.utils.encode_cell({ r, c })]);
    }

    const isAggregate = isAggregateRow(rowCells);
    if (isAggregate) continue;

    const settlementName = getCellString(rowCells[settlementNameCol]);
    if (!settlementName) continue;

    // Skip header-like rows
    const normalizedSettlementName = normalizeName(settlementName);
    const headerPatterns = [
      'naseljeno', 'mjesto', 'naseljeno_mjesto', 'naseljeno mjesto',
      'settlement', 'name', 'naziv', 'ime',
      'ukupno', 'total', 'population', 'populacija',
      'bošnjaci', 'bosniaks', 'hrvati', 'croats', 'srbi', 'serbs', 'ostali', 'others',
      '#', 'šifra', 'sifra', 'id'
    ];
    if (headerPatterns.some(p => normalizedSettlementName === normalizeName(p))) {
      continue;
    }

    // Parse values from Excel
    const parsedValues = {
      total_population: totalPopCol != null ? getCellNumber(rowCells[totalPopCol]) : null,
      bosniaks: bosniaksCol != null ? getCellNumber(rowCells[bosniaksCol]) : null,
      croats: croatsCol != null ? getCellNumber(rowCells[croatsCol]) : null,
      serbs: serbsCol != null ? getCellNumber(rowCells[serbsCol]) : null,
      others: othersCol != null ? getCellNumber(rowCells[othersCol]) : null
    };

    // Get raw cell preview
    const rawPreview = rowCells.slice(0, 15).map(getRawCellPreview);

    excelSettlements.set(normalizedSettlementName, {
      name: settlementName,
      row: r + 1, // 1-indexed
      parsedValues,
      rawPreview,
      isAggregate: false
    });
  }

  // Now analyze each Excel settlement
  for (const [normalizedName, excelData] of excelSettlements.entries()) {
    const cleanedSettlement = cleanedByName.get(normalizedName);
    const { parsedValues, rawPreview } = excelData;

    // Check for issues
    const reasons: string[] = [];

    // Check if settlement is missing from cleaned data
    if (!cleanedSettlement) {
      reasons.push('settlement not found in cleaned data (may have been skipped)');
    }

    // Check for null or non-numeric values
    if (parsedValues.total_population == null) {
      reasons.push('total_population is null or non-numeric in Excel');
    }
    if (parsedValues.bosniaks == null && bosniaksCol != null) {
      reasons.push('bosniaks is null or non-numeric in Excel');
    }
    if (parsedValues.croats == null && croatsCol != null) {
      reasons.push('croats is null or non-numeric in Excel');
    }
    if (parsedValues.serbs == null && serbsCol != null) {
      reasons.push('serbs is null or non-numeric in Excel');
    }
    if (parsedValues.others == null && othersCol != null) {
      reasons.push('others is null or non-numeric in Excel');
    }

    // Check for parsing differences (if we have cleaned data to compare)
    if (cleanedSettlement) {
      if (parsedValues.total_population != null && cleanedSettlement.total_population != null) {
        const diff = Math.abs(parsedValues.total_population - cleanedSettlement.total_population);
        if (diff > 0.01) {
          reasons.push(`total_population parsing difference: Excel=${parsedValues.total_population}, Cleaned=${cleanedSettlement.total_population}, diff=${diff}`);
        }
      }
      if (parsedValues.others != null && cleanedSettlement.others != null) {
        const diff = Math.abs(parsedValues.others - cleanedSettlement.others);
        if (diff > 0.01) {
          reasons.push(`others parsing difference: Excel=${parsedValues.others}, Cleaned=${cleanedSettlement.others}, diff=${diff}`);
        }
      }
    }

    // Check for negative, zero, or malformed values
    if (parsedValues.total_population != null && parsedValues.total_population < 0) {
      reasons.push('total_population is negative');
    }
    if (parsedValues.others != null && parsedValues.others < 0) {
      reasons.push('others is negative');
    }

    // Check if values are close to the delta (potential rounding issues)
    if (parsedValues.total_population != null) {
      const diff = Math.abs(parsedValues.total_population - mismatch.delta.total_population);
      if (diff < 10 && parsedValues.total_population > 0) {
        reasons.push(`total_population (${parsedValues.total_population}) is close to delta (${mismatch.delta.total_population})`);
      }
    }
    if (parsedValues.others != null) {
      const diff = Math.abs(parsedValues.others - mismatch.delta.others);
      if (diff < 5 && parsedValues.others > 0) {
        reasons.push(`others (${parsedValues.others}) is close to delta (${mismatch.delta.others})`);
      }
    }

    // Check if this might be a false positive aggregate (contains ∑ but wasn't detected)
    const allCellsStr = rawPreview.join(' ');
    if (allCellsStr.includes('∑') && !excelData.isAggregate) {
      reasons.push('contains ∑ symbol but not detected as aggregate row');
    }

    // If we have reasons, add to suspects
    if (reasons.length > 0) {
      suspects.push({
        sid: cleanedSettlement?.sid || 'unknown',
        name: excelData.name,
        reason: reasons.join('; '),
        raw_cells_preview: rawPreview,
        parsed_values: parsedValues
      });
    }
  }

  // Also check for settlements in cleaned data that aren't in Excel
  for (const cleanedSettlement of municipalitySettlements) {
    const normalized = normalizeName(cleanedSettlement.settlement_name);
    if (!excelSettlements.has(normalized)) {
      suspects.push({
        sid: cleanedSettlement.sid,
        name: cleanedSettlement.settlement_name,
        reason: 'settlement in cleaned data but not found in Excel (may have been added or renamed)',
        raw_cells_preview: [],
        parsed_values: {
          total_population: cleanedSettlement.total_population,
          bosniaks: cleanedSettlement.bosniaks,
          croats: cleanedSettlement.croats,
          serbs: cleanedSettlement.serbs,
          others: cleanedSettlement.others
        }
      });
    }
  }

  // Sort suspects by relevance (more reasons = higher priority)
  suspects.sort((a, b) => {
    const aReasons = a.reason.split(';').length;
    const bReasons = b.reason.split(';').length;
    if (aReasons !== bReasons) return bReasons - aReasons;
    return a.name.localeCompare(b.name);
  });

  // Build the report
  const report: MismatchDetail = {
    municipality: {
      mid: municipalityMid,
      name: municipalityName
    },
    aggregate_row: {
      found: aggregateRowFound,
      row_index: aggregateRowFound ? mismatch.aggregate_row_totals.row : null,
      values: aggregateRowValues,
      raw_cells_preview: aggregateRowPreview
    },
    computed_sum: {
      values: computedSum,
      settlement_count: municipalitySettlements.length
    },
    delta: mismatch.delta,
    top_suspects: suspects.slice(0, 30) // Top 30 suspects
  };

  // Write report
  const reportPath = resolve('data/source/master_census_mismatch_detail.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

  // Print summary
  console.log('\n=== Investigation Summary ===');
  console.log(`Municipality: ${municipalityName} (${municipalityMid})`);
  console.log(`Aggregate row found: ${aggregateRowFound}`);
  if (aggregateRowFound) {
    console.log(`Aggregate row index: ${mismatch.aggregate_row_totals.row}`);
    console.log(`Aggregate totals: total_population=${aggregateRowValues.total_population}, others=${aggregateRowValues.others}`);
  }
  console.log(`Computed sum: total_population=${computedSum.total_population}, others=${computedSum.others}`);
  console.log(`Delta: total_population=${mismatch.delta.total_population}, others=${mismatch.delta.others}`);
  console.log(`Excel settlements found: ${excelSettlements.size}`);
  console.log(`Cleaned settlements: ${municipalitySettlements.length}`);
  console.log(`Suspicious settlements found: ${suspects.length}`);
  if (suspects.length > 0) {
    console.log(`Top suspects: ${suspects.slice(0, 5).map(s => `${s.name} (${s.reason.split(';')[0]})`).join(', ')}`);
  }
  console.log(`\nReport written to: ${reportPath}`);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  try {
    await investigateMismatch();
    console.log('\n✓ Investigation complete!');
  } catch (err) {
    console.error(`\n✗ Investigation failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
