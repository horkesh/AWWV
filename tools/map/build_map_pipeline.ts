/**
 * Map Build Pipeline: Run all map build steps in sequence (Path A)
 * 
 * Runs:
 *   1. extract_html_features -> polygon_fabric.json
 *   2. svgpath_to_geojson -> polygon_fabric.geojson
 *   3. read_excel_meta -> settlements_meta.csv
 *   4. mun_code_crosswalk (optional) -> polygon_fabric_with_mid.geojson
 *   5. derive_municipality_outlines -> municipality_outline.geojson
 *   6. build_municipality_viewer_html -> municipality_borders_viewer.html
 *   7. settlement_points_from_excel -> settlement_points_from_excel.geojson
 *   8. build_inspector_html -> settlements_inspector.html
 *   9. generate_geometry_report -> geometry_report.json
 * 
 * Usage:
 *   tsx tools/map/build_map_pipeline.ts
 *   pnpm build:map
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';
import { loadLedger, assertLedgerFresh } from '../assistant/project_ledger_guard';

const execAsync = promisify(exec);

// ============================================================================
// Mistake Guard Integration
// ============================================================================

loadMistakes();
assertNoRepeat("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");
loadLedger();
assertLedgerFresh("map rebuild path A: keep polygon fabric separate from settlements, municipality-only linkage, inspector overlay");

// ============================================================================
// Pipeline Steps
// ============================================================================

interface PipelineStep {
  name: string;
  script: string;
  validateOutput?: () => Promise<void>;
}

const STEPS: PipelineStep[] = [
  {
    name: 'Extract HTML Features',
    script: resolve('tools/map/extract_html_features.ts')
  },
  {
    name: 'Convert SVG Paths to GeoJSON',
    script: resolve('tools/map/svgpath_to_geojson.ts')
  },
  {
    name: 'Read Excel Meta',
    script: resolve('tools/map/read_excel_meta.ts')
  },
  {
    name: 'Apply Municipality Code Crosswalk',
    script: resolve('tools/map/mun_code_crosswalk.ts')
  },
  {
    name: 'Derive Municipality Outlines',
    script: resolve('tools/map/derive_municipality_outlines.ts'),
    validateOutput: async () => {
      // Check if we're in mun_code mode by checking geometry_report.json
      try {
        const reportPath = resolve('data/derived/geometry_report.json');
        const reportContent = await readFile(reportPath, 'utf8');
        const report = JSON.parse(reportContent);
        
        if (report.outlines_mode === 'mun_code') {
          // In mun_code mode, mun_code_outline.geojson MUST exist
          const munCodeOutlinePath = resolve('data/derived/mun_code_outline.geojson');
          try {
            const content = await readFile(munCodeOutlinePath, 'utf8');
            const fc = JSON.parse(content);
            
            if (fc.type !== 'FeatureCollection' || fc.features.length === 0) {
              throw new Error(`Expected mun_code_outline.geojson in mun_code mode, but file has ${fc.features.length} features`);
            }
          } catch (err) {
            throw new Error(`Expected mun_code_outline.geojson in mun_code mode, but file was not created or is invalid: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        // If we can't read the report, that's okay - the script itself should have failed
        // But we'll still check for mun_code_outline.geojson if it exists
        const munCodeOutlinePath = resolve('data/derived/mun_code_outline.geojson');
        try {
          await readFile(munCodeOutlinePath, 'utf8');
          // File exists, that's good
        } catch {
          // File doesn't exist, but we don't know the mode, so we can't validate
          // The derive script should have handled this
        }
      }
    }
  },
  {
    name: 'Build Municipality Borders Viewer',
    script: resolve('tools/map/build_municipality_viewer_html.ts')
  },
  {
    name: 'Extract Municipality Borders from drzava.js',
    script: resolve('tools/map/extract_municipality_borders_from_drzava.ts')
  },
  {
    name: 'Build Municipality Borders Viewer (drzava.js)',
    script: resolve('tools/map/build_municipality_borders_viewer_html.ts')
  },
  {
    name: 'Generate Settlement Points',
    script: resolve('tools/map/settlement_points.ts')
  },
  {
    name: 'Build Inspector HTML',
    script: resolve('tools/map/build_inspector_html.ts')
  },
  {
    name: 'Generate Geometry Report',
    script: resolve('tools/map/generate_geometry_report.ts')
  }
];

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Map Build Pipeline\n');
  console.log('='.repeat(80));
  console.log();
  
  for (let i = 0; i < STEPS.length; i++) {
    const step = STEPS[i];
    console.log(`[${i + 1}/${STEPS.length}] ${step.name}...`);
    console.log('-'.repeat(80));
    
    try {
      const { stdout, stderr } = await execAsync(`tsx "${step.script}"`, {
        cwd: resolve('.'),
        maxBuffer: 10 * 1024 * 1024 // 10MB
      });
      
      if (stdout) {
        console.log(stdout);
      }
      if (stderr) {
        console.error(stderr);
      }
      
      console.log(`✓ ${step.name} complete\n`);
      
      // Run validation if provided
      if (step.validateOutput) {
        try {
          await step.validateOutput();
        } catch (err: unknown) {
          console.error(`\n✗ ${step.name} output validation failed`);
          if (err instanceof Error) {
            console.error(err.message);
            if (err.stack) {
              console.error(err.stack);
            }
          }
          process.exit(1);
        }
      }
    } catch (err: unknown) {
      console.error(`\n✗ ${step.name} failed`);
      if (err instanceof Error) {
        console.error(err.message);
        if (err.stack) {
          console.error(err.stack);
        }
      }
      process.exit(1);
    }
  }
  
  console.log('='.repeat(80));
  console.log('\n✓ Map build pipeline complete!');
}

main();
