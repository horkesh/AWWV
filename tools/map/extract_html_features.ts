/**
 * Extract HTML Features: Extract FEATURES array from known-good HTML map
 * 
 * Reads the HTML file and extracts the FEATURES constant containing
 * polygon data with SVG paths. Polygons are territorial micro-areas,
 * not settlements.
 * 
 * Outputs:
 *   - data/derived/polygon_fabric.json
 * 
 * Usage:
 *   tsx tools/map/extract_html_features.ts
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

interface HTMLFeature {
  id: number;
  mun: string;
  mun_code: string;
  d: string;
}

// ============================================================================
// Constants
// ============================================================================

const HTML_PATH = resolve('data/source/settlements_map_CURRENT_dark_zoom_v2_added_breza_centar_jezero.html');
const OUTPUT_PATH = resolve('data/derived/polygon_fabric.json');
const DERIVED_DIR = resolve('data/derived');

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extract FEATURES constant from HTML file
 */
async function extractFeatures(): Promise<PolygonFabricFeature[]> {
  const htmlContent = await readFile(HTML_PATH, 'utf8');
  
  // Match: const FEATURES = [...];
  const featuresMatch = htmlContent.match(/const\s+FEATURES\s*=\s*(\[[\s\S]*?\]);/);
  
  if (!featuresMatch) {
    throw new Error('Could not find FEATURES constant in HTML file');
  }
  
  const featuresJson = featuresMatch[1];
  let features: HTMLFeature[];
  
  try {
    features = JSON.parse(featuresJson) as HTMLFeature[];
  } catch (err) {
    throw new Error(`Failed to parse FEATURES JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Convert to output format with stable sorting by poly_id
  const output: PolygonFabricFeature[] = features
    .map(f => ({
      poly_id: String(f.id),
      mun_code: f.mun_code,
      name_html: f.mun,
      d: f.d
    }))
    .sort((a, b) => {
      // Stable sort by poly_id (numeric comparison)
      const idA = parseInt(a.poly_id, 10);
      const idB = parseInt(b.poly_id, 10);
      if (!isNaN(idA) && !isNaN(idB)) {
        return idA - idB;
      }
      return a.poly_id.localeCompare(b.poly_id);
    });
  
  return output;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log('Extracting FEATURES from HTML file...\n');
  console.log(`Input: ${HTML_PATH}`);
  
  try {
    const features = await extractFeatures();
    
    console.log(`Extracted ${features.length} features`);
    
    // Ensure output directory exists
    await mkdir(DERIVED_DIR, { recursive: true });
    
    // Write output with canonical JSON formatting
    const output = JSON.stringify(features, null, 2);
    await writeFile(OUTPUT_PATH, output, 'utf8');
    
    console.log(`\nOutput: ${OUTPUT_PATH}`);
    console.log('✓ Extraction complete');
  } catch (err) {
    console.error('Error extracting features:', err);
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
