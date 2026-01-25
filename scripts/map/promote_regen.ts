/**
 * Promote regenerated MapKit GeoJSON to canonical.
 * 
 * This script:
 * 1. Backs up the current canonical file to .pre_regen_backup
 * 2. Copies the regenerated file to the canonical path
 * 
 * Usage:
 *   tsx scripts/map/promote_regen.ts
 * 
 * Deterministic: No timestamps, stable file operations.
 */

import { readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';

const DERIVED_DIR = resolve('data/derived');
const CANONICAL_PATH = resolve(DERIVED_DIR, 'settlements_polygons.geojson');
const REGEN_PATH = resolve(DERIVED_DIR, 'settlements_polygons.regen.geojson');
const BACKUP_PATH = resolve(DERIVED_DIR, 'settlements_polygons.geojson.pre_regen_backup');

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Check that regen file exists
  if (!(await fileExists(REGEN_PATH))) {
    process.stderr.write(`ERROR: Regenerated file not found: ${REGEN_PATH}\n`);
    process.stderr.write(`Run 'npm run map:regen' first to generate it.\n`);
    process.exitCode = 1;
    return;
  }

  // Backup canonical if it exists
  if (await fileExists(CANONICAL_PATH)) {
    process.stdout.write(`Backing up canonical to: ${BACKUP_PATH}\n`);
    await copyFile(CANONICAL_PATH, BACKUP_PATH);
    process.stdout.write(`Backup complete.\n`);
  } else {
    process.stdout.write(`No existing canonical file to backup.\n`);
  }

  // Copy regen to canonical
  process.stdout.write(`Promoting regenerated file to canonical...\n`);
  await copyFile(REGEN_PATH, CANONICAL_PATH);
  process.stdout.write(`Promotion complete.\n`);
  process.stdout.write(`Canonical file: ${CANONICAL_PATH}\n`);
  process.stdout.write(`Backup file: ${BACKUP_PATH}\n`);
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  1. Rebuild adjacency: npm run map:adj\n`);
  process.stdout.write(`  2. Validate: npm run map:validate\n`);
  process.stdout.write(`  3. Run sim mapcheck: npm run sim:mapcheck\n`);
}

main().catch((err) => {
  process.stderr.write(`promote_regen failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
