#!/usr/bin/env node
/**
 * Simple HTTP server for SVG-derived municipality outlines viewer
 * 
 * Usage:
 *   tsx tools/map/serve_svg_muni_viewer.ts
 *   npm run map:view-muni-svg
 */

import { loadMistakes, assertNoRepeat, appendMistake } from "../assistant/mistake_guard";
loadMistakes();
assertNoRepeat("Add a simple HTML viewer to display municipality_outlines_from_html.geojson with basic pan/zoom and layer toggle");

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = parseInt(process.env.PORT || '5182', 10);
const BASE_DIR = resolve(__dirname, '../..');

const GEOJSON_PATH = resolve(BASE_DIR, 'data/derived/municipality_outlines_from_html.geojson');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
  '.css': 'text/css'
};

const server = createServer(async (req, res) => {
  let pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  
  // Route handling
  if (pathname === '/') {
    pathname = '/tools/map/view_svg_muni/index.html';
  } else if (pathname === '/viewer.js') {
    pathname = '/tools/map/view_svg_muni/viewer.js';
  } else if (pathname === '/data') {
    if (!existsSync(GEOJSON_PATH)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('GeoJSON file not found');
      console.warn(`WARNING: GeoJSON file not found at ${GEOJSON_PATH}`);
      return;
    }
    try {
      const content = await readFile(GEOJSON_PATH, 'utf8');
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

if (!existsSync(GEOJSON_PATH)) {
  console.warn(`WARNING: GeoJSON file not found at ${GEOJSON_PATH}`);
  console.warn('Server will start but viewer will show an error.');
}

server.listen(PORT, () => {
  console.log(`Open: http://localhost:${PORT}/`);
}).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${PORT} is already in use.`);
    console.error(`Please stop the existing server or set PORT environment variable to use a different port.`);
    console.error(`Example: PORT=5182 npm run map:view-muni-svg`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
