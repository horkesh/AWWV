/**
 * Municipality Code Crosswalk: Map polygon mun_code to canonical mid
 * 
 * Reads polygon_fabric.geojson and an optional mun_code_crosswalk.csv file.
 * If crosswalk exists, maps polygon features to mid and writes polygon_fabric_with_mid.geojson.
 * If crosswalk does NOT exist, writes polygon_fabric_with_mid.geojson with mid = null
 * and adds a warning to geometry_report.json.
 * 
 * Outputs:
 *   - data/derived/polygon_fabric_with_mid.geojson
 * 
 * Usage:
 *   tsx tools/map/mun_code_crosswalk.ts
 */

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import * as turf from '@turf/turf';
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
// Constants
// ============================================================================

const INPUT_PATH = resolve('data/derived/polygon_fabric.geojson');
const CROSSWALK_PATH = resolve('data/source/mun_code_crosswalk.csv');
const OUTPUT_PATH = resolve('data/derived/polygon_fabric_with_mid.geojson');
const DERIVED_DIR = resolve('data/derived');

// ============================================================================
// Crosswalk Loading
// ============================================================================

async function loadCrosswalk(): Promise<Map<string, string> | null> {
  try {
    await access(CROSSWALK_PATH, constants.F_OK);
  } catch {
    return null; // File doesn't exist
  }
  
  const content = await readFile(CROSSWALK_PATH, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  
  if (lines.length < 2) {
    return null; // No data rows
  }
  
  const header = lines[0].split(',');
  const munCodeIdx = header.indexOf('mun_code');
  const midIdx = header.indexOf('mid');
  
  if (munCodeIdx === -1 || midIdx === -1) {
    throw new Error('mun_code_crosswalk.csv must have mun_code and mid columns');
  }
  
  const crosswalk = new Map<string, string>();
  
  for (let i = 1; i < lines.length; i++) {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let j = 0; j < lines[i].length; j++) {
      const char = lines[i][j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        fields.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    fields.push(current);
    
    if (fields.length > Math.max(munCodeIdx, midIdx)) {
      const munCode = fields[munCodeIdx]?.trim();
      const mid = fields[midIdx]?.trim();
      if (munCode && mid) {
        crosswalk.set(munCode, mid);
      }
    }
  }
  
  return crosswalk;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Applying municipality code crosswalk...\n');
  console.log(`Input: ${INPUT_PATH}`);
  
  try {
    // Load polygon fabric
    const fabricContent = await readFile(INPUT_PATH, 'utf8');
    const fabricFC: turf.FeatureCollection<turf.Polygon> = JSON.parse(fabricContent);
    
    // Load crosswalk (optional)
    const crosswalk = await loadCrosswalk();
    
    let polygonsWithMid = 0;
    let polygonsWithoutMid = 0;
    
    // Apply crosswalk to features
    const outputFeatures: turf.Feature<turf.Polygon>[] = [];
    
    for (const feature of fabricFC.features) {
      const munCode = feature.properties?.mun_code;
      const polyId = feature.properties?.poly_id;
      
      if (!munCode || !polyId) {
        console.warn(`Warning: Feature missing mun_code or poly_id, skipping`);
        continue;
      }
      
      const mid = crosswalk?.get(String(munCode)) || null;
      
      const outputFeature: turf.Feature<turf.Polygon> = {
        ...feature,
        properties: {
          poly_id: polyId,
          mun_code: munCode,
          ...(mid ? { mid } : {})
        }
      };
      
      outputFeatures.push(outputFeature);
      
      if (mid) {
        polygonsWithMid++;
      } else {
        polygonsWithoutMid++;
      }
    }
    
    // Create output FeatureCollection
    const outputFC: turf.FeatureCollection<turf.Polygon> = {
      type: 'FeatureCollection',
      crs: fabricFC.crs,
      features: outputFeatures
    };
    
    // Ensure output directory exists
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Write output
    await writeFile(OUTPUT_PATH, JSON.stringify(outputFC, null, 2), 'utf8');
    
    console.log(`\nResults:`);
    console.log(`  Total polygons: ${outputFeatures.length}`);
    console.log(`  Polygons with mid: ${polygonsWithMid}`);
    console.log(`  Polygons without mid: ${polygonsWithoutMid}`);
    
    if (!crosswalk) {
      console.log(`\n  WARNING: mun_code_crosswalk.csv not found`);
      console.log(`  All polygons have mid = null`);
      console.log(`  Municipality outlines will need to be derived from settlement points`);
    }
    
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log('✓ Municipality code crosswalk complete');
  } catch (err) {
    console.error('Error applying crosswalk:', err);
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
