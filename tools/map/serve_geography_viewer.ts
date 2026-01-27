#!/usr/bin/env node
/**
 * Simple HTTP server for unified geography GeoJSON viewer
 * 
 * Usage:
 *   tsx tools/map/serve_geography_viewer.ts
 *   npm run map:view-geojson
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Serving GeoJSON viewer with offline HTML/JS");

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT || '5179', 10);
const BASE_DIR = resolve(__dirname, '../..');

// Try FINAL first (primary), then unified as fallback
const GEOJSON_PATHS = [
  resolve(BASE_DIR, 'data/source/awwv_geography_FINAL.geojson'),
  resolve(BASE_DIR, 'data/source/awwv_geography_unified.geojson')
];

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.css': 'text/css'
};

function findGeoJSONFile(): string | null {
  for (const path of GEOJSON_PATHS) {
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
    pathname = '/tools/map/view_geography/index.html';
  } else if (pathname === '/viewer.js') {
    pathname = '/tools/map/view_geography/viewer.js';
  } else if (pathname === '/data') {
    const geojsonPath = findGeoJSONFile();
    if (!geojsonPath) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'GeoJSON file not found', expected: GEOJSON_PATHS }));
      return;
    }
    try {
      const content = await readFile(geojsonPath, 'utf8');
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(content);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading GeoJSON file');
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

const geojsonPath = findGeoJSONFile();
if (!geojsonPath) {
  console.warn('WARNING: GeoJSON file not found. Expected paths:');
  GEOJSON_PATHS.forEach(p => console.warn(`  - ${p}`));
  console.warn('Server will start but viewer will show an error.');
}

server.listen(PORT, () => {
  console.log(`Open: http://localhost:${PORT}/`);
});
