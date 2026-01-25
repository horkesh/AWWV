/**
 * Municipality Code Summary: Diagnostic tool for polygon fabric mun_code values
 * 
 * Reads polygon_fabric.json and produces a summary of distinct mun_code values
 * with counts and sample names. This is diagnostic only, deterministic.
 * 
 * Outputs:
 *   - data/derived/mun_code_summary.csv
 * 
 * Usage:
 *   tsx tools/map/mun_code_summary.ts
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
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

interface PolygonFabricFeature {
  poly_id: string;
  mun_code: string;
  name_html?: string;
  d: string;
}

interface MunCodeSummary {
  mun_code: string;
  polygon_count: number;
  sample_names: string;
}

// ============================================================================
// Constants
// ============================================================================

const INPUT_PATH = resolve('data/derived/polygon_fabric.json');
const OUTPUT_PATH = resolve('data/derived/mun_code_summary.csv');
const DERIVED_DIR = resolve('data/derived');

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
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Generating municipality code summary...\n');
  console.log(`Input: ${INPUT_PATH}`);
  
  try {
    const inputContent = await readFile(INPUT_PATH, 'utf8');
    const features: PolygonFabricFeature[] = JSON.parse(inputContent);
    
    // Group by mun_code
    const munCodeMap = new Map<string, { count: number; names: Set<string> }>();
    
    for (const feature of features) {
      const munCode = feature.mun_code;
      if (!munCodeMap.has(munCode)) {
        munCodeMap.set(munCode, { count: 0, names: new Set() });
      }
      const entry = munCodeMap.get(munCode)!;
      entry.count++;
      if (feature.name_html) {
        entry.names.add(feature.name_html);
      }
    }
    
    // Convert to summary array
    const summaries: MunCodeSummary[] = Array.from(munCodeMap.entries())
      .map(([mun_code, data]) => ({
        mun_code,
        polygon_count: data.count,
        sample_names: Array.from(data.names).slice(0, 5).join('; ')
      }))
      .sort((a, b) => {
        // Stable sort by mun_code
        const codeA = parseInt(a.mun_code, 10);
        const codeB = parseInt(b.mun_code, 10);
        if (!isNaN(codeA) && !isNaN(codeB)) {
          return codeA - codeB;
        }
        return a.mun_code.localeCompare(b.mun_code);
      });
    
    // Ensure output directory exists
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Write CSV
    const header = 'mun_code,polygon_count,sample_names\n';
    const rows = summaries.map(s => [
      escapeCSV(s.mun_code),
      String(s.polygon_count),
      escapeCSV(s.sample_names)
    ].join(','));
    
    const csv = header + rows.join('\n');
    await writeFile(OUTPUT_PATH, csv, 'utf8');
    
    console.log(`\nFound ${summaries.length} distinct mun_code values`);
    console.log(`Total polygons: ${features.length}`);
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log('✓ Municipality code summary complete');
  } catch (err) {
    console.error('Error generating summary:', err);
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
