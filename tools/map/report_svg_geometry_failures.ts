/**
 * SVG Geometry Failure Diagnostics
 * 
 * Forensic report explaining WHY polygons are dropped per municipality and per failure mode.
 * Uses the same parse + clean + validate pipeline as build_map.ts via shared geometry_pipeline module.
 * 
 * Inputs:
 *   - data/source/master_municipalities.json
 * 
 * Outputs:
 *   - data/derived/svg_geometry_failures_by_municipality.json
 *   - data/derived/svg_geometry_failures_by_municipality.txt
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chooseSettlementRing, ringToCoords, DropReason } from './geometry_pipeline';
import { loadMistakes, assertNoRepeat, appendMistake } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';
import * as turf from '@turf/turf';
import booleanValid from '@turf/boolean-valid';

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

interface MunicipalityDiagnostic {
  mid: string;
  name: string;
  total_with_svg: number;
  written: number;
  dropped: number;
  dropped_by_reason: Record<DropReason, number>;
  max_abs_coord: number;
  avg_points_written: number;
  avg_points_dropped: number;
  coverage_geometry: number;
}

// Constants
const MASTER_FILE = resolve('data/source/master_municipalities.json');
const OUTPUT_JSON = resolve('data/derived/svg_geometry_failures_by_municipality.json');
const OUTPUT_TXT = resolve('data/derived/svg_geometry_failures_by_municipality.txt');

async function main(): Promise<void> {
  // Load mistake guard
  loadMistakes();
  assertNoRepeat('SVG geometry failure diagnostics');
  loadLedger();
  assertLedgerFresh('SVG geometry failure diagnostics');
  
  console.log('Generating SVG geometry failure diagnostics...\n');
  
  // Load master data
  console.log('Loading master data...');
  const masterContent = await readFile(MASTER_FILE, 'utf8');
  const masterData: MasterData = JSON.parse(masterContent);
  
  // Process each municipality
  const diagnostics: MunicipalityDiagnostic[] = [];
  const overallDroppedByReason: Record<DropReason, number> = {
    unsupported_arc: 0,
    parse_error: 0,
    too_few_points: 0,
    non_finite: 0,
    zero_area: 0,
    self_evident_degenerate: 0,
    no_closed_subpaths: 0
  };
  
  for (const muni of masterData.municipalities) {
    const mid = muni.municipality_id;
    const name = muni.name;
    
    let totalWithSvg = 0;
    let written = 0;
    let dropped = 0;
    const droppedByReason: Record<DropReason, number> = {
      unsupported_arc: 0,
      parse_error: 0,
      too_few_points: 0,
      non_finite: 0,
      zero_area: 0,
      self_evident_degenerate: 0,
      no_closed_subpaths: 0
    };
    
    let maxAbsCoord = 0;
    let totalPointsWritten = 0;
    let totalPointsDropped = 0;
    let countPointsWritten = 0;
    let countPointsDropped = 0;
    
    for (const settlement of muni.settlements) {
      const sid = settlement.settlement_id;
      const svgPath = settlement.svg_path;
      
      if (!svgPath) {
        continue;
      }
      
      totalWithSvg++;
      const result = chooseSettlementRing(svgPath);
      
      // Compute max absolute coordinate from ring or debug info
      if (result.ring) {
        for (let i = 0; i < result.ring.length; i++) {
          maxAbsCoord = Math.max(maxAbsCoord, Math.abs(result.ring[i]));
        }
      }
      
      if (result.ring) {
        // Convert to polygon and validate with turf (same as build_map.ts)
        try {
          const polygon = ringToCoords(result.ring);
          const turfPoly = turf.polygon([polygon]);
          
          if (booleanValid(turfPoly)) {
            const area = turf.area(turfPoly);
            if (area > 0 && isFinite(area)) {
              written++;
              totalPointsWritten += result.ring.length / 2; // Float32Array has x,y pairs
              countPointsWritten++;
            } else {
              dropped++;
              droppedByReason["zero_area"]++;
              overallDroppedByReason["zero_area"]++;
              countPointsDropped++;
            }
          } else {
            dropped++;
            droppedByReason["self_evident_degenerate"]++;
            overallDroppedByReason["self_evident_degenerate"]++;
            countPointsDropped++;
          }
        } catch (err) {
          dropped++;
          droppedByReason["parse_error"]++;
          overallDroppedByReason["parse_error"]++;
          countPointsDropped++;
        }
      } else {
        dropped++;
        if (result.drop_reason) {
          droppedByReason[result.drop_reason]++;
          overallDroppedByReason[result.drop_reason]++;
        }
        countPointsDropped++;
      }
    }
    
    const avgPointsWritten = countPointsWritten > 0 ? totalPointsWritten / countPointsWritten : 0;
    const avgPointsDropped = countPointsDropped > 0 ? totalPointsDropped / countPointsDropped : 0;
    const coverageGeometry = totalWithSvg > 0 ? written / totalWithSvg : 0;
    
    diagnostics.push({
      mid,
      name,
      total_with_svg: totalWithSvg,
      written,
      dropped,
      dropped_by_reason: droppedByReason,
      max_abs_coord: maxAbsCoord,
      avg_points_written: avgPointsWritten,
      avg_points_dropped: avgPointsDropped,
      coverage_geometry: coverageGeometry
    });
    
    // Check for municipalities with SVG but zero geometry
    if (totalWithSvg > 0 && written === 0) {
      appendMistake({
        title: "Municipality has SVG but zero valid geometry",
        mistake: `Assumed svg_path presence implies polygon validity; entire municipalities can fail due to open/stroke paths or transforms. Municipality: ${name} (${mid}) has ${totalWithSvg} settlements with SVG but 0 valid geometry.`,
        correctRule: "Track drop reasons per municipality, keep scale-aware closure, and require forensic report before claiming geometry coverage."
      });
    }
  }
  
  // Sort by increasing coverage_geometry
  diagnostics.sort((a, b) => a.coverage_geometry - b.coverage_geometry);
  
  // Write JSON
  console.log('Writing JSON report...');
  await writeFile(OUTPUT_JSON, JSON.stringify(diagnostics, null, 2), 'utf8');
  
  // Write TXT report
  console.log('Writing TXT report...');
  const txtLines: string[] = [];
  txtLines.push('SVG Geometry Failure Diagnostics');
  txtLines.push('='.repeat(80));
  txtLines.push('');
  
  txtLines.push('Overall Totals by Reason:');
  for (const [reason, count] of Object.entries(overallDroppedByReason)) {
    txtLines.push(`  ${reason}: ${count}`);
  }
  txtLines.push('');
  
  // Top 20 municipalities with written==0 and total_with_svg>0
  const zeroWritten = diagnostics
    .filter(d => d.written === 0 && d.total_with_svg > 0)
    .slice(0, 20);
  
  if (zeroWritten.length > 0) {
    txtLines.push(`Top ${zeroWritten.length} municipalities with written==0 but svg present:`);
    for (const d of zeroWritten) {
      txtLines.push(`  ${d.name} (${d.mid}): ${d.total_with_svg} with SVG, dropped by:`);
      for (const [reason, count] of Object.entries(d.dropped_by_reason)) {
        if (count > 0) {
          txtLines.push(`    ${reason}: ${count}`);
        }
      }
    }
    txtLines.push('');
  }
  
  // Top 20 municipalities with highest drop rate
  const highDropRate = diagnostics
    .filter(d => d.total_with_svg > 0 && d.dropped > 0)
    .sort((a, b) => {
      const rateA = a.dropped / a.total_with_svg;
      const rateB = b.dropped / b.total_with_svg;
      return rateB - rateA;
    })
    .slice(0, 20);
  
  if (highDropRate.length > 0) {
    txtLines.push(`Top ${highDropRate.length} municipalities with highest drop rate:`);
    for (const d of highDropRate) {
      const dropRate = (d.dropped / d.total_with_svg * 100).toFixed(1);
      txtLines.push(`  ${d.name} (${d.mid}): ${dropRate}% dropped (${d.dropped}/${d.total_with_svg})`);
      for (const [reason, count] of Object.entries(d.dropped_by_reason)) {
        if (count > 0) {
          txtLines.push(`    ${reason}: ${count}`);
        }
      }
    }
    txtLines.push('');
  }
  
  await writeFile(OUTPUT_TXT, txtLines.join('\n'), 'utf8');
  
  console.log(`  Wrote ${OUTPUT_JSON}`);
  console.log(`  Wrote ${OUTPUT_TXT}`);
  console.log(`  Processed ${diagnostics.length} municipalities`);
  console.log('\nDiagnostics complete!');
  
  // Print last 40 lines of mistake log
  try {
    const { readFileSync } = await import('node:fs');
    const mistakeLogPath = resolve('docs/ASSISTANT_MISTAKES.log');
    const mistakeLogContent = readFileSync(mistakeLogPath, 'utf8');
    const lines = mistakeLogContent.split('\n');
    const lastLines = lines.slice(-40);
    console.log('\nLast 40 lines of ASSISTANT_MISTAKES.log:');
    console.log('='.repeat(80));
    console.log(lastLines.join('\n'));
    console.log('='.repeat(80));
  } catch (err) {
    // Ignore if file doesn't exist or can't be read
  }
}

main().catch((err) => {
  console.error('Diagnostics failed:', err);
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) {
      console.error(err.stack);
    }
  }
  process.exit(1);
});
