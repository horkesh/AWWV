#!/usr/bin/env node
/**
 * Conditionally derive municipality borders if needed
 * 
 * Only runs derivation if:
 * - Output file doesn't exist, OR
 * - Input file is newer than output file
 * 
 * Usage:
 *   tsx tools/map/check_and_derive_muni_borders.ts
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Add a simple HTML map viewer and a single command that regenerates derived artifacts then serves the viewer");

import { statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'child_process';

const SETTLEMENT_INPUT_PATH = resolve('data/source/geography_settlements.geojson');
const OUTPUT_GEOJSON_PATH = resolve('data/derived/municipality_borders_from_settlements.geojson');

function getMtime(filePath: string): number | null {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const stats = statSync(filePath);
    return stats.mtimeMs;
  } catch (err) {
    return null;
  }
}

function needsDerivation(): boolean {
  // If output doesn't exist, need derivation
  if (!existsSync(OUTPUT_GEOJSON_PATH)) {
    console.log('Output file does not exist, derivation needed');
    return true;
  }
  
  // If input doesn't exist, skip (will fail later)
  if (!existsSync(SETTLEMENT_INPUT_PATH)) {
    console.log('Input file does not exist, skipping derivation');
    return false;
  }
  
  // Check modification times
  const inputMtime = getMtime(SETTLEMENT_INPUT_PATH);
  const outputMtime = getMtime(OUTPUT_GEOJSON_PATH);
  
  if (inputMtime === null || outputMtime === null) {
    // Can't determine, run derivation to be safe
    console.log('Cannot determine file times, running derivation');
    return true;
  }
  
  // If input is newer than output, need derivation
  if (inputMtime > outputMtime) {
    console.log('Input file is newer than output, derivation needed');
    return true;
  }
  
  console.log('Output file is up to date, skipping derivation');
  return false;
}

function main(): void {
  if (needsDerivation()) {
    console.log('Running municipality border derivation...');
    try {
      execSync('npm run map:derive-muni-borders', { stdio: 'inherit' });
      console.log('Derivation completed');
    } catch (err) {
      console.error('Derivation failed:', err);
      process.exitCode = 1;
    }
  } else {
    console.log('Skipping derivation (output is up to date)');
  }
}

main();
