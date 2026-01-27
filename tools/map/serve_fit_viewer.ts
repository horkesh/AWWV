#!/usr/bin/env node
/**
 * Simple HTTP server for dual-layer fit viewer (settlements + municipality outlines)
 * 
 * Usage:
 *   tsx tools/map/serve_fit_viewer.ts
 *   npm run map:view-fit
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Create a dual-layer HTML viewer to compare settlement fabric vs municipality outlines for fit, with toggles and focus tools");

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT || '5183', 10);
const BASE_DIR = resolve(__dirname, '../..');

// Settlement GeoJSON paths (try in order)
const SETTLEMENT_PATHS = [
  resolve(BASE_DIR, 'data/source/geography.geojson'),
  resolve(BASE_DIR, 'data/source/awwv_geography_FINAL.geojson')
];

const MUNI_OUTLINES_PATH = resolve(BASE_DIR, 'data/derived/municipality_outlines_from_html.geojson');
const MUNI_FABRIC_PATH = resolve(BASE_DIR, 'data/derived/municipality_boundaries_from_fabric.geojson');
const MUNI_FABRIC_CLEANED_PATH = resolve(BASE_DIR, 'data/derived/municipality_boundaries_from_fabric_cleaned.geojson');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.css': 'text/css'
};

function findSettlementFile(): string | null {
  for (const path of SETTLEMENT_PATHS) {
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

const server = createServer(async (req, res) => {
  let pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  
  // Route handling
  if (pathname === '/') {
    pathname = '/tools/map/view_fit/index.html';
  } else if (pathname === '/viewer.js') {
    pathname = '/tools/map/view_fit/viewer.js';
  } else if (pathname === '/settlements') {
    const settlementPath = findSettlementFile();
    if (!settlementPath) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Settlement GeoJSON file not found. Expected paths:\n' + SETTLEMENT_PATHS.join('\n'));
      return;
    }
    try {
      const content = await readFile(settlementPath, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading settlement GeoJSON file');
    }
    return;
  } else if (pathname === '/muni_outlines') {
    if (!existsSync(MUNI_OUTLINES_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Municipality outlines GeoJSON file not found at: ' + MUNI_OUTLINES_PATH);
      return;
    }
    try {
      const content = await readFile(MUNI_OUTLINES_PATH, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading municipality outlines GeoJSON file');
    }
    return;
  } else if (pathname === '/muni_fabric') {
    if (!existsSync(MUNI_FABRIC_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Municipality boundaries from fabric GeoJSON file not found at: ' + MUNI_FABRIC_PATH);
      return;
    }
    try {
      const content = await readFile(MUNI_FABRIC_PATH, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading municipality boundaries from fabric GeoJSON file');
    }
    return;
  } else if (pathname === '/muni_fabric_clean') {
    if (!existsSync(MUNI_FABRIC_CLEANED_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Municipality boundaries from fabric (cleaned) GeoJSON file not found at: ' + MUNI_FABRIC_CLEANED_PATH);
      return;
    }
    try {
      const content = await readFile(MUNI_FABRIC_CLEANED_PATH, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading municipality boundaries from fabric (cleaned) GeoJSON file');
    }
    return;
  }
  
  // Remove leading slash and resolve
  const filePath = resolve(BASE_DIR, pathname.substring(1));
  
  // Security check: ensure file is within base directory
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    res.writeHead(200, { 
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*'
    });
    res.end(content);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Server error');
    }
  }
});

const settlementPath = findSettlementFile();
if (!settlementPath) {
  console.warn('WARNING: Settlement GeoJSON file not found. Expected paths:');
  SETTLEMENT_PATHS.forEach(p => console.warn(`  - ${p}`));
  console.warn('Server will start but viewer will show an error.');
}

if (!existsSync(MUNI_OUTLINES_PATH)) {
  console.warn(`WARNING: Municipality outlines GeoJSON file not found at ${MUNI_OUTLINES_PATH}`);
  console.warn('Server will start but viewer will show an error.');
}

server.listen(PORT, () => {
  console.log(`Open: http://localhost:${PORT}/`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use.`);
    console.error(`Please stop the existing server or set PORT environment variable to use a different port.`);
    console.error(`Example: PORT=5184 npm run map:view-fit`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
