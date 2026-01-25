#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../../data/derived');
const TARGET_DIR = path.resolve(__dirname, 'data/derived');

const FILES_TO_COPY = [
  'settlements_polygons.geojson',
  'map_bounds.json'
];

// Ensure target directory exists
if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

let copied = 0;
let errors = 0;

for (const file of FILES_TO_COPY) {
  const sourcePath = path.join(SOURCE_DIR, file);
  const targetPath = path.join(TARGET_DIR, file);
  
  try {
    if (!fs.existsSync(sourcePath)) {
      console.error(`Warning: Source file not found: ${sourcePath}`);
      errors++;
      continue;
    }
    
    fs.copyFileSync(sourcePath, targetPath);
    copied++;
    console.log(`Copied: ${file}`);
  } catch (err) {
    console.error(`Error copying ${file}:`, err.message);
    errors++;
  }
}

if (errors === 0) {
  console.log(`\n✓ Successfully copied ${copied} file(s) to tools/map_viewer_simple/data/derived/`);
  process.exit(0);
} else {
  console.error(`\n✗ Completed with ${errors} error(s)`);
  process.exit(1);
}
