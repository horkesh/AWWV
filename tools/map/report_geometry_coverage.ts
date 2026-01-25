/**
 * Geometry Coverage Report
 * 
 * Generates a report of geometry coverage by municipality, including:
 * - Total settlements
 * - Settlements with SVG path
 * - Settlements with valid geometry
 * - Coverage ratios
 * - Reasons for skipped municipalities
 * 
 * Inputs:
 *   - data/source/master_municipalities.json
 *   - data/source/svg_join_order_report.json
 *   - data/derived/settlements_meta.json
 *   - data/derived/municipalities_meta.json
 * 
 * Outputs:
 *   - data/derived/geometry_coverage_by_municipality.json
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Types
interface MasterMunicipality {
  municipality_id: string;
  name: string;
  settlements: Array<{
    settlement_id: string;
    svg_path: string | null;
  }>;
}

interface MasterData {
  municipalities: MasterMunicipality[];
}

interface MunicipalityJoinResult {
  mid: string;
  name: string;
  js_file: string | null;
  settlements_count: number;
  paths_count: number;
  joined: boolean;
  reason_if_not: string | null;
}

interface JoinReport {
  per_municipality: MunicipalityJoinResult[];
  mismatches_sample: Array<{
    mid: string;
    name: string;
  }>;
  no_file_sample: Array<{
    mid: string;
    name: string;
  }>;
}

interface SettlementMeta {
  sid: string;
  mid: string;
  has_geometry: boolean;
}

interface MunicipalityMeta {
  mid: string;
  name: string;
  total_settlements: number;
  settlements_with_geometry: number;
}

interface CoverageEntry {
  mid: string;
  name: string;
  total_settlements: number;
  settlements_with_svg: number;
  settlements_with_geometry: number;
  coverage_svg: number;
  coverage_geometry: number;
  reason_if_skipped: string | null;
}

// Constants
const MASTER_FILE = resolve('data/source/master_municipalities.json');
const JOIN_REPORT_FILE = resolve('data/source/svg_join_order_report.json');
const SETTLEMENTS_META_FILE = resolve('data/derived/settlements_meta.json');
const MUNICIPALITIES_META_FILE = resolve('data/derived/municipalities_meta.json');
const OUTPUT_FILE = resolve('data/derived/geometry_coverage_by_municipality.json');

async function main(): Promise<void> {
  console.log('Generating geometry coverage report...\n');
  
  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  
  // Load join report
  console.log('Loading SVG join report...');
  let joinReport: JoinReport | null = null;
  try {
    const joinContent = await readFile(JOIN_REPORT_FILE, 'utf8');
    joinReport = JSON.parse(joinContent);
  } catch (err) {
    console.log('  Warning: Could not load SVG join report, continuing without it');
  }
  
  // Load settlements meta
  console.log('Loading settlements metadata...');
  const settlementsContent = await readFile(SETTLEMENTS_META_FILE, 'utf8');
  const settlementsMeta: SettlementMeta[] = JSON.parse(settlementsContent);
  
  // Load municipalities meta
  console.log('Loading municipalities metadata...');
  const municipalitiesContent = await readFile(MUNICIPALITIES_META_FILE, 'utf8');
  const municipalitiesMeta: MunicipalityMeta[] = JSON.parse(municipalitiesContent);
  
  // Build lookup maps
  const settlementBySid = new Map<string, SettlementMeta>();
  for (const settlement of settlementsMeta) {
    settlementBySid.set(settlement.sid, settlement);
  }
  
  const municipalityByMid = new Map<string, MunicipalityMeta>();
  for (const muni of municipalitiesMeta) {
    municipalityByMid.set(muni.mid, muni);
  }
  
  const joinResultByMid = new Map<string, MunicipalityJoinResult>();
  if (joinReport) {
    for (const result of joinReport.per_municipality) {
      joinResultByMid.set(result.mid, result);
    }
  }
  
  // Build coverage entries
  const coverageEntries: CoverageEntry[] = [];
  
  for (const muni of masterData.municipalities) {
    const mid = muni.municipality_id;
    const name = muni.name;
    
    // Count settlements with SVG path
    let settlementsWithSvg = 0;
    for (const settlement of muni.settlements) {
      if (settlement.svg_path) {
        settlementsWithSvg++;
      }
    }
    
    // Get geometry stats from municipalities_meta
    const muniMeta = municipalityByMid.get(mid);
    const totalSettlements = muni.settlements.length;
    const settlementsWithGeometry = muniMeta?.settlements_with_geometry ?? 0;
    
    // Calculate coverage ratios
    const coverageSvg = totalSettlements > 0 ? settlementsWithSvg / totalSettlements : 0;
    const coverageGeometry = totalSettlements > 0 ? settlementsWithGeometry / totalSettlements : 0;
    
    // Determine reason if skipped
    let reasonIfSkipped: string | null = null;
    const joinResult = joinResultByMid.get(mid);
    if (joinResult && !joinResult.joined) {
      reasonIfSkipped = joinResult.reason_if_not ?? 'unknown';
    } else if (!joinResult) {
      // Check if it's in the no-file sample
      const isNoFile = joinReport?.no_file_sample.some(m => m.mid === mid) ?? false;
      if (isNoFile) {
        reasonIfSkipped = 'no_js_file';
      }
    }
    
    coverageEntries.push({
      mid,
      name,
      total_settlements: totalSettlements,
      settlements_with_svg: settlementsWithSvg,
      settlements_with_geometry: settlementsWithGeometry,
      coverage_svg: coverageSvg,
      coverage_geometry: coverageGeometry,
      reason_if_skipped: reasonIfSkipped
    });
  }
  
  // Sort by coverage_geometry (lowest first) for easier analysis
  coverageEntries.sort((a, b) => a.coverage_geometry - b.coverage_geometry);
  
  // Write output
  console.log('\nWriting coverage report...');
  await writeFile(OUTPUT_FILE, JSON.stringify(coverageEntries, null, 2), 'utf8');
  
  console.log(`  Wrote ${OUTPUT_FILE}`);
  console.log(`  Total municipalities: ${coverageEntries.length}`);
  
  // Print summary
  const totalSettlements = coverageEntries.reduce((sum, e) => sum + e.total_settlements, 0);
  const totalWithSvg = coverageEntries.reduce((sum, e) => sum + e.settlements_with_svg, 0);
  const totalWithGeometry = coverageEntries.reduce((sum, e) => sum + e.settlements_with_geometry, 0);
  
  console.log('\nSummary:');
  console.log(`  Total settlements: ${totalSettlements}`);
  console.log(`  Settlements with SVG: ${totalWithSvg} (${(totalWithSvg / totalSettlements * 100).toFixed(1)}%)`);
  console.log(`  Settlements with geometry: ${totalWithGeometry} (${(totalWithGeometry / totalSettlements * 100).toFixed(1)}%)`);
  
  // Count skipped municipalities
  const skippedCountMismatch = coverageEntries.filter(e => e.reason_if_skipped?.startsWith('count_mismatch')).length;
  const skippedNoFile = coverageEntries.filter(e => e.reason_if_skipped === 'no_js_file').length;
  
  console.log(`  Municipalities skipped (count mismatch): ${skippedCountMismatch}`);
  console.log(`  Municipalities skipped (no file): ${skippedNoFile}`);
  
  // Show top 5 lowest and highest coverage
  console.log('\nTop 5 lowest coverage:');
  for (let i = 0; i < Math.min(5, coverageEntries.length); i++) {
    const e = coverageEntries[i];
    console.log(`  ${e.name} (${e.mid}): ${(e.coverage_geometry * 100).toFixed(1)}% (${e.settlements_with_geometry}/${e.total_settlements})`);
  }
  
  console.log('\nTop 5 highest coverage:');
  for (let i = Math.max(0, coverageEntries.length - 5); i < coverageEntries.length; i++) {
    const e = coverageEntries[i];
    console.log(`  ${e.name} (${e.mid}): ${(e.coverage_geometry * 100).toFixed(1)}% (${e.settlements_with_geometry}/${e.total_settlements})`);
  }
  
  console.log('\nCoverage report complete!');
}

main().catch((err) => {
  console.error('Coverage report failed:', err);
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
});
