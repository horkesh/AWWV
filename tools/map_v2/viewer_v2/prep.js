/**
 * Prep script: Copy derived_v2 data to viewer_v2/data/derived_v2/
 */

import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const DERIVED_DIR = resolve('data/derived_v2');
const VIEWER_DATA_DIR = resolve('tools/map_v2/viewer_v2/data/derived_v2');

async function main() {
  console.log('Preparing viewer data...');
  
  await mkdir(VIEWER_DATA_DIR, { recursive: true });
  
  const files = await readdir(DERIVED_DIR);
  const jsonFiles = files.filter(f => f.endsWith('.json') || f.endsWith('.geojson'));
  
  for (const file of jsonFiles) {
    const src = join(DERIVED_DIR, file);
    const dst = join(VIEWER_DATA_DIR, file);
    await copyFile(src, dst);
    console.log(`  Copied ${file}`);
  }
  
  console.log('Prep complete.');
}

main().catch(err => {
  console.error('Error:', err);
  process.exitCode = 1;
});
