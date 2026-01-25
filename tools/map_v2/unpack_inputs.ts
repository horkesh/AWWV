/**
 * Map v2 Unpack: Extract inputs from zip files
 * 
 * Unpacks:
 *   - data/source/master_municipalities.zip -> data/source_v2/master_municipalities.json
 *   - data/source/settlements_pack.zip -> tools/map_v2/.cache/settlements_pack/
 */

import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { loadMistakes, assertNoRepeat } from '../assistant/mistake_guard';

// Mistake guard
loadMistakes();
assertNoRepeat("Map v2 rebuild from master_municipalities.zip + settlements_pack.zip");

const MASTER_ZIP = resolve('data/source/master_municipalities.zip');
const SETTLEMENTS_ZIP = resolve('data/source/settlements_pack.zip');
const OUTPUT_MASTER = resolve('data/source_v2/master_municipalities.json');
const CACHE_DIR = resolve('tools/map_v2/.cache/settlements_pack');

async function main(): Promise<void> {
  console.log('Map v2 Unpack: Extracting inputs\n');

  // Create output directories
  await mkdir(resolve('data/source_v2'), { recursive: true });
  await mkdir(CACHE_DIR, { recursive: true });

  // Unpack master_municipalities.zip
  console.log('Unpacking master_municipalities.zip...');
  try {
    const masterZip = new AdmZip(MASTER_ZIP);
    const entries = masterZip.getEntries();
    
    // Find master_municipalities.json in the zip
    const masterEntry = entries.find(e => e.entryName.endsWith('master_municipalities.json'));
    if (!masterEntry) {
      throw new Error('master_municipalities.json not found in zip');
    }
    
    const masterContent = masterEntry.getData().toString('utf8');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(OUTPUT_MASTER, masterContent, 'utf8');
    console.log(`  Extracted to ${OUTPUT_MASTER}`);
  } catch (err) {
    console.error(`Error unpacking master_municipalities.zip: ${err}`);
    process.exitCode = 1;
    return;
  }

  // Unpack settlements_pack.zip
  console.log('Unpacking settlements_pack.zip...');
  try {
    const settlementsZip = new AdmZip(SETTLEMENTS_ZIP);
    settlementsZip.extractAllTo(CACHE_DIR, true);
    console.log(`  Extracted to ${CACHE_DIR}`);
  } catch (err) {
    console.error(`Error unpacking settlements_pack.zip: ${err}`);
    process.exitCode = 1;
    return;
  }

  console.log('\nUnpack complete.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exitCode = 1;
});
